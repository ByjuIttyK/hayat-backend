// routes/otRegister.js
// Overtime Register (monthly) from time_sheet_hdr / time_sheet_dtl + payroll_mst
//   GET /api/ot-register/categories
//   GET /api/ot-register?month=YYYY-MM&catg=ALL|<code>&draft=Y|N
//   GET /api/ot-register/excel?...same...&daywise=Y|N
//
// Register in HayatDb.js:
//   const otRegister = require("./routes/otRegister");
//   app.use("/api", otRegister(connection));

const express = require("express");
const ExcelJS = require("exceljs");

// ---- Names and rules: adjust here only ----
const EMP = { table: "emp_mst", code: "EMP_CODE", name: "EMP_NAME", catg: "EMP_CATG" };
const CATG = { table: "emp_catg_mst", code: "CATG_CODE", name: "CATG_NAME" };
const HOL = { table: "holiday_mst", date: "HOL_DATE", desc: "HOL_DESC" };
const RULES = {
  weeklyOff: [5],      // JS getDay(): 5 = Friday
  notFactor: 1.25,     // normal OT
  hotFactor: 1.5,      // holiday / off-day OT
  dailyOtLimit: 120,   // minutes of N.OT on a working day above which the cell is flagged
};

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fmtHm = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : "");
const fmtAmt = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// 'HHH:MM' varchar -> minutes
const toMin = (col) =>
  `(CAST(SUBSTRING_INDEX(IFNULL(NULLIF(h.${col},''),'0:00'),':',1) AS SIGNED)*60 + ` +
  `CAST(SUBSTRING_INDEX(IFNULL(NULLIF(h.${col},''),'0:00'),':',-1) AS SIGNED))`;

// ---------------------------------------------------------------
function getParams(q) {
  const month = String(q.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid month");
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) throw new Error("Invalid month");
  return {
    month, y, m,
    first: `${month}-01`,
    nDays: new Date(y, m, 0).getDate(),
    catg: q.catg && q.catg !== "ALL" ? String(q.catg) : "ALL",
    draft: q.draft === "Y" ? "Y" : "N",
    daywise: q.daywise === "N" ? "N" : "Y",
  };
}

async function headerInfo(db, p) {
  let company = "";
  let catgLabel = "All Categories";
  try {
    const [c] = await db.query("SELECT NAME FROM company LIMIT 1");
    company = c[0]?.NAME || "";
  } catch (_) { /* ignore */ }
  if (p.catg !== "ALL") {
    const [r] = await db.query(`SELECT ${CATG.name} AS N FROM ${CATG.table} WHERE ${CATG.code} = ?`, [p.catg]);
    catgLabel = `${p.catg} - ${r[0]?.N || ""}`;
  }
  return { company, catgLabel };
}

async function fetchHolidays(db, p) {
  try {
    const [rows] = await db.query(
      `SELECT DAY(${HOL.date}) AS D, ${HOL.desc} AS N FROM ${HOL.table}
        WHERE ${HOL.date} >= ? AND ${HOL.date} <= LAST_DAY(?)`, [p.first, p.first]);
    const map = {};
    rows.forEach((r) => (map[r.D] = r.N || "Holiday"));
    return map;
  } catch (e) {
    console.error("ot-register holidays:", e.message);
    return {};
  }
}

// ---------------------------------------------------------------
const emptyTot = () => ({ nMin: 0, hMin: 0, nAmt: 0, hAmt: 0 });
function addTot(t, s) {
  t.nMin += s.nMin; t.hMin += s.hMin;
  t.nAmt = r2(t.nAmt + s.nAmt); t.hAmt = r2(t.hAmt + s.hAmt);
}
const sumLine = (rowType, label, t, extra = {}) => ({
  rowType, label, ...t, tMin: t.nMin + t.hMin, tAmt: r2(t.nAmt + t.hAmt), ...extra,
});

