// routes/salaryRegister.js
// Salary Register (Summary / Detailed) from time_sheet_hdr + tsht_allow + tsht_ded + payroll_mst
//   GET /api/salary-register/categories
//   GET /api/salary-register?from=YYYY-MM-DD&to=YYYY-MM-DD&catg=ALL|<code>&mode=S|D&draft=Y|N
//   GET /api/salary-register/breakup?...same params...&type=A|D[&tshtNo=..|&empCode=..|&scatg=..]
//   GET /api/salary-register/annexure?...same params...
//   GET /api/salary-register/excel?...same params...[&annex=Y]
//
// Register in HayatDb.js:
//   const salaryRegister = require("./routes/salaryRegister");
//   app.use("/api", salaryRegister(connection));

const express = require("express");
const ExcelJS = require("exceljs");

// ---- Column names: adjust here only if your masters differ ----
const EMP = { table: "emp_mst", code: "EMP_CODE", name: "EMP_NAME", catg: "EMP_CATG" };
const CATG = { table: "emp_catg_mst", code: "CATG_CODE", name: "CATG_NAME" };
const BRK = {
  A: { table: "tsht_allow", code: "ALLOW_CODE", mst: "allow_mst", mstCode: "ALLOW_CODE", mstName: "ALLOW_DESC",
       title: "Allowances", letter: "A", regCol: "Add Allow.", regKey: "allow" },
  D: { table: "tsht_ded", code: "DED_CODE", mst: "ded_mst", mstCode: "DED_CODE", mstName: "DED_DESC",
       title: "Deductions", letter: "B", regCol: "Less Deduct.", regKey: "ded" },
};

// time_sheet_hdr.STATUS decode (D = Draft is the table default)
const STATUS_TEXT = { D: "Draft", T: "Time Approved", A: "Job Approved" };

// 'HHH:MM' varchar -> minutes (summable)
const toMin = (col) =>
  `(CAST(SUBSTRING_INDEX(IFNULL(NULLIF(h.${col},''),'0:00'),':',1) AS SIGNED)*60 + ` +
  `CAST(SUBSTRING_INDEX(IFNULL(NULLIF(h.${col},''),'0:00'),':',-1) AS SIGNED))`;

const fmtHm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const fmtAmt = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------
function getParams(q) {
  const from = String(q.from || "");
  const to = String(q.to || "");
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from) || !re.test(to)) throw new Error("Invalid date range");
  if (from > to) throw new Error("From date is after To date");
  return {
    from,
    to,
    catg: q.catg && q.catg !== "ALL" ? String(q.catg) : "ALL",
    mode: q.mode === "D" ? "D" : "S",
    draft: q.draft === "Y" ? "Y" : "N",
    annex: q.annex === "Y" ? "Y" : "N",
  };
}

