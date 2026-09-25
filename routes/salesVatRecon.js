/**
 * Sales VAT Register vs G/L — reconciliation
 *   GET /api/sales-vat-recon?dt1=YYYY-MM-DD&dt2=YYYY-MM-DD         — JSON for the grid
 *   GET /api/sales-vat-recon/excel?dt1=YYYY-MM-DD&dt2=YYYY-MM-DD   — .xlsx download
 *
 * Invoice rows, Taxable and VAT come from the Sales Register VAT itself
 * (fetchRows + decorateRows in salesRegisterVat.js) — same SQL, same
 * taxable/VAT rules — so any change made there shows in both reports.
 *
 * Registration in HayatDb.js:
 *   const salesVatRecon = require('./routes/salesVatRecon');
 *   app.use('/api', salesVatRecon(connection));
 */
const express = require('express');
const ExcelJS = require('exceljs');
const { fetchRows, decorateRows, round2 } = require('./salesRegisterVat');

const VAT_OUT_AC = '300-001-0-001';     // VAT ON SALES

// Register source (the `src` column in the register SQL) → tran_acc.TRAN_TYPE.
// Only sources listed here are reconciled. Add e.g. SINV: '05' for trading invoices.
const TT_BY_SRC = { FAB: '06' };

const GROUP_LABEL = { UAE: 'United Arab Emirates', ZZZ: 'Export — Zero Rated', GL: 'G/L postings without invoice' };
const GROUP_ORDER = { UAE: 0, ZZZ: 1, GL: 2 };

const ymdToDmy = (s) => { const [y, m, d] = String(s || '').split('-'); return d ? `${d}/${m}/${y}` : ''; };
const keyOf    = (tt, vno) => `${String(tt).trim()}|${String(vno).trim()}`;
const isYmd    = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// ─── Core: build the whole reconciliation (shared by JSON and Excel) ─────────
async function buildRecon(connection, db, dt1, dt2) {
  // 1. Register rows — exactly what the Sales Register VAT shows (UAE + export)
  // includeZero: fab invoices with net_amt = 0 are kept here (the register drops them)
  const regRows = decorateRows(await fetchRows(connection, { dt1, dt2, sloc: '', includeZero: true }))
    .filter(r => TT_BY_SRC[r.src]);

  // 2. VAT A/c postings for those tran types, per voucher
  const types  = [...new Set(Object.values(TT_BY_SRC))];
  const invNos = regRows.map(r => String(r.inv_no).trim());
  const [gl] = await db.query(`
    SELECT TRIM(TRAN_TYPE)                                          AS tt,
           TRIM(VCHR_NO)                                            AS vno,
           DATE_FORMAT(MIN(DATTE), '%d/%m/%Y')                      AS dt,
           MAX(DATTE BETWEEN ? AND ?)                               AS in_period,
           SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE -AMOUNT END)  AS gl_vat
    FROM   tran_acc
    WHERE  ACC_CODE = ?
      AND  TRIM(TRAN_TYPE) IN (?)
      AND  (DATTE BETWEEN ? AND ? OR TRIM(VCHR_NO) IN (?))
    GROUP  BY TRIM(TRAN_TYPE), TRIM(VCHR_NO)`,
    [dt1, dt2, VAT_OUT_AC, types, dt1, dt2, invNos.length ? invNos : ['']]);
  const glMap = new Map(gl.map(g => [keyOf(g.tt, g.vno), g]));

  // 3. Rows: register vs G/L
  const rows = regRows.map(r => {
    const k = keyOf(TT_BY_SRC[r.src], r.inv_no);
    const g = glMap.get(k);
    glMap.delete(k);
    const vat = round2(r.vat), glVat = round2(Number(g?.gl_vat) || 0);
    return {
      grp: r.nat_ind === 'UAE' ? 'UAE' : 'ZZZ',
      inv_no: r.inv_no, inv_date: ymdToDmy(r.inv_date), sort_date: r.inv_date,
      cust_code: r.cust_code, cust_name: r.cust_name, nation_code: r.nation_code,
      taxable: round2(r.taxable), vat, gl_vat: glVat, variance: round2(vat - glVat),
      note: [Number(r.zero_net) ? 'Net Amt 0' : '', g ? '' : 'Not posted'].filter(Boolean).join(' · '),
    };
  });
  for (const g of glMap.values()) {
    const glVat = round2(Number(g.gl_vat) || 0);
    if (!Number(g.in_period) || glVat === 0) continue;
    const [d, m, y] = String(g.dt).split('/');
    rows.push({
      grp: 'GL', inv_no: g.vno, inv_date: g.dt, sort_date: `${y}-${m}-${d}`,
      cust_code: '', cust_name: '', nation_code: '',
      taxable: 0, vat: 0, gl_vat: glVat, variance: round2(-glVat), note: 'G/L only',
    });
  }
  // UAE first, then Export, then G/L-only; each by date, invoice no.
  rows.sort((a, b) => (GROUP_ORDER[a.grp] - GROUP_ORDER[b.grp])
    || a.sort_date.localeCompare(b.sort_date) || String(a.inv_no).localeCompare(String(b.inv_no)));

  // 4. Group subtotals + grand total
  const tot = (list) => ({
    count: list.length,
    taxable: round2(list.reduce((s, r) => s + r.taxable, 0)),
    vat:     round2(list.reduce((s, r) => s + r.vat, 0)),
    gl_vat:  round2(list.reduce((s, r) => s + r.gl_vat, 0)),
    variance: round2(list.reduce((s, r) => s + r.variance, 0)),
  });
  // UAE and Export always listed (a 0-count Export line is itself informative)
  const groups = ['UAE', 'ZZZ', 'GL']
    .filter(k => k !== 'GL' || rows.some(r => r.grp === 'GL'))
    .map(k => ({ grp: k, label: GROUP_LABEL[k], ...tot(rows.filter(r => r.grp === k)) }));
  const totals = { ...tot(rows), count: regRows.length,
                   mismatches: rows.filter(r => r.variance !== 0).length };

  // 5. VAT A/c statement (Credit-positive)
  const [[ob]] = await db.query(`
    SELECT IFNULL(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE -AMOUNT END), 0) AS bal
    FROM   tran_acc WHERE ACC_CODE = ? AND DATTE < ?`, [VAT_OUT_AC, dt1]);
  const [mv] = await db.query(`
    SELECT TRIM(TRAN_TYPE)                                        AS tran_type,
           IFNULL(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT END), 0)  AS cr,
           IFNULL(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT END), 0)  AS dr
    FROM   tran_acc
    WHERE  ACC_CODE = ? AND DATTE BETWEEN ? AND ?
    GROUP  BY TRIM(TRAN_TYPE) ORDER BY TRIM(TRAN_TYPE)`, [VAT_OUT_AC, dt1, dt2]);
  const [[ac]] = await db.query(`SELECT ACC_HEAD FROM acc_mst WHERE ACC_CODE = ?`, [VAT_OUT_AC]);

  const byType  = mv.map(m => ({ tran_type: m.tran_type, cr: round2(Number(m.cr)), dr: round2(Number(m.dr)) }));
  const totCr   = round2(byType.reduce((s, m) => s + m.cr, 0));
  const totDr   = round2(byType.reduce((s, m) => s + m.dr, 0));
  const opening = round2(Number(ob.bal));

  return {
    rows: rows.map(({ sort_date, ...r }) => r),
    groups, totals,
    vatAc: { acc_code: VAT_OUT_AC, acc_head: ac?.ACC_HEAD || 'VAT ON SALES',
             opening, totCr, totDr, closing: round2(opening + totCr - totDr), byType },
  };
}