async function buildReport(db, p) {
  const hol = await fetchHolidays(db, p);
  const days = [];
  for (let d = 1; d <= p.nDays; d++) {
    const dt = new Date(p.y, p.m - 1, d);
    days.push({ d, wd: "SMTWTFS"[dt.getDay()], off: RULES.weeklyOff.includes(dt.getDay()), hol: hol[d] || "" });
  }

  // employees with OT in the month (stored hdr totals = what was paid)
  const [hdrs] = await db.query(
    `SELECT h.TSHT_NO, h.EMP_CODE, e.${EMP.name} AS EMP_NAME,
            e.${EMP.catg} AS CATG, c.${CATG.name} AS CATG_NAME,
            IFNULL(pm.BASIC_SAL,0) AS BASIC_SAL,
            ${toMin("TOT_NOT_HRS")} AS N_MIN, ${toMin("TOT_HOT_HRS")} AS H_MIN,
            IFNULL(h.NOT_WAGES,0) AS NOT_WAGES, IFNULL(h.HOT_WAGES,0) AS HOT_WAGES
       FROM time_sheet_hdr h
       JOIN ${EMP.table} e       ON e.${EMP.code} = h.EMP_CODE
       LEFT JOIN ${CATG.table} c ON c.${CATG.code} = e.${EMP.catg}
       LEFT JOIN payroll_mst pm  ON pm.EMP_CODE = h.EMP_CODE
      WHERE h.TSHT_DATE >= ? AND h.TSHT_DATE <= LAST_DAY(?)
        AND (? = 'ALL' OR e.${EMP.catg} = ?)
        AND (? = 'Y' OR h.STATUS <> 'D')
      ORDER BY e.${EMP.catg}, h.EMP_CODE`,
    [p.first, p.first, p.catg, p.catg, p.draft]);
  const ot = hdrs.filter((h) => Number(h.N_MIN) > 0 || Number(h.H_MIN) > 0 ||
    Number(h.NOT_WAGES) > 0 || Number(h.HOT_WAGES) > 0);

  // day-wise OT minutes per time sheet
  const byTs = {};
  if (ot.length) {
    const [dtl] = await db.query(
      `SELECT d.TSHT_NO, DAY(d.ATT_DATE) AS D,
              SUM(IFNULL(d.NORMAL_OT,0)) AS O, SUM(IFNULL(d.HOLIDAY_OT,0)) AS H
         FROM time_sheet_dtl d
        WHERE d.TSHT_NO IN (?)
        GROUP BY d.TSHT_NO, DAY(d.ATT_DATE)`,
      [ot.map((h) => h.TSHT_NO)]);
    dtl.forEach((r) => ((byTs[r.TSHT_NO] ||= {})[r.D] = { o: Number(r.O) || 0, h: Number(r.H) || 0 }));
  }

  const summary = [];
  const daywise = [];
  const grand = emptyTot();
  const gDay = { n: days.map(() => 0), h: days.map(() => 0) };
  let i = 0;
  while (i < ot.length) {
    const catg = ot[i].CATG;
    const ct = emptyTot();
    const cDay = { n: days.map(() => 0), h: days.map(() => 0) };
    const label = `${catg || "--"}  ${ot[i].CATG_NAME || ""}`.trim();
    summary.push({ rowType: "GROUP", catg, label });
    daywise.push({ rowType: "GROUP", catg, label });

    while (i < ot.length && ot[i].CATG === catg) {
      const h = ot[i];
      const rate = r2(Number(h.BASIC_SAL) * 12 / 365 / 8);
      const t = { nMin: Number(h.N_MIN) || 0, hMin: Number(h.H_MIN) || 0,
                  nAmt: r2(h.NOT_WAGES), hAmt: r2(h.HOT_WAGES) };
      addTot(ct, t); addTot(grand, t);
      summary.push(sumLine("DATA", "", t, {
        catg, empCode: h.EMP_CODE, empName: h.EMP_NAME, tshtNo: h.TSHT_NO,
        basic: r2(h.BASIC_SAL), rate, nRate: r2(rate * RULES.notFactor), hRate: r2(rate * RULES.hotFactor),
      }));

      const dd = byTs[h.TSHT_NO] || {};
      const nArr = days.map((d) => dd[d.d]?.o || 0);
      const hArr = days.map((d) => dd[d.d]?.h || 0);
      nArr.forEach((v, k) => { cDay.n[k] += v; gDay.n[k] += v; });
      hArr.forEach((v, k) => { cDay.h[k] += v; gDay.h[k] += v; });
      const over = days.map((d, k) => !d.off && !d.hol && nArr[k] > RULES.dailyOtLimit);
      daywise.push({ rowType: "DATA", catg, empCode: h.EMP_CODE, empName: h.EMP_NAME, type: "N.OT",
        first: true, mins: nArr, over, total: nArr.reduce((a, v) => a + v, 0) });
      daywise.push({ rowType: "DATA", catg, empCode: h.EMP_CODE, empName: h.EMP_NAME, type: "H.OT",
        first: false, mins: hArr, over: days.map(() => false), total: hArr.reduce((a, v) => a + v, 0) });
      i++;
    }
    summary.push(sumLine("CATTOTAL", "Category Total:", ct, { catg }));
    daywise.push({ rowType: "CATTOTAL", catg, label: "Category Total:", type: "N.OT", first: true,
      mins: cDay.n, total: cDay.n.reduce((a, v) => a + v, 0) });
    daywise.push({ rowType: "CATTOTAL", catg, label: "", type: "H.OT", first: false,
      mins: cDay.h, total: cDay.h.reduce((a, v) => a + v, 0) });
  }
  if (ot.length) {
    summary.push(sumLine("GRAND", "Grand Total", grand));
    daywise.push({ rowType: "GRAND", label: "Grand Total", type: "N.OT", first: true,
      mins: gDay.n, total: gDay.n.reduce((a, v) => a + v, 0) });
    daywise.push({ rowType: "GRAND", label: "", type: "H.OT", first: false,
      mins: gDay.h, total: gDay.h.reduce((a, v) => a + v, 0) });
  }
  return { days, summary, daywise, rules: { notFactor: RULES.notFactor, hotFactor: RULES.hotFactor,
    dailyOtLimit: RULES.dailyOtLimit } };
}

