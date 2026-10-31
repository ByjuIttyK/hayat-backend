// routes/attendanceRegister.js
// Attendance Register (monthly muster) from time_sheet_hdr / time_sheet_dtl
//   GET /api/attendance-register/categories
//   GET /api/attendance-register?month=YYYY-MM&catg=ALL|<code>&draft=Y|N
//   GET /api/attendance-register/excel?...same...&view=C|H|B   (Codes / Hours / Both)
//
// Register in HayatDb.js:
//   const attendanceRegister = require("./routes/attendanceRegister");
//   app.use("/api", attendanceRegister(connection));

const express = require("express");
const ExcelJS = require("exceljs");

// ---- Names and rules: adjust here only ----
const EMP = { table: "emp_mst", code: "EMP_CODE", name: "EMP_NAME", catg: "EMP_CATG", card: "CARD_NO" };
const CATG = { table: "emp_catg_mst", code: "CATG_CODE", name: "CATG_NAME" };
const HOL = { table: "holiday_mst", date: "HOL_DATE", desc: "HOL_DESC" };
const RULES = {
  weeklyOff: [5],        // JS getDay(): 0 = Sun … 5 = Fri
  lateAfter: "08:10",    // 08:00 + 10 min margin
  halfDayBelow: 240,     // normal minutes below this on a working day = half day
};

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fmtHm = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : "");
const pad = (n) => String(n).padStart(2, "0");
const hasT = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const hm = (v) => String(v).trim().slice(0, 5).padStart(5, "0"); // '8:05' / '08:05:00' -> '08:05'
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

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
    view: ["C", "H", "B"].includes(q.view) ? q.view : "B",
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
    console.error("attendance-register holidays:", e.message);
    return {};
  }
}

// ---- Day classification ----
//  P present · L late · ½ half day · M missing punch · A absent
//  W weekly off · H holiday · WP / HP worked on weekly off / holiday
function classify(rows, isOff, isHol) {
  const punched = rows.filter((r) => hasT(r.TIME_IN) || hasT(r.TIME_OUT));
  const n = rows.reduce((a, r) => a + (Number(r.N) || 0), 0);
  const o = rows.reduce((a, r) => a + (Number(r.O) || 0), 0);
  const h = rows.reduce((a, r) => a + (Number(r.H) || 0), 0);
  const base = { n, o, h, m: n + o + h };
  if (!punched.length) return { ...base, c: isHol ? "H" : isOff ? "W" : "A" };
  if (isHol) return { ...base, c: "HP" };
  if (isOff) return { ...base, c: "WP" };
  if (punched.some((r) => !hasT(r.TIME_IN) || !hasT(r.TIME_OUT))) return { ...base, c: "M" };
  if (n > 0 && n < RULES.halfDayBelow) return { ...base, c: "½" };
  const firstIn = punched.find((r) => hasT(r.TIME_IN));
  if (firstIn && hm(firstIn.TIME_IN) > RULES.lateAfter) return { ...base, c: "L" };
  return { ...base, c: "P" };
}

const emptyTot = () => ({
  present: 0, absent: 0, off: 0, workedOff: 0, late: 0, miss: 0, half: 0,
  nMin: 0, oMin: 0, hMin: 0, wMin: 0, paid: 0, emps: 0,
});
// per-day totals for the total rows: m = minutes worked, p = employees present
const newDayTot = (days) => days.map(() => ({ m: 0, p: 0 }));
// day cell text on a total row
function dayTotText(dt, view) {
  const hrs = fmtHm(dt.m);
  if (view === "C") return dt.p ? String(dt.p) : "";
  if (view === "H") return hrs;
  return dt.p || dt.m ? `${dt.p}\n${hrs}` : "";
}
function addTot(t, s) {
  Object.keys(t).forEach((k) => { if (k !== "emps") t[k] = r2(t[k] + (s[k] || 0)); });
  t.emps += 1;
}

