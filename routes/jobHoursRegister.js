// routes/jobHoursRegister.js
// Job Hours Allocation report — Employee-wise and Job-wise
// Source: time_sheet_job (job allocation lines) + time_sheet_dtl (hours to allocate)
//   GET /api/job-hours/categories
//   GET /api/job-hours?from=YYYY-MM&to=YYYY-MM&catg=ALL|<code>&job=<jobNo>&appr=Y|N
//   GET /api/job-hours/excel?...same...&view=E|J&cost=Y|N
//
// Register in HayatDb.js:
//   const jobHoursRegister = require("./routes/jobHoursRegister");
//   app.use("/api", jobHoursRegister(connection));

const express = require("express");
const ExcelJS = require("exceljs");

// ---- Names: adjust here only ----
const EMP = { table: "emp_mst", code: "EMP_CODE", name: "EMP_NAME", catg: "EMP_CATG" };
const CATG = { table: "emp_catg_mst", code: "CATG_CODE", name: "CATG_NAME" };
const RULES = { notFactor: 1.25, hotFactor: 1.5 };

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fmtHm = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : "");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const monLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

// ---------------------------------------------------------------
function getParams(q) {
  const from = String(q.from || "");
  const to = String(q.to || q.from || "");
  const re = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!re.test(from) || !re.test(to)) throw new Error("Invalid month");
  if (from > to) throw new Error("From month is after To month");
  return {
    from, to,
    first: `${from}-01`,
    last: `${to}-01`, // used with LAST_DAY()
    catg: q.catg && q.catg !== "ALL" ? String(q.catg) : "ALL",
    job: String(q.job || "").trim(),
    appr: q.appr === "Y" ? "Y" : "N", // Y = Job approved sheets only
    view: q.view === "J" ? "J" : "E",
    cost: q.cost === "N" ? "N" : "Y",
  };
}

async function headerInfo(db, p) {
  let company = "";
  let catgLabel = "All Categories";
  let jobLabel = "";
  try {
    const [c] = await db.query("SELECT NAME FROM company LIMIT 1");
    company = c[0]?.NAME || "";
  } catch (_) { /* ignore */ }
  if (p.catg !== "ALL") {
    const [r] = await db.query(`SELECT ${CATG.name} AS N FROM ${CATG.table} WHERE ${CATG.code} = ?`, [p.catg]);
    catgLabel = `${p.catg} - ${r[0]?.N || ""}`;
  }
  if (p.job) {
    const [r] = await db.query("SELECT PROJ_NAME FROM job_card WHERE JOB_NO = ?", [p.job]);
    jobLabel = `${p.job} - ${r[0]?.PROJ_NAME || ""}`;
  }
  const period = p.from === p.to ? monLabel(p.from) : `${monLabel(p.from)} to ${monLabel(p.to)}`;
  return { company, catgLabel, jobLabel, period };
}

// ---------------------------------------------------------------
const zero = () => ({ nMin: 0, oMin: 0, hMin: 0, nCost: 0, oCost: 0, hCost: 0 });
function add(t, s) {
  t.nMin += s.nMin; t.oMin += s.oMin; t.hMin += s.hMin;
  t.nCost = r2(t.nCost + s.nCost); t.oCost = r2(t.oCost + s.oCost); t.hCost = r2(t.hCost + s.hCost);
}
const line = (rowType, code, name, t, extra = {}) => ({
  rowType, code, name, ...t, tMin: t.nMin + t.oMin + t.hMin, tCost: r2(t.nCost + t.oCost + t.hCost), ...extra,
});
const costAt = (mins, rate, f) => r2((mins / 60) * rate * f);