// ---- Excel ----
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
    c.font = { bold: true, size: 9 };
    c.fill = HDR_FILL;
    c.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
}
function lineBorders(row, nCols, kind, span = 0) {
  for (let ci = 1; ci <= nCols; ci++) {
    const b = { left: THIN, right: THIN };
    if (kind === "tot") { b.top = THIN; b.bottom = THIN; }
    if (kind === "grand") { b.top = THIN; b.bottom = { style: "double" }; }
    if (kind === "top") { b.top = THIN; }
    if (span > 1 && ci <= span) { if (ci > 1) delete b.left; if (ci < span) delete b.right; }
    row.getCell(ci).border = b;
  }
}
function signatures(ws, cols) {
  ws.addRow([]);
  ws.addRow([]);
  const sig = ws.addRow([]);
  sig.getCell(1).value = "Prepared by ____________";
  sig.getCell(cols[0]).value = "Checked by (HR) ____________";
  sig.getCell(cols[1]).value = "Approved by ____________";
}

const SUM_COLS = [
  ["Emp Code", "empCode", 10], ["Employee Name", "empName", 26], ["Basic", "basic", 11, "amt"],
  ["Hourly Rate", "rate", 9, "amt"], ["N.OT Hrs", "nMin", 9, "hrs"], ["N.OT Rate", "nRate", 9, "amt"],
  ["N.OT Amount", "nAmt", 12, "amt"], ["H.OT Hrs", "hMin", 9, "hrs"], ["H.OT Rate", "hRate", 9, "amt"],
  ["H.OT Amount", "hAmt", 12, "amt"], ["Total OT Hrs", "tMin", 10, "hrs"], ["Total OT Amount", "tAmt", 13, "amt"],
  ["Signature", "sig", 16],
];

function addSummarySheet(wb, rep, p, company, catgLabel) {
  const ws = wb.addWorksheet("OT Register", {
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "5:5" },
  });
  const n = SUM_COLS.length;
  ws.columns = SUM_COLS.map((c) => ({ width: c[2] }));
  titleLines(ws, company, `Overtime Register - ${MONTHS[p.m - 1]} ${p.y}`,
    `Category: ${catgLabel}     N.OT at ${rep.rules.notFactor}x, H.OT at ${rep.rules.hotFactor}x hourly rate     ` +
    (p.draft === "Y" ? "Including Draft time sheets" : "Approved time sheets"));
  headerRow(ws, SUM_COLS.map((c) => c[0]));
  ws.views = [{ state: "frozen", ySplit: 5 }];

  for (const r of rep.summary) {
    if (r.rowType === "GROUP") {
      const row = ws.addRow([r.label]);
      row.font = { bold: true, color: { argb: "FF1F3C88" } };
      lineBorders(row, n, "", 2);
      continue;
    }
    const isData = r.rowType === "DATA";
    const vals = SUM_COLS.map(([, k, , kind], idx) => {
      if (!isData && idx === 0) return r.label;
      if (!isData && ["empName", "basic", "rate", "nRate", "hRate"].includes(k)) return null;
      if (k === "sig") return null;
      if (kind === "hrs") return fmtHm(r[k]) || null;
      return r[k] ?? null;
    });
    const row = ws.addRow(vals);
    row.font = { size: 10, bold: !isData };
    SUM_COLS.forEach(([, , , kind], idx) => {
      const cell = row.getCell(idx + 1);
      if (kind === "amt") cell.numFmt = "#,##0.00";
      if (kind) cell.alignment = { horizontal: "right" };
    });
    if (isData) row.height = 22;
    lineBorders(row, n, r.rowType === "GRAND" ? "grand" : isData ? "" : "tot", isData ? 0 : 2);
  }
  signatures(ws, [6, 11]);
}