async function buildReport(db, p) {
  // days of the month
  const hol = await fetchHolidays(db, p);
  const days = [];
  for (let d = 1; d <= p.nDays; d++) {
    const dt = new Date(p.y, p.m - 1, d);
    days.push({
      d, wd: "SMTWTFS"[dt.getDay()],
      off: RULES.weeklyOff.includes(dt.getDay()),
      hol: hol[d] || "",
    });
  }

  const [hdrs] = await db.query(
    `SELECT h.TSHT_NO, h.EMP_CODE, e.${EMP.name} AS EMP_NAME, e.${EMP.card} AS CARD_NO,
            e.${EMP.catg} AS CATG, c.${CATG.name} AS CATG_NAME
       FROM time_sheet_hdr h
       JOIN ${EMP.table} e       ON e.${EMP.code} = h.EMP_CODE
       LEFT JOIN ${CATG.table} c ON c.${CATG.code} = e.${EMP.catg}
      WHERE h.TSHT_DATE >= ? AND h.TSHT_DATE <= LAST_DAY(?)
        AND (? = 'ALL' OR e.${EMP.catg} = ?)
        AND (? = 'Y' OR h.STATUS <> 'D')
      ORDER BY e.${EMP.catg}, h.EMP_CODE`,
    [p.first, p.first, p.catg, p.catg, p.draft]);

  const byTs = {};
  if (hdrs.length) {
    const [dtl] = await db.query(
      `SELECT d.TSHT_NO, DAY(d.ATT_DATE) AS D, d.SEQ_NO, d.TIME_IN, d.TIME_OUT,
              IFNULL(d.NORMAL_HRS,0) AS N, IFNULL(d.NORMAL_OT,0) AS O, IFNULL(d.HOLIDAY_OT,0) AS H
         FROM time_sheet_dtl d
        WHERE d.TSHT_NO IN (?)
        ORDER BY d.TSHT_NO, d.ATT_DATE, d.SEQ_NO`,
      [hdrs.map((h) => h.TSHT_NO)]);
    dtl.forEach((r) => {
      ((byTs[r.TSHT_NO] ||= {})[r.D] ||= []).push(r);
    });
  }

  const rows = [];
  const grand = emptyTot();
  const grandDay = newDayTot(days);
  let i = 0;
  while (i < hdrs.length) {
    const catg = hdrs[i].CATG;
    const ct = emptyTot();
    rows.push({ rowType: "GROUP", catg, label: `${catg || "--"}  ${hdrs[i].CATG_NAME || ""}`.trim() });
    const catDay = newDayTot(days);
    while (i < hdrs.length && hdrs[i].CATG === catg) {
      const h = hdrs[i];
      const t = emptyTot();
      const cells = days.map((day, k) => {
        const x = classify(byTs[h.TSHT_NO]?.[day.d] || [], day.off, !!day.hol);
        // day-wise column totals: hours worked and head count present
        const pres = ["P", "L", "M", "WP", "HP"].includes(x.c) ? 1 : x.c === "½" ? 0.5 : 0;
        catDay[k].m += x.m; catDay[k].p += pres;
        grandDay[k].m += x.m; grandDay[k].p += pres;
        if (["P", "L", "M", "WP", "HP"].includes(x.c)) t.present += 1;
        if (x.c === "½") { t.present += 0.5; t.half += 1; }
        if (x.c === "A") t.absent += 1;
        if (["W", "H", "WP", "HP"].includes(x.c)) t.off += 1;
        if (["WP", "HP"].includes(x.c)) t.workedOff += 1;
        if (x.c === "L") t.late += 1;
        if (x.c === "M") t.miss += 1;
        t.nMin += x.n; t.oMin += x.o; t.hMin += x.h; t.wMin += x.m;
        return { c: x.c, m: x.m, ot: x.o + x.h > 0 };
      });
      // paid = present on working days + every weekly off / holiday (worked or not)
      t.paid = r2(t.present - t.workedOff + t.off);
      addTot(ct, t); addTot(grand, t);
      rows.push({ rowType: "DATA", catg, empCode: h.EMP_CODE, empName: h.EMP_NAME, cardNo: h.CARD_NO ?? "",
        tshtNo: h.TSHT_NO, cells, ...t });
      i++;
    }
    rows.push({ rowType: "CATTOTAL", catg, label: "Category Total:", ...ct, dayTot: catDay });
  }
  if (hdrs.length) rows.push({ rowType: "GRAND", label: "Grand Total", ...grand, dayTot: grandDay });
  return { days, rows };
}

// ---- Excel ----
const THIN = { style: "thin", color: { argb: "FF7F8896" } };
const TOT_COLS = [
  ["Days Present", "present"], ["Absent", "absent"], ["Off / Hol", "off"], ["Worked Off", "workedOff"],
  ["Late", "late"], ["Missing Punch", "miss"], ["Normal Hrs", "nMin", 1], ["N.OT Hrs", "oMin", 1],
  ["H.OT Hrs", "hMin", 1], ["Hours Worked", "wMin", 1], ["Paid Days", "paid"],
];
const CODE_COLOR = { A: "FFA32D2D", M: "FFC62828", L: "FF854F0B", WP: "FF185FA5", HP: "FF185FA5", W: "FF888780", H: "FF888780" };

function cellText(cell, view) {
  const hrs = fmtHm(cell.m);
  if (view === "C") return cell.c;
  if (view === "H") return hrs || cell.c;
  return hrs ? `${cell.c}\n${hrs}` : cell.c;
}

