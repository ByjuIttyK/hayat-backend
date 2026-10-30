// =====================================================================
// routes/timeSheetApi.js  —  Time Sheet Entry (TimeSheetEnt) backend
//
// Register in HayatDb.js:
//   const timeSheetApi = require('./routes/timeSheetApi');
//   app.use('/api', timeSheetApi(connection));
//
// Tables: shift_mst, emp_mst, payroll_mst, time_sheet_hdr, time_sheet_dtl,
//         tsht_allow, tsht_ded, allow_mst, ded_mst, job_card, holiday_mst,
//         doc_attachments (MODULE = 'TIMESHEET', REF_NO = TSHT_NO)
// All times are handled in minutes. The calculation here is the only
// place the shift rules are applied (screen calls /tsht/calc).
//
// 25-Oct-2026: /tsht/save stores the month totals in time_sheet_hdr (TOT_COLS) in Draft:
//   TOT_NORMAL_HRS / TOT_NOT_HRS / TOT_HOT_HRS as Hrs:Min worked out here from the days,
//   wages from req.body.totals. /tsht/list returns them for the list grid.
//
// Approval (24-Oct-2026): STATUS D = Draft, T = Time approved, A = Job approved
//   POST /tsht/save              D: full save · T: Job No only · A: refused
//   POST /tsht/time-approve/:no  D -> T  (TIME_APPR_BY / TIME_APPR_DT)
//   POST /tsht/job-approve/:no   T -> A  (APPROVED_BY / APPROVED_DT)
//   POST /tsht/revoke/:no        admin only: A -> T, T -> D  (REVOKED_BY / REVOKED_DT)
//
// 26-Oct-2026: shift crossing midnight — time_sheet_dtl key is TSHT_NO + DAY_NO + SEQ_NO
//   CONT_FLAG 'C' = continuation row (00:00 → out) of the previous day's shift:
//     day 14 seq 1  18:00 → 23:59   (23:59 counts as 24:00 when a continuation follows)
//     day 15 seq 1  00:00 → 02:30   C  minutes classified by DAY 14: working day → N.OT,
//                                      week off / holiday → H.OT; never late / short / absent
//     day 15 seq 2  08:00 → 17:30      regular duty, judged as usual
//   A shift on the last day continues on day "last + 1" (1st of next month), kept on this sheet.
// 30-Oct-2026: POST /tsht/payslips { nos: [...] } — payslip figures of processed sheets (Payslip Print list):
//   stored days recalculated (as when the sheet is opened), the same month totals as the screen
//   (useTimeSheet totals), the sheet's own allowance / deduction lines, and the basic in force for
//   the month (salary revisions, salRevPay.js) — so the slip matches "Print Payslip" on the sheet.
// 26-Oct-2026: AI card read returns EVERY stamp of every column (A.M./P.M./Overtime In/Out);
//   In / Out are worked out here: In = first stamp, Out = last stamp. An early-morning stamp
//   (before TSHT_CARRY_BEFORE, default 05:00) that ends the previous day's shift is moved to
//   that day as its Out (earlier than In → the screen splits it at midnight).
// =====================================================================
const express = require('express');
const fs = require('fs');
// basic in force for a month (salary revisions); falls back to payroll_mst.BASIC_SAL if not installed
let payAsOf = null;
try {
  ({ payAsOf } = require('./salRevPay'));
} catch {
  /* salary revisions not installed */
}
const path = require('path');

// ---- adjust these to your schema if names differ --------------------
const JOB_SQL = 'SELECT JOB_NO, PROJ_NAME FROM job_card ORDER BY JOB_NO DESC';
const HOLIDAY_SQL = 'SELECT DATE_FORMAT(HOL_DATE, "%Y-%m-%d") AS D FROM holiday_mst WHERE HOL_DATE BETWEEN ? AND ?';
const DEFAULT_SHIFT = 'GEN';
const ATT_MODULE = 'TIMESHEET';
const UPLOAD_DIR = process.env.TSHT_UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'timesheets');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || '';
// The screen gives up at 120 s: main model gets 60 s, the fallback model 45 s.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000;
const GEMINI_FALLBACK_TIMEOUT_MS = Number(process.env.GEMINI_FALLBACK_TIMEOUT_MS) || 45000;
// Thinking makes card reads very slow. Gemini 3.x uses a thinking LEVEL
// (minimal | low | medium | high); Gemini 2.5 uses a thinking BUDGET (0 = off).
const GEMINI_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'minimal';
const GEMINI_THINKING_BUDGET = process.env.GEMINI_THINKING_BUDGET !== undefined ? Number(process.env.GEMINI_THINKING_BUDGET) : 0;
/** thinkingConfig for a model, or null if the model has no known thinking control */
const thinkingConfigFor = (model) => {
  if (/gemini-2\.5/.test(model)) return { thinkingBudget: GEMINI_THINKING_BUDGET };
  if (/gemini-[3-9]/.test(model)) return { thinkingLevel: GEMINI_THINKING_LEVEL };
  return null;
};
// Card photos are shrunk to this long edge before sending (needs the optional 'sharp' package)
const CARD_MAX_EDGE_PX = Number(process.env.TSHT_CARD_MAX_EDGE) || 1800;
let sharp = null;
try {
  sharp = require('sharp'); // optional: npm install sharp
} catch {
  console.warn('[tsht] sharp not installed — card images are sent to Gemini at full size (slower). Run: npm install sharp');
}
// AI read: a stamp before this time (minutes) can be the Out of the previous day's shift
const CARRY_BEFORE_MIN = Number(process.env.TSHT_CARRY_BEFORE_MIN) || 300; // 05:00
const STAMP_COLS = ['AM_IN', 'AM_OUT', 'PM_IN', 'PM_OUT', 'OT_IN', 'OT_OUT'];
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// time_sheet_hdr month totals — saved in Draft, frozen after Time approval
//   hours as Hrs:Min text (e.g. "176:30"), wages to 2 decimals
const HRS_COLS = ['TOT_NORMAL_HRS', 'TOT_NOT_HRS', 'TOT_HOT_HRS'];
const WAGE_COLS = ['NORMAL_WAGES', 'NOT_WAGES', 'HOT_WAGES', 'TOTAL_SALARY'];
const TOT_COLS = [...HRS_COLS, ...WAGE_COLS];
/** minutes -> "H:MM" (hours not limited to 24), e.g. 10590 -> "176:30" */
const totHrsMin = (mins) => `${Math.floor((Number(mins) || 0) / 60)}:${String((Number(mins) || 0) % 60).padStart(2, '0')}`;
// ---------------------------------------------------------------------

