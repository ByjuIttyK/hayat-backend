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
// =====================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');

// ---- adjust these to your schema if names differ --------------------
const JOB_SQL = 'SELECT JOB_NO, PROJ_NAME FROM job_card ORDER BY JOB_NO DESC';
const HOLIDAY_SQL = 'SELECT DATE_FORMAT(HOL_DATE, "%Y-%m-%d") AS D FROM holiday_mst WHERE HOL_DATE BETWEEN ? AND ?';
const DEFAULT_SHIFT = 'GEN';
const ATT_MODULE = 'TIMESHEET';
const UPLOAD_DIR = process.env.TSHT_UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'timesheets');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
function calcDay(date, timeIn, timeOut, sh, holidays, otEligible) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() + 1; // 1 = Sunday (MySQL DAYOFWEEK)
  const isWeekOff = dow === sh.weekOff;
  const isHol = isWeekOff || holidays.has(date);
  const res = {
    dayType: isWeekOff ? 'S' : holidays.has(date) ? 'H' : 'W',
    effIn: null, effOut: null, normalHrs: 0, normalOt: 0, holidayOt: 0, lateMins: 0, shortMins: 0, error: null,
  };
  const i = toMin(timeIn);
  const o = toMin(timeOut);
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

  /** Builds one full month of computed rows from the screen's rows (by day no.). */
  async function computeSheet({ tshtDate, empCode, rows }, conn = db) {
    const month = parseMonth(tshtDate);
    if (!month) throw httpErr(400, 'Invalid month');
    const emp = await loadEmp(empCode, conn);
    if (!emp) throw httpErr(404, `Employee ${padEmp(empCode)} not found`);
    const shifts = await loadShifts(conn);
    const holidays = await loadHolidays(month, conn);
    const empShift = emp.SHIFT_CODE || DEFAULT_SHIFT;
    const otEligible = emp.OT_ELIGIBLE !== 'N';
    const byDay = new Map((rows || []).map((r) => [Number(r.dayNo), r]));

    const out = [];
    for (let d = 1; d <= month.days; d++) {
      const src = byDay.get(d) || {};
      const date = `${month.first.slice(0, 8)}${pad2(d)}`;
      const shiftCode = src.shiftCode || empShift;
      const sh = shifts.get(shiftCode);
      if (!sh) throw httpErr(400, `Shift ${shiftCode} not found in shift_mst`);
      const timeIn = toMin(src.timeIn);
      const timeOut = toMin(src.timeOut);
      const c = calcDay(date, src.timeIn, src.timeOut, sh, holidays, otEligible);
      out.push({
        dayNo: d,
        attDate: date,
        timeIn: hhmm(timeIn),
        timeOut: hhmm(timeOut),
        shiftCode,
        jobNo: src.jobNo || null,
        remarks: src.remarks ? String(src.remarks).slice(0, 30) : null,
        needsCheck: !!src.needsCheck || !!c.error,
        ...c,
      });
    }
    return { month, emp, rows: out };
  }

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
      res.json({ ok: true, allowCodes, dedCodes, shifts, jobs });
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
        `SELECT h.TSHT_NO, DATE_FORMAT(h.TSHT_DATE, '%Y-%m-%d') AS TSHT_DATE, h.EMP_CODE, e.EMP_NAME, h.STATUS,
                SUM(d.NORMAL_HRS) AS NORMAL_MINS, SUM(d.NORMAL_OT) AS NORMAL_OT_MINS, SUM(d.HOLIDAY_OT) AS HOLIDAY_OT_MINS
           FROM time_sheet_hdr h
           JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
           LEFT JOIN time_sheet_dtl d ON d.TSHT_NO = h.TSHT_NO
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          GROUP BY h.TSHT_NO, h.TSHT_DATE, h.EMP_CODE, e.EMP_NAME, h.STATUS
          ORDER BY h.TSHT_DATE DESC, h.EMP_CODE`,
        args,
      );
      res.json({ ok: true, rows });
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
                CREATED_BY, EDITED_BY, APPROVED_BY
           FROM time_sheet_hdr WHERE TSHT_NO = ?`,
        [no],
      );
      if (!h.length) return res.status(404).json({ ok: false, error: `Time sheet ${no} not found` });
      const hdr = h[0];
      const emp = await loadEmp(hdr.EMP_CODE);
      const [dtl] = await db.query(
        `SELECT DAY_NO, DATE_FORMAT(ATT_DATE, '%Y-%m-%d') AS ATT_DATE,
                TIME_FORMAT(TIME_IN, '%H:%i') AS TIME_IN, TIME_FORMAT(TIME_OUT, '%H:%i') AS TIME_OUT,
                SHIFT_CODE, JOB_NO, NORMAL_HRS, NORMAL_OT, HOLIDAY_OT, REMARKS
           FROM time_sheet_dtl WHERE TSHT_NO = ? ORDER BY DAY_NO`,
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
        rows: dtl.map((r) => ({ dayNo: r.DAY_NO, timeIn: r.TIME_IN, timeOut: r.TIME_OUT, shiftCode: r.SHIFT_CODE, jobNo: r.JOB_NO, remarks: r.REMARKS })),
      });
      res.json({ ok: true, hdr, emp, rows: calc.rows, allow, ded });
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

  // ---------- save ----------
  router.post('/tsht/save', async (req, res) => {
    const { mode, tshtDate, empCode, remarks, allow = [], ded = [] } = req.body || {};
    const user = String(userOf(req)).slice(0, 20);
    let conn;
    try {
      const month = parseMonth(tshtDate);
      if (!month) throw httpErr(400, 'Invalid month');
      const no = tsNoOf(month.first, empCode);

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

      conn = await db.getConnection();
      await conn.beginTransaction();

      const [ex] = await conn.query('SELECT STATUS FROM time_sheet_hdr WHERE TSHT_NO = ? FOR UPDATE', [no]);
      if (mode === 'ADD' && ex.length) throw httpErr(409, `Time sheet ${no} already exists — open it in EDIT`);
      if (mode !== 'ADD' && !ex.length) throw httpErr(404, `Time sheet ${no} not found`);
      if (ex.length && ex[0].STATUS === 'A') throw httpErr(423, `Time sheet ${no} is approved and locked`);

      const calc = await computeSheet({ tshtDate: month.first, empCode, rows: req.body.rows }, conn);
      const bad = calc.rows.find((r) => r.error);
      if (bad) throw httpErr(400, `Day ${bad.dayNo}: ${bad.error}`);

      if (mode === 'ADD') {
        await conn.execute(
          'INSERT INTO time_sheet_hdr (TSHT_NO, TSHT_DATE, EMP_CODE, REMARKS, CREATED_BY, STATUS) VALUES (?, ?, ?, ?, ?, "D")',
          [no, month.first, calc.emp.EMP_CODE, remarks || null, user],
        );
      } else {
        await conn.execute('UPDATE time_sheet_hdr SET REMARKS = ?, EDITED_BY = ? WHERE TSHT_NO = ?', [remarks || null, user, no]);
      }

      await conn.execute('DELETE FROM time_sheet_dtl WHERE TSHT_NO = ?', [no]);
      for (const r of calc.rows) {
        await conn.execute(
          `INSERT INTO time_sheet_dtl
             (TSHT_NO, ATT_DATE, DAY_NO, TIME_IN, TIME_OUT, SHIFT_CODE, JOB_NO, NORMAL_HRS, NORMAL_OT, HOLIDAY_OT, REMARKS)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [no, r.attDate, r.dayNo, toTime(toMin(r.timeIn)), toTime(toMin(r.timeOut)), r.shiftCode, r.jobNo, r.normalHrs, r.normalOt, r.holidayOt, r.remarks],
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
      res.json({ ok: true, tshtNo: no, rows: calc.rows });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      if (e.code === 'ER_DUP_ENTRY') e = httpErr(409, 'This time sheet was just saved by another user — reopen it in EDIT');
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------- approve (recalculate stored rows, then lock) ----------
  router.post('/tsht/approve/:no', async (req, res) => {
    const no = req.params.no;
    const user = String(userOf(req)).slice(0, 20);
    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();
      const [h] = await conn.query(
        'SELECT DATE_FORMAT(TSHT_DATE, "%Y-%m-%d") AS TSHT_DATE, EMP_CODE, STATUS FROM time_sheet_hdr WHERE TSHT_NO = ? FOR UPDATE',
        [no],
      );
      if (!h.length) throw httpErr(404, `Time sheet ${no} not found`);
      if (h[0].STATUS === 'A') throw httpErr(409, `Time sheet ${no} is already approved`);
      const [dtl] = await conn.query(
        `SELECT DAY_NO, TIME_FORMAT(TIME_IN, '%H:%i') AS TIME_IN, TIME_FORMAT(TIME_OUT, '%H:%i') AS TIME_OUT,
                SHIFT_CODE, JOB_NO, REMARKS FROM time_sheet_dtl WHERE TSHT_NO = ?`,
        [no],
      );
      const calc = await computeSheet(
        {
          tshtDate: h[0].TSHT_DATE,
          empCode: h[0].EMP_CODE,
          rows: dtl.map((r) => ({ dayNo: r.DAY_NO, timeIn: r.TIME_IN, timeOut: r.TIME_OUT, shiftCode: r.SHIFT_CODE, jobNo: r.JOB_NO, remarks: r.REMARKS })),
        },
        conn,
      );
      const bad = calc.rows.find((r) => r.error);
      if (bad) throw httpErr(400, `Day ${bad.dayNo}: ${bad.error}`);
      for (const r of calc.rows) {
        await conn.execute('UPDATE time_sheet_dtl SET NORMAL_HRS = ?, NORMAL_OT = ?, HOLIDAY_OT = ? WHERE TSHT_NO = ? AND DAY_NO = ?', [
          r.normalHrs, r.normalOt, r.holidayOt, no, r.dayNo,
        ]);
      }
      await conn.execute('UPDATE time_sheet_hdr SET STATUS = "A", APPROVED_BY = ?, APPROVED_DT = NOW() WHERE TSHT_NO = ?', [user, no]);
      await conn.commit();
      res.json({ ok: true, tshtNo: no, rows: calc.rows });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------- delete (draft only) ----------
  router.delete('/tsht/sheet/:no', async (req, res) => {
    try {
      const [h] = await db.query('SELECT STATUS FROM time_sheet_hdr WHERE TSHT_NO = ?', [req.params.no]);
      if (!h.length) return res.status(404).json({ ok: false, error: 'Not found' });
      if (h[0].STATUS === 'A') return res.status(423).json({ ok: false, error: 'Approved time sheets cannot be deleted' });
      await db.query('DELETE FROM time_sheet_hdr WHERE TSHT_NO = ?', [req.params.no]); // dtl / allow / ded cascade
      res.json({ ok: true });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- AI card read (Gemini) ----------
  router.post('/tsht/ai-read', async (req, res) => {
    try {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw httpErr(500, 'GEMINI_API_KEY is not set on the server');
      const { images = [], tshtDate } = req.body || {};
      const month = parseMonth(tshtDate);
      if (!month) throw httpErr(400, 'Select the month first');
      if (!images.length) throw httpErr(400, 'No card images sent');

      const prompt = `These are photos of a monthly punch time card (an employee may have two cards: days 1-15 and 16-31) for ${month.y}-${pad2(month.mo)}.
Each stamp is printed as "<day digits><HH:MM>", e.g. "17 07:55" or "1707:55". Use the printed day digits to decide the day — stamps are often printed slightly off their row.
For every day 1-${month.days} return the FIRST stamp of the day as "in" and the LAST stamp as "out" (24-hour HH:MM), whichever column they are in.
Handwritten times count (set "manual": true). A stamp printed in red means late (set "late": true).
If a digit is unclear, give your best reading and set "check": true with a short "note" (max 25 chars).
Days with no stamps: in and out null. Return only JSON.`;

      const body = {
        contents: [
          {
            parts: [
              { text: prompt },
              ...images.map((im) => ({ inline_data: { mime_type: im.mime || 'image/jpeg', data: String(im.data).replace(/^data:[^,]+,/, '') } })),
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              cardNo: { type: 'STRING', nullable: true },
              name: { type: 'STRING', nullable: true },
              days: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    day: { type: 'INTEGER' },
                    in: { type: 'STRING', nullable: true },
                    out: { type: 'STRING', nullable: true },
                    late: { type: 'BOOLEAN' },
                    manual: { type: 'BOOLEAN' },
                    check: { type: 'BOOLEAN' },
                    note: { type: 'STRING', nullable: true },
                  },
                  required: ['day'],
                },
              },
            },
            required: ['days'],
          },
        },
      };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw httpErr(502, `Gemini: ${(j.error && j.error.message) || r.status}`);
      const text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map((p) => p.text || '').join('');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw httpErr(502, 'Could not read the AI response — try a clearer photo');
      }
      const days = (parsed.days || [])
        .filter((d) => Number.isInteger(d.day) && d.day >= 1 && d.day <= month.days)
        .map((d) => {
          const notes = [];
          if (d.late) notes.push('Late stamp');
          if (d.manual) notes.push('Manual time');
          if (d.note) notes.push(d.note);
          return {
            dayNo: d.day,
            timeIn: hhmm(toMin(d.in)),
            timeOut: hhmm(toMin(d.out)),
            needsCheck: !!d.check || !!d.manual,
            remarks: notes.join('; ').slice(0, 30) || null,
          };
        });
      res.json({ ok: true, cardNo: parsed.cardNo || null, name: parsed.name || null, days, model: GEMINI_MODEL });
    } catch (e) {
      send(res, e);
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
      if (rows[0].STATUS === 'A') return res.status(423).json({ ok: false, error: 'Time sheet is approved' });
      await db.query('DELETE FROM doc_attachments WHERE ID = ?', [req.params.id]);
      const r = rows[0];
      fs.rm(path.join(UPLOAD_DIR, r.REF_NO.slice(0, 4), r.REF_NO.slice(5, 7), path.basename(r.STORED_NAME)), () => {});
      res.json({ ok: true });
    } catch (e) {
      send(res, e);
    }
  });

  return router;
};

// exported for tests
module.exports.calcDay = calcDay;
module.exports.prepShift = prepShift;