async function fetchRows(db, p) {
  // Time sheets are dated the 1st of the month, so the range is widened to whole months.
  const RANGE = `TSHT_DATE >= DATE_FORMAT(?, '%Y-%m-01') AND TSHT_DATE <= LAST_DAY(?)`;
  const sql = `
    SELECT h.TSHT_NO,
           DATE_FORMAT(h.TSHT_DATE,'%m/%Y')       AS MON,
           h.EMP_CODE,
           e.${EMP.name}                          AS EMP_NAME,
           e.${EMP.catg}                          AS CATG,
           c.${CATG.name}                         AS CATG_NAME,
           h.STATUS,
           IFNULL(pm.BASIC_SAL,0)                 AS BASIC_SAL,
           ${toMin("TOT_NORMAL_HRS")}             AS N_MIN,
           ${toMin("TOT_NOT_HRS")}                AS O_MIN,
           ${toMin("TOT_HOT_HRS")}                AS H_MIN,
           h.NORMAL_WAGES, h.NOT_WAGES, h.HOT_WAGES,
           IFNULL(a.AMT,0)                        AS ALLOW_AMT,
           IFNULL(d.AMT,0)                        AS DED_AMT,
           h.TOTAL_SALARY
      FROM time_sheet_hdr h
      JOIN ${EMP.table} e       ON e.${EMP.code} = h.EMP_CODE
      LEFT JOIN ${CATG.table} c ON c.${CATG.code} = e.${EMP.catg}
      LEFT JOIN payroll_mst pm  ON pm.EMP_CODE = h.EMP_CODE
      LEFT JOIN (SELECT TSHT_NO, SUM(AMOUNT) AS AMT FROM tsht_allow
                  WHERE ${RANGE} GROUP BY TSHT_NO) a ON a.TSHT_NO = h.TSHT_NO
      LEFT JOIN (SELECT TSHT_NO, SUM(AMOUNT) AS AMT FROM tsht_ded
                  WHERE ${RANGE} GROUP BY TSHT_NO) d ON d.TSHT_NO = h.TSHT_NO
     WHERE h.${RANGE}
       AND (? = 'ALL' OR e.${EMP.catg} = ?)
       AND (? = 'Y' OR h.STATUS <> 'D')
     ORDER BY e.${EMP.catg}, h.EMP_CODE, h.TSHT_DATE`;
  const [rows] = await db.query(sql, [
    p.from, p.to,          // tsht_allow
    p.from, p.to,          // tsht_ded
    p.from, p.to,          // time_sheet_hdr
    p.catg, p.catg, p.draft,
  ]);
  return rows;
}

async function headerInfo(db, p) {
  let company = "";
  let catgLabel = "All Categories";
  try {
    const [c] = await db.query("SELECT NAME FROM company LIMIT 1");
    company = c[0]?.NAME || "";
  } catch (_) { /* ignore */ }
  if (p.catg !== "ALL") {
    const [r] = await db.query(
      `SELECT ${CATG.name} AS N FROM ${CATG.table} WHERE ${CATG.code} = ?`, [p.catg]);
    catgLabel = `${p.catg} - ${r[0]?.N || ""}`;
  }
  return { company, catgLabel };
}

// ---- Build flat report rows (shared by screen, PDF and Excel) ----
const emptyTot = () => ({
  cnt: 0, nMin: 0, oMin: 0, hMin: 0, nW: 0, oW: 0, hW: 0, gross: 0, allow: 0, ded: 0, tot: 0,
});

function add(t, r) {
  t.cnt += 1;
  t.nMin += Number(r.N_MIN) || 0;
  t.oMin += Number(r.O_MIN) || 0;
  t.hMin += Number(r.H_MIN) || 0;
  t.nW = r2(t.nW + Number(r.NORMAL_WAGES));
  t.oW = r2(t.oW + Number(r.NOT_WAGES));
  t.hW = r2(t.hW + Number(r.HOT_WAGES));
  t.gross = r2(t.gross + Number(r.NORMAL_WAGES) + Number(r.NOT_WAGES) + Number(r.HOT_WAGES));
  t.allow = r2(t.allow + Number(r.ALLOW_AMT));
  t.ded = r2(t.ded + Number(r.DED_AMT));
  t.tot = r2(t.tot + Number(r.TOTAL_SALARY));
}

const totLine = (rowType, label, t, extra = {}) => ({
  rowType, label, sheets: t.cnt, basic: null,
  nHrs: fmtHm(t.nMin), nWages: t.nW,
  oHrs: fmtHm(t.oMin), oWages: t.oW,
  hHrs: fmtHm(t.hMin), hWages: t.hW,
  gross: t.gross, allow: t.allow, ded: t.ded, total: t.tot,
  ...extra,
});

