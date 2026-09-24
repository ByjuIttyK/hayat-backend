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

/** Exports are zero-rated: anything outside the UAE carries no output VAT. */
const isExport = (r) => r.nat_ind !== 'UAE';

// ─── SQL ─────────────────────────────────────────────────────────────────────
// sal_loc_mst joined via LEFT JOIN so rows without a matching sloc_code still
// appear; sloc_name falls back to cn_code when no match.
// All table names lowercase for VPS compatibility.
const SQL = `
  SELECT
    a.inv_no,
    DATE_FORMAT(a.inv_date, '%Y-%m-%d')        AS inv_date,
    a.cust_code,
    LEFT(TRIM(b.cust_name), 50)                AS cust_name,
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
    LEFT(TRIM(b.cust_name), 50)                AS cust_name,
    -- Taxable is built from the item lines (fab_inv_stl), not from net_amt
    -- (which already includes VAT). Project invoices bill only the contract
    -- percentage of the gross (fab_inv_hdr.CONTRACT_AMT_PERCENT, e.g. 60.00),
    -- then the line discount AMOUNT (DIS_COUNT) is deducted:
    --   taxable = inv_qty * inv_rate * pct / 100 - dis_count
    -- A NULL or 0 percentage is treated as 100 (full value).
    (d.taxable * IFNULL(a.convert_rate, 1))    AS amt,
    b.cn_code                                   AS sloc,
    IFNULL(s.sloc_name, b.cn_code)             AS sloc_name,
    a.convert_rate                              AS exchg_rate,
    0                                           AS discount,
    IF(b.nation_code = 'UAE', 'UAE', 'ZZZ')    AS nat_ind,
    b.nation_code
  FROM   fab_inv_hdr  a
  JOIN   (SELECT t.inv_no,
                 SUM(IFNULL(t.inv_qty, 0) * IFNULL(t.inv_rate, 0)
                     * IFNULL(NULLIF(h.contract_amt_percent, 0), 100) / 100
                     - IFNULL(t.dis_count, 0))               AS taxable
            FROM fab_inv_stl t
            JOIN fab_inv_hdr h ON h.inv_no = t.inv_no
           WHERE h.inv_date BETWEEN ? AND ?
           GROUP BY t.inv_no)     d ON d.inv_no     = a.inv_no
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
    // order follows the placeholders: net_sales WHERE, fab subquery dates,
    // fab WHERE
    const params = [slocFilter, dt1, dt2, dt1, dt2, slocFilter, dt1, dt2];
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
    // Export / international sales are zero-rated — no output VAT.
    const vat = isExport(r) ? 0 : round2(taxable * VAT_RATE);
    return { ...r, taxable, vat, total: round2(taxable + vat), zero_rated: isExport(r) };
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

const natLabelOf = n =>
  n.nat_ind === 'UAE' ? 'UNITED ARAB EMIRATES' : `EXPORT — ZERO RATED (${n.nat_ind})`;

// ─── Excel Builder ────────────────────────────────────────────────────────────
// Print-friendly: no solid fills anywhere except the column header row.

async function buildExcel(report, { dt1, dt2, sloc }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Telltron ERP';
  const ws = wb.addWorksheet('Sales Register VAT', {
    views: [{ showGridLines: false, state: 'frozen', ySplit: 5 }],
    pageSetup: {
      orientation: 'landscape', paperSize: 9,
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printTitlesRow: '5:5',
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.25 },
    },
    headerFooter: { oddFooter: '&L&9Telltron ERP&C&9Page &P of &N&R&9Printed &D' },
  });

  ws.columns = [
    // Inv No / Date / Cust Code kept tight; Customer Name widened to hold the
    // 50-character trimmed name on one line.
    { width: 12 }, { width: 11 }, { width: 10 }, { width: 52 },
    { width: 18 }, { width: 18 }, { width: 18 }, { width: 8  }, { width: 8 },
  ];

  const NAVY = '0D1B2A', LBLUE = 'DCE7F3',
        STEEL = '1B3A5C', GREY = '6B7280', RULE = '94A3B8';

  const fill  = a  => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: a } });
  const font  = (bold, argb, sz = 10) => ({ name: 'Calibri', bold, color: { argb }, size: sz });
  const aln   = (h = 'left', wrapText = false) => ({ horizontal: h, vertical: 'middle', wrapText });
  const thin  = c => ({ style: 'thin',   color: { argb: c } });
  const med   = c => ({ style: 'medium', color: { argb: c } });
  const dbl   = c => ({ style: 'double', color: { argb: c } });
  const thinBorder = { top: thin('C0C0C0'), bottom: thin('C0C0C0'), left: thin('C0C0C0'), right: thin('C0C0C0') };

  let rn = 1;

  /** Heading line: plain text, no fill. */
  const mergeRow = (val, fg, sz, bold = true, underline = null) => {
    ws.mergeCells(rn, 1, rn, 9);
    const c = ws.getCell(rn, 1);
    c.value = val; c.font = font(bold, fg, sz); c.alignment = aln('center');
    if (underline) c.border = { bottom: thin(underline) };
    ws.getRow(rn).height = sz + 10; rn++;
  };

  mergeRow('AL HAYAT ELECT. SWITCHGEAR IND. LLC.', NAVY, 14);
  mergeRow('SHARJAH, U.A.E.', GREY, 10, false);
  mergeRow(
    `SALES REGISTER — UAE VAT SUBMISSION  |  Period: ${dt1}  to  ${dt2}  |  Location: ${sloc || 'ALL'}`,
    STEEL, 9, false, RULE
  );
  ws.getRow(rn).height = 6; rn++;

  // ── the only shaded row in the sheet ──
  const hdrs = ['Invoice No.','Inv. Date','Cust. Code','Customer Name','Taxable (AED)','VAT (AED)','Total (AED)','Loc','Ctry'];
  hdrs.forEach((h, i) => {
    const c = ws.getCell(rn, i + 1);
    c.value = h; c.fill = fill(LBLUE); c.font = font(true, NAVY, 9);
    c.alignment = aln('center', true);
    c.border = { top: thin(STEEL), left: thin(RULE), right: thin(RULE), bottom: med(STEEL) };
  });
  ws.getRow(rn).height = 22; rn++;

  for (const nation of report.nations) {
    ws.mergeCells(rn, 1, rn, 9);
    const nc = ws.getCell(rn, 1);
    nc.value = `  ${natLabelOf(nation)}`;
    nc.font = font(true, NAVY, 10); nc.alignment = aln('left');
    nc.border = { bottom: thin(STEEL) };
    ws.getRow(rn).height = 20; rn++;

    for (const st of nation.states) {
      ws.mergeCells(rn, 1, rn, 9);
      const sc = ws.getCell(rn, 1);
      sc.value = `    ${st.state_name}  ${st.state_name !== st.state ? `(${st.state})` : ''}`;
      sc.font = font(true, STEEL, 10); sc.alignment = aln('left');
      ws.getRow(rn).height = 18; rn++;

      st.rows.forEach(r => {
        [r.inv_no, r.inv_date, r.cust_code, r.cust_name, r.taxable, r.vat, r.total,
         (r.sloc || '').substring(0, 3), r.nation_code].forEach((v, i) => {
          const c = ws.getCell(rn, i + 1);
          c.value = v; c.border = thinBorder;
          if (i >= 4 && i <= 6) { c.numFmt = '#,##0.00'; c.font = font(false, STEEL, 9); c.alignment = aln('right'); }
          else if (i === 3)     { c.font = font(false, '000000', 9); c.alignment = aln('left', true); }
          else                  { c.font = font(false, '374151', 9); c.alignment = aln('center'); }
        });
        ws.getRow(rn).height = 16; rn++;
      });

      ws.mergeCells(rn, 1, rn, 4);
      const stc = ws.getCell(rn, 1);
      stc.value = `  Subtotal — ${st.state_name}  (${st.rows.length} invoices)`;
      stc.font = font(true, NAVY, 9); stc.alignment = aln('right');
      stc.border = { top: thin(STEEL) };
      [[5, st.subtotal_taxable],[6, st.subtotal_vat],[7, st.subtotal_total]].forEach(([col, val]) => {
        const c = ws.getCell(rn, col);
        c.value = val; c.numFmt = '#,##0.00';
        c.font = font(true, NAVY, 9); c.alignment = aln('right');
        c.border = { top: thin(STEEL) };
      });
      ws.getRow(rn).height = 18; rn++;
    }

    ws.mergeCells(rn, 1, rn, 4);
    const ntc = ws.getCell(rn, 1);
    ntc.value = `  TOTAL — ${nation.nat_ind}`;
    ntc.font = font(true, NAVY, 10); ntc.alignment = aln('right');
    ntc.border = { top: med(STEEL), bottom: thin(STEEL) };
    [[5, nation.nat_taxable],[6, nation.nat_vat],[7, nation.nat_total]].forEach(([col, val]) => {
      const c = ws.getCell(rn, col);
      c.value = val; c.numFmt = '#,##0.00';
      c.font = font(true, NAVY, 10); c.alignment = aln('right');
      c.border = { top: med(STEEL), bottom: thin(STEEL) };
    });
    ws.getRow(rn).height = 20; rn++; rn++;
  }

  ws.mergeCells(rn, 1, rn, 4);
  const gtc = ws.getCell(rn, 1);
  gtc.value = `  GRAND TOTAL  (${report.count} Invoices)`;
  gtc.font = font(true, NAVY, 12); gtc.alignment = aln('right');
  gtc.border = { top: med(NAVY), bottom: dbl(NAVY) };
  [[5, report.grand_taxable],[6, report.grand_vat],[7, report.grand_total]].forEach(([col, val]) => {
    const c = ws.getCell(rn, col);
    c.value = val; c.numFmt = '#,##0.00';
    c.font = font(true, NAVY, 12); c.alignment = aln('right');
    c.border = { top: med(NAVY), bottom: dbl(NAVY) };
  });
  ws.getRow(rn).height = 24; rn++;

  // zero-rating note
  const exportNation = report.nations.find(n => n.nat_ind !== 'UAE');
  if (exportNation) {
    rn++;
    ws.mergeCells(rn, 1, rn, 9);
    const nt = ws.getCell(rn, 1);
    nt.value = 'Export / international sales are zero-rated: taxable value is reported, output VAT is nil.';
    nt.font = { name: 'Calibri', size: 9, italic: true, color: { argb: GREY } };
    nt.alignment = aln('left');
  }

  return wb;
}

// ─── PDF Builder ──────────────────────────────────────────────────────────────
// Uses save()/restore() + clip rect per cell so text NEVER bleeds into adjacent
// columns. Print-friendly: rules and bold text instead of filled bands; the
// column header row is the only shaded area.

function buildPdf(report, { dt1, dt2, sloc }) {
  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape',
    // bottom margin 0: page breaks are handled only by checkPage(). With a
    // non-zero bottom margin PDFKit auto-adds a page for every cell whose
    // text crosses it, producing runs of near-blank pages (one cell each).
    margins: { top: 24, bottom: 0, left: 22, right: 22 },
    autoFirstPage: true,
  });

  const PW      = doc.page.width;   // 841.89 pt landscape
  const MARGIN  = 18;
  const CW      = PW - MARGIN * 2;

  // ── colours ──────────────────────────────────────────────────────────────
  const NAVY  = '#0D1B2A', LBLUE = '#DCE7F3',
        STEEL = '#1B3A5C', GREY  = '#6B7280', RULE = '#94A3B8';

  // ── column layout (must sum to exactly 1.0) ───────────────────────────────
  // Inv No / Date / Cust Code tightened; Customer Name widened (50-char names)
  const PCT = [0.085, 0.075, 0.07, 0.33, 0.11, 0.11, 0.11, 0.055, 0.055];
  const CWS = PCT.map(p => Math.floor(p * CW));
  const rem = CW - CWS.reduce((a,b)=>a+b,0);
  CWS[3] += rem;

  const COL_HDRS = ['Invoice No.','Date','Cust Code','Customer Name',
                    'Taxable (AED)','VAT (AED)','Total (AED)','Loc','Ctry'];
  const ROW_H  = 15;
  const HEAD_H = 19;
  let y = MARGIN;

  // ── core drawing helpers ──────────────────────────────────────────────────

  const fillR = (x, ry, w, h, col) => doc.save().rect(x, ry, w, h).fill(col).restore();

  const rule = (ry, col = RULE, w = 0.8) =>
    doc.save().moveTo(MARGIN, ry).lineTo(MARGIN + CW, ry).lineWidth(w).stroke(col).restore();

  const cell = (text, cx, cy, cw, ch,
                { align='left', color='#111', fontSize=7, bold=false, padH=3, wrap=false } = {}) => {
    if (text === null || text === undefined || text === '') return;
    const str = String(text);
    doc.save();
    doc.rect(cx + 0.5, cy + 0.5, cw - 1, ch - 1).clip();
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(fontSize)
       .fillColor(color);
    const w = cw - padH * 2;
    // wrapped text is centred on its measured height; single-line on font size
    const textH = wrap ? doc.heightOfString(str, { width: w }) : fontSize;
    const vertY = cy + (ch - textH) / 2;
    doc.text(str, cx + padH, vertY, {
      lineBreak: wrap,
      width: w,
      align,
    });
    doc.restore();
  };

  /** Draw a full-width row of 9 cells (no background fill) */
  const drawDataRow = (vals, ry, opts, rh = ROW_H) => {
    let cx = MARGIN;
    vals.forEach((v, i) => {
      doc.save().rect(cx, ry, CWS[i], rh).stroke('#D8DCE4').restore();
      cell(v, cx, ry, CWS[i], rh, opts[i]);
      cx += CWS[i];
    });
  };

  /** Column-header row (repeated on each page) — the only shaded band */
  const drawColHeaders = () => {
    let cx = MARGIN;
    fillR(MARGIN, y, CW, HEAD_H, LBLUE);
    COL_HDRS.forEach((h, i) => {
      doc.save().rect(cx, y, CWS[i], HEAD_H).stroke(STEEL).restore();
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

  // ── page header : plain text, no filled bands ─────────────────────────────
  cell('AL HAYAT ELECT. SWITCHGEAR IND. LLC.', MARGIN, y, CW, 20,
    { align:'center', color:NAVY, fontSize:12, bold:true }); y += 20;

  cell('SHARJAH, U.A.E.', MARGIN, y, CW, 12,
    { align:'center', color:GREY, fontSize:8.5 }); y += 12;

  cell(`SALES REGISTER — UAE VAT SUBMISSION  |  Period: ${dt1} to ${dt2}  |  Location: ${sloc || 'ALL LOCATIONS'}  |  Printed: ${new Date().toLocaleDateString('en-AE')}`,
    MARGIN, y, CW, 12, { align:'center', color:STEEL, fontSize:7 }); y += 13;

  rule(y, STEEL, 1); y += 5;

  drawColHeaders();

  // ── data ──────────────────────────────────────────────────────────────────
  for (const nation of report.nations) {
    checkPage(HEAD_H);
    cell(`  ${natLabelOf(nation)}`, MARGIN, y, CW, HEAD_H,
      { color: NAVY, fontSize: 9, bold: true });
    rule(y + HEAD_H - 1, STEEL, 0.8);
    y += HEAD_H;

    for (const st of nation.states) {
      checkPage(HEAD_H);
      const stLabel = st.state_name !== st.state
        ? `${st.state_name}  (${st.state})` : st.state_name;
      cell(`    ${stLabel}`, MARGIN, y, CW, HEAD_H - 3,
        { color: STEEL, fontSize: 8, bold: true });
      y += HEAD_H - 3;

      // invoice rows
      st.rows.forEach(r => {
        // row grows to fit a wrapped customer name; break BEFORE drawing it
        doc.font('Helvetica').fontSize(7);
        const nameH = doc.heightOfString(String(r.cust_name || ''), { width: CWS[3] - 6 });
        const rowH  = Math.max(ROW_H, Math.ceil(nameH) + 6);
        checkPage(rowH);
        drawDataRow(
          [r.inv_no, r.inv_date, r.cust_code, r.cust_name,
           fmtNum(r.taxable), fmtNum(r.vat), fmtNum(r.total),
           r.sloc || '', r.nation_code],
          y,
          [
            { align:'center', color:'#1B3A5C', fontSize:7, bold:true, padH:1.5 },
            { align:'center', color:'#374151', fontSize:7, padH:1.5 },
            { align:'center', color:'#374151', fontSize:7, padH:1.5 },
            { align:'left',   color:'#111',    fontSize:7, wrap:true },
            { align:'right',  color:STEEL,     fontSize:7 },
            { align:'right',  color:'#9A6F00', fontSize:7 },
            { align:'right',  color:STEEL,     fontSize:7, bold:true },
            { align:'center', color:GREY,      fontSize:7 },
            { align:'center', color:GREY,      fontSize:7 },
          ],
          rowH
        );
        y += rowH;
      });

      // state subtotal
      checkPage(HEAD_H);
      const SPAN = CWS[0]+CWS[1]+CWS[2]+CWS[3];
      rule(y, STEEL, 0.8);
      cell(`Subtotal — ${st.state_name}  (${st.rows.length} invoices)`,
        MARGIN, y, SPAN, HEAD_H - 3, { align:'right', color:NAVY, fontSize:7.5, bold:true });
      let cx = MARGIN + SPAN;
      [st.subtotal_taxable, st.subtotal_vat, st.subtotal_total].forEach((v, i) => {
        cell(fmtNum(v), cx, y, CWS[4+i], HEAD_H-3,
          { align:'right', color:NAVY, fontSize:7.5, bold:true, padH:2 });
        cx += CWS[4+i];
      });
      rule(y + HEAD_H - 3, STEEL, 1);
      y += HEAD_H - 3;
    }

    // nation total
    checkPage(HEAD_H);
    const SPAN = CWS[0]+CWS[1]+CWS[2]+CWS[3];
    rule(y, STEEL, 1);
    cell(`  TOTAL — ${nation.nat_ind}`, MARGIN, y, SPAN, HEAD_H,
      { align:'right', color:NAVY, fontSize:9, bold:true });
    let cx = MARGIN + SPAN;
    [nation.nat_taxable, nation.nat_vat, nation.nat_total].forEach((v, i) => {
      cell(fmtNum(v), cx, y, CWS[4+i], HEAD_H,
        { align:'right', color:NAVY, fontSize:9, bold:true, padH:2 });
      cx += CWS[4+i];
    });
    rule(y + HEAD_H, STEEL, 1);
    y += HEAD_H + 5;
  }

  // grand total
  checkPage(HEAD_H + 14);
  rule(y, NAVY, 1.4); y += 2.5;
  const SPAN = CWS[0]+CWS[1]+CWS[2]+CWS[3];
  cell(`  GRAND TOTAL  (${report.count} Invoices)`, MARGIN, y, SPAN, HEAD_H + 6,
    { align:'right', color:NAVY, fontSize:11, bold:true });
  let cx = MARGIN + SPAN;
  [report.grand_taxable, report.grand_vat, report.grand_total].forEach((v, i) => {
    cell(fmtNum(v), cx, y, CWS[4+i], HEAD_H + 6,
      { align:'right', color:NAVY, fontSize:11, bold:true, padH:2 });
    cx += CWS[4+i];
  });
  y += HEAD_H + 6;
  rule(y, NAVY, 1.4); y += 1.6;
  rule(y, NAVY, 0.7); y += 8;

  if (report.nations.some(n => n.nat_ind !== 'UAE')) {
    cell('Export / international sales are zero-rated: taxable value is reported, output VAT is nil.',
      MARGIN, y, CW, 10, { align:'left', color:GREY, fontSize:6.5 });
  }

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