// ─── Excel (print-friendly: light fill on the column header row only) ────────
async function buildExcel(rep, dt1, dt2) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Telltron ERP';
  const ws = wb.addWorksheet('VAT Register vs GL', {
    views: [{ showGridLines: false, state: 'frozen', ySplit: 5 }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
                 printTitlesRow: '5:5',
                 margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.25 } },
    headerFooter: { oddFooter: '&L&9Telltron ERP&C&9Page &P of &N&R&9Printed &D' },
  });
  ws.columns = [{ width: 13 }, { width: 11 }, { width: 10 }, { width: 46 }, { width: 8 },
                { width: 16 }, { width: 15 }, { width: 15 }, { width: 13 }, { width: 13 }];

  const NAVY = '0D1B2A', STEEL = '1B3A5C', GREY = '6B7280', RED = 'C0392B', ORANGE = 'D35400', RULE = '94A3B8';
  const NUM  = '#,##0.00;[Red]-#,##0.00';
  const font = (bold, argb = NAVY, size = 10, italic = false) => ({ name: 'Calibri', bold, italic, size, color: { argb } });
  const thin = { style: 'thin', color: { argb: RULE } };
  const dmy  = (s) => s.split('-').reverse().join('/');

  ws.mergeCells('A1:J1'); ws.getCell('A1').value = 'AL HAYAT ELECT. SWITCHGEAR IND. LLC';
  ws.getCell('A1').font = font(true, NAVY, 14);
  ws.mergeCells('A2:J2'); ws.getCell('A2').value = `Sales VAT Register vs G/L — ${rep.vatAc.acc_code} ${rep.vatAc.acc_head}`;
  ws.getCell('A2').font = font(true, STEEL, 11);
  ws.mergeCells('A3:J3'); ws.getCell('A3').value = `Period: ${dmy(dt1)} to ${dmy(dt2)}`;
  ws.getCell('A3').font = font(false, GREY, 10);

  const hdr = ws.getRow(5);
  hdr.values = ['Invoice No.', 'Date', 'Cust Code', 'Customer Name', 'Country',
                'Taxable (AED)', 'VAT Register', 'VAT per G/L', 'Variance', 'Remarks'];
  hdr.eachCell((c, i) => {
    c.font = font(true, NAVY, 10);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DCE7F3' } };   // light — header row only
    c.alignment = { horizontal: i >= 6 && i <= 9 ? 'right' : 'center', vertical: 'middle' };
    c.border = { top: thin, bottom: thin };
  });
  hdr.height = 20;

  const put = (vals, opts = {}) => {
    const r = ws.addRow(vals);
    r.eachCell({ includeEmpty: true }, (c, i) => {
      c.font = font(!!opts.bold, opts.color || NAVY, opts.size || 10, !!opts.italic);
      if (i >= 6 && i <= 9) { c.numFmt = NUM; c.alignment = { horizontal: 'right' }; }
      if (opts.rule) c.border = { top: thin, bottom: opts.double ? { style: 'double', color: { argb: NAVY } } : thin };
    });
    return r;
  };

  for (const g of rep.groups) {
    const sec = ws.addRow([`${g.label}  (${g.count})`]);
    sec.getCell(1).font = font(true, STEEL, 11);
    for (const r of rep.rows.filter(x => x.grp === g.grp)) {
      const row = put([r.inv_no, r.inv_date, r.cust_code, r.cust_name, r.nation_code,
                       r.taxable, r.vat, r.gl_vat, r.variance, r.note],
                      { italic: r.grp === 'GL' });
      if (Math.abs(r.variance) >= 0.005) row.getCell(9).font = font(true, RED);
      if (r.note) row.getCell(10).font = font(true, ORANGE, 9);
    }
    put(['', '', '', `Subtotal — ${g.label}`, '', g.taxable, g.vat, g.gl_vat, g.variance, ''],
        { bold: true, rule: true });
    ws.addRow([]);
  }
  const t = rep.totals;
  put(['', '', '', `GRAND TOTAL — ${t.count} invoices`, '', t.taxable, t.vat, t.gl_vat, t.variance, ''],
      { bold: true, rule: true, double: true, size: 11 });

  // VAT A/c statement
  ws.addRow([]); ws.addRow([]);
  const st = ws.addRow([`${rep.vatAc.acc_code} — ${rep.vatAc.acc_head}`]);
  st.getCell(1).font = font(true, STEEL, 11);
  const bal = (n) => `${Math.abs(n).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${n >= 0 ? 'Cr' : 'Dr'}`;
  const stLine = (label, val, bold = false, rule = false) => {
    const r = ws.addRow(['', '', '', label, '', val]);
    r.getCell(4).font = font(bold); r.getCell(6).font = font(bold);
    r.getCell(6).alignment = { horizontal: 'right' };
    if (typeof val === 'number') r.getCell(6).numFmt = NUM;
    if (rule) { r.getCell(4).border = { top: thin, bottom: thin }; r.getCell(6).border = { top: thin, bottom: thin }; }
  };
  const a = rep.vatAc;
  stLine(`Opening Balance (before ${dmy(dt1)})`, bal(a.opening), true);
  stLine('Add: Credits in period', a.totCr);
  stLine('Less: Debits in period', -a.totDr);
  stLine(`Closing Balance (as on ${dmy(dt2)})`, bal(a.closing), true, true);

  ws.addRow([]);
  const mh = ws.addRow(['', '', '', 'Period movement by Tran Type', '', 'Credits', 'Debits', 'Net (Cr − Dr)']);
  mh.eachCell((c, i) => { c.font = font(true, STEEL); if (i >= 6) c.alignment = { horizontal: 'right' }; });
  for (const m of a.byType) put(['', '', '', `Tran Type ${m.tran_type}`, '', m.cr, m.dr, round2(m.cr - m.dr)]);
  put(['', '', '', 'Total', '', a.totCr, a.totDr, round2(a.totCr - a.totDr)], { bold: true, rule: true });

  return wb.xlsx.writeBuffer();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
module.exports = function (connection) {
  const router = express.Router();
  const db     = connection.promise();

  router.get('/sales-vat-recon', async (req, res) => {
    const { dt1, dt2 } = req.query;
    if (!isYmd(dt1) || !isYmd(dt2)) return res.status(400).json({ error: 'dt1 and dt2 are required as YYYY-MM-DD' });
    try {
      res.json(await buildRecon(connection, db, dt1, dt2));
    } catch (err) {
      console.error('sales-vat-recon:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sales-vat-recon/excel', async (req, res) => {
    const { dt1, dt2 } = req.query;
    if (!isYmd(dt1) || !isYmd(dt2)) return res.status(400).send('dt1 and dt2 are required as YYYY-MM-DD');
    try {
      const buf = await buildExcel(await buildRecon(connection, db, dt1, dt2), dt1, dt2);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Sales_VAT_Recon_${dt1}_${dt2}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (err) {
      console.error('sales-vat-recon/excel:', err);
      res.status(500).send(err.message);
    }
  });

  return router;
};