// ---------- time helpers ----------
const toMin = (t) => {
  if (t === null || t === undefined || t === '') return null;
  const m = String(t).trim().match(/^(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
};
const toTime = (m) =>
  m === null || m === undefined ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
const hhmm = (m) => (m === null || m === undefined ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
const pad2 = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const padEmp = (c) => String(c || '').trim().toUpperCase().padStart(4, '0').slice(-4);
const tsNoOf = (tshtDate, empCode) => `${tshtDate.slice(0, 7)}-${padEmp(empCode)}`;
const userOf = (req) =>
  (req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) || (req.body && req.body.user) || 'system';
/** Users allowed to revoke approvals. Taken from the login token only — never from the request body. */
const REVOKE_USERS = ['admin'];
const canRevokeUser = (req) => {
  const u = req.user && (req.user.USER_NAME || req.user.username || req.user.user_name);
  return !!u && REVOKE_USERS.includes(String(u).trim().toLowerCase());
};

function parseMonth(tshtDate) {
  const m = String(tshtDate || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { y, mo, first: `${m[1]}-${m[2]}-01`, last: `${m[1]}-${m[2]}-${pad2(daysInMonth(y, mo))}`, days: daysInMonth(y, mo) };
}

// ---------- shift rules ----------
function prepShift(r) {
  const breaks = [
    [r.LUNCH_FROM, r.LUNCH_TO],
    [r.TEA1_FROM, r.TEA1_TO],
    [r.TEA2_FROM, r.TEA2_TO],
  ]
    .map(([a, b]) => [toMin(a), toMin(b)])
    .filter(([a, b]) => a !== null && b !== null && b > a);
  return {
    code: r.SHIFT_CODE,
    sin: toMin(r.SHIFT_IN),
    sout: toMin(r.SHIFT_OUT),
    inEarly: Number(r.IN_EARLY_MRG) || 0,
    inLate: Number(r.IN_LATE_MRG) || 0,
    outEarly: Number(r.OUT_EARLY_MRG) || 0,
    outLate: Number(r.OUT_LATE_MRG) || 0,
    std: Number(r.STD_MINS) || 480,
    otBreak: r.OT_BREAK_DEDUCT === 'Y',
    round: Math.max(1, Number(r.OT_ROUND_MINS) || 1),
    lateFromMrg: r.LATE_FROM_MRG === 'Y',
    weekOff: Number(r.WEEK_OFF_DAY) || 1,
    breaks,
  };
}
const breakMins = (from, to, sh) => sh.breaks.reduce((t, [f, e]) => t + overlap(from, to, f, e), 0);

/**
 * One day's figures from In/Out and the shift rules.
 *  - Week off / holiday: all worked minutes are Holiday OT.
 *  - Margins snap In/Out to the shift times (e.g. 07:50-08:10 -> 08:00).
 *  - Breaks are always deducted from regular time; from OT only if OT_BREAK_DEDUCT = 'Y'.
 *  - OT is rounded down to OT_ROUND_MINS.
 */
function calcDay(date, timeIn, timeOut, sh, holidays, otEligible, outMinOverride) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() + 1; // 1 = Sunday (MySQL DAYOFWEEK)
  const isWeekOff = dow === sh.weekOff;
  const isHol = isWeekOff || holidays.has(date);
  const res = {
    dayType: isWeekOff ? 'S' : holidays.has(date) ? 'H' : 'W',
    effIn: null, effOut: null, normalHrs: 0, normalOt: 0, holidayOt: 0, lateMins: 0, shortMins: 0, error: null,
  };
  const i = toMin(timeIn);
  const o = outMinOverride !== undefined && outMinOverride !== null ? outMinOverride : toMin(timeOut);
  if (i === null && o === null) {
    if (!isHol) res.dayType = 'A';
    return res;
  }
  if (i === null || o === null) {
    res.error = i === null ? 'In time missing' : 'Out time missing';
    return res;
  }
  if (o <= i) {
    res.error = 'Out must be after In';
    return res;
  }
  const roundDown = (m) => Math.floor(m / sh.round) * sh.round;

  if (isHol) {
    let w = o - i;
    if (sh.otBreak) w -= breakMins(i, o, sh);
    res.effIn = i;
    res.effOut = o;
    res.holidayOt = otEligible ? roundDown(Math.max(0, w)) : 0;
    return res;
  }

  const effIn = i >= sh.sin - sh.inEarly && i <= sh.sin + sh.inLate ? sh.sin : i;
  const effOut = o >= sh.sout - sh.outEarly && o <= sh.sout + sh.outLate ? sh.sout : o;
  res.effIn = effIn;
  res.effOut = effOut;

  const rs = Math.max(effIn, sh.sin);
  const re = Math.min(effOut, sh.sout);
  if (re > rs) res.normalHrs = Math.min(sh.std, Math.max(0, re - rs - breakMins(rs, re, sh)));

  let ot = 0;
  if (effIn < sh.sin) {
    const e = Math.min(sh.sin, effOut);
    ot += e - effIn - (sh.otBreak ? breakMins(effIn, e, sh) : 0);
  }
  if (effOut > sh.sout) {
    const s = Math.max(sh.sout, effIn);
    ot += effOut - s - (sh.otBreak ? breakMins(s, effOut, sh) : 0);
  }
  res.normalOt = otEligible ? roundDown(Math.max(0, ot)) : 0;

  if (effIn > sh.sin) res.lateMins = Math.max(0, effIn - (sh.lateFromMrg ? sh.sin + sh.inLate : sh.sin));
  if (effOut < sh.sout) res.shortMins = Math.max(0, (sh.lateFromMrg ? sh.sout - sh.outEarly : sh.sout) - effOut);
  return res;
}

/**
 * AI card read: every stamp per day → In / Out per day.
 *  - Stamps of a day are sorted by time; In = first, Out = last (one stamp only: In, Out missing).
 *  - Carry-over: when a day's first stamp is before CARRY_BEFORE_MIN (05:00) and the day before has
 *    stamps, and either day has an odd number of stamps (an Out missing on one side), that early
 *    stamp is the Out of the previous day's shift. It becomes that day's Out — earlier than its In —
 *    and the screen splits it at midnight (23:59 + a 00:00 continuation row).
 *  - Day 1 cannot take a carry-over (the shift began last month) → marked to check.
 */
function stampsToDays(aiDays, monthDays) {
  const byDay = new Map();
  const meta = new Map();
  for (const d of aiDays || []) {
    const day = Number(d.day);
    if (!Number.isInteger(day) || day < 1 || day > monthDays) continue;
    const list = byDay.get(day) || [];
    for (const st of d.stamps || []) {
      const t = toMin(st.time);
      if (t === null) continue;
      if (list.some((x) => x.t === t)) continue; // same stamp read twice
      list.push({ t, manual: !!st.manual, late: !!st.late, col: st.col });
    }
    list.sort((a, b) => a.t - b.t);
    byDay.set(day, list);
    const m = meta.get(day) || { check: false, notes: [] };
    if (d.check) m.check = true;
    if (d.note) m.notes.push(String(d.note));
    meta.set(day, m);
  }
  const metaOf = (day) => {
    if (!meta.has(day)) meta.set(day, { check: false, notes: [] });
    return meta.get(day);
  };

  // early-morning stamp that ends the previous day's shift
  const carried = new Set(); // days whose Out was carried in from the next day
  for (let day = 1; day <= monthDays; day++) {
    const list = byDay.get(day) || [];
    if (!list.length || list[0].t >= CARRY_BEFORE_MIN) continue;
    const prev = byDay.get(day - 1) || [];
    const oddSomewhere = prev.length % 2 === 1 || list.length % 2 === 1;
    if (day === 1) {
      if (list.length % 2 === 1) {
        metaOf(1).check = true;
        metaOf(1).notes.push('Early stamp: prev month?');
      }
      continue;
    }
    if (!prev.length || !oddSomewhere || carried.has(day - 1)) continue;
    prev.push(list.shift()); // stays last → becomes the Out (after midnight)
    byDay.set(day - 1, prev);
    carried.add(day - 1);
  }

  const out = [];
  for (let day = 1; day <= monthDays; day++) {
    const list = byDay.get(day) || [];
    const m = meta.get(day) || { check: false, notes: [] };
    if (!list.length && !m.check) continue;
    const first = list[0];
    const last = list.length > 1 ? list[list.length - 1] : null;
    const notes = [];
    if (list.some((x) => x.late)) notes.push('Late stamp');
    if (list.some((x) => x.manual)) notes.push('Manual time');
    if (carried.has(day)) notes.push('Out next day');
    notes.push(...m.notes);
    out.push({
      dayNo: day,
      timeIn: first ? hhmm(first.t) : null,
      timeOut: last ? hhmm(last.t) : null,
      needsCheck: m.check || list.some((x) => x.manual),
      remarks: notes.join('; ').slice(0, 30) || null,
    });
  }
  return out;
}

/**
 * Continuation row (00:00 → out) of a shift that started the day before.
 * All minutes are OT, classified by the START day: week off / holiday → H.OT, else N.OT.
 * Never late, short or absent. dayType shows the row's own date (W / S / H).
 */
function calcCont(prevDate, ownDate, timeIn, timeOut, sh, holidays, otEligible) {
  const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() + 1;
  const prevHol = dowOf(prevDate) === sh.weekOff || holidays.has(prevDate);
  const ownWeekOff = dowOf(ownDate) === sh.weekOff;
  const res = {
    dayType: ownWeekOff ? 'S' : holidays.has(ownDate) ? 'H' : 'W',
    effIn: null, effOut: null, normalHrs: 0, normalOt: 0, holidayOt: 0, lateMins: 0, shortMins: 0, error: null,
  };
  const i = toMin(timeIn) ?? 0;
  const o = toMin(timeOut);
  if (o === null) {
    res.error = 'Out time missing';
    return res;
  }
  if (o <= i) {
    res.error = 'Out must be after In';
    return res;
  }
  let w = o - i;
  if (sh.otBreak) w -= breakMins(i, o, sh);
  const mins = otEligible ? Math.floor(Math.max(0, w) / sh.round) * sh.round : 0;
  res.effIn = i;
  res.effOut = o;
  if (prevHol) res.holidayOt = mins;
  else res.normalOt = mins;
  return res;
}

module.exports = function timeSheetApi(connection) {
  const router = express.Router();
  const db = connection.promise();
  // card images travel as base64 — needs a bigger body limit than the default
  router.use('/tsht', express.json({ limit: '30mb' }));

  // ---------- shared loaders ----------
  async function loadShifts(conn = db) {
    const [rows] = await conn.query('SELECT * FROM shift_mst');
    const map = new Map();
    rows.forEach((r) => map.set(r.SHIFT_CODE, prepShift(r)));
    return map;
  }
  async function loadHolidays(month, conn = db) {
    try {
      const [rows] = await conn.query(HOLIDAY_SQL, [month.first, month.last]);
      return new Set(rows.map((r) => r.D));
    } catch (e) {
      console.warn('[tsht] holiday_mst not read:', e.code || e.message);
      return new Set();
    }
  }
  async function loadEmp(empCode, conn = db) {
    const [rows] = await conn.query(
      `SELECT e.EMP_CODE, e.EMP_NAME, e.CARD_NO, p.BASIC_SAL, p.SHIFT_CODE, p.OT_ELIGIBLE
         FROM emp_mst e LEFT JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
        WHERE e.EMP_CODE = ?`,
      [padEmp(empCode)],
    );
    return rows[0] || null;
  }

  /**
   * Builds one full month of computed rows from the screen's rows.
   * Rows are matched by day no.; a day may have a continuation row (contFlag 'C', listed first)
   * and its regular row(s). Day "last + 1" may hold the continuation of the last day's shift.
   * SEQ_NO is renumbered per day: continuation first, then regular rows.
   */
  async function computeSheet({ tshtDate, empCode, rows }, conn = db) {
    const month = parseMonth(tshtDate);
    if (!month) throw httpErr(400, 'Invalid month');
    const emp = await loadEmp(empCode, conn);
    if (!emp) throw httpErr(404, `Employee ${padEmp(empCode)} not found`);
    const shifts = await loadShifts(conn);
    const holidays = await loadHolidays(month, conn);
    const empShift = emp.SHIFT_CODE || DEFAULT_SHIFT;
    const otEligible = emp.OT_ELIGIBLE !== 'N';
    const dateOf = (d) => {
      const x = new Date(Date.UTC(month.y, month.mo - 1, d));
      return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
    };
    const shiftOf = (code) => {
      const sh = shifts.get(code);
      if (!sh) throw httpErr(400, `Shift ${code} not found in shift_mst`);
      return sh;
    };

    // split the screen rows into continuation and regular rows per day (in seq order)
    const contByDay = new Map();
    const regByDay = new Map();
    (rows || [])
      .map((r) => ({ ...r, dayNo: Number(r.dayNo), seqNo: Number(r.seqNo) || 1 }))
      .sort((a, b) => a.dayNo - b.dayNo || a.seqNo - b.seqNo)
      .forEach((r) => {
        const isCont = r.contFlag === 'C';
        if (!Number.isInteger(r.dayNo) || r.dayNo < 1) return;
        if (r.dayNo > month.days + (isCont ? 1 : 0)) return;
        if (isCont && r.dayNo === 1) return; // would belong to last month's sheet
        const m = isCont ? contByDay : regByDay;
        if (!m.has(r.dayNo)) m.set(r.dayNo, []);
        m.get(r.dayNo).push(r);
      });

    const out = [];
    for (let d = 1; d <= month.days + 1; d++) {
      const date = dateOf(d);
      let seq = 0;

      // continuation of the shift that started the day before
      for (const c of contByDay.get(d) || []) {
        const prevRows = regByDay.get(d - 1) || [];
        const prevSrc = prevRows[prevRows.length - 1] || {};
        const shiftCode = c.shiftCode || prevSrc.shiftCode || empShift;
        const calc = calcCont(dateOf(d - 1), date, c.timeIn, c.timeOut, shiftOf(shiftCode), holidays, otEligible);
        out.push({
          dayNo: d,
          seqNo: ++seq,
          contFlag: 'C',
          attDate: date,
          timeIn: hhmm(toMin(c.timeIn) ?? 0),
          timeOut: hhmm(toMin(c.timeOut)),
          shiftCode,
          jobNo: c.jobNo || null,
          remarks: c.remarks ? String(c.remarks).slice(0, 30) : null,
          needsCheck: !!c.needsCheck || !!calc.error,
          ...calc,
        });
      }
      if (d > month.days) break; // day "last + 1" holds only a continuation

      const regs = regByDay.get(d) || [{}];
      const nextHasCont = (contByDay.get(d + 1) || []).length > 0;
      regs.forEach((src, idx) => {
        const shiftCode = src.shiftCode || empShift;
        const isLastReg = idx === regs.length - 1;
        // runs on past midnight: 23:59 counts as 24:00 so no minute is lost at the split
        const outOverride = isLastReg && nextHasCont && toMin(src.timeOut) === 23 * 60 + 59 ? 24 * 60 : undefined;
        const calc = calcDay(date, src.timeIn, src.timeOut, shiftOf(shiftCode), holidays, otEligible, outOverride);
        out.push({
          dayNo: d,
          seqNo: ++seq,
          contFlag: null,
          attDate: date,
          timeIn: hhmm(toMin(src.timeIn)),
          timeOut: hhmm(toMin(src.timeOut)),
          shiftCode,
          jobNo: src.jobNo || null,
          remarks: src.remarks ? String(src.remarks).slice(0, 30) : null,
          needsCheck: !!src.needsCheck || !!calc.error,
          ...calc,
        });
      });
    }
    return { month, emp, rows: out };
  }

  /** "Day 15" or "Day 15 (cont.)" for messages */
  const dayLabel = (r) => `Day ${r.dayNo}${r.contFlag === 'C' ? ' (cont.)' : ''}`;
  /** stored dtl row -> screen row */
  const dtlToRow = (r) => ({
    dayNo: r.DAY_NO, seqNo: r.SEQ_NO, contFlag: r.CONT_FLAG, timeIn: r.TIME_IN, timeOut: r.TIME_OUT,
    shiftCode: r.SHIFT_CODE, jobNo: r.JOB_NO, remarks: r.REMARKS,
  });

  function httpErr(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }
  const send = (res, e) => {
    if (!e.status) console.error('[tsht]', e);
    res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : e.sqlMessage || e.message });
  };

  // ---------- lookups (job / allowance / deduction / shift lists) ----------
  router.get('/tsht/lookups', async (req, res) => {
    try {
      const [allowCodes] = await db.query('SELECT ALLOW_CODE, ALLOW_DESC, ALLOW_TYPE FROM allow_mst ORDER BY ALLOW_CODE');
      const [dedCodes] = await db.query('SELECT DED_CODE, DED_DESC, DED_TYPE FROM ded_mst ORDER BY DED_CODE');
      const [shifts] = await db.query('SELECT SHIFT_CODE, SHIFT_NAME FROM shift_mst WHERE ACTIVE_FLAG = "Y" ORDER BY SHIFT_CODE');
      let jobs = [];
      try {
        [jobs] = await db.query(JOB_SQL);
      } catch (e) {
        console.warn('[tsht] job_card not read:', e.code || e.message);
      }
      res.json({ ok: true, allowCodes, dedCodes, shifts, jobs, canRevoke: canRevokeUser(req) });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- employees ----------
  router.get('/tsht/employees', async (req, res) => {
    try {
      const q = `%${String(req.query.q || '').trim()}%`;
      const [rows] = await db.query(
        `SELECT e.EMP_CODE, e.EMP_NAME, e.CARD_NO, p.BASIC_SAL, p.SHIFT_CODE, p.OT_ELIGIBLE
           FROM emp_mst e LEFT JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
          WHERE e.EMP_CODE LIKE ? OR e.EMP_NAME LIKE ? OR e.CARD_NO LIKE ?
          ORDER BY e.EMP_CODE LIMIT 300`,
        [q, q, q],
      );
      res.json({ ok: true, rows });
    } catch (e) {
      send(res, e);
    }
  });

  router.get('/tsht/employee/:code', async (req, res) => {
    try {
      const emp = await loadEmp(req.params.code);
      if (!emp) return res.status(404).json({ ok: false, error: `Employee ${padEmp(req.params.code)} not found` });
      res.json({ ok: true, emp });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- list (for InfoGrid / month review) ----------
  router.get('/tsht/list', async (req, res) => {
    try {
      const where = [];
      const args = [];
      if (req.query.year && req.query.month) {
        where.push('h.TSHT_DATE = ?');
        args.push(`${req.query.year}-${pad2(req.query.month)}-01`);
      }
      const [rows] = await db.query(
        `SELECT h.TSHT_NO, DATE_FORMAT(h.TSHT_DATE, '%Y-%m-%d') AS TSHT_DATE, h.EMP_CODE, e.EMP_NAME,
                CASE h.STATUS
                  WHEN 'D' THEN 'Draft'
                  WHEN 'T' THEN 'Time Approved'
                  WHEN 'A' THEN 'Job Approved'
                  ELSE h.STATUS
                END AS STATUS,
                h.STATUS AS STATUS_CODE,
                ${TOT_COLS.map((c) => `h.${c}`).join(', ')}
           FROM time_sheet_hdr h
           JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY h.TSHT_DATE DESC, h.EMP_CODE`,
        args,
      );
      //  res.json({ ok: true, rows });
      res.json(rows);
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- load one sheet ----------
  router.get('/tsht/sheet/:no', async (req, res) => {
    try {
      const no = req.params.no;
      const [h] = await db.query(
        `SELECT TSHT_NO, DATE_FORMAT(TSHT_DATE, '%Y-%m-%d') AS TSHT_DATE, EMP_CODE, REMARKS, STATUS,
                CREATED_BY, EDITED_BY, TIME_APPR_BY, APPROVED_BY
           FROM time_sheet_hdr WHERE TSHT_NO = ?`,
        [no],
      );
      if (!h.length) return res.status(404).json({ ok: false, error: `Time sheet ${no} not found` });
      const hdr = h[0];
      const emp = await loadEmp(hdr.EMP_CODE);
      const [dtl] = await db.query(
        `SELECT DAY_NO, SEQ_NO, CONT_FLAG, DATE_FORMAT(ATT_DATE, '%Y-%m-%d') AS ATT_DATE,
                TIME_FORMAT(TIME_IN, '%H:%i') AS TIME_IN, TIME_FORMAT(TIME_OUT, '%H:%i') AS TIME_OUT,
                SHIFT_CODE, JOB_NO, NORMAL_HRS, NORMAL_OT, HOLIDAY_OT, REMARKS
           FROM time_sheet_dtl WHERE TSHT_NO = ? ORDER BY DAY_NO, SEQ_NO`,
        [no],
      );
      const [allow] = await db.query(
        `SELECT a.ALLOW_CODE AS CODE, m.ALLOW_DESC AS DESCR, m.ALLOW_TYPE AS TYPE, a.AMOUNT, a.REMARKS
           FROM tsht_allow a LEFT JOIN allow_mst m ON m.ALLOW_CODE = a.ALLOW_CODE
          WHERE a.TSHT_NO = ? ORDER BY a.srno_row_id`,
        [no],
      );
      const [ded] = await db.query(
        `SELECT a.DED_CODE AS CODE, m.DED_DESC AS DESCR, m.DED_TYPE AS TYPE, a.AMOUNT, a.REMARKS
           FROM tsht_ded a LEFT JOIN ded_mst m ON m.DED_CODE = a.DED_CODE
          WHERE a.TSHT_NO = ? ORDER BY a.srno_row_id`,
        [no],
      );
      // late / short / day type are not stored: recompute them for display
      const calc = await computeSheet({
        tshtDate: hdr.TSHT_DATE,
        empCode: hdr.EMP_CODE,
        rows: dtl.map(dtlToRow),
      });
      res.json({ ok: true, hdr, emp, rows: calc.rows, allow, ded, canRevoke: canRevokeUser(req) });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- calculate (Recalculate button, after AI read, after edits) ----------
  router.post('/tsht/calc', async (req, res) => {
    try {
      const { rows } = await computeSheet(req.body);
      res.json({ ok: true, rows });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- stored rows of one sheet, recalculated ----------
  async function loadStoredSheet(no, conn = db, lock = false) {
    const [h] = await conn.query(
      `SELECT DATE_FORMAT(TSHT_DATE, "%Y-%m-%d") AS TSHT_DATE, EMP_CODE, STATUS FROM time_sheet_hdr WHERE TSHT_NO = ?${lock ? ' FOR UPDATE' : ''}`,
      [no],
    );
    if (!h.length) throw httpErr(404, `Time sheet ${no} not found`);
    const [dtl] = await conn.query(
      `SELECT DAY_NO, SEQ_NO, CONT_FLAG, TIME_FORMAT(TIME_IN, '%H:%i') AS TIME_IN, TIME_FORMAT(TIME_OUT, '%H:%i') AS TIME_OUT,
              SHIFT_CODE, JOB_NO, REMARKS FROM time_sheet_dtl WHERE TSHT_NO = ? ORDER BY DAY_NO, SEQ_NO`,
      [no],
    );
    const calc = await computeSheet(
      {
        tshtDate: h[0].TSHT_DATE,
        empCode: h[0].EMP_CODE,
        rows: dtl.map(dtlToRow),
      },
      conn,
    );
    return { hdr: h[0], calc };
  }

  // ---------- save ----------
  // STATUS D (Draft)         : header, days, allowances and deductions are replaced
  // STATUS T (Time approved) : only JOB_NO of each day is updated
  // STATUS A (Job approved)  : refused
  router.post('/tsht/save', async (req, res) => {
    const { mode, tshtDate, empCode, remarks, allow = [], ded = [] } = req.body || {};
    const user = String(userOf(req)).slice(0, 20);
    let conn;
    try {
      const month = parseMonth(tshtDate);
      if (!month) throw httpErr(400, 'Invalid month');
      const no = tsNoOf(month.first, empCode);

      conn = await db.getConnection();
      await conn.beginTransaction();

      const [ex] = await conn.query('SELECT STATUS FROM time_sheet_hdr WHERE TSHT_NO = ? FOR UPDATE', [no]);
      if (mode === 'ADD' && ex.length) throw httpErr(409, `Time sheet ${no} already exists — open it in EDIT`);
      if (mode !== 'ADD' && !ex.length) throw httpErr(404, `Time sheet ${no} not found`);
      const status = ex.length ? ex[0].STATUS : 'D';
      if (status === 'A') throw httpErr(423, `Time sheet ${no} is job-approved and locked`);

      // ---- Time approved: Job No only ----
      if (status === 'T') {
        const validJobs = new Set();
        try {
          const [jobs] = await conn.query(JOB_SQL);
          jobs.forEach((j) => validJobs.add(j.JOB_NO));
        } catch {
          /* job_card not readable: skip the check */
        }
        for (const r of req.body.rows || []) {
          const jobNo = r.jobNo ? String(r.jobNo).trim().slice(0, 20) : null;
          if (jobNo && validJobs.size && !validJobs.has(jobNo)) throw httpErr(400, `${dayLabel(r)}: Job No ${jobNo} not found in job_card`);
          await conn.execute('UPDATE time_sheet_dtl SET JOB_NO = ? WHERE TSHT_NO = ? AND DAY_NO = ? AND SEQ_NO = ?', [
            jobNo, no, Number(r.dayNo), Number(r.seqNo) || 1,
          ]);
        }
        await conn.execute('UPDATE time_sheet_hdr SET EDITED_BY = ?, EDITED_DT = NOW() WHERE TSHT_NO = ?', [user, no]);
        const { calc } = await loadStoredSheet(no, conn);
        await conn.commit();
        return res.json({ ok: true, tshtNo: no, status: 'T', rows: calc.rows });
      }

      // ---- Draft: full save ----
      const codesOk = (list, label) => {
        const seen = new Set();
        list.forEach((r) => {
          const c = Number(r.code);
          if (!Number.isInteger(c)) throw httpErr(400, `${label}: code missing on a row`);
          if (seen.has(c)) throw httpErr(400, `${label}: code ${c} entered twice`);
          if (!(Number(r.amount) >= 0)) throw httpErr(400, `${label}: invalid amount for code ${c}`);
          seen.add(c);
        });
      };
      codesOk(allow, 'Allowances');
      codesOk(ded, 'Deductions');
      const calc = await computeSheet({ tshtDate: month.first, empCode, rows: req.body.rows }, conn);
      const bad = calc.rows.find((r) => r.error);
      if (bad) throw httpErr(400, `${dayLabel(bad)}: ${bad.error}`);

      // month totals → time_sheet_hdr: hours as Hrs:Min from the calculated days, wages from the screen
      const sumMins = (k) => calc.rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
      const wages = req.body.totals || {};
      const totVals = [
        totHrsMin(sumMins('normalHrs')),
        totHrsMin(sumMins('normalOt')),
        totHrsMin(sumMins('holidayOt')),
        ...WAGE_COLS.map((c) => Math.round((Number(wages[c]) || 0) * 100) / 100),
      ];

      if (mode === 'ADD') {
        await conn.execute(
          `INSERT INTO time_sheet_hdr
             (TSHT_NO, TSHT_DATE, EMP_CODE, REMARKS, STATUS, CREATED_BY, ${TOT_COLS.join(', ')})
           VALUES (?, ?, ?, ?, 'D', ?, ${TOT_COLS.map(() => '?').join(', ')})`,
          [no, month.first, calc.emp.EMP_CODE, remarks || null, user, ...totVals],
        );
      } else {
        await conn.execute(
          `UPDATE time_sheet_hdr
              SET REMARKS = ?, EDITED_BY = ?, EDITED_DT = NOW(), ${TOT_COLS.map((c) => `${c} = ?`).join(', ')}
            WHERE TSHT_NO = ?`,
          [remarks || null, user, ...totVals, no],
        );
      }

      await conn.execute('DELETE FROM time_sheet_dtl WHERE TSHT_NO = ?', [no]);
      for (const r of calc.rows) {
        await conn.execute(
          `INSERT INTO time_sheet_dtl
             (TSHT_NO, ATT_DATE, DAY_NO, SEQ_NO, CONT_FLAG, TIME_IN, TIME_OUT, SHIFT_CODE, JOB_NO, NORMAL_HRS, NORMAL_OT, HOLIDAY_OT, REMARKS)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            no, r.attDate, r.dayNo, r.seqNo, r.contFlag, toTime(toMin(r.timeIn)), toTime(toMin(r.timeOut)),
            r.shiftCode, r.jobNo, r.normalHrs, r.normalOt, r.holidayOt, r.remarks,
          ],
        );
      }

      await conn.execute('DELETE FROM tsht_allow WHERE TSHT_NO = ?', [no]);
      for (const a of allow) {
        await conn.execute(
          'INSERT INTO tsht_allow (TSHT_NO, TSHT_DATE, EMP_CODE, ALLOW_CODE, AMOUNT, REMARKS, CREATED_BY) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [no, month.first, calc.emp.EMP_CODE, Number(a.code), Number(a.amount) || 0, a.remarks ? String(a.remarks).slice(0, 100) : null, user],
        );
      }
      await conn.execute('DELETE FROM tsht_ded WHERE TSHT_NO = ?', [no]);
      for (const a of ded) {
        await conn.execute(
          'INSERT INTO tsht_ded (TSHT_NO, TSHT_DATE, EMP_CODE, DED_CODE, AMOUNT, REMARKS, CREATED_BY) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [no, month.first, calc.emp.EMP_CODE, Number(a.code), Number(a.amount) || 0, a.remarks ? String(a.remarks).slice(0, 100) : null, user],
        );
      }

      await conn.commit();
      res.json({ ok: true, tshtNo: no, status: 'D', rows: calc.rows });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => { });
      if (e.code === 'ER_DUP_ENTRY') e = httpErr(409, 'This time sheet was just saved by another user — reopen it in EDIT');
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------- Time approval: D -> T (recalculate stored rows, freeze times) ----------
  router.post('/tsht/time-approve/:no', async (req, res) => {
    const no = req.params.no;
    const user = String(userOf(req)).slice(0, 20);
    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();
      const { hdr, calc } = await loadStoredSheet(no, conn, true);
      if (hdr.STATUS !== 'D') throw httpErr(409, `Time sheet ${no} is already time-approved`);
      const bad = calc.rows.find((r) => r.error);
      if (bad) throw httpErr(400, `${dayLabel(bad)}: ${bad.error}`);
      for (const r of calc.rows) {
        await conn.execute(
          'UPDATE time_sheet_dtl SET NORMAL_HRS = ?, NORMAL_OT = ?, HOLIDAY_OT = ? WHERE TSHT_NO = ? AND DAY_NO = ? AND SEQ_NO = ?',
          [r.normalHrs, r.normalOt, r.holidayOt, no, r.dayNo, r.seqNo],
        );
      }
      await conn.execute('UPDATE time_sheet_hdr SET STATUS = "T", TIME_APPR_BY = ?, TIME_APPR_DT = NOW() WHERE TSHT_NO = ?', [user, no]);
      await conn.commit();
      res.json({ ok: true, tshtNo: no, status: 'T', rows: calc.rows });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => { });
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------- Job approval: T -> A (every worked day needs a Job No, then lock) ----------
  router.post('/tsht/job-approve/:no', async (req, res) => {
    const no = req.params.no;
    const user = String(userOf(req)).slice(0, 20);
    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();
      const { hdr, calc } = await loadStoredSheet(no, conn, true);
      if (hdr.STATUS === 'D') throw httpErr(409, `Approve the time for ${no} first`);
      if (hdr.STATUS === 'A') throw httpErr(409, `Time sheet ${no} is already job-approved`);
      const noJob = [...new Set(calc.rows.filter((r) => r.normalHrs + r.normalOt + r.holidayOt > 0 && !r.jobNo).map((r) => r.dayNo))];
      if (noJob.length) throw httpErr(400, `Enter a Job No on every worked day first (days ${noJob.join(', ')})`);
      await conn.execute('UPDATE time_sheet_hdr SET STATUS = "A", APPROVED_BY = ?, APPROVED_DT = NOW() WHERE TSHT_NO = ?', [user, no]);
      await conn.commit();
      res.json({ ok: true, tshtNo: no, status: 'A', rows: calc.rows });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => { });
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------- Revoke approval (admin only): A -> T, or T -> D ----------
  // Steps back one approval at a time, so a job-approved sheet needs two revokes to reach Draft.
  // The approver columns of the revoked step are cleared; REVOKED_BY / REVOKED_DT keep who did it.
  router.post('/tsht/revoke/:no', async (req, res) => {
    const no = req.params.no;
    let conn;
    try {
      if (!canRevokeUser(req)) throw httpErr(403, 'Only admin can revoke approvals');
      const user = String(userOf(req)).slice(0, 20);
      conn = await db.getConnection();
      await conn.beginTransaction();
      const { hdr } = await loadStoredSheet(no, conn, true);
      let newStatus;
      if (hdr.STATUS === 'A') {
        newStatus = 'T';
        await conn.execute(
          'UPDATE time_sheet_hdr SET STATUS = "T", APPROVED_BY = NULL, APPROVED_DT = NULL, REVOKED_BY = ?, REVOKED_DT = NOW() WHERE TSHT_NO = ?',
          [user, no],
        );
      } else if (hdr.STATUS === 'T') {
        newStatus = 'D';
        await conn.execute(
          'UPDATE time_sheet_hdr SET STATUS = "D", TIME_APPR_BY = NULL, TIME_APPR_DT = NULL, REVOKED_BY = ?, REVOKED_DT = NOW() WHERE TSHT_NO = ?',
          [user, no],
        );
      } else {
        throw httpErr(409, `Time sheet ${no} is a draft — nothing to revoke`);
      }
      const { calc } = await loadStoredSheet(no, conn);
      await conn.commit();
      console.log(`[tsht] ${user} revoked ${hdr.STATUS === 'A' ? 'job' : 'time'} approval of ${no}`);
      res.json({ ok: true, tshtNo: no, status: newStatus, rows: calc.rows });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => { });
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------- payslips of processed sheets (Payslip Print list) ----------
  /** Month totals exactly as useTimeSheet builds them on the screen. */
  function sheetTotals(rows, allow, ded) {
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const dayRows = rows.filter((r) => r.contFlag !== 'C');
    const days = (fn) => new Set(dayRows.filter(fn).map((r) => r.dayNo)).size;
    return {
      normalHrs: sum('normalHrs'),
      normalOt: sum('normalOt'),
      holidayOt: sum('holidayOt'),
      lateMins: sum('lateMins'),
      shortMins: sum('shortMins'),
      workDays: days((r) => r.dayType === 'W' && r.normalHrs > 0),
      offDays: days((r) => (r.dayType === 'S' || r.dayType === 'H') && !r.holidayOt),
      absentDays: days((r) => r.dayType === 'A'),
      lateDays: days((r) => r.lateMins > 0),
      allow: allow.reduce((a, r) => a + (Number(r.AMOUNT) || 0), 0),
      ded: ded.reduce((a, r) => a + (Number(r.AMOUNT) || 0), 0),
    };
  }

  router.post('/tsht/payslips', async (req, res) => {
    try {
      const nos = Array.isArray(req.body && req.body.nos) ? req.body.nos.map(String).slice(0, 500) : [];
      if (!nos.length) throw httpErr(400, 'No time sheets selected');
      const slips = [];
      const skipped = [];
      for (const no of nos) {
        const [h] = await db.query(
          `SELECT TSHT_NO, DATE_FORMAT(TSHT_DATE, '%Y-%m-%d') AS TSHT_DATE, EMP_CODE, STATUS FROM time_sheet_hdr WHERE TSHT_NO = ?`,
          [no],
        );
        if (!h.length) {
          skipped.push(`${no}: not found`);
          continue;
        }
        const hdr = h[0];
        if (hdr.STATUS !== 'T' && hdr.STATUS !== 'A') {
          skipped.push(`${no}: not processed (draft)`);
          continue;
        }
        const { calc } = await loadStoredSheet(no);
        const [allow] = await db.query(
          `SELECT a.ALLOW_CODE AS CODE, m.ALLOW_DESC AS DESCR, a.AMOUNT, a.REMARKS
             FROM tsht_allow a LEFT JOIN allow_mst m ON m.ALLOW_CODE = a.ALLOW_CODE
            WHERE a.TSHT_NO = ? ORDER BY a.srno_row_id`,
          [no],
        );
        const [ded] = await db.query(
          `SELECT a.DED_CODE AS CODE, m.DED_DESC AS DESCR, a.AMOUNT, a.REMARKS
             FROM tsht_ded a LEFT JOIN ded_mst m ON m.DED_CODE = a.DED_CODE
            WHERE a.TSHT_NO = ? ORDER BY a.srno_row_id`,
          [no],
        );
        const emp = calc.emp;
        let basic = emp.BASIC_SAL;
        if (payAsOf) {
          try {
            basic = (await payAsOf((c, sql, params) => c.query(sql, params).then(([rows]) => rows), db, emp.EMP_CODE, hdr.TSHT_DATE)).basic;
          } catch (e) {
            console.warn('[tsht] payslips: month basic not read, using payroll_mst:', e.code || e.message);
          }
        }
        const line = (a) => ({ code: a.CODE, descr: a.DESCR || '', amount: Number(a.AMOUNT) || 0, remarks: a.REMARKS || '' });
        slips.push({
          tshtNo: hdr.TSHT_NO,
          tshtDate: hdr.TSHT_DATE,
          status: 'A', // processed: pay is fixed once the time is approved (same as the sheet's Print Payslip)
          employee: { EMP_CODE: emp.EMP_CODE, EMP_NAME: emp.EMP_NAME, CARD_NO: emp.CARD_NO, SHIFT_CODE: emp.SHIFT_CODE, BASIC_SAL: basic },
          totals: sheetTotals(calc.rows, allow, ded),
          allowances: allow.map(line),
          deductions: ded.map(line),
        });
      }
      res.json({ ok: true, slips, skipped });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- delete (draft only) ----------
  router.delete('/tsht/sheet/:no', async (req, res) => {
    try {
      const [h] = await db.query('SELECT STATUS FROM time_sheet_hdr WHERE TSHT_NO = ?', [req.params.no]);
      if (!h.length) return res.status(404).json({ ok: false, error: 'Not found' });
      if (h[0].STATUS !== 'D') return res.status(423).json({ ok: false, error: 'Approved time sheets cannot be deleted' });
      await db.query('DELETE FROM time_sheet_hdr WHERE TSHT_NO = ?', [req.params.no]); // dtl / allow / ded cascade
      res.json({ ok: true });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- AI card read (Gemini) ----------
  /** Shrinks one card photo (JPEG, long edge CARD_MAX_EDGE_PX). Returns the original if sharp is missing or fails. */
  async function shrinkCardImage(im) {
    const mime = im.mime || 'image/jpeg';
    const data = String(im.data || '').replace(/^data:[^,]+,/, '');
    if (!sharp || !/^image\//.test(mime)) return { mime, data };
    try {
      const out = await sharp(Buffer.from(data, 'base64'))
        .rotate() // honour the phone's EXIF orientation
        .resize({ width: CARD_MAX_EDGE_PX, height: CARD_MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      return { mime: 'image/jpeg', data: out.toString('base64') };
    } catch (e) {
      console.warn('[tsht] image shrink failed, sending original:', e.message);
      return { mime, data };
    }
  }

  router.post('/tsht/ai-read', async (req, res) => {
    const startedAt = Date.now();
    const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    let clientClosed = false;
    let currentCall = null; // AbortController of the Gemini call in progress
    // browser cancelled / timed out -> stop waiting for Gemini too
    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        if (currentCall) currentCall.abort('client-closed');
      }
    });

    try {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw httpErr(500, 'GEMINI_API_KEY is not set on the server');
      const { images = [], tshtDate } = req.body || {};
      const month = parseMonth(tshtDate);
      if (!month) throw httpErr(400, 'Select the month first');
      if (!images.length) throw httpErr(400, 'No card images sent');

      const sentKb = Math.round(images.reduce((t, im) => t + String(im.data || '').length, 0) * 0.75 / 1024);
      const cardImages = await Promise.all(images.map(shrinkCardImage));
      const geminiKb = Math.round(cardImages.reduce((t, im) => t + im.data.length, 0) * 0.75 / 1024);
      console.log(`[tsht] ai-read: ${images.length} image(s), ${sentKb} KB received, ${geminiKb} KB to Gemini, month ${month.y}-${pad2(month.mo)}`);

      const prompt = `These are photos of a monthly punch time card. An employee may have two cards: days 1-15 and days 16-31. The operator selected ${MONTH_NAMES[month.mo - 1]} ${month.y}.

HEADER
- The card No. is written in bold at the top left (e.g. "03", "06"). Return it as "cardNo" exactly as written, keeping leading zeros. Return the name written beside it as "name".
- Return the month and year written on the card as "cardMonth" (1-12) and "cardYear" (4 digits), or null if not written.

CARD LAYOUT
- One row per day. Each row has SIX stamp columns, left to right:
  AM_IN (A.M. In), AM_OUT (A.M. Out), PM_IN (P.M. In), PM_OUT (P.M. Out), OT_IN (Overtime In), OT_OUT (Overtime Out).
- READ ALL SIX COLUMNS. An employee who stays late is stamped in the OVERTIME columns (e.g. OT_OUT "20:26") — that stamp is part of the day and must be returned. Do not skip the Overtime columns.
- The time clock prints the DAY NUMBER rotated 90 degrees (sideways) immediately to the LEFT of each time, e.g. a sideways "17" followed by "07:56". It may also look like "1707:56" or "17 07:56".
  Use that printed day number to decide which day the stamp belongs to — stamps are often printed slightly off their row. If it differs from the row, trust the printed day number.
  NEVER make the sideways day number part of the time.

WHAT TO RETURN for every day 1-${month.days} that has any stamp:
- "day": the day number.
- "stamps": EVERY stamp of that day, each as { "col": one of AM_IN, AM_OUT, PM_IN, PM_OUT, OT_IN, OT_OUT, "time": "HH:MM" (24-hour) }.
  Handwritten times count — set "manual": true on that stamp. A stamp printed in red means late — set "late": true.
  Return the stamps exactly as printed on that day; do not move a stamp to another day and do not decide which one is In or Out.
- If a digit is unclear, give your best reading and set "check": true on the day with a short "note" (max 25 chars).
Days with no stamps can be left out. Return only JSON.`;

      const responseSchema = {
        type: 'OBJECT',
        properties: {
          cardNo: { type: 'STRING', nullable: true },
          name: { type: 'STRING', nullable: true },
          cardMonth: { type: 'INTEGER', nullable: true },
          cardYear: { type: 'INTEGER', nullable: true },
          days: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                day: { type: 'INTEGER' },
                stamps: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      col: { type: 'STRING', enum: STAMP_COLS },
                      time: { type: 'STRING' },
                      manual: { type: 'BOOLEAN' },
                      late: { type: 'BOOLEAN' },
                    },
                    required: ['col', 'time'],
                  },
                },
                check: { type: 'BOOLEAN' },
                note: { type: 'STRING', nullable: true },
              },
              required: ['day', 'stamps'],
            },
          },
        },
        required: ['days'],
      };
      const imageParts = cardImages.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } }));

      /** One Gemini call. Returns the parsed JSON, or throws (e.status, e.thinkingRejected). */
      async function askGemini(model, timeoutMs, useThinkingConfig) {
        const generationConfig = { temperature: 0, responseMimeType: 'application/json', responseSchema };
        const thinkingConfig = useThinkingConfig ? thinkingConfigFor(model) : null;
        if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
        const body = { contents: [{ parts: [{ text: prompt }, ...imageParts] }], generationConfig };

        const call = new AbortController();
        currentCall = call;
        const timer = setTimeout(() => call.abort('timeout'), timeoutMs);
        const t0 = Date.now();
        try {
          let r;
          try {
            r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, // key in a header, not the URL
              body: JSON.stringify(body),
              signal: call.signal,
            });
          } catch (e) {
            if (call.signal.reason === 'client-closed') throw httpErr(499, 'cancelled by the screen');
            if (call.signal.reason === 'timeout') throw httpErr(504, `${model} did not answer within ${timeoutMs / 1000} s`);
            throw httpErr(502, `Could not reach Gemini: ${e.message}`);
          }
          const rawText = await r.text();
          let j;
          try {
            j = JSON.parse(rawText);
          } catch {
            throw httpErr(502, `${model} returned an unreadable reply (HTTP ${r.status})`);
          }
          if (!r.ok) {
            const message = (j.error && j.error.message) || String(r.status);
            const err = httpErr(502, `${model}: ${message}`);
            // a model that does not accept this thinking setting: retry without it
            err.thinkingRejected = r.status === 400 && /thinking/i.test(message);
            throw err;
          }
          const candidate = (j.candidates || [])[0] || {};
          if (!candidate.content && candidate.finishReason) throw httpErr(502, `${model} stopped without an answer (${candidate.finishReason}) — try a clearer photo`);
          const text = (candidate.content || { parts: [] }).parts.map((p) => p.text || '').join('');
          try {
            const parsed = JSON.parse(text);
            console.log(`[tsht] ${model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s${thinkingConfig ? ` (thinking ${JSON.stringify(thinkingConfig)})` : ''}`);
            return parsed;
          } catch {
            throw httpErr(502, `Could not read the ${model} response — try a clearer photo`);
          }
        } finally {
          clearTimeout(timer);
          if (currentCall === call) currentCall = null;
        }
      }

      // main model first, then the fallback model from .env
      const attempts = [{ model: GEMINI_MODEL, timeoutMs: GEMINI_TIMEOUT_MS }];
      if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
        attempts.push({ model: GEMINI_FALLBACK_MODEL, timeoutMs: GEMINI_FALLBACK_TIMEOUT_MS });
      }

      let parsed = null;
      let usedModel = '';
      let lastError = null;
      for (const attempt of attempts) {
        if (clientClosed) break;
        try {
          try {
            parsed = await askGemini(attempt.model, attempt.timeoutMs, true);
          } catch (e) {
            if (!e.thinkingRejected) throw e;
            console.warn(`[tsht] ${attempt.model} rejected the thinking setting — retrying without it`);
            parsed = await askGemini(attempt.model, attempt.timeoutMs, false);
          }
          usedModel = attempt.model;
          break;
        } catch (e) {
          lastError = e;
          if (e.status === 499) break; // screen cancelled
          console.warn(`[tsht] ${attempt.model} failed after ${elapsed()}: ${e.message}`);
        }
      }

      if (clientClosed) {
        console.warn(`[tsht] ai-read cancelled by the screen after ${elapsed()}`);
        return; // nobody is waiting for a reply
      }
      if (!parsed) {
        const tried = attempts.map((a) => a.model).join(' and ');
        throw httpErr(lastError && lastError.status === 504 ? 504 : 502, `AI read failed (${tried}): ${lastError ? lastError.message : 'no answer'}`);
      }

      const days = stampsToDays(parsed.days, month.days);

      const cardMonth = Number.isInteger(parsed.cardMonth) && parsed.cardMonth >= 1 && parsed.cardMonth <= 12 ? parsed.cardMonth : null;
      const cardYear = Number.isInteger(parsed.cardYear) && parsed.cardYear >= 2000 && parsed.cardYear <= 2100 ? parsed.cardYear : null;

      console.log(`[tsht] ai-read done in ${elapsed()} with ${usedModel}: card ${parsed.cardNo || '?'}, ${days.filter((d) => d.timeIn || d.timeOut).length} day(s) with stamps`);
      res.json({
        ok: true,
        cardNo: parsed.cardNo ? String(parsed.cardNo).trim() : null,
        name: parsed.name || null,
        cardMonth,
        cardYear,
        days,
        model: usedModel,
        seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      });
    } catch (e) {
      console.warn(`[tsht] ai-read failed after ${elapsed()}:`, e.message);
      if (!res.headersSent && !clientClosed) send(res, e);
    }
  });

  // ---------- card attachments (doc_attachments) ----------
  router.get('/tsht/attach/:no', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ID, FILE_NAME, FILE_EXT, FILE_SIZE, MIME_TYPE, REMARKS, UPLOADED_BY, UPLOADED_AT
           FROM doc_attachments WHERE MODULE = ? AND REF_NO = ? ORDER BY ID`,
        [ATT_MODULE, req.params.no],
      );
      res.json({ ok: true, rows });
    } catch (e) {
      send(res, e);
    }
  });

  router.post('/tsht/attach/:no', async (req, res) => {
    try {
      const no = req.params.no;
      const user = String(userOf(req)).slice(0, 30);
      const files = (req.body && req.body.files) || [];
      if (!files.length) throw httpErr(400, 'No files sent');
      const dir = path.join(UPLOAD_DIR, no.slice(0, 4), no.slice(5, 7));
      fs.mkdirSync(dir, { recursive: true });
      const saved = [];
      for (const f of files) {
        const buf = Buffer.from(String(f.data).replace(/^data:[^,]+,/, ''), 'base64');
        const ext = (path.extname(f.name || '').slice(1) || 'jpg').toLowerCase().slice(0, 10);
        const stored = `${no}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
        fs.writeFileSync(path.join(dir, stored), buf);
        const [r] = await db.execute(
          `INSERT INTO doc_attachments (MODULE, REF_NO, FILE_NAME, STORED_NAME, FILE_EXT, FILE_SIZE, MIME_TYPE, REMARKS, UPLOADED_BY)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ATT_MODULE, no, String(f.name || stored).slice(0, 200), stored, ext, buf.length, f.mime || null, f.remarks ? String(f.remarks).slice(0, 200) : null, user],
        );
        saved.push({ ID: r.insertId, FILE_NAME: f.name, STORED_NAME: stored });
      }
      res.json({ ok: true, saved });
    } catch (e) {
      send(res, e);
    }
  });

  router.get('/tsht/attach-file/:id', async (req, res) => {
    try {
      const [rows] = await db.query('SELECT REF_NO, FILE_NAME, STORED_NAME, MIME_TYPE FROM doc_attachments WHERE ID = ? AND MODULE = ?', [
        req.params.id,
        ATT_MODULE,
      ]);
      if (!rows.length) return res.status(404).end();
      const r = rows[0];
      const file = path.join(UPLOAD_DIR, r.REF_NO.slice(0, 4), r.REF_NO.slice(5, 7), path.basename(r.STORED_NAME));
      if (!fs.existsSync(file)) return res.status(404).end();
      res.setHeader('Content-Type', r.MIME_TYPE || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.FILE_NAME)}"`);
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      send(res, e);
    }
  });

  router.delete('/tsht/attach/:id', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT a.REF_NO, a.STORED_NAME, h.STATUS FROM doc_attachments a
           LEFT JOIN time_sheet_hdr h ON h.TSHT_NO = a.REF_NO
          WHERE a.ID = ? AND a.MODULE = ?`,
        [req.params.id, ATT_MODULE],
      );
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      if (rows[0].STATUS === 'T' || rows[0].STATUS === 'A') return res.status(423).json({ ok: false, error: 'Time sheet is approved — card images can no longer be removed' });
      await db.query('DELETE FROM doc_attachments WHERE ID = ?', [req.params.id]);
      const r = rows[0];
      fs.rm(path.join(UPLOAD_DIR, r.REF_NO.slice(0, 4), r.REF_NO.slice(5, 7), path.basename(r.STORED_NAME)), () => { });
      res.json({ ok: true });
    } catch (e) {
      send(res, e);
    }
  });

  return router;
};

// exported for tests
module.exports.calcDay = calcDay;
module.exports.calcCont = calcCont;
module.exports.stampsToDays = stampsToDays;
module.exports.prepShift = prepShift;
