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
//   POST /tsht/revoke/:no        role 'admin' only: A -> T, T -> D  (REVOKED_BY / REVOKED_DT)
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
// 03-Nov-2026: approved leaves (leave_appl, via tsLeaveDays.js) — every calendar day inside an
//   approved / resumed leave becomes dayType 'L' (Sundays and holidays too, as leave is in calendar
//   days) instead of Absent / Weekly off / Holiday. Each row carries leaveNo, leaveName and leavePay
//   (A annual · F full · H half · U unpaid), which drive the salary (PayslipPrint.calcSalary).
//   Punches on a leave day: the day is calculated as worked and marked "to check".
//   Leaves are not stored on the sheet — every calculation reads them afresh.
// 03-Nov-2026: salary calculation scheme (sal_scheme_mst, routes/salSchemeApi.js).
//   computeSheet returns `scheme`: a Draft uses the employee category's scheme (or the default);
//   a Time / Job approved sheet keeps the scheme stored on it (time_sheet_hdr.SAL_SCHEME).
//   /tsht/save stores the scheme in Draft. /tsht/payslips sends it inside totals (totals.scheme)
//   with monthDays and allowFixed, so PayslipPrint.calcSalary gives the same figures as the screen.
// 03-Nov-2026: Normal / N.OT / H.OT of every row rounded to the nearest 5 minutes (2.5 min rounds up):
//   2:57 → 2:55, 2:58 → 3:00, 2:59 → 3:00, 3:09 → 3:10. Punched In / Out times stay as on the card.
//   Applies to every sheet (time sheets start Sep 2026). TSHT_ROUND_FROM=yyyy-mm-01 in .env limits
//   it to sheets from that month on. A sheet approved before rounding: revoke, Recalculate, Save and
//   approve again, so its stored totals carry the rounded hours too.
// 07-Nov-2026:
//   - Continuation row (00:00 → out after a shift past midnight): minutes are classified by the row's
//     OWN date — weekly off / holiday → H.OT, working day → N.OT (was: by the day the shift started).
//   - Several In / Out pairs on one day: late is judged on the day's first regular row only, short
//     on its last regular row only. A second pair (e.g. back at 23:45 for overtime) is no longer
//     "late" against the 08:00 shift start.
//   - Late / short no longer count break time: short = time from Out to shift end LESS the breaks in
//     it (lunch / tea not worked are not "short"), late likewise. So Normal + Late + Short = the
//     standard day (8:00) — e.g. 08:00–13:00 with lunch 12:30–13:30: Normal 4:15, Short 3:45
//     (was 4:30, so 45 minutes too much was deducted).
//   - Half day (later the same day): an employee who leaves before the end of lunch (shift_mst
//     LUNCH_FROM / LUNCH_TO, now 13:00–14:00) is not cut the morning tea break — 08:00–13:00 = Normal
//     5:00; staying into lunch adds nothing (lunch is unpaid), so 08:00–13:30 is also 5:00.
//     On a day with one In / Out pair, Short = standard day − Normal − Late, so the hours still add
//     up to 8:00 (08:00–13:00 → Short 3:00).
//   - Hours edited by hand: Normal / N.OT / H.OT of a row can be typed on the screen (Draft only).
//     The row comes with hrsEdited = true and its own normalHrs / normalOt / holidayOt (minutes);
//     computeSheet keeps them instead of the calculated figures, after validation (applyHrsEdit):
//       · In and Out must be punched; hours ≥ 0; Normal ≤ standard day (STD_MINS)
//       · weekly off / holiday / ↪ continuation row: no Normal, no N.OT (H.OT only on an off day)
//       · working day: no H.OT
//       · no OT for an employee who is not OT eligible
//       · Normal + N.OT + H.OT ≤ the time between In and Out
//     A failing row gets row.error, so Save / Time approval are refused until it is corrected.
//     On a working day with one In / Out pair, Short follows the edited Normal: 8:00 − Normal − Late.
//     Stored in time_sheet_dtl.HRS_EDITED ('Y'); edited hours are not rounded to 5 minutes.
//     Changing In / Out on the screen clears the flag (the row is calculated again).
//     DB: ALTER TABLE time_sheet_dtl ADD COLUMN HRS_EDITED CHAR(1) NULL AFTER HOLIDAY_OT;
// 07-Nov-2026: Attendance Register and Absent / Short Time Register (screens AttRegister, AbsentRegister)
//   GET /tsht/reg-catg                      employee categories (emp_catg_mst) for the filter
//   GET /tsht/register?month=YYYY-MM&catg=W&approved=Y
//     every time sheet of the month (optionally one category, optionally Time / Job approved only),
//     each recalculated exactly as when it is opened (loadStoredSheet), summed per day:
//       mark  P present · A absent · WO weekly off · H holiday · OW worked on a weekly off / holiday
//             L leave (paid) · UL unpaid leave · ? day with an error (punch missing etc.)
//       late / short minutes, Normal / N.OT / H.OT (↪ rows count on their own date)
//     plus month totals per employee. Both registers use this one route.
// 07-Nov-2026: leave pay from leave_type_mst.PAY_FLAG, read in tsLeaveDays.js (no hard-coded PAY_TYPE
//     mapping): PAY_FLAG N → U (unpaid, deducted) · Y → A when IS_ANNUAL = 'Y', else F (paid).
//     leave_pay_type_mst and the applyLeavePayFlags patch here are no longer used.
// 07-Nov-2026: register days also carry leaveType and leavePay (Leave Register, LeaveRegister.tsx).
// 08-Nov-2026: salary snapshot on time_sheet_hdr — a month's pay is frozen on its own sheet, so a
//   payslip of an old month never picks up a later increment from payroll_mst / salary revisions.
//   SNAP_COLS (BASIC_SAL, HOURLY_RATE, DAYS_IN_MONTH, DAY_RATE, RATE_EFF_DATE) saved in Draft from
//   req.body.totals beside the wages; SAL_SCHEME was already stored. The basic the screen used is
//   checked against the basic in force for the month (monthPay): a mismatch is refused (409) so a
//   salary revision entered meanwhile cannot slip into an approved sheet with stale figures.
//   /tsht/sheet returns the snapshot in hdr; /tsht/payslips uses the stored BASIC_SAL.
//   tsht_allow / tsht_ded.SRC_FLAG: 'M' = line from the employee master, 'U' = added / changed on the sheet.
//   Revoke of the time approval is refused once the month's Salary JV has posted the sheet (JV_POSTED_SQL).
//   DB:
//     ALTER TABLE time_sheet_hdr
//       ADD COLUMN BASIC_SAL DECIMAL(12,3) NULL, ADD COLUMN HOURLY_RATE DECIMAL(10,2) NULL,
//       ADD COLUMN DAYS_IN_MONTH TINYINT NULL, ADD COLUMN DAY_RATE DECIMAL(10,2) NULL,
//       ADD COLUMN RATE_EFF_DATE DATE NULL;
//     ALTER TABLE tsht_allow ADD COLUMN SRC_FLAG CHAR(1) NOT NULL DEFAULT 'M';
//     ALTER TABLE tsht_ded   ADD COLUMN SRC_FLAG CHAR(1) NOT NULL DEFAULT 'M';
// 09-Nov-2026: employee start date in the month — absent / late / short count only from it:
//   emp_mst.APPT_DT (joining) and hr_mst.LAST_RESUME_DT (back from leave), read by loadEmp.
//   · date < APPT_DT        → dayType 'J' (before joining): never absent, late or short; not paid
//                              (PayslipPrint: "Before joining" deduction at the day rate).
//   · date < LAST_RESUME_DT → a day not already on an approved leave becomes annual leave
//     (dayType 'L', leavePay 'A' — paid by Leave Salary, taken off the month like any annual leave).
//   Only days with no punch change type; late / short is cleared on every day before the start date.
//   Totals / payslips: notJoinedDays. Registers: mark 'NJ'.
// 09-Nov-2026: several In / Out lines on one date — Late / Short judged PER LINE (any employee, any date,
//   however the user splits the times):
//   · Late  — the day's first line (earliest In) only: shift start → In, breaks not counted.
//   · Short — every line: from its Out to the next line's In when that line starts inside the shift,
//     else to the shift end; breaks inside the gap not counted. e.g. 07:58–11:40 + 15:41–20:30 →
//     A gap that runs across the lunch break is split there: the part before lunch is Short on the
//     earlier line (left early), the part after lunch is Short on the later line (came back late).
//     e.g. 07:58–11:40 + 15:41–20:30 → line 1 Short 1:20 (11:40→13:00), line 2 Short 1:41 (14:00→15:41).
//     A gap that does not cross lunch stays on the earlier line. A single line keeps the old rule
//     (Short = standard day − Normal − late), so a half day still adds up to 8:00.
//   · Half day (morning tea not cut) only for a line that leaves before the end of lunch and does not
//     come back inside the shift — a line followed by another in-shift line has all its breaks cut.
//   · A later line starting at / after the shift end (e.g. back at 23:45) is flagged afterShift —
//     the screen labels it "Overtime after regular shift"; the line before it is short to the shift end.
// 11-Nov-2026: earned format — /tsht/save stores EARNED_BASIC, EARNED_ALLOW, ATT_DED, ROUND_OFF (SNAP_COLS),
//   /tsht/list returns them, /tsht/payslips sends each allowance line's type (fixed lines are prorated).
//   DB: ALTER TABLE time_sheet_hdr ADD COLUMN EARNED_BASIC DECIMAL(12,2) NULL AFTER BASIC_SAL,
//         ADD COLUMN EARNED_ALLOW DECIMAL(12,2) NULL AFTER EARNED_BASIC, ADD COLUMN ATT_DED DECIMAL(12,2) NULL AFTER EARNED_ALLOW,
//         ADD COLUMN ROUND_OFF DECIMAL(6,2) NULL AFTER ATT_DED;   (EARNED_BASIC / ROUND_OFF already added)
// 08-Nov-2026: payroll month close (payrollPeriod.js) — a month whose payroll is closed refuses Save,
//   Time approval, revoke to Draft, delete and card images; a month whose job allocation is closed
//   refuses Job approval, revoke of the Job approval and Job No changes (423).
// =====================================================================
const express = require('express');
const { loadLeaveDays } = require('./tsLeaveDays');
const { loadScheme, resolveScheme } = require('./salSchemeApi');
const { assertPayrollOpen, assertJobAllocOpen } = require('./payrollPeriod');
/** query function for the payroll-period checks, on a mysql2 promise connection / pool */
const runOn = (c) => (sql, params) => c.query(sql, params).then(([rows]) => rows);
/** 1st of the month of a time sheet no. (yyyy-mm-EMP) */
const monthOfNo = (no) => `${String(no).slice(0, 7)}-01`;
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
// employee category: emp_mst column and master (registers)
const EMP_CATG_COL = 'EMP_CATG';
const CATG_SQL = 'SELECT CATG_CODE, CATG_NAME FROM emp_catg_mst ORDER BY CATG_CODE';
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
/** first sheet month whose hours are rounded to 5 minutes */
const ROUND_FROM = process.env.TSHT_ROUND_FROM || '2000-01-01';
const ROUND_TO = 5; // minutes
/** nearest 5 minutes, the half-way point (x.5) rounds up: 27 → 25, 28 → 30, 179 → 180 */
const round5 = (m) => (Number(m) > 0 ? Math.floor((Number(m) + ROUND_TO / 2) / ROUND_TO) * ROUND_TO : Number(m) || 0);
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// time_sheet_hdr month totals — saved in Draft, frozen after Time approval
//   hours as Hrs:Min text (e.g. "176:30"), wages to 2 decimals
const HRS_COLS = ['TOT_NORMAL_HRS', 'TOT_NOT_HRS', 'TOT_HOT_HRS'];
const WAGE_COLS = ['NORMAL_WAGES', 'NOT_WAGES', 'HOT_WAGES', 'TOTAL_SALARY'];
const TOT_COLS = [...HRS_COLS, ...WAGE_COLS];
// salary snapshot — the pay the month was calculated with (SAL_SCHEME is stored separately)
// 11-Nov-2026: earned figures for the Salary Register — Earned basic + Earned allow + N.OT + H.OT
//   − ATT_DED (late / short + absent) − the sheet's deductions + ROUND_OFF = TOTAL_SALARY
const SNAP_COLS = ['BASIC_SAL', 'HOURLY_RATE', 'DAYS_IN_MONTH', 'DAY_RATE', 'RATE_EFF_DATE', 'EARNED_BASIC', 'EARNED_ALLOW', 'ATT_DED', 'ROUND_OFF'];
/** Salary JV posted for this sheet? (tran_acc tran type 15, Narration 2 = TSHT_NO). Adjust to your schema. */
const JV_POSTED_SQL = 'SELECT 1 FROM tran_acc WHERE TRAN_TYPE = 15 AND NARRATION2 = ? LIMIT 1';
const srcFlag = (v) => (v === 'U' ? 'U' : 'M');
const num = (v, dec) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Math.round(Number(v) * 10 ** dec) / 10 ** dec);
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
/**
 * Roles allowed to revoke approvals (09-Nov-2026: by ROLE, no longer by the user name 'admin').
 * Taken from the login token only (req.user.role, signed at login) — never from the request body.
 */