function buildReport(rows, mode) {
  const out = [];
  const grand = emptyTot();
  let i = 0;
  while (i < rows.length) {
    const catg = rows[i].CATG;
    const catgTot = emptyTot();
    out.push({ rowType: "GROUP", catg, label: `${catg || "--"}  ${rows[i].CATG_NAME || ""}`.trim() });

    while (i < rows.length && rows[i].CATG === catg) {
      const emp = rows[i].EMP_CODE;
      const name = rows[i].EMP_NAME;
      const basic = r2(rows[i].BASIC_SAL);
      const empTot = emptyTot();
      let lines = 0;

      while (i < rows.length && rows[i].CATG === catg && rows[i].EMP_CODE === emp) {
        const r = rows[i];
        add(empTot, r); add(catgTot, r); add(grand, r);
        if (mode === "D") {
          const t = emptyTot(); add(t, r);
          out.push(totLine("DATA", "", t, {
            catg, empCode: emp, empName: name, month: r.MON, tshtNo: r.TSHT_NO,
            status: STATUS_TEXT[r.STATUS] || r.STATUS, basic,
          }));
          lines++;
        }
        i++;
      }
      if (mode === "S") out.push(totLine("DATA", "", empTot, { catg, empCode: emp, empName: name, basic }));
      else if (lines > 1) {
        out.push(totLine("SUBTOTAL", `Total: ${emp}  ${name}`, empTot, { catg, empCode: emp, empName: name }));
      }
    }
    out.push(totLine("CATTOTAL", "Category Total:", catgTot, { catg }));
  }
  if (rows.length) out.push(totLine("GRAND", "Grand Total", grand));
  return out;
}

// ---- Allowance / deduction breakup lines ----
async function fetchBreakup(db, p, type, scope = {}) {
  const b = BRK[type];
  let where = `h.TSHT_DATE >= DATE_FORMAT(?, '%Y-%m-01') AND h.TSHT_DATE <= LAST_DAY(?)
     AND (? = 'ALL' OR e.${EMP.catg} = ?)
     AND (? = 'Y' OR h.STATUS <> 'D')
     AND x.AMOUNT <> 0`;
  const args = [p.from, p.to, p.catg, p.catg, p.draft];
  if (scope.tshtNo) { where += " AND h.TSHT_NO = ?"; args.push(scope.tshtNo); }
  if (scope.empCode) { where += " AND h.EMP_CODE = ?"; args.push(scope.empCode); }
  if (scope.catg) { where += ` AND e.${EMP.catg} = ?`; args.push(scope.catg); }

  const sql = `
    SELECT x.${b.code} AS CODE, m.${b.mstName} AS CNAME,
           h.EMP_CODE, e.${EMP.name} AS EMP_NAME,
           e.${EMP.catg} AS CATG, c.${CATG.name} AS CATG_NAME,
           DATE_FORMAT(h.TSHT_DATE,'%m/%Y') AS MON, h.TSHT_NO,
           x.AMOUNT, x.REMARKS
      FROM ${b.table} x
      JOIN time_sheet_hdr h     ON h.TSHT_NO = x.TSHT_NO
      JOIN ${EMP.table} e       ON e.${EMP.code} = h.EMP_CODE
      LEFT JOIN ${CATG.table} c ON c.${CATG.code} = e.${EMP.catg}
      LEFT JOIN ${b.mst} m      ON m.${b.mstCode} = x.${b.code}
     WHERE ${where}
     ORDER BY x.${b.code}, e.${EMP.catg}, h.EMP_CODE, h.TSHT_DATE`;
  const [rows] = await db.query(sql, args);
  return rows.map((r) => ({
    code: r.CODE, name: r.CNAME || "", empCode: r.EMP_CODE, empName: r.EMP_NAME,
    catg: r.CATG, catgName: r.CATG_NAME || "", month: r.MON, tshtNo: r.TSHT_NO,
    amount: r2(r.AMOUNT), remarks: r.REMARKS || "",
  }));
}