async function writeExcel(res, rep, p, company, catgLabel) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Attendance Register", {
    pageSetup: { orientation: "landscape", paperSize: 8 /* A3 */, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "5:5" },
  });
  const nDays = rep.days.length;
  const nCols = 3 + nDays + TOT_COLS.length;
  ws.columns = [
    { width: 9 }, { width: 22 }, { width: 6 },
    ...rep.days.map(() => ({ width: p.view === "C" ? 4.2 : 6 })),
    ...TOT_COLS.map(() => ({ width: 9 })),
  ];

  ws.addRow([company]).font = { bold: true, size: 14 };
  ws.addRow([`Attendance Register - ${MONTHS[p.m - 1]} ${p.y}`]).font = { bold: true, size: 12 };
  ws.addRow([`Category: ${catgLabel}     ${p.draft === "Y" ? "Including Draft time sheets" : "Approved time sheets"}`]);
  ws.addRow([]);

  const hdr = ws.addRow(["Emp Code", "Employee Name", "Card",
    ...rep.days.map((d) => `${d.d}\n${d.wd}`), ...TOT_COLS.map((c) => c[0])]);
  hdr.height = 32;
  hdr.eachCell((c) => {
    c.font = { bold: true, size: 9 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8ECF2" } };
    c.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.views = [{ state: "frozen", xSplit: 3, ySplit: 5 }];

  const border = (row, kind, span = 0) => {
    for (let ci = 1; ci <= nCols; ci++) {
      const b = { left: THIN, right: THIN };
      if (kind === "tot") { b.top = THIN; b.bottom = THIN; }
      if (kind === "grand") { b.top = THIN; b.bottom = { style: "double" }; }
      if (span > 1 && ci <= span) { if (ci > 1) delete b.left; if (ci < span) delete b.right; }
      row.getCell(ci).border = b;
    }
  };

  for (const r of rep.rows) {
    if (r.rowType === "GROUP") {
      const row = ws.addRow([r.label]);
      row.font = { bold: true, color: { argb: "FF1F3C88" } };
      border(row, "", 3 + nDays);
      continue;
    }
    const isData = r.rowType === "DATA";
    const tot = TOT_COLS.map(([, k, isHrs]) => (isHrs ? fmtHm(r[k]) || null : r[k]));
    const vals = isData
      ? [r.empCode, r.empName, r.cardNo, ...r.cells.map((c) => cellText(c, p.view)), ...tot]
      : [r.label, null, null, ...(r.dayTot || []).map((dt) => dayTotText(dt, p.view) || null), ...tot];
    const row = ws.addRow(vals);
    row.font = { size: 9, bold: !isData };
    if (p.view === "B") row.height = 26;
    for (let k = 0; k < nDays; k++) {
      const cell = row.getCell(4 + k);
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      if (isData) {
        const col = CODE_COLOR[r.cells[k].c];
        if (col) cell.font = { size: 9, color: { argb: col }, bold: ["A", "M"].includes(r.cells[k].c) };
      }
    }
    for (let k = 0; k < TOT_COLS.length; k++) row.getCell(4 + nDays + k).alignment = { horizontal: "right" };
    border(row, r.rowType === "GRAND" ? "grand" : isData ? "" : "tot", isData ? 0 : 3);
  }

  ws.addRow([]);
  ws.addRow(["Codes: P Present · L Late · ½ Half day · M Missing punch · A Absent · W Weekly off · H Holiday · WP / HP Worked on weekly off / holiday"]).font = { size: 9 };
  ws.addRow(["Total rows, day columns: " + (p.view === "C" ? "employees present"
    : p.view === "H" ? "hours worked that day" : "employees present / hours worked that day")]).font = { size: 9 };
  const hols = rep.days.filter((d) => d.hol);
  if (hols.length) ws.addRow([`Holidays: ${hols.map((d) => `${d.d} - ${d.hol}`).join(", ")}`]).font = { size: 9 };
  ws.addRow([]);
  ws.addRow([]);
  const sig = ws.addRow([]);
  sig.getCell(1).value = "Prepared by ____________";
  sig.getCell(10).value = "Checked by (HR) ____________";
  sig.getCell(22).value = "Approved by ____________";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="AttendanceRegister_${p.month}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ---------------------------------------------------------------
module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get("/attendance-register/categories", async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ${CATG.code} AS CATG_CODE, ${CATG.name} AS CATG_NAME FROM ${CATG.table} ORDER BY ${CATG.code}`);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/attendance-register", async (req, res) => {
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

  router.get("/attendance-register/excel", async (req, res) => {
    let p;
    try { p = getParams(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const rep = await buildReport(db, p);
      const { company, catgLabel } = await headerInfo(db, p);
      await writeExcel(res, rep, p, company, catgLabel);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports._test = { classify, getParams, buildReport, writeExcel };