const REVOKE_ROLES = ['admin'];
const canRevokeUser = (req) => {
  const role = req.user && (req.user.role || req.user.ROLE);
  return !!role && REVOKE_ROLES.includes(String(role).trim().toLowerCase());
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
    lunchFrom: toMin(r.LUNCH_FROM),
    lunchTo: toMin(r.LUNCH_TO), // leaving by the end of lunch = half day: morning tea not cut
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
function calcDay(date, timeIn, timeOut, sh, holidays, otEligible, outMinOverride, judge = { late: true, short: true }) {
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
  if (re > rs) {
    // half day — left before the end of lunch: the morning tea break is not cut; only the part of
    // the lunch hour he stayed through (unpaid) comes off, so 13:00 and 13:30 both give 5:00
    const halfDay = judge.halfDay !== false && sh.lunchFrom !== null && sh.lunchTo !== null && effOut <= sh.lunchTo;
    const brk = halfDay ? overlap(rs, re, sh.lunchFrom, sh.lunchTo) : breakMins(rs, re, sh);
    res.normalHrs = Math.min(sh.std, Math.max(0, re - rs - brk));
  }

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

  // late / short: only on the day's first (late) / last (short) In-Out pair; breaks inside the
  // missed time are not counted, so Normal + Late + Short adds up to the standard day
  if (judge.late && effIn > sh.sin) {
    const from = sh.lateFromMrg ? sh.sin + sh.inLate : sh.sin;
    res.lateMins = Math.max(0, effIn - from - breakMins(from, effIn, sh));
  }
  if (judge.gapFrom !== null && judge.gapFrom !== undefined && effIn > judge.gapFrom) {
    // came back late after lunch: from the end of lunch to this line's In, breaks not counted
    res.shortMins += Math.max(0, effIn - judge.gapFrom - breakMins(judge.gapFrom, effIn, sh));
  }
  if (judge.short && judge.shortTo !== null && judge.shortTo !== undefined) {
    // a later line of the day starts inside the shift: short = the gap up to its In, breaks not counted
    const to = Math.min(judge.shortTo, sh.sout);
    if (effOut < to) res.shortMins += Math.max(0, to - effOut - breakMins(effOut, to, sh));
  } else if (judge.short && effOut < sh.sout) {
    if (judge.late && !judge.multi) {
      // one In / Out pair: short = standard day − normal − late (as worked from the shift start),
      // so Normal + Late + Short = 8:00 even when a break was not cut (half day)
      const lateRaw = effIn > sh.sin ? Math.max(0, effIn - sh.sin - breakMins(sh.sin, effIn, sh)) : 0;
      res.shortMins = Math.max(0, sh.std - res.normalHrs - lateRaw);
    } else {
      // last of several pairs: time from Out to shift end, breaks in it not counted
      const to = sh.lateFromMrg ? sh.sout - sh.outEarly : sh.sout;
      res.shortMins += Math.max(0, to - effOut - breakMins(effOut, to, sh));
    }
  }
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
 * All minutes are OT, classified by the row's OWN date (07-Nov-2026): weekly off / holiday → H.OT,
 * working day → N.OT. Never late, short or absent. dayType shows the row's own date (W / S / H).
 * prevDate is kept in the signature for callers; it no longer decides N.OT / H.OT.
 */
function calcCont(prevDate, ownDate, timeIn, timeOut, sh, holidays, otEligible) {
  const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() + 1;
  const ownWeekOff = dowOf(ownDate) === sh.weekOff;
  const ownHol = ownWeekOff || holidays.has(ownDate);
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
  if (ownHol) res.holidayOt = mins; // the hours fall on a weekly off / holiday
  else res.normalOt = mins;
  return res;
}

/** Edited minutes from the screen: a whole number ≥ 0, else null. */
const editedMins = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * Hours typed on the screen for one row (src.hrsEdited): validated, then they replace the calculated
 * Normal / N.OT / H.OT in `calc`. A broken rule sets calc.error (Save / approval are refused).
 *   isCont    ↪ continuation row (00:00 → out): OT only
 *   onlyPair  the day has one In / Out pair → Short follows the edited Normal
 */
function applyHrsEdit(src, calc, sh, otEligible, isCont, onlyPair) {
  calc.hrsEdited = true;
  const n = editedMins(src.normalHrs);
  const not = editedMins(src.normalOt);
  const hot = editedMins(src.holidayOt);
  if (n === null || not === null || hot === null) {
    calc.error = 'Edited hours: enter them as H:MM';
    return;
  }
  calc.normalHrs = n;
  calc.normalOt = not;
  calc.holidayOt = hot;
  const offDay = calc.dayType === 'S' || calc.dayType === 'H';
  const span = calc.effIn !== null && calc.effOut !== null ? calc.effOut - calc.effIn : null;
  let err = null;
  if (span === null || calc.error) err = calc.error || 'Edited hours: punch In and Out first';
  else if (n > sh.std) err = `Edited hours: Normal is more than ${hhmm(sh.std)}`;
  else if (n && (offDay || isCont)) err = isCont ? 'Edited hours: no Normal on a continuation row' : 'Edited hours: no Normal on a weekly off / holiday';
  else if (not && offDay) err = 'Edited hours: use H.OT on a weekly off / holiday';
  else if (hot && !offDay) err = 'Edited hours: H.OT only on a weekly off / holiday';
  else if ((not || hot) && !otEligible) err = 'Edited hours: employee is not OT eligible';
  else if (n + not + hot > span) err = `Edited hours: more than the In–Out time (${hhmm(span)})`;
  if (err) {
    calc.error = err;
    return;
  }
  // one pair on a working day: Short follows the edited Normal (Normal + Late + Short = standard day)
  if (!offDay && !isCont && onlyPair) calc.shortMins = Math.max(0, sh.std - n - (calc.lateMins || 0));
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * One employee's month for the registers: a mark per day plus month totals.
 * rows = computeSheet rows (continuation rows count on their own date; day "last + 1" only adds hours).
 */
function registerOf(rows, month) {
  const sumOf = (list, k) => list.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  const tot = {
    present: 0, absent: 0, weekOff: 0, holiday: 0, offWorked: 0, leave: 0, unpaidLeave: 0, toCheck: 0, notJoined: 0,
    lateDays: 0, shortDays: 0, lateMins: 0, shortMins: 0,
    normalHrs: sumOf(rows, 'normalHrs'), normalOt: sumOf(rows, 'normalOt'), holidayOt: sumOf(rows, 'holidayOt'),
  };
  const days = [];
  for (let d = 1; d <= month.days; d++) {
    const dayRows = rows.filter((r) => r.dayNo === d);
    const regs = dayRows.filter((r) => r.contFlag !== 'C');
    const first = regs[0] || {};
    const last = regs[regs.length - 1] || {};
    const punched = regs.some((r) => r.timeIn || r.timeOut);
    const err = regs.find((r) => r.error);
    const late = sumOf(regs, 'lateMins');
    const short = sumOf(regs, 'shortMins');
    const hot = sumOf(dayRows, 'holidayOt');
    let mark;
    if (err) mark = '?';
    else if (first.dayType === 'J') mark = 'NJ'; // before joining
    else if (first.dayType === 'L') mark = first.leavePay === 'U' ? 'UL' : 'L';
    else if (first.dayType === 'A') mark = 'A';
    // worked on an off day = a punch on the day itself (a ↪ row from the night before only adds hours)
    else if (first.dayType === 'S' || first.dayType === 'H') mark = punched ? 'OW' : first.dayType === 'S' ? 'WO' : 'H';
    else mark = punched ? 'P' : 'A';

    if (mark === 'P') tot.present++;
    else if (mark === 'A') tot.absent++;
    else if (mark === 'WO') tot.weekOff++;
    else if (mark === 'H') tot.holiday++;
    else if (mark === 'OW') tot.offWorked++;
    else if (mark === 'L') tot.leave++;
    else if (mark === 'UL') tot.unpaidLeave++;
    else if (mark === 'NJ') tot.notJoined++;
    else tot.toCheck++;
    if (late > 0) tot.lateDays++;
    if (short > 0) tot.shortDays++;
    tot.lateMins += late;
    tot.shortMins += short;

    const date = `${month.first.slice(0, 8)}${pad2(d)}`;
    days.push({
      dayNo: d,
      date,
      weekday: WEEKDAY_SHORT[new Date(`${date}T00:00:00Z`).getUTCDay()],
      mark,
      timeIn: first.timeIn || null,
      timeOut: last.timeOut || null,
      late,
      short,
      normalHrs: sumOf(dayRows, 'normalHrs'),
      normalOt: sumOf(dayRows, 'normalOt'),
      holidayOt: hot,
      leaveName: first.dayType === 'L' ? first.leaveName || null : null,
      leaveNo: first.leaveNo || null,
      // Leave Register: leave type code and pay (A annual · F paid · H half · U unpaid)
      leaveType: first.dayType === 'L' ? first.leaveType || null : null,
      leavePay: first.dayType === 'L' ? first.leavePay || null : null,
      remarks: (err && err.error) || first.remarks || null,
    });
  }
  return { days, tot };
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
      `SELECT e.EMP_CODE, e.EMP_NAME, e.CARD_NO, p.BASIC_SAL, p.SHIFT_CODE, p.OT_ELIGIBLE,
              DATE_FORMAT(e.APPT_DT, '%Y-%m-%d') AS APPT_DT,
              DATE_FORMAT(h.LAST_RESUME_DT, '%Y-%m-%d') AS LAST_RESUME_DT
         FROM emp_mst e
         LEFT JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
         LEFT JOIN hr_mst h ON h.EMP_CODE = e.EMP_CODE
        WHERE e.EMP_CODE = ?`,
      [padEmp(empCode)],
    );
    return rows[0] || null;
  }

  /** Basic in force for the month (salary revisions), else payroll_mst.BASIC_SAL. */
  async function monthPay(emp, monthFirst, conn = db) {
    let basic = Number(emp.BASIC_SAL) || 0;
    let effDate = null;
    if (payAsOf) {
      try {
        const p = await payAsOf((c, sql, params) => c.query(sql, params).then(([rows]) => rows), conn, emp.EMP_CODE, monthFirst);
        basic = Number(p.basic);
        effDate = p.effDate || p.EFF_DATE || null;
      } catch (e) {
        console.warn('[tsht] month basic not read, using payroll_mst:', e.code || e.message);
      }
    }
    return { basic, effDate };
  }

  /**
   * Builds one full month of computed rows from the screen's rows.
   * Rows are matched by day no.; a day may have a continuation row (contFlag 'C', listed first)
   * and its regular row(s). Day "last + 1" may hold the continuation of the last day's shift.
   * SEQ_NO is renumbered per day: continuation first, then regular rows.
   */
  async function computeSheet({ tshtDate, empCode, rows, schemeCode }, conn = db) {
    const month = parseMonth(tshtDate);
    if (!month) throw httpErr(400, 'Invalid month');
    const emp = await loadEmp(empCode, conn);
    if (!emp) throw httpErr(404, `Employee ${padEmp(empCode)} not found`);
    const shifts = await loadShifts(conn);
    const holidays = await loadHolidays(month, conn);
    const leaveDays = await loadLeaveDays(conn, emp.EMP_CODE, month.first, month.last);
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
        calc.hrsEdited = false;
        if (c.hrsEdited) applyHrsEdit(c, calc, shiftOf(shiftCode), otEligible, true, false);
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
      // approved leave on this date: no punches → leave day; punches → worked day, to check
      const leave = leaveDays.get(date) || null;
      const punchedOnLeave = !!leave && regs.some((r) => toMin(r.timeIn) !== null || toMin(r.timeOut) !== null);
      // before the employee's start date in this month: joining (APPT_DT) / back from leave (LAST_RESUME_DT)
      const punchedDay = regs.some((r) => toMin(r.timeIn) !== null || toMin(r.timeOut) !== null);
      const beforeJoin = !!emp.APPT_DT && date < emp.APPT_DT;
      const beforeResume = !beforeJoin && !!emp.LAST_RESUME_DT && date < emp.LAST_RESUME_DT;
      // lines of the date in time order (punched In and Out) — Late on the first, Short up to the next
      const timed = regs
        .map((r, idx) => ({ idx, i: toMin(r.timeIn), o: toMin(r.timeOut) }))
        .filter((x) => x.i !== null && x.o !== null)
        .sort((a, b) => a.i - b.i || a.idx - b.idx);
      const firstIdx = timed.length ? timed[0].idx : 0;
      regs.forEach((src, idx) => {
        const shiftCode = src.shiftCode || empShift;
        const isLastReg = idx === regs.length - 1;
        // runs on past midnight: 23:59 counts as 24:00 so no minute is lost at the split
        const outOverride = isLastReg && nextHasCont && toMin(src.timeOut) === 23 * 60 + 59 ? 24 * 60 : undefined;
        // per line: late on the day's first line, short up to the next in-shift line (or the shift end)
        const pos = timed.findIndex((x) => x.idx === idx);
        const next = pos >= 0 ? timed[pos + 1] : undefined;
        const shN = shiftOf(shiftCode);
        const nextInShift = !!next && next.i < shN.sout;
        const prev = pos > 0 ? timed[pos - 1] : undefined;
        const cur = pos >= 0 ? timed[pos] : undefined;
        // a gap running across the lunch break is split at it (before → earlier line, after → later line)
        const crossesLunch = (a, b) => shN.lunchTo !== null && a.o < shN.lunchTo && b.i > shN.lunchTo;
        const calc = calcDay(date, src.timeIn, src.timeOut, shiftOf(shiftCode), holidays, otEligible, outOverride, {
          late: idx === firstIdx,
          short: pos >= 0 || isLastReg,
          shortTo: nextInShift ? (crossesLunch(cur, next) ? shN.lunchTo : next.i) : null,
          gapFrom: prev && cur && cur.i < shN.sout && crossesLunch(prev, cur) ? shN.lunchTo : null,
          halfDay: !nextInShift, // morning tea uncut only when he does not come back inside the shift
          multi: timed.length > 1,
        });
        calc.hrsEdited = false;
        if (src.hrsEdited) applyHrsEdit(src, calc, shiftOf(shiftCode), otEligible, false, regs.length === 1);
        if (leave && !punchedOnLeave) calc.dayType = 'L';
        Object.assign(calc, {
          leaveNo: leave ? leave.leaveNo : null,
          leaveName: leave ? leave.leaveName : null,
          leaveType: leave ? leave.leaveType || null : null,
          leavePay: leave && !punchedOnLeave ? leave.leavePay : null,
          leaveConflict: punchedOnLeave,
        });
        // no absent / late / short before the start date
        if (beforeJoin || beforeResume) {
          calc.lateMins = 0;
          calc.shortMins = 0;
        }
        if (beforeJoin && !punchedDay) {
          calc.dayType = 'J'; // before joining — not employed yet, not paid
        } else if (beforeResume && !punchedDay && !leave) {
          // still on leave until the resume date — counted as annual leave (paid by Leave Salary)
          Object.assign(calc, {
            dayType: 'L',
            leavePay: 'A',
            leaveName: `Annual leave (resumed ${emp.LAST_RESUME_DT.slice(8, 10)}/${emp.LAST_RESUME_DT.slice(5, 7)})`,
            leaveType: null,
            leaveNo: null,
          });
        }
        out.push({
          dayNo: d,
          seqNo: ++seq,
          contFlag: null,
          attDate: date,
          timeIn: hhmm(toMin(src.timeIn)),
          timeOut: hhmm(toMin(src.timeOut)),
          shiftCode,
          jobNo: src.jobNo || null,
          remarks: src.remarks ? String(src.remarks).slice(0, 30) : calc.dayType === 'J' ? 'Before joining' : null,
          needsCheck: !!src.needsCheck || !!calc.error || punchedOnLeave,
          // a later pair starting at / after the shift end — overtime after the regular shift
          afterShift: idx > 0 && toMin(src.timeIn) !== null && toMin(src.timeIn) >= shiftOf(shiftCode).sout,
          ...calc,
        });
      });
    }
    // hours rounded to 5 minutes (sheets from ROUND_FROM on)
    if (month.first >= ROUND_FROM) {
      for (const r of out) {
        if (r.hrsEdited) continue; // hours typed by hand stay as entered
        r.normalHrs = round5(r.normalHrs);
        r.normalOt = round5(r.normalOt);
        r.holidayOt = round5(r.holidayOt);
      }
    }
    // salary scheme: the sheet's stored one (approved sheets) or the employee's current one
    const scheme = schemeCode ? await loadScheme(conn, schemeCode) : await resolveScheme(conn, emp.EMP_CODE);
    return { month, emp, rows: out, scheme };
  }

  /** "Day 15" or "Day 15 (cont.)" for messages */
  const dayLabel = (r) => `Day ${r.dayNo}${r.contFlag === 'C' ? ' (cont.)' : ''}`;
  /** stored dtl row -> screen row */
  const dtlToRow = (r) => ({
    dayNo: r.DAY_NO, seqNo: r.SEQ_NO, contFlag: r.CONT_FLAG, timeIn: r.TIME_IN, timeOut: r.TIME_OUT,
    shiftCode: r.SHIFT_CODE, jobNo: r.JOB_NO, remarks: r.REMARKS,
    // hours typed by hand are kept (others are recalculated from In / Out)
    hrsEdited: r.HRS_EDITED === 'Y',
    normalHrs: r.NORMAL_HRS, normalOt: r.NORMAL_OT, holidayOt: r.HOLIDAY_OT,
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

  router.get('/ts-ded-acc', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT acc_code AS ACC_CODE, acc_head AS ACC_HEAD
       FROM acc_mst WHERE report_ln = '12' AND gl_code = '1208'
      ORDER BY acc_code`);
  res.json(rows);
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
                ${TOT_COLS.map((c) => `h.${c}`).join(', ')}, h.EARNED_BASIC, h.EARNED_ALLOW, h.ATT_DED, h.ROUND_OFF
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
                CREATED_BY, EDITED_BY, TIME_APPR_BY, APPROVED_BY, SAL_SCHEME,
                BASIC_SAL, HOURLY_RATE, DAYS_IN_MONTH, DAY_RATE, DATE_FORMAT(RATE_EFF_DATE, '%Y-%m-%d') AS RATE_EFF_DATE
           FROM time_sheet_hdr WHERE TSHT_NO = ?`,
        [no],
      );
      if (!h.length) return res.status(404).json({ ok: false, error: `Time sheet ${no} not found` });
      const hdr = h[0];
      const emp = await loadEmp(hdr.EMP_CODE);
      const [dtl] = await db.query(
        `SELECT DAY_NO, SEQ_NO, CONT_FLAG, DATE_FORMAT(ATT_DATE, '%Y-%m-%d') AS ATT_DATE,
                TIME_FORMAT(TIME_IN, '%H:%i') AS TIME_IN, TIME_FORMAT(TIME_OUT, '%H:%i') AS TIME_OUT,
                SHIFT_CODE, JOB_NO, NORMAL_HRS, NORMAL_OT, HOLIDAY_OT, HRS_EDITED, REMARKS
           FROM time_sheet_dtl WHERE TSHT_NO = ? ORDER BY DAY_NO, SEQ_NO`,
        [no],
      );
      const [allow] = await db.query(
        `SELECT a.ALLOW_CODE AS CODE, m.ALLOW_DESC AS DESCR, m.ALLOW_TYPE AS TYPE, a.AMOUNT, a.REMARKS, a.SRC_FLAG
           FROM tsht_allow a LEFT JOIN allow_mst m ON m.ALLOW_CODE = a.ALLOW_CODE
          WHERE a.TSHT_NO = ? ORDER BY a.srno_row_id`,
        [no],
      );
      const [ded] = await db.query(
        `SELECT a.DED_CODE AS CODE, m.DED_DESC AS DESCR, m.DED_TYPE AS TYPE, a.AMOUNT, a.REMARKS, a.SRC_FLAG
           FROM tsht_ded a LEFT JOIN ded_mst m ON m.DED_CODE = a.DED_CODE
          WHERE a.TSHT_NO = ? ORDER BY a.srno_row_id`,
        [no],
      );
      // late / short / day type are not stored: recompute them for display
      const calc = await computeSheet({
        tshtDate: hdr.TSHT_DATE,
        empCode: hdr.EMP_CODE,
        rows: dtl.map(dtlToRow),
        schemeCode: hdr.STATUS !== 'D' ? hdr.SAL_SCHEME || 'A' : null, // approved: the scheme it was approved with
      });
      res.json({ ok: true, hdr, emp, rows: calc.rows, allow, ded, scheme: calc.scheme, canRevoke: canRevokeUser(req) });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- calculate (Recalculate button, after AI read, after edits) ----------
  router.post('/tsht/calc', async (req, res) => {
    try {
      const { rows, scheme } = await computeSheet({ ...req.body, schemeCode: null });
      res.json({ ok: true, rows, scheme });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- stored rows of one sheet, recalculated ----------
  async function loadStoredSheet(no, conn = db, lock = false) {
    const [h] = await conn.query(
      `SELECT DATE_FORMAT(TSHT_DATE, "%Y-%m-%d") AS TSHT_DATE, EMP_CODE, STATUS, SAL_SCHEME FROM time_sheet_hdr WHERE TSHT_NO = ?${lock ? ' FOR UPDATE' : ''}`,
      [no],
    );
    if (!h.length) throw httpErr(404, `Time sheet ${no} not found`);
    const [dtl] = await conn.query(
      `SELECT DAY_NO, SEQ_NO, CONT_FLAG, TIME_FORMAT(TIME_IN, '%H:%i') AS TIME_IN, TIME_FORMAT(TIME_OUT, '%H:%i') AS TIME_OUT,
              SHIFT_CODE, JOB_NO, NORMAL_HRS, NORMAL_OT, HOLIDAY_OT, HRS_EDITED, REMARKS
         FROM time_sheet_dtl WHERE TSHT_NO = ? ORDER BY DAY_NO, SEQ_NO`,
      [no],
    );
    const calc = await computeSheet(
      {
        tshtDate: h[0].TSHT_DATE,
        empCode: h[0].EMP_CODE,
        rows: dtl.map(dtlToRow),
        schemeCode: h[0].STATUS !== 'D' ? h[0].SAL_SCHEME || 'A' : null,
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
      if (status === 'T') await assertJobAllocOpen(runOn(conn), month.first, 'Changing Job No');
      else await assertPayrollOpen(runOn(conn), month.first, 'Saving this time sheet');

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

      // salary snapshot: the basic must be the one in force for the month — the wages were worked out with it
      const pay = await monthPay(calc.emp, month.first, conn);
      const sentBasic = num(wages.BASIC_SAL, 3);
      if (sentBasic !== null && sentBasic !== num(pay.basic, 3)) {
        throw httpErr(409, `The basic for ${month.first.slice(5, 7)}/${month.first.slice(0, 4)} is now ${num(pay.basic, 3)} (screen used ${sentBasic}) — a salary revision changed it. Press Recalculate / reopen the sheet, check the salary and save again.`);
      }
      const snapVals = [
        num(pay.basic, 3),
        num(wages.HOURLY_RATE, 2) ?? num((pay.basic * 12) / 365 / 8, 2),
        month.days,
        num(wages.DAY_RATE, 2),
        wages.RATE_EFF_DATE || pay.effDate || null,
        num(wages.EARNED_BASIC, 2), // null if the screen did not send it (old build)
        num(wages.EARNED_ALLOW, 2),
        num(wages.ATT_DED, 2),
        num(wages.ROUND_OFF, 2),
      ];

      if (mode === 'ADD') {
        await conn.execute(
          `INSERT INTO time_sheet_hdr
             (TSHT_NO, TSHT_DATE, EMP_CODE, REMARKS, STATUS, CREATED_BY, SAL_SCHEME, ${TOT_COLS.join(', ')}, ${SNAP_COLS.join(', ')})
           VALUES (?, ?, ?, ?, 'D', ?, ?, ${[...TOT_COLS, ...SNAP_COLS].map(() => '?').join(', ')})`,
          [no, month.first, calc.emp.EMP_CODE, remarks || null, user, calc.scheme.code, ...totVals, ...snapVals],
        );
      } else {
        await conn.execute(
          `UPDATE time_sheet_hdr
              SET REMARKS = ?, EDITED_BY = ?, EDITED_DT = NOW(), SAL_SCHEME = ?, ${[...TOT_COLS, ...SNAP_COLS].map((c) => `${c} = ?`).join(', ')}
            WHERE TSHT_NO = ?`,
          [remarks || null, user, calc.scheme.code, ...totVals, ...snapVals, no],
        );
      }

      await conn.execute('DELETE FROM time_sheet_dtl WHERE TSHT_NO = ?', [no]);
      for (const r of calc.rows) {
        await conn.execute(
          `INSERT INTO time_sheet_dtl
             (TSHT_NO, ATT_DATE, DAY_NO, SEQ_NO, CONT_FLAG, TIME_IN, TIME_OUT, SHIFT_CODE, JOB_NO, NORMAL_HRS, NORMAL_OT, HOLIDAY_OT, HRS_EDITED, REMARKS)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            no, r.attDate, r.dayNo, r.seqNo, r.contFlag, toTime(toMin(r.timeIn)), toTime(toMin(r.timeOut)),
            r.shiftCode, r.jobNo, r.normalHrs, r.normalOt, r.holidayOt, r.hrsEdited ? 'Y' : null, r.remarks,
          ],
        );
      }

      await conn.execute('DELETE FROM tsht_allow WHERE TSHT_NO = ?', [no]);
      for (const a of allow) {
        await conn.execute(
          'INSERT INTO tsht_allow (TSHT_NO, TSHT_DATE, EMP_CODE, ALLOW_CODE, AMOUNT, REMARKS, SRC_FLAG, CREATED_BY) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [no, month.first, calc.emp.EMP_CODE, Number(a.code), Number(a.amount) || 0, a.remarks ? String(a.remarks).slice(0, 100) : null, srcFlag(a.src), user],
        );
      }
      await conn.execute('DELETE FROM tsht_ded WHERE TSHT_NO = ?', [no]);
      for (const a of ded) {
        await conn.execute(
          'INSERT INTO tsht_ded (TSHT_NO, TSHT_DATE, EMP_CODE, DED_CODE, AMOUNT, REMARKS, SRC_FLAG, CREATED_BY) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [no, month.first, calc.emp.EMP_CODE, Number(a.code), Number(a.amount) || 0, a.remarks ? String(a.remarks).slice(0, 100) : null, srcFlag(a.src), user],
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
      await assertPayrollOpen(runOn(conn), hdr.TSHT_DATE, 'Time approval');
      // the stored pay must still be the pay in force for the month (no salary revision since the last save)
      const [snap] = await conn.query('SELECT BASIC_SAL FROM time_sheet_hdr WHERE TSHT_NO = ?', [no]);
      const pay = await monthPay(calc.emp, hdr.TSHT_DATE, conn);
      if (snap[0].BASIC_SAL === null) throw httpErr(409, `Time sheet ${no} has no salary stored — save it again, then approve`);
      if (num(snap[0].BASIC_SAL, 3) !== num(pay.basic, 3)) {
        throw httpErr(409, `The basic for this month is now ${num(pay.basic, 3)} but the sheet was saved with ${num(snap[0].BASIC_SAL, 3)} — recalculate, check the salary and save before approving`);
      }
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
      await assertJobAllocOpen(runOn(conn), hdr.TSHT_DATE, 'Job approval');
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

  // ---------- Revoke approval (role 'admin' only): A -> T, or T -> D ----------
  // Steps back one approval at a time, so a job-approved sheet needs two revokes to reach Draft.
  // The approver columns of the revoked step are cleared; REVOKED_BY / REVOKED_DT keep who did it.
  router.post('/tsht/revoke/:no', async (req, res) => {
    const no = req.params.no;
    let conn;
    try {
      if (!canRevokeUser(req)) throw httpErr(403, 'Only a user with the admin role can revoke approvals');
      const user = String(userOf(req)).slice(0, 20);
      conn = await db.getConnection();
      await conn.beginTransaction();
      const { hdr } = await loadStoredSheet(no, conn, true);
      let newStatus;
      if (hdr.STATUS === 'A') {
        await assertJobAllocOpen(runOn(conn), hdr.TSHT_DATE, 'Revoking the job approval');
        newStatus = 'T';
        await conn.execute(
          'UPDATE time_sheet_hdr SET STATUS = "T", APPROVED_BY = NULL, APPROVED_DT = NULL, REVOKED_BY = ?, REVOKED_DT = NOW() WHERE TSHT_NO = ?',
          [user, no],
        );
      } else if (hdr.STATUS === 'T') {
        await assertPayrollOpen(runOn(conn), hdr.TSHT_DATE, 'Revoking the time approval');
        // salary already posted to the G/L: the time approval stays (reverse the Salary JV first)
        try {
          const [jv] = await conn.query(JV_POSTED_SQL, [no]);
          if (jv.length) throw httpErr(423, `The salary of ${no} is posted in the Salary JV — delete that JV first, then revoke`);
        } catch (e) {
          if (e.status) throw e;
          console.warn('[tsht] revoke: Salary JV check skipped:', e.code || e.message);
        }
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
  function sheetTotals(rows, allow, ded, month, scheme) {
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
      notJoinedDays: days((r) => r.dayType === 'J'), // before joining (APPT_DT) — not paid
      // approved leave (same as useTimeSheet totals)
      leaveDays: days((r) => r.dayType === 'L'),
      annualLeaveDays: days((r) => r.dayType === 'L' && r.leavePay === 'A'),
      paidLeaveDays: days((r) => r.dayType === 'L' && r.leavePay === 'F'),
      unpaidLeaveDays: days((r) => r.dayType === 'L' && r.leavePay === 'U') + days((r) => r.dayType === 'L' && r.leavePay === 'H') / 2,
      allow: allow.reduce((a, r) => a + (Number(r.AMOUNT) || 0), 0),
      allowFixed: allow.filter((r) => r.TYPE !== 'V').reduce((a, r) => a + (Number(r.AMOUNT) || 0), 0), // prorated by scheme
      ded: ded.reduce((a, r) => a + (Number(r.AMOUNT) || 0), 0),
      monthDays: month ? month.days : undefined,
      scheme,
    };
  }

  // ---------- registers: Attendance Register / Absent & Short Time Register ----------
  router.get('/tsht/reg-catg', async (req, res) => {
    try {
      const [rows] = await db.query(CATG_SQL);
      res.json({ ok: true, rows });
    } catch (e) {
      send(res, e);
    }
  });

  router.get('/tsht/register', async (req, res) => {
    try {
      const month = parseMonth(`${String(req.query.month || '').slice(0, 7)}-01`);
      if (!month) throw httpErr(400, 'Month must be YYYY-MM');
      const catg = String(req.query.catg || '').trim();
      const approvedOnly = req.query.approved === 'Y';
      const where = ['h.TSHT_DATE = ?'];
      const args = [month.first];
      if (catg) {
        where.push(`e.${EMP_CATG_COL} = ?`);
        args.push(catg);
      }
      if (approvedOnly) where.push("h.STATUS IN ('T', 'A')");
      const [hdrs] = await db.query(
        `SELECT h.TSHT_NO, h.EMP_CODE, h.STATUS, e.EMP_NAME, e.${EMP_CATG_COL} AS CATG_CODE, c.CATG_NAME
           FROM time_sheet_hdr h
           JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
           LEFT JOIN emp_catg_mst c ON c.CATG_CODE = e.${EMP_CATG_COL}
          WHERE ${where.join(' AND ')}
          ORDER BY e.${EMP_CATG_COL}, h.EMP_CODE`,
        args,
      );
      // each sheet recalculated as when it is opened — a few at a time
      const out = [];
      for (let i = 0; i < hdrs.length; i += 4) {
        const part = await Promise.all(
          hdrs.slice(i, i + 4).map(async (h) => {
            const { calc } = await loadStoredSheet(h.TSHT_NO);
            const { days, tot } = registerOf(calc.rows, month);
            return {
              tshtNo: h.TSHT_NO,
              empCode: h.EMP_CODE,
              empName: h.EMP_NAME,
              catgCode: h.CATG_CODE || '',
              catgName: h.CATG_NAME || '',
              status: h.STATUS,
              days,
              tot,
            };
          }),
        );
        out.push(...part);
      }
      res.json({ ok: true, month: month.first, monthDays: month.days, rows: out });
    } catch (e) {
      send(res, e);
    }
  });

  router.post('/tsht/payslips', async (req, res) => {
    try {
      const nos = Array.isArray(req.body && req.body.nos) ? req.body.nos.map(String).slice(0, 500) : [];
      if (!nos.length) throw httpErr(400, 'No time sheets selected');
      const slips = [];
      const skipped = [];
      for (const no of nos) {
        const [h] = await db.query(
          `SELECT TSHT_NO, DATE_FORMAT(TSHT_DATE, '%Y-%m-%d') AS TSHT_DATE, EMP_CODE, STATUS, BASIC_SAL FROM time_sheet_hdr WHERE TSHT_NO = ?`,
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
          `SELECT a.ALLOW_CODE AS CODE, m.ALLOW_DESC AS DESCR, m.ALLOW_TYPE AS TYPE, a.AMOUNT, a.REMARKS
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
        // the basic stored with the sheet; sheets saved before the snapshot: the basic in force for the month
        const basic = hdr.BASIC_SAL !== null ? Number(hdr.BASIC_SAL) : (await monthPay(emp, hdr.TSHT_DATE)).basic;
        // type (F / V): fixed allowance lines are earned for the paid days only (11-Nov-2026)
        const line = (a) => ({ code: a.CODE, descr: a.DESCR || '', amount: Number(a.AMOUNT) || 0, remarks: a.REMARKS || '', type: a.TYPE || '' });
        slips.push({
          tshtNo: hdr.TSHT_NO,
          tshtDate: hdr.TSHT_DATE,
          status: 'A', // processed: pay is fixed once the time is approved (same as the sheet's Print Payslip)
          employee: { EMP_CODE: emp.EMP_CODE, EMP_NAME: emp.EMP_NAME, CARD_NO: emp.CARD_NO, SHIFT_CODE: emp.SHIFT_CODE, BASIC_SAL: basic },
          totals: sheetTotals(calc.rows, allow, ded, calc.month, calc.scheme),
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
      await assertPayrollOpen(runOn(db), monthOfNo(req.params.no), 'Deleting this time sheet');
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
      await assertPayrollOpen(runOn(db), monthOfNo(no), 'Adding card images');
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
      await assertPayrollOpen(runOn(db), monthOfNo(rows[0].REF_NO), 'Removing card images');
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