// Annexure: listed by code (narrow), plus code x category summary and a check against the register
function buildAnnex(lines, type, registerTotal) {
  const b = BRK[type];
  const rows = [];
  const cats = [];
  const summary = [];
  let total = 0;
  let i = 0;
  while (i < lines.length) {
    const code = lines[i].code;
    const name = lines[i].name;
    const sm = { code, name, byCat: {}, total: 0 };
    let ct = 0;
    rows.push({ rowType: "CODEHDR", label: `${code}  ${name}`.trim() });
    while (i < lines.length && lines[i].code === code) {
      const l = lines[i];
      rows.push({ rowType: "LINE", ...l });
      ct = r2(ct + l.amount);
      if (!cats.find((c) => c.code === l.catg)) cats.push({ code: l.catg, name: l.catgName });
      sm.byCat[l.catg] = r2((sm.byCat[l.catg] || 0) + l.amount);
      i++;
    }
    sm.total = ct;
    summary.push(sm);
    rows.push({ rowType: "CODETOT", label: "Code Total", amount: ct });
    total = r2(total + ct);
  }
  rows.push({ rowType: "TOTAL", label: `Total ${b.title}`, amount: total });
  cats.sort((x, y) => String(x.code).localeCompare(String(y.code)));
  const catTotals = {};
  cats.forEach((c) => { catTotals[c.code] = r2(summary.reduce((a, s) => a + (s.byCat[c.code] || 0), 0)); });
  return {
    type, title: b.title, letter: b.letter, regCol: b.regCol,
    rows, cats, summary, catTotals, total,
    registerTotal: r2(registerTotal), diff: r2(total - r2(registerTotal)),
  };
}

// Employee-wise annexure: per employee, allowance and deduction lines side by side
function buildEmpAnnex(allowLines, dedLines, regAllow, regDed) {
  const all = [
    ...allowLines.map((l) => ({ ...l, t: "A" })),
    ...dedLines.map((l) => ({ ...l, t: "D" })),
  ].sort((a, b) =>
    String(a.catg || "").localeCompare(String(b.catg || "")) ||
    String(a.empCode).localeCompare(String(b.empCode)) ||
    String(a.tshtNo).localeCompare(String(b.tshtNo)) ||        // yyyy-mm-... = month order
    a.t.localeCompare(b.t) ||                                  // allowances before deductions
    String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));

  const rows = [];
  let gA = 0, gD = 0, i = 0;
  while (i < all.length) {
    const emp = all[i].empCode;
    const name = all[i].empName;
    let eA = 0, eD = 0;
    rows.push({ rowType: "EMPHDR", label: `${emp}  ${name}`, empCode: emp, catg: all[i].catg });
    while (i < all.length && all[i].empCode === emp) {
      const l = all[i];
      rows.push({
        rowType: "LINE", month: l.month, tshtNo: l.tshtNo, code: l.code, name: l.name,
        allow: l.t === "A" ? l.amount : null, ded: l.t === "D" ? l.amount : null, remarks: l.remarks,
      });
      if (l.t === "A") eA = r2(eA + l.amount); else eD = r2(eD + l.amount);
      i++;
    }
    rows.push({ rowType: "EMPTOT", label: `Total: ${emp}`, allow: eA, ded: eD, net: r2(eA - eD) });
    gA = r2(gA + eA); gD = r2(gD + eD);
  }
  rows.push({ rowType: "TOTAL", label: "Grand Total", allow: gA, ded: gD, net: r2(gA - gD) });
  return {
    title: "Employee-wise Allowances & Deductions", letter: "C", rows,
    totalAllow: gA, totalDed: gD,
    regAllow: r2(regAllow), regDed: r2(regDed),
    diffAllow: r2(gA - r2(regAllow)), diffDed: r2(gD - r2(regDed)),
  };
}

async function annexData(db, p, report) {
  const grand = report.find((r) => r.rowType === "GRAND") || {};
  const [al, dl] = await Promise.all([fetchBreakup(db, p, "A"), fetchBreakup(db, p, "D")]);
  return {
    allow: buildAnnex(al, "A", grand.allow || 0),
    ded: buildAnnex(dl, "D", grand.ded || 0),
    emp: buildEmpAnnex(al, dl, grand.allow || 0, grand.ded || 0),
  };
}