async function buildReport(db, p) {
  const statusCond = p.appr === "Y" ? "h.STATUS = 'A'" : "h.STATUS IN ('T','A')";
  const base = [p.first, p.last, p.catg, p.catg];

  // hours to allocate per employee (time-approved sheets only: allocation needs Time approval)
  const [emps] = await db.query(
    `SELECT h.EMP_CODE, e.${EMP.name} AS EMP_NAME, e.${EMP.catg} AS CATG, c.${CATG.name} AS CATG_NAME,
            ROUND(IFNULL(pm.BASIC_SAL,0)*12/365/8, 2) AS RATE,
            SUM(IFNULL(d.NORMAL_HRS,0)) AS N, SUM(IFNULL(d.NORMAL_OT,0)) AS O, SUM(IFNULL(d.HOLIDAY_OT,0)) AS H
       FROM time_sheet_hdr h
       JOIN ${EMP.table} e       ON e.${EMP.code} = h.EMP_CODE
       LEFT JOIN ${CATG.table} c ON c.${CATG.code} = e.${EMP.catg}
       LEFT JOIN payroll_mst pm  ON pm.EMP_CODE = h.EMP_CODE
       LEFT JOIN time_sheet_dtl d ON d.TSHT_NO = h.TSHT_NO
      WHERE h.TSHT_DATE >= ? AND h.TSHT_DATE <= LAST_DAY(?)
        AND (? = 'ALL' OR e.${EMP.catg} = ?)
        AND ${statusCond}
      GROUP BY h.EMP_CODE, e.${EMP.name}, e.${EMP.catg}, c.${CATG.name}, pm.BASIC_SAL
      ORDER BY e.${EMP.catg}, h.EMP_CODE`, base);

  // allocated hours and cost per employee per job (stored cost; lines saved without cost
  // — e.g. carried over from the old Job No column — are costed at the current rate)
  const [alloc] = await db.query(
    `SELECT h.EMP_CODE, j.JOB_NO, jc.PROJ_NAME,
            SUM(j.NORMAL_MINS) AS N, SUM(j.NOT_MINS) AS O, SUM(j.HOT_MINS) AS H,
            SUM(CASE WHEN j.NORMAL_COST = 0 AND j.NORMAL_MINS > 0
                     THEN ROUND(j.NORMAL_MINS/60 * ROUND(IFNULL(pm.BASIC_SAL,0)*12/365/8,2), 2) ELSE j.NORMAL_COST END) AS NC,
            SUM(CASE WHEN j.NOT_COST = 0 AND j.NOT_MINS > 0
                     THEN ROUND(j.NOT_MINS/60 * ROUND(IFNULL(pm.BASIC_SAL,0)*12/365/8,2) * ${RULES.notFactor}, 2) ELSE j.NOT_COST END) AS OC,
            SUM(CASE WHEN j.HOT_COST = 0 AND j.HOT_MINS > 0
                     THEN ROUND(j.HOT_MINS/60 * ROUND(IFNULL(pm.BASIC_SAL,0)*12/365/8,2) * ${RULES.hotFactor}, 2) ELSE j.HOT_COST END) AS HC
       FROM time_sheet_job j
       JOIN time_sheet_hdr h     ON h.TSHT_NO = j.TSHT_NO
       JOIN ${EMP.table} e       ON e.${EMP.code} = h.EMP_CODE
       LEFT JOIN payroll_mst pm  ON pm.EMP_CODE = h.EMP_CODE
       LEFT JOIN job_card jc     ON jc.JOB_NO = j.JOB_NO
      WHERE h.TSHT_DATE >= ? AND h.TSHT_DATE <= LAST_DAY(?)
        AND (? = 'ALL' OR e.${EMP.catg} = ?)
        AND ${statusCond}
        AND (? = '' OR j.JOB_NO = ?)
      GROUP BY h.EMP_CODE, j.JOB_NO, jc.PROJ_NAME
      ORDER BY h.EMP_CODE, j.JOB_NO`, [...base, p.job, p.job]);

  const toT = (r) => ({
    nMin: Number(r.N) || 0, oMin: Number(r.O) || 0, hMin: Number(r.H) || 0,
    nCost: r2(r.NC), oCost: r2(r.OC), hCost: r2(r.HC),
  });

  const byEmp = {};
  alloc.forEach((a) => (byEmp[a.EMP_CODE] ||= []).push(a));

  // unallocated = sheet hours not yet given to a job (only when no Job filter)
  const unalloc = {};
  if (!p.job) {
    emps.forEach((e) => {
      const done = zero();
      (byEmp[e.EMP_CODE] || []).forEach((a) => add(done, toT(a)));
      const n = Math.max(0, (Number(e.N) || 0) - done.nMin);
      const o = Math.max(0, (Number(e.O) || 0) - done.oMin);
      const h = Math.max(0, (Number(e.H) || 0) - done.hMin);
      if (n + o + h > 0) {
        const rate = Number(e.RATE) || 0;
        unalloc[e.EMP_CODE] = { nMin: n, oMin: o, hMin: h,
          nCost: costAt(n, rate, 1), oCost: costAt(o, rate, RULES.notFactor), hCost: costAt(h, rate, RULES.hotFactor) };
      }
    });
  }

  // ---- Employee-wise ----
  const empRows = [];
  const gE = zero();
  let i = 0;
  while (i < emps.length) {
    const catg = emps[i].CATG;
    const ct = zero();
    const block = [];
    while (i < emps.length && emps[i].CATG === catg) {
      const e = emps[i++];
      const lines = byEmp[e.EMP_CODE] || [];
      const un = unalloc[e.EMP_CODE];
      if (!lines.length && !un) continue;
      const et = zero();
      block.push({ rowType: "HEAD", code: e.EMP_CODE, name: e.EMP_NAME });
      lines.forEach((a) => {
        const t = toT(a);
        add(et, t);
        block.push(line("LINE", a.JOB_NO, a.PROJ_NAME || "", t));
      });
      if (un) { add(et, un); block.push(line("UNALLOC", "", "Unallocated", un)); }
      block.push(line("SUB", `Total: ${e.EMP_CODE}`, "", et));
      add(ct, et);
    }
    if (block.length) {
      empRows.push({ rowType: "GROUP", code: `${catg || "--"}  ${emps.find((x) => x.CATG === catg)?.CATG_NAME || ""}`.trim() });
      empRows.push(...block);
      empRows.push(line("CATTOTAL", "Category Total:", "", ct));
      add(gE, ct);
    }
  }
  if (empRows.length) empRows.push(line("GRAND", "Grand Total", "", gE));

  // ---- Job-wise ----
  const empInfo = Object.fromEntries(emps.map((e) => [e.EMP_CODE, e]));
  const byJob = {};
  alloc.forEach((a) => {
    if (!empInfo[a.EMP_CODE]) return;
    (byJob[a.JOB_NO] ||= { name: a.PROJ_NAME || "", lines: [] }).lines.push(a);
  });
  const jobNos = Object.keys(byJob).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const jobRows = [];
  const gJ = zero();
  jobNos.forEach((jn) => {
    const jt = zero();
    jobRows.push({ rowType: "HEAD", code: jn, name: byJob[jn].name });
    byJob[jn].lines.forEach((a) => {
      const t = toT(a);
      add(jt, t);
      jobRows.push(line("LINE", a.EMP_CODE, empInfo[a.EMP_CODE]?.EMP_NAME || "", t));
    });
    jobRows.push(line("SUB", `Total: Job ${jn}`, "", jt));
    add(gJ, jt);
  });
  const unEmps = emps.filter((e) => unalloc[e.EMP_CODE]);
  if (unEmps.length) {
    const ut = zero();
    jobRows.push({ rowType: "HEAD", code: "", name: "Unallocated" });
    unEmps.forEach((e) => {
      add(ut, unalloc[e.EMP_CODE]);
      jobRows.push(line("UNALLOC", e.EMP_CODE, e.EMP_NAME, unalloc[e.EMP_CODE]));
    });
    jobRows.push(line("SUB", "Total: Unallocated", "", ut));
    add(gJ, ut);
  }
  if (jobRows.length) jobRows.push(line("GRAND", "Grand Total", "", gJ));

  return { empRows, jobRows, rules: RULES };
}

