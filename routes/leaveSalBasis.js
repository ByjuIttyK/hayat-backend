// routes/leaveSalBasis.js — leave salary basis (Payroll › Leave)  21-Nov-2026
// Shared by routes/leaveApi.js (GET /leave/salary/:no) and routes/leaveSalPayApi.js (voucher ctx / validation),
// so the statement and the payment voucher always pay the same days.
//
//   AVAIL (default)  leave salary for the leave EARNED since the last resumption — i.e. the RESUME_DT of the latest
//                    resumed annual leave before this one — or, when there is none, since the date of joining
//                    (opening balance + earned when an opening balance date is set), up to the day before this
//                    leave starts; encashments (voucher type E) in that period are deducted.
//   APPL             leave salary for the days of this application (actual days once resumed) — the earlier rule.
//
// The engine is passed in (not required here) to avoid a circular require with leaveApi.js.
// Uses engine.leaveBalance(emp, leaves, asOn, encashments) — its `earned` is cumulative, so
// earned in a period = earned(end) − earned(day before start).

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const prevDay = (ymd) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const basisOf = (v) => (String(v || "").toUpperCase() === "APPL" ? "APPL" : "AVAIL");

/**
 * Available (earned) days for one annual leave.
 * @param engine  leave engine of routes/leaveApi.js
 * @param emp     employee row (APPT_DT, LEAVE_DAYS_PA, LEAVE_OPBAL, LEAVE_OPBAL_DT …) as the engine expects
 * @param leaves  the employee's approved / resumed leave rows (FROM_DT, TO_DT, RESUME_DT, STATUS, IS_ANNUAL, LEAVE_NO …)
 * @param leave   the leave application being paid (needs LEAVE_NO, FROM_DT)
 * @param encs    encashment vouchers of the employee (LS_TYPE 'E': LS_DT, DAYS)
 * @returns { from, to, source: 'R'|'O'|'J', lastLeave, earned, encashed, days }
 *          source R = since last resumption, O = opening balance date, J = date of joining
 */
function availableDays(engine, emp, leaves, leave, encs = []) {
  const fromDt = leave.FROM_DT;
  const toDt = prevDay(fromDt);
  const others = leaves.filter((l) => l.LEAVE_NO !== leave.LEAVE_NO);

  // latest resumed annual leave that came back on or before this leave starts; a resumption on or before the
  // opening-balance (cut-over) date is already inside the opening balance, so it is not used
  const opDt = emp.LEAVE_OPBAL_DT || null;
  const last = others
    .filter((l) => l.IS_ANNUAL === "Y" && l.STATUS === "S" && l.RESUME_DT && l.RESUME_DT <= fromDt && (!opDt || l.RESUME_DT > opDt))
    .sort((a, b) => (a.RESUME_DT < b.RESUME_DT ? 1 : a.RESUME_DT > b.RESUME_DT ? -1 : 0))[0] || null;

  const end = engine.leaveBalance(emp, others, toDt, encs);
  let start; let earned; let source;
  if (last) {
    start = last.RESUME_DT;
    const before = engine.leaveBalance(emp, others, prevDay(start), encs);
    earned = Number(end.earned || 0) - Number(before.earned || 0);
    source = "R";
  } else {
    start = emp.LEAVE_OPBAL_DT || emp.APPT_DT || null;
    earned = Number(end.opening || 0) + Number(end.earned || 0);
    source = emp.LEAVE_OPBAL_DT ? "O" : "J";
  }
  const encashed = encs
    .filter((p) => (!p.LS_TYPE || p.LS_TYPE === "E") && start && p.LS_DT >= start && p.LS_DT <= toDt)
    .reduce((t, p) => t + Number(p.DAYS || 0), 0);

  return {
    from: start, to: toDt, source, lastLeave: last ? last.LEAVE_NO : null,
    earned: r2(earned), encashed: r2(encashed), days: r2(Math.max(earned - encashed, 0)),
  };
}

module.exports = { availableDays, basisOf, prevDay };