// ---- Column layout (same order as the screen) ----
function columnsFor(mode) {
  const left = mode === "D"
    ? [
        { h: "Emp Code", k: "empCode", w: 10 },
        { h: "Employee Name", k: "empName", w: 26 },
        { h: "Month", k: "month", w: 9 },
        { h: "T/S No", k: "tshtNo", w: 15 },
        { h: "Status", k: "status", w: 14 },
      ]
    : [
        { h: "Emp Code", k: "empCode", w: 10 },
        { h: "Employee Name", k: "empName", w: 28 },
        { h: "Sheets", k: "sheets", w: 7, num: "0" },
      ];
  const right = [
    { h: "Basic Salary", k: "basic", w: 11, num: "#,##0.00" },
    { h: "Normal Hrs", k: "nHrs", w: 9, hrs: true },
    { h: "Normal Wages", k: "nWages", w: 12, num: "#,##0.00" },
    { h: "N.OT Hrs", k: "oHrs", w: 8, hrs: true },
    { h: "N.OT Wages", k: "oWages", w: 11, num: "#,##0.00" },
    { h: "H.OT Hrs", k: "hHrs", w: 8, hrs: true },
    { h: "H.OT Wages", k: "hWages", w: 11, num: "#,##0.00" },
    { h: "Gross Salary", k: "gross", w: 12, num: "#,##0.00" },
    { h: "Add Allow.", k: "allow", w: 11, num: "#,##0.00" },
    { h: "Less Deduct.", k: "ded", w: 11, num: "#,##0.00" },
    { h: "Total Salary", k: "total", w: 13, num: "#,##0.00" },
  ];
  return { left, cols: [...left, ...right] };
}

// ---- Excel helpers ----
const THIN = { style: "thin", color: { argb: "FF7F8896" } };
const HDR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8ECF2" } };

function titleLines(ws, company, title, sub) {
  ws.addRow([company]).font = { bold: true, size: 14 };
  ws.addRow([title]).font = { bold: true, size: 12 };
  ws.addRow([sub]);
  ws.addRow([]);
}

