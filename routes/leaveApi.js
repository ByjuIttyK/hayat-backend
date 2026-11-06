// routes/leaveApi.js — Leave Application, Leave Ledger and Leave Balance (Payroll)
// Register in HayatDb.js:
//   const leaveApi = require("./routes/leaveApi");
//   app.use("/api", leaveApi(connection));
// Tables: leave_type_mst, leave_appl (sql/leave_tables.sql); reads emp_mst, hr_mst, payroll_mst.
//
// Annual leave balance is worked out, not stored:
//   start   = hr_mst.LEAVE_OPBAL_DT (with LEAVE_OPBAL as opening) else emp_mst.APPT_DT (opening 0)
//   earned  = one credit on each completed month from start:
//               first 12 months of service (from APPT_DT): min(2, LEAVE_DAYS_PA/12) — UAE 2 days/month
//               after that: LEAVE_DAYS_PA / 12
//   taken   = leave types with IS_ANNUAL = 'Y': resumed (S) -> ACT_DAYS, approved (A) -> DAYS
//             (leaves starting before the opening-balance date are already inside the opening)
//   balance = opening + earned - taken          (as on a date)
//   booked  = approved annual leave starting after that date;  available = balance - booked
//
// Leave application status: D Applied -> A Approved -> S Resumed  |  R Rejected  |  C Cancelled
//   GET    /leave/lookups
//   GET    /leave/appl?status=D,A&from=yyyy-mm-dd&to=yyyy-mm-dd&emp=W003
//   GET    /leave/appl/:no
//   GET    /leave/emp-info/:code?asOn=yyyy-mm-dd&type=AL&excl=LV2026-0001
//   POST   /leave/appl                 (new, status D)
//   PUT    /leave/appl/:no             (only while D)
//   DELETE /leave/appl/:no             (only while D)
//   POST   /leave/appl/:no/approve     { remarks }          D -> A
//   POST   /leave/appl/:no/reject      { remarks }          D -> R
//   POST   /leave/appl/:no/resume      { resumeDt, remarks } A -> S  (ACT_DAYS = resume - from)
//   POST   /leave/appl/:no/cancel      { remarks }          D/A -> C
//   POST   /leave/appl/:no/revoke                           admin only: S -> A, A -> D
//   GET    /leave/ledger/:code?from=yyyy-mm-dd&to=yyyy-mm-dd[&type=ANNUAL|SL|UL...]
//          type blank = all leave; ANNUAL (or AL / EL) = annual balance only;
//          another type = that type only, with its per-calendar-year limit (MAX_DAYS_PA) as the balance
//   GET    /leave/balance?catg=M,S,W&status=A,L&asOn=yyyy-mm-dd[&withSal=1]
//   GET    /leave/salary/:no          detailed leave salary of one annual-type application
//   (ledger also takes withSal=1 -> adds `rates` so the screen can value days taken and the balance)
// Leave salary (company rule: on basic salary only — allowances are not included):
//   daily rate   = payroll_mst.BASIC_SAL × 12 / 365
//   paid days    = actual days (resumed) else applied days, limited to the annual balance available
//                  before the leave; days beyond the balance are shown as not paid
//   leave salary = daily rate × paid days;  value of the balance left on exit = days × daily rate
//   Salary figures are the current ones on the employee master.
// Employee status: approved leave that has started sets emp_mst.EMP_STATUS 'L'; resume / cancel puts it back to 'A'.
const express = require("express");

const STATUSES = ["A", "L", "R", "T", "X"];
const ADMIN_USERS = ["admin"];