// ---- Excel ----
const THIN = { style: "thin", color: { argb: "FF7F8896" } };
const HRS = [["Normal Hrs", "nMin"], ["N.OT Hrs", "oMin"], ["H.OT Hrs", "hMin"], ["Total Hrs", "tMin"]];
const COST = [["Normal Cost", "nCost"], ["N.OT Cost", "oCost"], ["H.OT Cost", "hCost"], ["Total Cost", "tCost"]];

async function writeExcel(res, rep, p, info) {
  const rows = p.view === "J" ? rep.jobRows : rep.empRows;
  const withCost = p.cost === "Y";
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(p.view === "J" ? "Job-wise" : "Employee-wise", {
    pageSetup: { orientation: withCost ? "landscape" : "portrait", paperSize: 9, fitToPage: true,
      fitToWidth: 1, fitToHeight: 0, printTitlesRow: "5:5" },
  });
  const heads = [
    p.view === "J" ? "Job No / Emp Code" : "Emp Code / Job No",
    p.view === "J" ? "Project / Employee" : "Employee / Project",
    ...HRS.map((c) => c[0]), ...(withCost ? COST.map((c) => c[0]) : []),
  ];
  const n = heads.length;
  ws.columns = [{ width: 14 }, { width: 38 }, ...HRS.map(() => ({ width: 10 })), ...(withCost ? COST.map(() => ({ width: 12 })) : [])];

  ws.addRow([info.company]).font = { bold: true, size: 14 };
  ws.addRow([`Job Hours Allocation - ${p.view === "J" ? "Job-wise" : "Employee-wise"} - ${info.period}`]).font = { bold: true, size: 12 };
  ws.addRow([`Category: ${info.catgLabel}` + (info.jobLabel ? `     Job: ${info.jobLabel}` : "") +
    `     ${p.appr === "Y" ? "Job approved sheets" : "Time / Job approved sheets"}` +
    (withCost ? `     Cost = hours x hourly rate x 1 / ${rep.rules.notFactor} / ${rep.rules.hotFactor}` : "")]);
  ws.addRow([]);
  const hdr = ws.addRow(heads);
  hdr.height = 30;
  hdr.eachCell((c) => {
    c.font = { bold: true, size: 10 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8ECF2" } };
    c.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.views = [{ state: "frozen", ySplit: 5 }];

  for (const r of rows) {
    const isNum = !["GROUP", "HEAD"].includes(r.rowType);
    const lead = r.rowType === "LINE" || r.rowType === "UNALLOC" ? "   " : "";
    const vals = [lead + (r.code || ""), r.name || null];
    if (isNum) {
      HRS.forEach(([, k]) => vals.push(fmtHm(r[k]) || null));
      if (withCost) COST.forEach(([, k]) => vals.push(r[k] || null));
    }
    const row = ws.addRow(vals);
    const bold = !["LINE", "UNALLOC"].includes(r.rowType);
    row.font = { size: 10, bold,
      ...(r.rowType === "GROUP" || r.rowType === "HEAD" ? { color: { argb: "FF1F3C88" } } : {}),
      ...(r.rowType === "UNALLOC" ? { italic: true, color: { argb: "FF854F0B" } } : {}) };
    for (let ci = 3; ci <= n; ci++) {
      row.getCell(ci).alignment = { horizontal: "right" };
      if (ci > 6) row.getCell(ci).numFmt = "#,##0.00";
    }
    for (let ci = 1; ci <= n; ci++) {
      const b = { left: THIN, right: THIN };
      if (["SUB", "CATTOTAL"].includes(r.rowType)) { b.top = THIN; b.bottom = THIN; }
      if (r.rowType === "GRAND") { b.top = THIN; b.bottom = { style: "double" }; }
      row.getCell(ci).border = b;
    }
  }

  ws.addRow([]);
  ws.addRow([]);
  const sig = ws.addRow([]);
  sig.getCell(1).value = "Prepared by ____________";
  sig.getCell(3).value = "Checked by ____________";
  sig.getCell(withCost ? 8 : 5).value = "Approved by ____________";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    `attachment; filename="JobHours_${p.view === "J" ? "Jobwise" : "Empwise"}_${p.from}_${p.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ---------------------------------------------------------------
module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get("/job-hours/categories", async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ${CATG.code} AS CATG_CODE, ${CATG.name} AS CATG_NAME FROM ${CATG.table} ORDER BY ${CATG.code}`);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // job list for the Job No picker (jobs that have allocated hours)
  router.get("/job-hours/jobs", async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT DISTINCT j.JOB_NO, jc.PROJ_NAME
           FROM time_sheet_job j LEFT JOIN job_card jc ON jc.JOB_NO = j.JOB_NO
          ORDER BY j.JOB_NO`);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/job-hours", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const rep = await buildReport(db, p);
      const info = await headerInfo(db, p);
      res.json({ ...rep, ...info, params: { from: p.from, to: p.to, catg: p.catg, job: p.job, appr: p.appr } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/job-hours/excel", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const rep = await buildReport(db, p);
      const info = await headerInfo(db, p);
      await writeExcel(res, rep, p, info);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports._test = { buildReport, getParams, writeExcel };