function headerRow(ws, heads) {
  const hdr = ws.addRow(heads);
  hdr.height = 32;
  hdr.eachCell((c) => {
    c.font = { bold: true };
    c.fill = HDR_FILL;
    c.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  return hdr;
}

// vertical lines on all columns; optional top/bottom; label spans first `span` columns without inner lines
function lineBorders(row, nCols, kind, span = 0) {
  for (let ci = 1; ci <= nCols; ci++) {
    const b = { left: THIN, right: THIN };
    if (kind === "tot") { b.top = THIN; b.bottom = THIN; }
    if (kind === "grand") { b.top = THIN; b.bottom = { style: "double" }; }
    if (span > 1 && ci <= span) {
      if (ci > 1) delete b.left;
      if (ci < span) delete b.right;
    }
    row.getCell(ci).border = b;
  }
}

// ---- Excel: register sheet ----
function addRegisterSheet(wb, report, p, company, catgLabel) {
  const ws = wb.addWorksheet("Salary Register", {
    pageSetup: {
      orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printTitlesRow: "5:5",
    },
  });
  const { left, cols } = columnsFor(p.mode);
  const nCols = cols.length;
  ws.columns = cols.map((c) => ({ width: c.w }));

  titleLines(ws, company, `Salary Register - ${p.mode === "D" ? "Detailed" : "Summary"}`,
    `Period: ${dmy(p.from)} to ${dmy(p.to)}     Category: ${catgLabel}` +
      (p.draft === "Y" ? "     (incl. Draft time sheets)" : ""));
  headerRow(ws, cols.map((c) => c.h));
  ws.views = [{ state: "frozen", ySplit: 5 }];

  for (const r of report) {
    let vals;
    if (r.rowType === "GROUP") vals = [r.label];
    else if (r.rowType === "DATA") vals = cols.map((c) => (r[c.k] ?? null));
    else {
      vals = cols.map((c, idx) =>
        idx === 0 ? r.label : idx < left.length ? (c.k === "sheets" ? r.sheets : null) : (r[c.k] ?? null));
    }
    while (vals.length < nCols) vals.push(null);
    const row = ws.addRow(vals);

    cols.forEach((def, idx) => {
      const cell = row.getCell(idx + 1);
      if (def.num) cell.numFmt = def.num;
      if (def.hrs || def.num) cell.alignment = { horizontal: "right" };
    });
    const span = r.rowType === "DATA" ? 0 : r.rowType === "GROUP" ? left.length : (p.mode === "D" ? left.length : 2);
    const kind = r.rowType === "GRAND" ? "grand" : (r.rowType === "CATTOTAL" || r.rowType === "SUBTOTAL") ? "tot" : "";
    lineBorders(row, nCols, kind, span);

    if (r.rowType === "GROUP") row.font = { bold: true, color: { argb: "FF1F3C88" } };
    else if (r.rowType !== "DATA") row.font = { bold: true };
  }
}

// ---- Excel: annexure sheet (Allowances / Deductions) ----
function addAnnexSheet(wb, ax, p, company, catgLabel) {
  const ws = wb.addWorksheet(ax.title, {
    pageSetup: { orientation: "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "5:5" },
  });
  const heads = ["Emp Code", "Employee Name", "Month", "T/S No", "Amount", "Remarks"];
  const nCols = heads.length;
  ws.columns = [{ width: 10 }, { width: 30 }, { width: 9 }, { width: 15 }, { width: 13 }, { width: 30 }];

  titleLines(ws, company, `Annexure ${ax.letter} - ${ax.title}`,
    `Period: ${dmy(p.from)} to ${dmy(p.to)}     Category: ${catgLabel}`);
  headerRow(ws, heads);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  for (const r of ax.rows) {
    let row;
    if (r.rowType === "CODEHDR") {
      row = ws.addRow([r.label]);
      row.font = { bold: true, color: { argb: "FF1F3C88" } };
      lineBorders(row, nCols, "", 4);
    } else if (r.rowType === "LINE") {
      row = ws.addRow([r.empCode, r.empName, r.month, r.tshtNo, r.amount, r.remarks || null]);
      lineBorders(row, nCols, "");
    } else {
      row = ws.addRow([r.label, null, null, null, r.amount, null]);
      row.font = { bold: true };
      lineBorders(row, nCols, r.rowType === "TOTAL" ? "grand" : "tot", 4);
    }
    row.getCell(5).numFmt = "#,##0.00";
  }

  // check against the register column
  ws.addRow([]);
  const chk = ws.addRow([
    `Register ${ax.regCol} total: ${fmtAmt(ax.registerTotal)}     ` +
      (ax.diff === 0 ? "Tallied" : `Difference: ${fmtAmt(ax.diff)}`),
  ]);
  chk.font = { bold: true, color: { argb: ax.diff === 0 ? "FF1F3C88" : "FFC62828" } };

  // code x category summary
  if (ax.summary.length) {
    ws.addRow([]);
    ws.addRow([`Code Summary - ${ax.title}`]).font = { bold: true };
    const sHeads = ["Code", "Description", ...ax.cats.map((c) => `${c.code || "--"} ${c.name || ""}`.trim()), "Total"];
    const sN = sHeads.length;
    // widen extra columns if categories exceed the detail layout
    for (let ci = 7; ci <= sN; ci++) ws.getColumn(ci).width = 13;
    headerRow(ws, sHeads);
    for (const s of ax.summary) {
      const row = ws.addRow([s.code, s.name, ...ax.cats.map((c) => s.byCat[c.code] || null), s.total]);
      for (let ci = 3; ci <= sN; ci++) row.getCell(ci).numFmt = "#,##0.00";
      lineBorders(row, sN, "");
    }
    const tot = ws.addRow(["Total", null, ...ax.cats.map((c) => ax.catTotals[c.code]), ax.total]);
    tot.font = { bold: true };
    for (let ci = 3; ci <= sN; ci++) tot.getCell(ci).numFmt = "#,##0.00";
    lineBorders(tot, sN, "grand", 2);
  }
}

// ---- Excel: employee-wise annexure ----
function addEmpAnnexSheet(wb, ax, p, company, catgLabel) {
  const ws = wb.addWorksheet("Employee-wise", {
    pageSetup: { orientation: "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "5:5" },
  });
  const heads = ["Month", "T/S No", "Code", "Description", "Add Allow.", "Less Deduct.", "Net", "Remarks"];
  const nCols = heads.length;
  ws.columns = [{ width: 9 }, { width: 15 }, { width: 7 }, { width: 28 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 26 }];

  titleLines(ws, company, `Annexure ${ax.letter} - ${ax.title}`,
    `Period: ${dmy(p.from)} to ${dmy(p.to)}     Category: ${catgLabel}`);
  headerRow(ws, heads);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  for (const r of ax.rows) {
    let row;
    if (r.rowType === "EMPHDR") {
      row = ws.addRow([r.label]);
      row.font = { bold: true, color: { argb: "FF1F3C88" } };
      lineBorders(row, nCols, "", 4);
    } else if (r.rowType === "LINE") {
      row = ws.addRow([r.month, r.tshtNo, r.code, r.name, r.allow, r.ded, null, r.remarks || null]);
      lineBorders(row, nCols, "");
    } else {
      row = ws.addRow([r.label, null, null, null, r.allow, r.ded, r.net, null]);
      row.font = { bold: true };
      lineBorders(row, nCols, r.rowType === "TOTAL" ? "grand" : "tot", 4);
    }
    for (let ci = 5; ci <= 7; ci++) row.getCell(ci).numFmt = "#,##0.00";
  }

  ws.addRow([]);
  const ok = ax.diffAllow === 0 && ax.diffDed === 0;
  const chk = ws.addRow([
    `Register Add Allow. ${fmtAmt(ax.regAllow)}  /  Less Deduct. ${fmtAmt(ax.regDed)}     ` +
      (ok ? "Tallied" : `Difference: Allow ${fmtAmt(ax.diffAllow)}  Ded ${fmtAmt(ax.diffDed)}`),
  ]);
  chk.font = { bold: true, color: { argb: ok ? "FF1F3C88" : "FFC62828" } };
}

// ---------------------------------------------------------------
module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get("/salary-register/categories", async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ${CATG.code} AS CATG_CODE, ${CATG.name} AS CATG_NAME
           FROM ${CATG.table} ORDER BY ${CATG.code}`);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/salary-register", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const rows = await fetchRows(db, p);
      const { company, catgLabel } = await headerInfo(db, p);
      res.json({ rows: buildReport(rows, p.mode), company, catgLabel, params: p });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // drill-down popup: one time sheet / one employee / one category / all
  router.get("/salary-register/breakup", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    const type = req.query.type === "D" ? "D" : "A";
    const scope = {
      tshtNo: req.query.tshtNo ? String(req.query.tshtNo) : undefined,
      empCode: req.query.empCode ? String(req.query.empCode) : undefined,
      catg: req.query.scatg ? String(req.query.scatg) : undefined,
    };
    try {
      res.json({ type, title: BRK[type].title, lines: await fetchBreakup(db, p, type, scope) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // annexure data for the client-side PDF
  router.get("/salary-register/annexure", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const report = buildReport(await fetchRows(db, p), p.mode);
      res.json(await annexData(db, p, report));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/salary-register/excel", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const report = buildReport(await fetchRows(db, p), p.mode);
      const { company, catgLabel } = await headerInfo(db, p);

      const wb = new ExcelJS.Workbook();
      addRegisterSheet(wb, report, p, company, catgLabel);
      if (p.annex === "Y") {
        const ax = await annexData(db, p, report);
        addAnnexSheet(wb, ax.allow, p, company, catgLabel);
        addAnnexSheet(wb, ax.ded, p, company, catgLabel);
        addEmpAnnexSheet(wb, ax.emp, p, company, catgLabel);
      }

      const fname = `SalaryRegister_${p.mode === "D" ? "Detailed" : "Summary"}_${p.from}_${p.to}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  return router;
};