// ---------------------------------------------------------------- date helpers (yyyy-mm-dd strings, UTC)
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s + "T00:00:00Z"));
const toD = (s) => new Date(s + "T00:00:00Z");
const ymd = (d) => d.toISOString().slice(0, 10);
const todayYmd = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};
const daysBetween = (a, b) => Math.round((toD(b) - toD(a)) / 86400000);      // b - a
const addDays = (s, n) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
// same day-of-month k months later, clamped to the month end (31-Jan + 1 month = 28/29-Feb)
const addMonths = (s, k) => {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return ymd(t);
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");

// ---------------------------------------------------------------- the leave engine (pure, no database)
// emp:    { APPT_DT, LEAVE_OPBAL, LEAVE_OPBAL_DT, LEAVE_DAYS_PA }  (dates yyyy-mm-dd or null)
// leaves: [{ LEAVE_NO, LEAVE_TYPE, LEAVE_NAME, IS_ANNUAL, STATUS, FROM_DT, TO_DT, RESUME_DT, DAYS, ACT_DAYS }]
// Returns the dated events (opening, monthly credits, leaves) up to `upTo`.
function leaveEvents(emp, leaves, upTo) {
  const daysPa = Number(emp.LEAVE_DAYS_PA) || 0;
  const appt = emp.APPT_DT || null;
  const opDt = emp.LEAVE_OPBAL_DT || null;
  const start = opDt || appt;
  const ev = [];
  if (opDt) ev.push({ date: opDt, kind: "OPEN", particulars: "Opening balance (cut-over)", earned: r2(emp.LEAVE_OPBAL), taken: 0, other: 0 });
  else if (appt) ev.push({ date: appt, kind: "OPEN", particulars: "Date of appointment", earned: 0, taken: 0, other: 0 });

  if (start && daysPa > 0) {
    const after1 = daysPa / 12;
    const first = Math.min(2, after1);
    for (let k = 1; ; k++) {
      const d = addMonths(start, k);
      if (d > upTo) break;
      // month of service being credited: counted from the appointment date
      const svcMonths = appt ? monthsDone(appt, d) : 99;
      const rate = svcMonths <= 12 ? first : after1;
      ev.push({ date: d, kind: "EARN", particulars: appt ? `Earned — service month ${svcMonths}` : "Earned — monthly credit", earned: r2(rate), taken: 0, other: 0 });
      if (k > 1200) break;                                        // 100 years — guard
    }
  }

  leaves.forEach((l) => {
    if (!["A", "S"].includes(l.STATUS)) return;
    if (l.FROM_DT > upTo) return;
    if (opDt && l.FROM_DT < opDt) return;                         // inside the opening balance
    const days = l.STATUS === "S" ? Number(l.ACT_DAYS) || 0 : Number(l.DAYS) || 0;
    const range = l.STATUS === "S"
      ? `${dmy(l.FROM_DT)} – ${dmy(addDays(l.RESUME_DT, -1))}, resumed ${dmy(l.RESUME_DT)}`
      : `${dmy(l.FROM_DT)} – ${dmy(l.TO_DT)}, not resumed yet`;
    ev.push({
      date: l.FROM_DT, kind: l.IS_ANNUAL === "Y" ? "TAKE" : "OTHER", ref: l.LEAVE_NO, type: l.LEAVE_TYPE,
      particulars: `${l.LEAVE_NAME} (${range})`, status: l.STATUS,
      earned: 0, taken: l.IS_ANNUAL === "Y" ? days : 0, other: l.IS_ANNUAL === "Y" ? 0 : days,
    });
  });

  const order = { OPEN: 0, EARN: 1, TAKE: 2, OTHER: 3 };
  ev.sort((a, b) => (a.date === b.date ? order[a.kind] - order[b.kind] : a.date < b.date ? -1 : 1));
  return ev;
}
// completed months from a to b (a = appointment); the month that ends on b counts
function monthsDone(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  let m = (by - ay) * 12 + (bm - am);
  if (bd < ad && addMonths(a, m) > b) m -= 1;
  return m;
}

// balance figures as on a date
function leaveBalance(emp, leaves, asOn) {
  const ev = leaveEvents(emp, leaves, asOn);
  let opening = 0, earned = 0, taken = 0;
  ev.forEach((e) => {
    if (e.kind === "OPEN") opening += e.earned;
    if (e.kind === "EARN") earned += e.earned;
    if (e.kind === "TAKE") taken += e.taken;
  });
  const booked = leaves
    .filter((l) => l.STATUS === "A" && l.IS_ANNUAL === "Y" && l.FROM_DT > asOn)
    .reduce((t, l) => t + (Number(l.DAYS) || 0), 0);
  const balance = r2(opening + earned - taken);
  return { asOn, opening: r2(opening), earned: r2(earned), taken: r2(taken), balance, booked: r2(booked), available: r2(balance - booked) };
}

// ledger rows between from and to, with the running balance
function leaveLedger(emp, leaves, from, to) {
  const ev = leaveEvents(emp, leaves, to);
  let bal = 0, bf = 0;
  const rows = [];
  ev.forEach((e) => {
    const delta = e.earned - e.taken;
    if (from && e.date < from) { bf += delta; bal += delta; return; }
    bal += delta;
    rows.push({ ...e, balance: r2(bal) });
  });
  return { broughtForward: r2(bf), rows, closing: r2(bal) };
}

// one non-annual leave type: per calendar year, entitlement = limit (unused days lapse on 1 Jan);
// without a limit (e.g. unpaid) the balance column is the days used so far in the year
function typeLedger(leaves, limit, from, to) {
  const ls = leaves.filter((l) => ["A", "S"].includes(l.STATUS) && l.FROM_DT <= to);
  const y0 = Number((from || (ls[0] && ls[0].FROM_DT) || to).slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  const ev = [];
  for (let y = y0; y <= y1; y++) {
    ev.push({ date: `${y}-01-01`, kind: "ENT", earned: limit || 0, taken: 0, other: 0,
      particulars: limit ? `Entitlement for ${y} (${limit} days; unused days lapse)` : `Year ${y}` });
  }
  ls.filter((l) => Number(l.FROM_DT.slice(0, 4)) >= y0).forEach((l) => {
    const days = l.STATUS === "S" ? Number(l.ACT_DAYS) || 0 : Number(l.DAYS) || 0;
    const range = l.STATUS === "S"
      ? `${dmy(l.FROM_DT)} – ${dmy(addDays(l.RESUME_DT, -1))}, resumed ${dmy(l.RESUME_DT)}`
      : `${dmy(l.FROM_DT)} – ${dmy(l.TO_DT)}, not resumed yet`;
    ev.push({ date: l.FROM_DT, kind: "TAKE", ref: l.LEAVE_NO, type: l.LEAVE_TYPE, status: l.STATUS,
      particulars: `${l.LEAVE_NAME} (${range})`, earned: 0, taken: days, other: 0 });
  });
  ev.sort((a, b) => (a.date === b.date ? (a.kind === "ENT" ? -1 : 1) : a.date < b.date ? -1 : 1));
  let bal = 0, bf = 0, used = 0;
  const rows = [];
  ev.forEach((e) => {
    if (e.kind === "ENT") { bal = limit ? limit : 0; used = 0; }           // new year: reset
    else { used += e.taken; bal = limit ? bal - e.taken : used; }
    if (from && e.date < from) { bf = bal; return; }
    rows.push({ ...e, balance: r2(bal) });
  });
  const yr = to.slice(0, 4);
  const usedYr = r2(ls.filter((l) => l.FROM_DT.slice(0, 4) === yr)
    .reduce((t, l) => t + (l.STATUS === "S" ? Number(l.ACT_DAYS) || 0 : Number(l.DAYS) || 0), 0));
  return {
    broughtForward: r2(bf), rows, closing: r2(bal),
    typeBal: { year: yr, entitled: limit || null, used: usedYr, balance: limit ? r2(limit - usedYr) : null },
  };
}

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) => connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
  const qc = (conn, sql, params = []) =>
    new Promise((resolve, reject) => conn.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const send = (res, e) => res.status(e.status || 500).json({ message: e.sqlMessage || e.message });
  const userOf = (req) => String(req.user?.username || req.user?.user_name || req.user?.user_id || "").slice(0, 20) || null;
  const str = (v, n) => { const s = v == null ? "" : String(v).trim(); return s ? s.slice(0, n) : null; };
  const yn = (v) => (v === "Y" || v === true ? "Y" : "N");
  const list = (v, re = /^[A-Z0-9_]{1,10}$/) =>
    String(v || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => re.test(s));

  // run fn(conn) inside a transaction
  const tx = (fn) => new Promise((resolve, reject) => {
    connection.getConnection(async (err, conn) => {
      if (err) return reject(err);
      try {
        await qc(conn, "START TRANSACTION");
        const out = await fn(conn);
        await qc(conn, "COMMIT");
        resolve(out);
      } catch (e) {
        try { await qc(conn, "ROLLBACK"); } catch (_) { /* ignore */ }
        reject(e);
      } finally { conn.release(); }
    });
  });

  // ---- reads used by several endpoints
  const EMP_SQL = `
    SELECT e.EMP_CODE, e.EMP_NAME, e.EMP_CATG, e.EMP_STATUS, e.GENDER, e.CARD_NO,
           e.DEPT_CODE, dp.DEPT_NAME, e.TRADE_CODE, t.TRADE_NAME,
           DATE_FORMAT(e.APPT_DT, '%Y-%m-%d') AS APPT_DT,
           COALESCE(h.LEAVE_DAYS_PA, 30) AS LEAVE_DAYS_PA, COALESCE(h.LEAVE_OPBAL, 0) AS LEAVE_OPBAL,
           DATE_FORMAT(h.LEAVE_OPBAL_DT, '%Y-%m-%d') AS LEAVE_OPBAL_DT,
           DATE_FORMAT(h.LAST_LEAVE_DT, '%Y-%m-%d') AS LAST_LEAVE_DT,
           DATE_FORMAT(h.LAST_RESUME_DT, '%Y-%m-%d') AS LAST_RESUME_DT
      FROM emp_mst e
      LEFT JOIN hr_mst h     ON h.EMP_CODE = e.EMP_CODE
      LEFT JOIN dept_mst dp  ON dp.DEPT_CODE = e.DEPT_CODE
      LEFT JOIN trade_mst t  ON t.TRADE_CODE = e.TRADE_CODE`;

  const APPL_SQL = `
    SELECT a.LEAVE_NO, DATE_FORMAT(a.APPL_DT, '%Y-%m-%d') AS APPL_DT, a.EMP_CODE, e.EMP_NAME, e.EMP_CATG,
           a.LEAVE_TYPE, lt.LEAVE_NAME, lt.IS_ANNUAL, lt.PAY_TYPE,
           DATE_FORMAT(a.FROM_DT, '%Y-%m-%d') AS FROM_DT, DATE_FORMAT(a.TO_DT, '%Y-%m-%d') AS TO_DT,
           a.DAYS, a.REASON, a.CONTACT_ADDR, a.CONTACT_PHONE, a.RELIEVER_CODE, rl.EMP_NAME AS RELIEVER_NAME,
           a.TICKET_REQ, a.ADV_SAL_REQ, a.BAL_ON_APPL, a.STATUS,
           a.APPR_BY, DATE_FORMAT(a.APPR_DT, '%Y-%m-%d %H:%i') AS APPR_DT, a.APPR_REMARKS,
           DATE_FORMAT(a.RESUME_DT, '%Y-%m-%d') AS RESUME_DT, a.ACT_DAYS, a.RESUME_REMARKS, a.RESUMED_BY,
           a.CREATED_BY, DATE_FORMAT(a.CREATED_DT, '%Y-%m-%d %H:%i') AS CREATED_DT, a.MODIFIED_BY
      FROM leave_appl a
      JOIN emp_mst e         ON e.EMP_CODE = a.EMP_CODE
      JOIN leave_type_mst lt ON lt.LEAVE_TYPE = a.LEAVE_TYPE
      LEFT JOIN emp_mst rl   ON rl.EMP_CODE = a.RELIEVER_CODE`;

  const LEAVES_OF_SQL = `
    SELECT a.LEAVE_NO, a.EMP_CODE, a.LEAVE_TYPE, lt.LEAVE_NAME, lt.IS_ANNUAL, a.STATUS, a.DAYS, a.ACT_DAYS,
           DATE_FORMAT(a.FROM_DT, '%Y-%m-%d') AS FROM_DT, DATE_FORMAT(a.TO_DT, '%Y-%m-%d') AS TO_DT,
           DATE_FORMAT(a.RESUME_DT, '%Y-%m-%d') AS RESUME_DT
      FROM leave_appl a JOIN leave_type_mst lt ON lt.LEAVE_TYPE = a.LEAVE_TYPE
     WHERE a.STATUS IN ('A','S') AND a.EMP_CODE IN (?)
     ORDER BY a.FROM_DT`;

  const empOf = async (code, db = null) => {
    const rows = db ? await qc(db, `${EMP_SQL} WHERE e.EMP_CODE = ?`, [code]) : await q(`${EMP_SQL} WHERE e.EMP_CODE = ?`, [code]);
    if (!rows.length) throw fail(404, `Employee ${code} not found`);
    return rows[0];
  };
  const leavesOf = async (codes, db = null) => {
    if (!codes.length) return [];
    return db ? qc(db, LEAVES_OF_SQL, [codes]) : q(LEAVES_OF_SQL, [codes]);
  };
  const applOf = async (no, db = null) => {
    const rows = db ? await qc(db, `${APPL_SQL} WHERE a.LEAVE_NO = ? FOR UPDATE`, [no]) : await q(`${APPL_SQL} WHERE a.LEAVE_NO = ?`, [no]);
    if (!rows.length) throw fail(404, `Leave application ${no} not found`);
    return rows[0];
  };

  // employees whose approved leave has started -> 'L'; employees on 'L' with no running leave -> 'A'
  const syncOnLeave = async (db = null) => {
    const run = (sql) => (db ? qc(db, sql) : q(sql));
    await run(`UPDATE emp_mst e SET e.EMP_STATUS = 'L'
                WHERE e.EMP_STATUS = 'A'
                  AND EXISTS (SELECT 1 FROM leave_appl a WHERE a.EMP_CODE = e.EMP_CODE AND a.STATUS = 'A' AND a.FROM_DT <= CURDATE())`);
    await run(`UPDATE emp_mst e SET e.EMP_STATUS = 'A'
                WHERE e.EMP_STATUS = 'L'
                  AND NOT EXISTS (SELECT 1 FROM leave_appl a WHERE a.EMP_CODE = e.EMP_CODE AND a.STATUS = 'A' AND a.FROM_DT <= CURDATE())`);
  };

  // ---------------------------------------------------------------- lookups
  router.get("/leave/lookups", async (req, res) => {
    try {
      const [types, emps, catgs] = await Promise.all([
        q(`SELECT LEAVE_TYPE AS code, LEAVE_NAME AS name, IS_ANNUAL AS isAnnual, PAY_TYPE AS payType,
                  MAX_DAYS_PA AS maxDays, MIN_SERVICE_M AS minServiceM, GENDER AS gender, DOC_REQ AS docReq
             FROM leave_type_mst WHERE ACTIVE = 'Y' ORDER BY SORT_NO, LEAVE_TYPE`),
        q(`SELECT e.EMP_CODE AS code, e.EMP_NAME AS name, e.EMP_CATG AS catg, e.EMP_STATUS AS status, e.CARD_NO AS cardNo
             FROM emp_mst e WHERE e.EMP_STATUS IN ('A','L') ORDER BY e.EMP_CODE`),
        q(`SELECT catg_code AS code, catg_name AS name FROM emp_catg_mst ORDER BY catg_code`),
      ]);
      res.json({ types, emps, catgs });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- list
  router.get("/leave/appl", async (req, res) => {
    try {
      await syncOnLeave().catch(() => { /* status sync is best effort */ });
      const where = ["1=1"]; const p = [];
      const st = list(req.query.status).filter((s) => ["D", "A", "R", "S", "C"].includes(s));
      if (st.length) { where.push("a.STATUS IN (?)"); p.push(st); }
      // period: leave that overlaps from..to
      if (isYmd(req.query.from)) { where.push("COALESCE(DATE_SUB(a.RESUME_DT, INTERVAL 1 DAY), a.TO_DT) >= ?"); p.push(req.query.from); }
      if (isYmd(req.query.to)) { where.push("a.FROM_DT <= ?"); p.push(req.query.to); }
      if (req.query.emp) { where.push("a.EMP_CODE = ?"); p.push(String(req.query.emp).trim().toUpperCase()); }
      const rows = await q(`${APPL_SQL} WHERE ${where.join(" AND ")} ORDER BY a.FROM_DT DESC, a.LEAVE_NO DESC LIMIT 3000`, p);
      res.json({ rows });
    } catch (e) { send(res, e); }
  });

  router.get("/leave/appl/:no", async (req, res) => {
    try { res.json({ row: await applOf(String(req.params.no).trim().toUpperCase()) }); } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- employee info for the application form
  router.get("/leave/emp-info/:code", async (req, res) => {
    try {
      const code = String(req.params.code).trim().toUpperCase();
      const asOn = isYmd(req.query.asOn) ? req.query.asOn : todayYmd();
      const excl = String(req.query.excl || "").trim().toUpperCase();
      const emp = await empOf(code);
      const leaves = (await leavesOf([code])).filter((l) => l.LEAVE_NO !== excl);
      // balance on the day before the leave starts
      const bal = leaveBalance(emp, leaves, addDays(asOn, -1));
      // this calendar year's use of each leave type (approved + resumed, this application excluded)
      const yr = asOn.slice(0, 4);
      const yearUse = {};
      leaves.filter((l) => l.FROM_DT.slice(0, 4) === yr).forEach((l) => {
        yearUse[l.LEAVE_TYPE] = r2((yearUse[l.LEAVE_TYPE] || 0) + Number(l.STATUS === "S" ? l.ACT_DAYS : l.DAYS));
      });
      const recent = await q(`${APPL_SQL} WHERE a.EMP_CODE = ? AND a.LEAVE_NO <> ? ORDER BY a.FROM_DT DESC LIMIT 6`, [code, excl]);
      const svcMonths = emp.APPT_DT ? monthsDone(emp.APPT_DT, asOn) : null;
      res.json({ emp, bal, yearUse, recent, svcMonths });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- validation shared by add / edit
  const readBody = (b) => ({
    APPL_DT: b.APPL_DT, EMP_CODE: str(b.EMP_CODE, 4)?.toUpperCase() || null, LEAVE_TYPE: str(b.LEAVE_TYPE, 3)?.toUpperCase() || null,
    FROM_DT: b.FROM_DT, TO_DT: b.TO_DT, REASON: str(b.REASON, 200), CONTACT_ADDR: str(b.CONTACT_ADDR, 150),
    CONTACT_PHONE: str(b.CONTACT_PHONE, 30), RELIEVER_CODE: str(b.RELIEVER_CODE, 4)?.toUpperCase() || null,
    TICKET_REQ: yn(b.TICKET_REQ), ADV_SAL_REQ: yn(b.ADV_SAL_REQ),
  });
  const validate = async (db, a, exclNo) => {
    if (!a.EMP_CODE) throw fail(400, "Select the employee");
    if (!a.LEAVE_TYPE) throw fail(400, "Select the leave type");
    if (!isYmd(a.APPL_DT)) throw fail(400, "Application date is not valid");
    if (!isYmd(a.FROM_DT) || !isYmd(a.TO_DT)) throw fail(400, "Leave from / to dates are not valid");
    if (a.TO_DT < a.FROM_DT) throw fail(400, "Leave 'To' date is before the 'From' date");
    if (a.RELIEVER_CODE && a.RELIEVER_CODE === a.EMP_CODE) throw fail(400, "Reliever cannot be the same employee");
    const emp = await empOf(a.EMP_CODE, db);
    if (!["A", "L"].includes(emp.EMP_STATUS)) throw fail(400, `${emp.EMP_NAME} is not in service`);
    const lt = await qc(db, "SELECT * FROM leave_type_mst WHERE LEAVE_TYPE = ? AND ACTIVE = 'Y'", [a.LEAVE_TYPE]);
    if (!lt.length) throw fail(400, `Leave type ${a.LEAVE_TYPE} is not in the leave type master`);
    if (lt[0].GENDER && emp.GENDER && lt[0].GENDER !== emp.GENDER) throw fail(400, `${lt[0].LEAVE_NAME} does not apply to this employee`);
    const clash = await qc(db,
      `SELECT LEAVE_NO, DATE_FORMAT(FROM_DT,'%d/%m/%Y') f, DATE_FORMAT(TO_DT,'%d/%m/%Y') t FROM leave_appl
        WHERE EMP_CODE = ? AND LEAVE_NO <> ? AND STATUS IN ('D','A','S')
          AND FROM_DT <= ? AND COALESCE(DATE_SUB(RESUME_DT, INTERVAL 1 DAY), TO_DT) >= ? LIMIT 1`,
      [a.EMP_CODE, exclNo || "", a.TO_DT, a.FROM_DT]);
    if (clash.length) throw fail(400, `Overlaps leave ${clash[0].LEAVE_NO} (${clash[0].f} – ${clash[0].t})`);
    a.DAYS = daysBetween(a.FROM_DT, a.TO_DT) + 1;                 // calendar days
    // annual balance snapshot (day before the leave)
    const leaves = (await leavesOf([a.EMP_CODE], db)).filter((l) => l.LEAVE_NO !== exclNo);
    a.BAL_ON_APPL = leaveBalance(emp, leaves, addDays(a.FROM_DT, -1)).available;
    return { emp, lt: lt[0] };
  };

  // ---------------------------------------------------------------- add
  router.post("/leave/appl", async (req, res) => {
    const a = readBody(req.body || {});
    const user = userOf(req);
    try {
      let no = null;
      for (let attempt = 0; attempt < 3 && !no; attempt++) {
        try {
          no = await tx(async (db) => {
            await validate(db, a, null);
            const pre = `LV${a.APPL_DT.slice(0, 4)}-`;
            const m = await qc(db, "SELECT MAX(CAST(SUBSTRING(LEAVE_NO, 8) AS UNSIGNED)) n FROM leave_appl WHERE LEAVE_NO LIKE ?", [pre + "%"]);
            const newNo = pre + String((Number(m[0].n) || 0) + 1).padStart(4, "0");
            await qc(db,
              `INSERT INTO leave_appl (LEAVE_NO, APPL_DT, EMP_CODE, LEAVE_TYPE, FROM_DT, TO_DT, DAYS, REASON, CONTACT_ADDR,
                                       CONTACT_PHONE, RELIEVER_CODE, TICKET_REQ, ADV_SAL_REQ, BAL_ON_APPL, STATUS, CREATED_BY)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'D', ?)`,
              [newNo, a.APPL_DT, a.EMP_CODE, a.LEAVE_TYPE, a.FROM_DT, a.TO_DT, a.DAYS, a.REASON, a.CONTACT_ADDR,
                a.CONTACT_PHONE, a.RELIEVER_CODE, a.TICKET_REQ, a.ADV_SAL_REQ, a.BAL_ON_APPL, user]);
            return newNo;
          });
        } catch (e) { if (e.code !== "ER_DUP_ENTRY") throw e; }      // number taken by another user — retry
      }
      if (!no) throw fail(409, "Could not allocate a leave number, please save again");
      res.json({ ok: true, LEAVE_NO: no, message: `Leave application ${no} saved` });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- edit (applied only)
  router.put("/leave/appl/:no", async (req, res) => {
    const no = String(req.params.no).trim().toUpperCase();
    const a = readBody(req.body || {});
    try {
      await tx(async (db) => {
        const cur = await applOf(no, db);
        if (cur.STATUS !== "D") throw fail(400, `Leave ${no} is ${STATUS_TXT[cur.STATUS]} — only an applied (not yet approved) leave can be edited`);
        await validate(db, a, no);
        await qc(db,
          `UPDATE leave_appl SET APPL_DT=?, EMP_CODE=?, LEAVE_TYPE=?, FROM_DT=?, TO_DT=?, DAYS=?, REASON=?, CONTACT_ADDR=?,
                  CONTACT_PHONE=?, RELIEVER_CODE=?, TICKET_REQ=?, ADV_SAL_REQ=?, BAL_ON_APPL=?, MODIFIED_BY=?
            WHERE LEAVE_NO = ?`,
          [a.APPL_DT, a.EMP_CODE, a.LEAVE_TYPE, a.FROM_DT, a.TO_DT, a.DAYS, a.REASON, a.CONTACT_ADDR, a.CONTACT_PHONE,
            a.RELIEVER_CODE, a.TICKET_REQ, a.ADV_SAL_REQ, a.BAL_ON_APPL, userOf(req), no]);
      });
      res.json({ ok: true, LEAVE_NO: no, message: `Leave application ${no} saved` });
    } catch (e) { send(res, e); }
  });

  router.delete("/leave/appl/:no", async (req, res) => {
    const no = String(req.params.no).trim().toUpperCase();
    try {
      await tx(async (db) => {
        const cur = await applOf(no, db);
        if (cur.STATUS !== "D") throw fail(400, `Leave ${no} is ${STATUS_TXT[cur.STATUS]} — cancel it instead of deleting`);
        await qc(db, "DELETE FROM leave_appl WHERE LEAVE_NO = ?", [no]);
      });
      res.json({ ok: true, message: `Leave application ${no} deleted` });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- status actions
  const STATUS_TXT = { D: "Applied", A: "Approved", R: "Rejected", S: "Resumed", C: "Cancelled" };

  // plain :action (no inline regex) so it works on Express 4 and 5
  router.post("/leave/appl/:no/:action", async (req, res) => {
    const no = String(req.params.no).trim().toUpperCase();
    const action = String(req.params.action || "").toLowerCase();
    if (!["approve", "reject", "resume", "cancel", "revoke"].includes(action)) return res.status(404).json({ message: `Unknown action ${action}` });
    const user = userOf(req);
    const remarks = str(req.body?.remarks, 150);
    try {
      const msg = await tx(async (db) => {
        const cur = await applOf(no, db);
        const need = (ok, what) => { if (!ok.includes(cur.STATUS)) throw fail(400, `Leave ${no} is ${STATUS_TXT[cur.STATUS]} — cannot ${what}`); };

        if (action === "approve") {
          need(["D"], "approve");
          const clash = await qc(db,
            `SELECT LEAVE_NO FROM leave_appl WHERE EMP_CODE = ? AND LEAVE_NO <> ? AND STATUS IN ('A','S')
               AND FROM_DT <= ? AND COALESCE(DATE_SUB(RESUME_DT, INTERVAL 1 DAY), TO_DT) >= ? LIMIT 1`,
            [cur.EMP_CODE, no, cur.TO_DT, cur.FROM_DT]);
          if (clash.length) throw fail(400, `Overlaps approved leave ${clash[0].LEAVE_NO}`);
          await qc(db, "UPDATE leave_appl SET STATUS='A', APPR_BY=?, APPR_DT=NOW(), APPR_REMARKS=? WHERE LEAVE_NO=?", [user, remarks, no]);
          await syncOnLeave(db);
          return `Leave ${no} approved`;
        }
        if (action === "reject") {
          need(["D"], "reject");
          if (!remarks) throw fail(400, "Give the reason for rejecting");
          await qc(db, "UPDATE leave_appl SET STATUS='R', APPR_BY=?, APPR_DT=NOW(), APPR_REMARKS=? WHERE LEAVE_NO=?", [user, remarks, no]);
          return `Leave ${no} rejected`;
        }
        if (action === "resume") {
          need(["A"], "record resumption");
          const rd = req.body?.resumeDt;
          if (!isYmd(rd)) throw fail(400, "Resumption date is not valid");
          if (rd <= cur.FROM_DT) throw fail(400, "Resumption date must be after the leave start date");
          const act = daysBetween(cur.FROM_DT, rd);
          await qc(db, "UPDATE leave_appl SET STATUS='S', RESUME_DT=?, ACT_DAYS=?, RESUME_REMARKS=?, RESUMED_BY=? WHERE LEAVE_NO=?",
            [rd, act, remarks, user, no]);
          if (cur.IS_ANNUAL === "Y") {
            // last annual leave on the employee master (only if this one is the latest)
            await qc(db,
              `INSERT INTO hr_mst (EMP_CODE, LAST_LEAVE_DT, LAST_RESUME_DT, CREATED_BY) VALUES (?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE
                 LAST_RESUME_DT = IF(LAST_LEAVE_DT IS NULL OR LAST_LEAVE_DT <= VALUES(LAST_LEAVE_DT), VALUES(LAST_RESUME_DT), LAST_RESUME_DT),
                 LAST_LEAVE_DT  = IF(LAST_LEAVE_DT IS NULL OR LAST_LEAVE_DT <= VALUES(LAST_LEAVE_DT), VALUES(LAST_LEAVE_DT), LAST_LEAVE_DT)`,
              [cur.EMP_CODE, cur.FROM_DT, rd, user]);
          }
          await syncOnLeave(db);
          const diff = act - Number(cur.DAYS);
          return `Leave ${no} closed — ${act} day${act === 1 ? "" : "s"} taken`
            + (diff > 0 ? ` (${diff} day${diff === 1 ? "" : "s"} over the approved ${Number(cur.DAYS)})` : diff < 0 ? ` (returned ${-diff} day${diff === -1 ? "" : "s"} early)` : "");
        }
        if (action === "cancel") {
          need(["D", "A"], "cancel");
          await qc(db, "UPDATE leave_appl SET STATUS='C', APPR_REMARKS=COALESCE(?, APPR_REMARKS), MODIFIED_BY=? WHERE LEAVE_NO=?", [remarks, user, no]);
          await syncOnLeave(db);
          return `Leave ${no} cancelled`;
        }
        // revoke — admin only, one step back
        if (!ADMIN_USERS.includes(String(user || "").toLowerCase())) throw fail(403, "Only the admin user can revoke");
        need(["A", "S"], "revoke");
        if (cur.STATUS === "S") {
          await qc(db, "UPDATE leave_appl SET STATUS='A', RESUME_DT=NULL, ACT_DAYS=NULL, RESUME_REMARKS=NULL, RESUMED_BY=NULL, MODIFIED_BY=? WHERE LEAVE_NO=?", [user, no]);
        } else {
          await qc(db, "UPDATE leave_appl SET STATUS='D', APPR_BY=NULL, APPR_DT=NULL, APPR_REMARKS=NULL, MODIFIED_BY=? WHERE LEAVE_NO=?", [user, no]);
        }
        await syncOnLeave(db);
        return `Leave ${no} revoked to ${cur.STATUS === "S" ? "Approved" : "Applied"}`;
      });
      res.json({ ok: true, message: msg, row: await applOf(no) });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- salary rate (current master figure)
  // Leave salary in this company is on basic salary only — allowances are not included.
  // The shape (lines / monthly / dailyFull) is kept so the screens that read `rates` need no change;
  // monthly = basic and dailyFull = dailyBasic.
  const ratesOf = async (code) => {
    const p = await q("SELECT COALESCE(BASIC_SAL, 0) AS BASIC_SAL FROM payroll_mst WHERE EMP_CODE = ?", [code]);
    const basic = r2(p[0]?.BASIC_SAL);
    const dailyBasic = r2(basic * 12 / 365);
    return {
      lines: [{ code: "BASIC", name: "Basic Salary", monthly: basic, daily: dailyBasic }],
      monthly: basic, basic, dailyFull: dailyBasic, dailyBasic,
    };
  };

  // ---------------------------------------------------------------- leave salary of one application (detailed)
  router.get("/leave/salary/:no", async (req, res) => {
    try {
      const no = String(req.params.no).trim().toUpperCase();
      const a = await applOf(no);
      if (a.IS_ANNUAL !== "Y") throw fail(400, `${a.LEAVE_NAME} is not paid as leave salary — only annual-type leave is (other leave is paid through the monthly payroll as per its pay type)`);
      const emp = await empOf(a.EMP_CODE);
      const leaves = (await leavesOf([a.EMP_CODE])).filter((l) => l.LEAVE_NO !== no);
      const before = leaveBalance(emp, leaves, addDays(a.FROM_DT, -1));
      const resumed = a.STATUS === "S";
      const days = Number(resumed ? a.ACT_DAYS : a.DAYS) || 0;
      const avail = Math.max(before.available, 0);
      const paidDays = r2(Math.min(days, avail));
      const unpaidDays = r2(days - paidDays);
      const rates = await ratesOf(a.EMP_CODE);
      const total = r2(rates.dailyBasic * paidDays);                  // basic daily rate × paid days
      const lines = rates.lines.map((l) => ({ ...l, days: paidDays, amount: total }));
      const after = r2(before.available - days);
      res.json({
        appl: a, emp, before, days, daysBasis: resumed ? "actual (resumed)" : "applied", paidDays, unpaidDays,
        lines, monthly: rates.basic, dailyFull: rates.dailyBasic, total,
        balanceAfter: after,
        exitValue: { days: Math.max(after, 0), dailyBasic: rates.dailyBasic, amount: r2(Math.max(after, 0) * rates.dailyBasic) },
      });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- leave ledger
  router.get("/leave/ledger/:code", async (req, res) => {
    try {
      const code = String(req.params.code).trim().toUpperCase();
      const to = isYmd(req.query.to) ? req.query.to : todayYmd();
      const from = isYmd(req.query.from) ? req.query.from : null;
      const emp = await empOf(code);
      const leaves = await leavesOf([code]);
      const bal = leaveBalance(emp, leaves, to);
      let rates = null;
      if (String(req.query.withSal || "") === "1") {
        const r = await ratesOf(code);
        rates = { monthly: r.monthly, basic: r.basic, dailyFull: r.dailyFull, dailyBasic: r.dailyBasic, lines: r.lines };
      }
      // one leave type only
      let type = String(req.query.type || "").trim().toUpperCase();
      if (type && type !== "ANNUAL") {
        const lt = await q("SELECT LEAVE_TYPE, LEAVE_NAME, IS_ANNUAL, MAX_DAYS_PA FROM leave_type_mst WHERE LEAVE_TYPE = ?", [type]);
        if (!lt.length) throw fail(400, `Leave type ${type} is not in the leave type master`);
        if (lt[0].IS_ANNUAL === "Y") type = "ANNUAL";                  // AL / EL share the annual balance
        else {
          const limit = lt[0].MAX_DAYS_PA == null ? null : Number(lt[0].MAX_DAYS_PA);
          const led = typeLedger(leaves.filter((l) => l.LEAVE_TYPE === type), limit, from, to);
          return res.json({ emp, from, to, mode: "TYPE", type, typeName: lt[0].LEAVE_NAME, limit, ...led, bal, other: {} });
        }
      }
      const led = leaveLedger(emp, leaves, from, to);
      if (type === "ANNUAL") led.rows = led.rows.filter((r) => r.kind !== "OTHER");
      // other leave (not annual) in the period, by type
      const other = {};
      led.rows.filter((r) => r.kind === "OTHER").forEach((r) => { other[r.type] = r2((other[r.type] || 0) + r.other); });
      res.json({ emp, from, to, mode: type === "ANNUAL" ? "ANNUAL" : "ALL", ...led, bal, other: type === "ANNUAL" ? {} : other, rates });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- leave balance report
  router.get("/leave/balance", async (req, res) => {
    try {
      const catgs = list(req.query.catg);
      if (!catgs.length) throw fail(400, "Select at least one employee category");
      const sts = list(req.query.status).filter((x) => STATUSES.includes(x));
      const statuses = sts.length ? sts : ["A", "L"];
      const asOn = isYmd(req.query.asOn) ? req.query.asOn : todayYmd();
      const withSal = String(req.query.withSal || "") === "1";
      const emps = await q(
        `${EMP_SQL.replace("FROM emp_mst e", `${withSal ? ", COALESCE(p.BASIC_SAL, 0) AS BASIC_SAL" : ""}, c.catg_name AS CATG_NAME FROM emp_mst e`)}
          LEFT JOIN emp_catg_mst c ON c.catg_code = e.EMP_CATG
          ${withSal ? "LEFT JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE" : ""}
         WHERE e.EMP_CATG IN (?) AND e.EMP_STATUS IN (?)
         ORDER BY e.EMP_CODE`, [catgs, statuses]);
      const leaves = await leavesOf(emps.map((e) => e.EMP_CODE));
      const byEmp = new Map();
      leaves.forEach((l) => { if (!byEmp.has(l.EMP_CODE)) byEmp.set(l.EMP_CODE, []); byEmp.get(l.EMP_CODE).push(l); });
      const yr = asOn.slice(0, 4);
      const rows = emps.map((e) => {
        const ls = byEmp.get(e.EMP_CODE) || [];
        const b = leaveBalance(e, ls, asOn);
        const yearOf = (pred) => r2(ls.filter((l) => l.FROM_DT.slice(0, 4) === yr && l.FROM_DT <= asOn && pred(l))
          .reduce((t, l) => t + Number(l.STATUS === "S" ? l.ACT_DAYS : l.DAYS), 0));
        const onLeave = ls.find((l) => l.STATUS === "A" && l.FROM_DT <= asOn);
        const row = {
          ...e, OPENING: b.opening, EARNED: b.earned, TAKEN: b.taken, BALANCE: b.balance, BOOKED: b.booked, AVAILABLE: b.available,
          SICK_YR: yearOf((l) => l.LEAVE_TYPE === "SL"), UNPAID_YR: yearOf((l) => l.LEAVE_TYPE === "UL"),
          OTHER_YR: yearOf((l) => l.IS_ANNUAL !== "Y" && !["SL", "UL"].includes(l.LEAVE_TYPE)),
          ON_LEAVE: onLeave ? onLeave.LEAVE_NO : null,
        };
        if (withSal) {
          row.DAY_RATE = r2(Number(e.BASIC_SAL) * 12 / 365);
          row.LEAVE_SAL = r2(row.DAY_RATE * Math.max(b.balance, 0));
        }
        return row;
      });
      res.json({ asOn, rows });
    } catch (e) { send(res, e); }
  });

// GET /api/leave/matrix-ledger

router.get('/leave/matrix-ledger', async (req, res) => {
  try {
    // 1. Fetch unique active leave years including 'A' and 'S' (Resumed)
    const yearResult = await q(`
      SELECT DISTINCT YEAR(FROM_DT) AS yr 
      FROM leave_appl 
      WHERE FROM_DT IS NOT NULL AND STATUS IN ('A', 'S') AND LEAVE_TYPE = 'AL'
      ORDER BY yr ASC;
    `);
        const rawYears = Array.isArray(yearResult) ? (Array.isArray(yearResult[0]) ? yearResult[0] : yearResult) : [];
    let dbYears = rawYears.map(y => Number(y.yr || y)).filter(Boolean);

    // Minimum 4-year default range fallback
    const defaultYears = [2022,2023, 2024, 2025, 2026];
    const years = Array.from(new Set([...defaultYears, ...dbYears])).sort((a, b) => a - b);

    // 2. Fetch employees
    const empResult = await q(`
      SELECT EMP_CODE as empCode, EMP_NAME as empName, DATE_FORMAT(APPT_DT, '%Y-%m-%d') as joinDate 
      FROM emp_mst 
      WHERE EMP_CODE IS NOT NULL AND EMP_CODE != ''
      ORDER BY EMP_CODE ASC;
    `);
    const empList = Array.isArray(empResult) ? (Array.isArray(empResult[0]) ? empResult[0] : empResult) : [];

    // 3. Fetch approved and resumed annual leave records
    const leaveResult = await q(`
      SELECT EMP_CODE as empCode, YEAR(FROM_DT) AS yr, DATE_FORMAT(FROM_DT, '%Y-%m-%d') AS fromDt, DATE_FORMAT(TO_DT, '%Y-%m-%d') AS toDt, DAYS as days
      FROM leave_appl 
      WHERE STATUS IN ('A', 'S') AND LEAVE_TYPE = 'AL';
    `);
    const leaveList = Array.isArray(leaveResult) ? (Array.isArray(leaveResult[0]) ? leaveResult[0] : leaveResult) : [];

    // 4. Index leave records by employee code and year
    const leaveMap = {};
    leaveList.forEach(l => {
      if (!leaveMap[l.empCode]) leaveMap[l.empCode] = {};
      if (!leaveMap[l.empCode][l.yr]) {
        leaveMap[l.empCode][l.yr] = { from: l.fromDt, to: l.toDt, days: Number(l.days) || 0 };
      } else {
        leaveMap[l.empCode][l.yr].days += Number(l.days) || 0;
      }
    });

    // 5. Build structured response per employee across all target years
    const formattedData = empList.map(emp => {
      const empLeaves = leaveMap[emp.empCode] || {};
      let totalDays = 0;
      const leavesByYear = {};

      years.forEach(y => {
        const yrData = empLeaves[y] || { from: null, to: null, days: 0 };
        leavesByYear[y] = yrData;
        totalDays += yrData.days;
      });

      return {
        code: emp.empCode,
        name: emp.empName,
        joinDate: emp.joinDate || '',
        leaves: leavesByYear,
        totalDays: totalDays
      };
    });

    res.json({ success: true, years, data: formattedData });
  } catch (err) {
    console.error('Matrix Ledger Error:', err);
    res.status(500).json({ error: err.message });
  }
});
return router;
};

// exported for testing
module.exports.engine = { leaveEvents, leaveBalance, leaveLedger, typeLedger, monthsDone, addMonths, daysBetween };
