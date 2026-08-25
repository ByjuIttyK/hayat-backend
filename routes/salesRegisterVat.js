/**
 * Sales Register VAT Route — UAE VAT Submission
 * Route: /api/sales-register-vat
 *
 * Endpoints:
 *   GET /api/sales-register-vat          — grouped JSON (nations → states → rows)
 *   GET /api/sales-register-vat/pdf      — streams PDF
 *   GET /api/sales-register-vat/excel    — streams Excel
 *
 * Query params:
 *   dt1   : "YYYY-MM-DD"  (required)
 *   dt2   : "YYYY-MM-DD"  (required)
 *   sloc  : location code e.g. "DUBAI" (optional — omit / "" for all)
 *
 * Registration in HayatDb.js:
 *   const salesRegisterVat = require('./routes/salesRegisterVat');
 *   app.use('/api', salesRegisterVat(connection));
 */

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const VAT_RATE = 0.05;
// ─── SQL ─────────────────────────────────────────────────────────────────────
// sal_loc_mst joined via LEFT JOIN so rows without a matching sloc_code still
// appear; sloc_name falls back to cn_code when no match.
// All table names lowercase for VPS compatibility.
const SQL = `
  SELECT
    a.inv_no,
    DATE_FORMAT(a.inv_date, '%Y-%m-%d')        AS inv_date,
    a.cust_code,
    b.cust_name,
    (a.amount * IFNULL(a.exchg_rate, 1))       AS amt,
    b.cn_code                                   AS sloc,
    IFNULL(s.sloc_name, b.cn_code)             AS sloc_name,
    a.exchg_rate,
    0                                           AS discount,
    IF(b.nation_code = 'UAE', 'UAE', 'ZZZ')    AS nat_ind,
    b.nation_code
  FROM   net_sales   a
  JOIN   cus_mst     b ON a.cust_code  = b.cust_code
  LEFT JOIN sal_loc_mst s ON s.sloc_code = b.cn_code
  WHERE  IFNULL(b.cn_code, 'X') LIKE ?
    AND  a.inv_date BETWEEN ? AND ?
    AND  IFNULL(a.can_cel, 'N') <> 'Y'

  UNION ALL

  SELECT
    a.inv_no,
    DATE_FORMAT(a.inv_date, '%Y-%m-%d')        AS inv_date,
    a.cust_code,
    b.cust_name,
    (a.net_amt * IFNULL(a.convert_rate, 1))    AS amt,
    b.cn_code                                   AS sloc,
    IFNULL(s.sloc_name, b.cn_code)             AS sloc_name,
    a.convert_rate                              AS exchg_rate,
    IFNULL(a.discount, 0)                       AS discount,
    IF(b.nation_code = 'UAE', 'UAE', 'ZZZ')    AS nat_ind,
    b.nation_code
  FROM   fab_inv_hdr  a
  JOIN   cus_mst      b ON a.cust_code  = b.cust_code
  LEFT JOIN sal_loc_mst s ON s.sloc_code = b.cn_code
  WHERE  IFNULL(b.cn_code, 'X') LIKE ?
    AND  a.inv_date BETWEEN ? AND ?
    AND  IFNULL(a.inv_cancelled, 'N') <> 'Y'
    AND  IFNULL(a.net_amt, 0) <> 0

  ORDER BY inv_date
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchRows(connection, { dt1, dt2, sloc }) {
  return new Promise((resolve, reject) => {
    const slocFilter = sloc && sloc.toUpperCase() !== 'ALL' ? sloc : '%';
    const params = [slocFilter, dt1, dt2, slocFilter, dt1, dt2];
    connection.getConnection((err, conn) => {
      if (err) return reject(err);
      conn.query(SQL, params, (qErr, results) => {
        conn.release();
        if (qErr) return reject(qErr);
        resolve(results);
      });
    });
  });
}

function decorateRows(rows) {
  return rows.map(r => {
    const taxable = round2(r.amt - r.discount);
    const vat     = round2(taxable * VAT_RATE);
    return { ...r, taxable, vat, total: round2(taxable + vat) };
  });
}

/** Group by nat_ind → sloc (code), carrying sloc_name from SQL */
function groupRows(rows) {
  const grouped   = {};   // { nat: { slocCode: { name, rows[] } } }
  for (const r of rows) {
    const nat  = r.nat_ind;
    const code = r.sloc || 'UNKNOWN';
    if (!grouped[nat]) grouped[nat] = {};
    if (!grouped[nat][code]) grouped[nat][code] = { name: r.sloc_name || code, rows: [] };
    grouped[nat][code].rows.push(r);
  }
  return grouped;
}

function buildReport(rows) {
  const decorated = decorateRows(rows);
  const grouped   = groupRows(decorated);

  let grandTaxable = 0, grandVat = 0, grandTotal = 0;

  const nations = Object.keys(grouped).sort().map(nat => {
    let natTaxable = 0, natVat = 0, natTotal = 0;

    const states = Object.keys(grouped[nat]).sort().map(sloc => {
      const { name: sloc_name, rows: slRows } = grouped[nat][sloc];
      const stTaxable = slRows.reduce((s, r) => s + r.taxable, 0);
      const stVat     = slRows.reduce((s, r) => s + r.vat,     0);
      const stTotal   = slRows.reduce((s, r) => s + r.total,   0);
      natTaxable += stTaxable; natVat += stVat; natTotal += stTotal;
      return {
        state:            sloc,
        state_name:       sloc_name,
        rows:             slRows,
        subtotal_taxable: round2(stTaxable),
        subtotal_vat:     round2(stVat),
        subtotal_total:   round2(stTotal),
      };
    });

    grandTaxable += natTaxable; grandVat += natVat; grandTotal += natTotal;
    return { nat_ind: nat, states, nat_taxable: round2(natTaxable), nat_vat: round2(natVat), nat_total: round2(natTotal) };
  });

  return { nations, grand_taxable: round2(grandTaxable), grand_vat: round2(grandVat), grand_total: round2(grandTotal), count: decorated.length };
}

const round2  = v  => Math.round(v * 100) / 100;
const fmtNum  = v  => Number(v).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Excel Builder ────────────────────────────────────────────────────────────

async function buildExcel(report, { dt1, dt2, sloc }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Telltron ERP';
  const ws = wb.addWorksheet('Sales Register VAT', { views: [{ showGridLines: false }] });

  ws.columns = [
    { width: 17 }, { width: 13 }, { width: 13 }, { width: 40 },
    { width: 18 }, { width: 18 }, { width: 18 }, { width: 8  }, { width: 8 },
  ];

  const NAVY = '0D1B2A', GOLD = 'C9A84C', LGOLD = 'F5E6C8',
        STEEL = '1B3A5C', STBG = 'E8F0F7', ALT = 'F4F8FC';

  const fill  = a  => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: a } });
  const font  = (bold, argb, sz = 10) => ({ name: 'Calibri', bold, color: { argb }, size: sz });
  const aln   = (h = 'left', wrapText = false) => ({ horizontal: h, vertical: 'middle', wrapText });
  const thin  = c => ({ style: 'thin',   color: { argb: c } });
  const med   = c => ({ style: 'medium', color: { argb: c } });
  const thinBorder = { top: thin('C0C0C0'), bottom: thin('C0C0C0'), left: thin('C0C0C0'), right: thin('C0C0C0') };
  const goldBorder = { top: med(GOLD), bottom: med(GOLD), left: med(GOLD), right: med(GOLD) };

  let rn = 1;
  const mergeRow = (val, bg, fg, sz, bold = true) => {
    ws.mergeCells(rn, 1, rn, 9);
    const c = ws.getCell(rn, 1);
    c.value = val; c.fill = fill(bg); c.font = font(bold, fg, sz); c.alignment = aln('center');
    ws.getRow(rn).height = sz + 14; rn++;
  };

  mergeRow('AL HAYAT ELECT. SWITCHGEAR IND. LLC.', NAVY, GOLD, 14);
  mergeRow('SHARJAH, U.A.E.', NAVY, GOLD, 10, false);
  mergeRow(`SALES REGISTER — UAE VAT SUBMISSION  |  Period: ${dt1}  to  ${dt2}  |  Location: ${sloc || 'ALL'}`, STEEL, 'F5E6C8', 9, false);
  ws.getRow(rn).height = 6; rn++;

  const hdrs = ['Invoice No.','Inv. Date','Cust. Code','Customer Name','Taxable (AED)','VAT 5% (AED)','Total (AED)','Loc','Ctry'];
  hdrs.forEach((h, i) => {
    const c = ws.getCell(rn, i + 1);
    c.value = h; c.fill = fill(GOLD); c.font = font(true, NAVY, 9);
    c.alignment = aln('center', true); c.border = goldBorder;
  });
  ws.getRow(rn).height = 22; rn++;

  for (const nation of report.nations) {
    ws.mergeCells(rn, 1, rn, 9);
    const nc = ws.getCell(rn, 1);
    nc.value = `  ${nation.nat_ind === 'UAE' ? 'UNITED ARAB EMIRATES' : `EXPORT — ${nation.nat_ind}`}`;
    nc.fill = fill(STEEL); nc.font = font(true, 'FFFFFF', 10); nc.alignment = aln('left');
    ws.getRow(rn).height = 20; rn++;

    for (const st of nation.states) {
      ws.mergeCells(rn, 1, rn, 9);
      const sc = ws.getCell(rn, 1);
      // ── state_name from sal_loc_mst shown here ──
      sc.value = `    ${st.state_name}  ${st.state_name !== st.state ? `(${st.state})` : ''}`;
      sc.fill = fill(STBG); sc.font = font(true, STEEL, 10); sc.alignment = aln('left');
      ws.getRow(rn).height = 18; rn++;

      st.rows.forEach((r, idx) => {
        const bg = idx % 2 === 0 ? 'FFFFFF' : ALT;
        [r.inv_no, r.inv_date, r.cust_code, r.cust_name, r.taxable, r.vat, r.total,
         (r.sloc || '').substring(0, 3), r.nation_code].forEach((v, i) => {
          const c = ws.getCell(rn, i + 1);
          c.value = v; c.fill = fill(bg); c.border = thinBorder;
          if (i >= 4 && i <= 6) { c.numFmt = '#,##0.00'; c.font = font(false, STEEL, 9); c.alignment = aln('right'); }
          else if (i === 3)     { c.font = font(false, '000000', 9); c.alignment = aln('left', true); }
          else                  { c.font = font(false, '374151', 9); c.alignment = aln('center'); }
        });
        ws.getRow(rn).height = 16; rn++;
      });

      ws.mergeCells(rn, 1, rn, 4);
      const stc = ws.getCell(rn, 1);
      stc.value = `  Subtotal — ${st.state_name}  (${st.rows.length} invoices)`;
      stc.fill = fill(LGOLD); stc.font = font(true, NAVY, 9); stc.alignment = aln('right');
      [[5, st.subtotal_taxable],[6, st.subtotal_vat],[7, st.subtotal_total]].forEach(([col, val]) => {
        const c = ws.getCell(rn, col);
        c.value = val; c.numFmt = '#,##0.00'; c.fill = fill(LGOLD);
        c.font = font(true, NAVY, 9); c.alignment = aln('right');
      });
      ws.getRow(rn).height = 18; rn++;
    }

    ws.mergeCells(rn, 1, rn, 4);
    const ntc = ws.getCell(rn, 1);
    ntc.value = `  TOTAL — ${nation.nat_ind}`; ntc.fill = fill(STEEL);
    ntc.font = font(true, 'FFFFFF', 10); ntc.alignment = aln('right');
    [[5, nation.nat_taxable],[6, nation.nat_vat],[7, nation.nat_total]].forEach(([col, val]) => {
      const c = ws.getCell(rn, col);
      c.value = val; c.numFmt = '#,##0.00'; c.fill = fill(STEEL);
      c.font = font(true, GOLD, 10); c.alignment = aln('right');
    });
    ws.getRow(rn).height = 20; rn++; rn++;
  }

  ws.mergeCells(rn, 1, rn, 4);
  const gtc = ws.getCell(rn, 1);
  gtc.value = `  GRAND TOTAL  (${report.count} Invoices)`;
  gtc.fill = fill(NAVY); gtc.font = font(true, GOLD, 12); gtc.alignment = aln('right');
  [[5, report.grand_taxable],[6, report.grand_vat],[7, report.grand_total]].forEach(([col, val]) => {
    const c = ws.getCell(rn, col);
    c.value = val; c.numFmt = '#,##0.00'; c.fill = fill(NAVY);
    c.font = font(true, GOLD, 12); c.alignment = aln('right');
  });
  ws.getRow(rn).height = 24;
  return wb;
}

// ─── PDF Builder ──────────────────────────────────────────────────────────────
// Uses save()/restore() + clip rect per cell so text NEVER bleeds into adjacent columns.

function buildPdf(report, { dt1, dt2, sloc }) {
  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape',
    margins: { top: 24, bottom: 24, left: 22, right: 22 },
    autoFirstPage: true,
  });

  const PW      = doc.page.width;   // 841.89 pt landscape
  const MARGIN  = 18;   // tighter margin = more usable width
  const CW      = PW - MARGIN * 2;  // usable content width ≈ 797 pt

  // ── colours ──────────────────────────────────────────────────────────────
  const NAVY  = '#0D1B2A', GOLD  = '#C9A84C', LGOLD = '#F5E6C8',
        STEEL = '#1B3A5C', STBG  = '#E8F0F7', ALT   = '#F4F8FC',
        WHITE = '#FFFFFF', GREY  = '#6B7280';

  // ── column layout (must sum to exactly 1.0) ───────────────────────────────
  //  InvNo  Date   CCode  CustName  Taxable  VAT    Total   Loc   Ctry
  //           InvNo  Date  CCode CustName  Tax    VAT   Total  Loc  Ctry
  const PCT = [0.13, 0.09, 0.09, 0.25, 0.11, 0.11, 0.11, 0.055, 0.055];
  const CWS = PCT.map(p => Math.floor(p * CW));
  // fix rounding: add remainder to customer name column
  const rem = CW - CWS.reduce((a,b)=>a+b,0);
  CWS[3] += rem;

  const COL_HDRS = ['Invoice No.','Date','Cust Code','Customer Name',
                    'Taxable (AED)','VAT 5% (AED)','Total (AED)','Loc','Ctry'];
  const ROW_H  = 15;
  const HEAD_H = 19;
  let y = MARGIN;

  // ── core drawing helpers ──────────────────────────────────────────────────

  /** Fill a rectangle with a solid colour */
  const fillR = (x, ry, w, h, col) => doc.save().rect(x, ry, w, h).fill(col).restore();

  /** Draw text clipped strictly inside [cx, cy, cw, ch].
   *  align: 'left' | 'center' | 'right'
   *  PDFKit's doc.text() is called with lineBreak:false so it never wraps.
   *  We clip to the cell so overflow is invisible. */
  const cell = (text, cx, cy, cw, ch,
                { align='left', color='#111', fontSize=7, bold=false, padH=3 } = {}) => {
    if (text === null || text === undefined || text === '') return;
    const str = String(text);
    doc.save();
    // Clip strictly to this cell — nothing bleeds into adjacent columns
    doc.rect(cx + 0.5, cy + 0.5, cw - 1, ch - 1).clip();
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(fontSize)
       .fillColor(color);
    const vertY = cy + (ch - fontSize) / 2;
    // Always anchor at cx+padH with full inner width; pass align to PDFKit.
    // This is the ONLY correct way to right-align in PDFKit — never shift tx.
    doc.text(str, cx + padH, vertY, {
      lineBreak: false,
      width: cw - padH * 2,
      align,                   // 'left' | 'center' | 'right' — PDFKit handles it
    });
    doc.restore();
  };

  /** Draw a full-width row of 9 cells */
  const drawDataRow = (vals, ry, bg, opts) => {
    let cx = MARGIN;
    fillR(MARGIN, ry, CW, ROW_H, bg);
    vals.forEach((v, i) => {
      // light grid line
      doc.save().rect(cx, ry, CWS[i], ROW_H).stroke('#D8DCE4').restore();
      cell(v, cx, ry, CWS[i], ROW_H, opts[i]);
      cx += CWS[i];
    });
  };

  /** Column-header row (repeated on each page) */
  const drawColHeaders = () => {
    let cx = MARGIN;
    fillR(MARGIN, y, CW, HEAD_H, LGOLD);
    COL_HDRS.forEach((h, i) => {
      doc.save().rect(cx, y, CWS[i], HEAD_H).stroke(GOLD).restore();
      cell(h, cx, y, CWS[i], HEAD_H, { align:'center', color:NAVY, fontSize:6.5, bold:true });
      cx += CWS[i];
    });
    y += HEAD_H;
  };

  const checkPage = (needed = ROW_H) => {
    if (y + needed > doc.page.height - MARGIN) {
      doc.addPage();
      y = MARGIN;
      drawColHeaders();
    }
  };

  // ── page header ───────────────────────────────────────────────────────────
  fillR(MARGIN, y, CW, 24, NAVY);
  cell('AL HAYAT ELECT. SWITCHGEAR IND. LLC.', MARGIN, y, CW, 24,
    { align:'center', color:GOLD, fontSize:12, bold:true }); y += 24;

  fillR(MARGIN, y, CW, 14, NAVY);
  cell('SHARJAH, U.A.E.', MARGIN, y, CW, 14,
    { align:'center', color:GOLD, fontSize:8.5 }); y += 14;

  fillR(MARGIN, y, CW, 14, STEEL);
  cell(`SALES REGISTER — UAE VAT SUBMISSION  |  Period: ${dt1} to ${dt2}  |  Location: ${sloc || 'ALL LOCATIONS'}  |  Printed: ${new Date().toLocaleDateString('en-AE')}`,
    MARGIN, y, CW, 14, { align:'center', color:LGOLD, fontSize:7 }); y += 14 + 5;

  drawColHeaders();

  // ── data ──────────────────────────────────────────────────────────────────
  for (const nation of report.nations) {
    checkPage(HEAD_H);
    fillR(MARGIN, y, CW, HEAD_H, STEEL);
    const natLabel = nation.nat_ind === 'UAE' ? 'UNITED ARAB EMIRATES' : `EXPORT — ${nation.nat_ind}`;
    cell(`  ${natLabel}`, MARGIN, y, CW, HEAD_H,
      { color: WHITE, fontSize: 9, bold: true }); y += HEAD_H;

    for (const st of nation.states) {
      checkPage(HEAD_H);
      fillR(MARGIN, y, CW, HEAD_H - 3, STBG);
      const stLabel = st.state_name !== st.state
        ? `${st.state_name}  (${st.state})` : st.state_name;
      cell(`    ${stLabel}`, MARGIN, y, CW, HEAD_H - 3,
        { color: STEEL, fontSize: 8, bold: true });
      y += HEAD_H - 3;

      // invoice rows
      st.rows.forEach((r, idx) => {
        checkPage(ROW_H);
        const bg = idx % 2 === 0 ? WHITE : ALT;
        drawDataRow(
          [r.inv_no, r.inv_date, r.cust_code, r.cust_name,
           fmtNum(r.taxable), fmtNum(r.vat), fmtNum(r.total),
           r.sloc || '', r.nation_code],
          y, bg,
          [
            { align:'center', color:'#1B3A5C', fontSize:7, bold:true },
            { align:'center', color:'#374151', fontSize:7 },
            { align:'center', color:'#374151', fontSize:7 },
            { align:'left',   color:'#111',    fontSize:7 },
            { align:'right',  color:STEEL,     fontSize:7 },
            { align:'right',  color:'#9A6F00', fontSize:7 },
            { align:'right',  color:STEEL,     fontSize:7, bold:true },
            { align:'center', color:GREY,      fontSize:7 },
            { align:'center', color:GREY,      fontSize:7 },
          ]
        );
        y += ROW_H;
      });

      // state subtotal
      checkPage(HEAD_H);
      const SPAN = CWS[0]+CWS[1]+CWS[2]+CWS[3];
      fillR(MARGIN, y, CW, HEAD_H - 3, LGOLD);
      cell(`Subtotal — ${st.state_name}  (${st.rows.length} invoices)`,
        MARGIN, y, SPAN, HEAD_H - 3, { align:'right', color:NAVY, fontSize:7.5, bold:true });
      let cx = MARGIN + SPAN;
      [st.subtotal_taxable, st.subtotal_vat, st.subtotal_total].forEach((v, i) => {
        cell(fmtNum(v), cx, y, CWS[4+i], HEAD_H-3,
          { align:'right', color:NAVY, fontSize:7.5, bold:true, padH:2 });
        cx += CWS[4+i];
      });
      doc.save().moveTo(MARGIN, y+HEAD_H-3)
         .lineTo(MARGIN+CW, y+HEAD_H-3).lineWidth(1).stroke(GOLD).restore();
      y += HEAD_H - 3;
    }

    // nation total
    checkPage(HEAD_H);
    const SPAN = CWS[0]+CWS[1]+CWS[2]+CWS[3];
    fillR(MARGIN, y, CW, HEAD_H, STEEL);
    cell(`  TOTAL — ${nation.nat_ind}`, MARGIN, y, SPAN, HEAD_H,
      { align:'right', color:WHITE, fontSize:9, bold:true });
    let cx = MARGIN + SPAN;
    [nation.nat_taxable, nation.nat_vat, nation.nat_total].forEach((v, i) => {
      cell(fmtNum(v), cx, y, CWS[4+i], HEAD_H,
        { align:'right', color:GOLD, fontSize:9, bold:true, padH:2 });
      cx += CWS[4+i];
    });
    y += HEAD_H + 5;
  }

  // grand total
  checkPage(HEAD_H + 8);
  doc.save().moveTo(MARGIN, y).lineTo(MARGIN+CW, y).lineWidth(2).stroke(GOLD).restore(); y += 2;
  const SPAN = CWS[0]+CWS[1]+CWS[2]+CWS[3];
  fillR(MARGIN, y, CW, HEAD_H+8, NAVY);
  cell(`  GRAND TOTAL  (${report.count} Invoices)`, MARGIN, y, SPAN, HEAD_H+8,
    { align:'right', color:GOLD, fontSize:11, bold:true });
  let cx = MARGIN + SPAN;
  [report.grand_taxable, report.grand_vat, report.grand_total].forEach((v, i) => {
    cell(fmtNum(v), cx, y, CWS[4+i], HEAD_H+8,
      { align:'right', color:'#E8C96D', fontSize:11, bold:true, padH:2 });
    cx += CWS[4+i];
  });

  doc.end();
  return doc;
}

// ─── Route Factory ────────────────────────────────────────────────────────────

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/sales-register-vat?dt1=2026-06-01&dt2=2026-06-30&sloc=DUBAI
  router.get('/sales-register-vat', async (req, res) => {
    const { dt1, dt2, sloc } = req.query;
    if (!dt1 || !dt2) return res.status(400).json({ error: 'dt1 and dt2 are required (YYYY-MM-DD)' });
    try {
      const rows   = await fetchRows(connection, { dt1, dt2, sloc });
      const report = buildReport(rows);
      res.json(report);
    } catch (err) {
      console.error('[sales-register-vat]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/sales-register-vat/excel
  router.get('/sales-register-vat/excel', async (req, res) => {
    const { dt1, dt2, sloc } = req.query;
    if (!dt1 || !dt2) return res.status(400).json({ error: 'dt1 and dt2 required' });
    try {
      const rows   = await fetchRows(connection, { dt1, dt2, sloc });
      const report = buildReport(rows);
      const wb     = await buildExcel(report, { dt1, dt2, sloc });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Sales_Register_VAT_${dt1}_${dt2}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('[sales-register-vat/excel]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/sales-register-vat/pdf
  router.get('/sales-register-vat/pdf', async (req, res) => {
    const { dt1, dt2, sloc } = req.query;
    if (!dt1 || !dt2) return res.status(400).json({ error: 'dt1 and dt2 required' });
    try {
      const rows   = await fetchRows(connection, { dt1, dt2, sloc });
      const report = buildReport(rows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Sales_Register_VAT_${dt1}_${dt2}.pdf"`);
      const pdfDoc = buildPdf(report, { dt1, dt2, sloc });
      pdfDoc.pipe(res);
    } catch (err) {
      console.error('[sales-register-vat/pdf]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