function addDaywiseSheet(wb, rep, p, company, catgLabel) {
  const ws = wb.addWorksheet("Day-wise OT", {
    pageSetup: { orientation: "landscape", paperSize: 8, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "5:5" },
  });
  const nDays = rep.days.length;
  const n = 3 + nDays + 1;
  ws.columns = [{ width: 9 }, { width: 22 }, { width: 6 }, ...rep.days.map(() => ({ width: 5.5 })), { width: 9 }];
  titleLines(ws, company, `Day-wise Overtime - ${MONTHS[p.m - 1]} ${p.y}`,
    `Category: ${catgLabel}     Hours as Hrs:Min     red = N.OT above ${fmtHm(rep.rules.dailyOtLimit)} hrs on a working day`);
  headerRow(ws, ["Emp Code", "Employee Name", "Type", ...rep.days.map((d) => `${d.d}\n${d.wd}`), "Total"]);
  ws.views = [{ state: "frozen", xSplit: 3, ySplit: 5 }];

  for (const r of rep.daywise) {
    if (r.rowType === "GROUP") {
      const row = ws.addRow([r.label]);
      row.font = { bold: true, color: { argb: "FF1F3C88" } };
      lineBorders(row, n, "", 3);
      continue;
    }
    const isData = r.rowType === "DATA";
    const left = isData ? [r.first ? r.empCode : null, r.first ? r.empName : null, r.type]
      : [r.first ? r.label : null, null, r.type];
    const row = ws.addRow([...left, ...r.mins.map((m) => fmtHm(m) || null), fmtHm(r.total) || null]);
    row.font = { size: 9, bold: !isData };
    for (let k = 0; k < nDays; k++) {
      const cell = row.getCell(4 + k);
      cell.alignment = { horizontal: "center" };
      if (isData && r.over?.[k]) cell.font = { size: 9, bold: true, color: { argb: "FFC62828" } };
    }
    row.getCell(4 + nDays).alignment = { horizontal: "right" };
    row.getCell(4 + nDays).font = { size: 9, bold: true };
    const kind = r.first
      ? (r.rowType === "GRAND" ? "tot" : isData ? "top" : "tot")
      : (r.rowType === "GRAND" ? "grand" : isData ? "" : "tot");
    lineBorders(row, n, kind, isData ? 0 : 2);
  }
  signatures(ws, [12, 24]);
}

// ---------------------------------------------------------------
module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get("/ot-register/categories", async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ${CATG.code} AS CATG_CODE, ${CATG.name} AS CATG_NAME FROM ${CATG.table} ORDER BY ${CATG.code}`);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/ot-register", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const rep = await buildReport(db, p);
      const { company, catgLabel } = await headerInfo(db, p);
      res.json({ ...rep, company, catgLabel, monthLabel: `${MONTHS[p.m - 1]} ${p.y}`,
        params: { month: p.month, catg: p.catg, draft: p.draft } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/ot-register/excel", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const rep = await buildReport(db, p);
      const { company, catgLabel } = await headerInfo(db, p);
      const wb = new ExcelJS.Workbook();
      addSummarySheet(wb, rep, p, company, catgLabel);
      if (p.daywise === "Y") addDaywiseSheet(wb, rep, p, company, catgLabel);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="OtRegister_${p.month}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports._test = { buildReport, getParams, addSummarySheet, addDaywiseSheet, fmtAmt };
