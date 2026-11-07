// =====================================================================
// routes/tsLeaveDays.js — approved leave days for the Time Sheet (03-Nov-2026)
// Used by routes/timeSheetApi.js (computeSheet) so every calculation of a sheet
// (/tsht/calc, open sheet, save, time approval, payslips) sees the leaves.
//
// Which leaves count
//   leave_appl STATUS 'A' (Approved)  : FROM_DT .. TO_DT
//   leave_appl STATUS 'S' (Resumed)   : FROM_DT .. RESUME_DT − 1   (actual leave, same as ACT_DAYS)
//   Applied (D), Rejected (R) and Cancelled (C) leaves are ignored.
// Leave is in calendar days, so Sundays and holidays inside the leave are leave days too.
//
// Pay per leave type (leave_type_mst.PAY_FLAG, 07-Nov-2026 — replaces the PAY_TYPE mapping)
//   PAY_FLAG  = 'N'  → 'U'  unpaid: a full day deducted
//   PAY_FLAG  = 'Y'  → 'A'  when IS_ANNUAL = 'Y': annual leave, off the month's salary, paid by Leave Salary
//                    → 'F'  otherwise: paid leave, no deduction (Sick, Maternity …)
//   PAY_FLAG empty → treated as 'Y' (paid). Add the column before using this file.
// =====================================================================

const LEAVE_SQL = `
  SELECT a.LEAVE_NO, a.LEAVE_TYPE, t.LEAVE_NAME, t.IS_ANNUAL, t.PAY_FLAG, a.STATUS,
         DATE_FORMAT(a.FROM_DT, '%Y-%m-%d') AS FROM_DT,
         DATE_FORMAT(CASE WHEN a.STATUS = 'S' AND a.RESUME_DT IS NOT NULL
                          THEN DATE_SUB(a.RESUME_DT, INTERVAL 1 DAY) ELSE a.TO_DT END, '%Y-%m-%d') AS END_DT
    FROM leave_appl a
    JOIN leave_type_mst t ON t.LEAVE_TYPE = a.LEAVE_TYPE
   WHERE a.EMP_CODE = ?
     AND a.STATUS IN ('A', 'S')
     AND a.FROM_DT <= ?
     AND (CASE WHEN a.STATUS = 'S' AND a.RESUME_DT IS NOT NULL
               THEN DATE_SUB(a.RESUME_DT, INTERVAL 1 DAY) ELSE a.TO_DT END) >= ?
   ORDER BY a.FROM_DT`;

/** 'A' annual · 'F' paid · 'U' unpaid — from leave_type_mst.PAY_FLAG (Y / N) */
const payOf = (r) => {
  if (String(r.PAY_FLAG || 'Y').trim().toUpperCase() === 'N') return 'U';
  return String(r.IS_ANNUAL || '').trim().toUpperCase() === 'Y' ? 'A' : 'F';
};

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Leave days of one employee between two dates (yyyy-mm-dd, inclusive).
 * Returns Map<date, { leaveNo, leaveType, leaveName, leavePay }>.
 * If leave_appl cannot be read the sheet is still calculated, without leaves.
 */
async function loadLeaveDays(conn, empCode, first, last) {
  const days = new Map();
  let rows;
  try {
    [rows] = await conn.query(LEAVE_SQL, [empCode, last, first]);
  } catch (e) {
    console.warn('[tsht] leave_appl not read:', e.code || e.message);
    return days;
  }
  for (const r of rows) {
    const from = r.FROM_DT > first ? r.FROM_DT : first;
    const to = r.END_DT < last ? r.END_DT : last;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (days.has(d)) continue; // overlapping leaves are blocked by the leave screen; keep the first
      days.set(d, {
        leaveNo: r.LEAVE_NO,
        leaveType: r.LEAVE_TYPE,
        leaveName: r.LEAVE_NAME,
        leavePay: payOf(r),
      });
    }
  }
  return days;
}

module.exports = { loadLeaveDays };
