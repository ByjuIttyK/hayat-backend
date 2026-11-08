// =====================================================================
// routes/payrollPeriod.js — payroll month close: the lock checks every payroll route calls  08-Nov-2026
//
// One row per month in payroll_period (company-wide):
//   STATUS      O open · C closed  — pay: time sheets, leaves, salary revisions, Salary JV
//   JOB_STATUS  O open · C closed  — job allocation / job approval (usually closed a month later)
//
//   assertPayrollOpen(run, date, what)       refuse when the pay of that month is closed
//   assertPayRangeOpen(run, from, to, what)  refuse when any month from..to has its pay closed
//   assertJobAllocOpen(run, date, what)      refuse when the job allocation of that month is closed
//
// run(sql, params) → Promise<rows>  — each route passes its own query function (its connection /
// transaction), so the check reads inside the same transaction as the change it guards.
// Until payroll_period exists every month counts as open, so this can be deployed before the table.
//
// DB (sql/payroll_period.sql):
//   CREATE TABLE payroll_period (
//     PERIOD_MONTH  DATE        NOT NULL PRIMARY KEY,   -- 1st of the month
//     STATUS        CHAR(1)     NOT NULL DEFAULT 'O',   -- pay: O open, C closed
//     CLOSED_BY     VARCHAR(30) NULL,  CLOSED_DT     DATETIME NULL,
//     JOB_STATUS    CHAR(1)     NOT NULL DEFAULT 'O',   -- job allocation: O open, C closed
//     JOB_CLOSED_BY VARCHAR(30) NULL,  JOB_CLOSED_DT DATETIME NULL,
//     REOPENED_BY   VARCHAR(30) NULL,  REOPENED_DT   DATETIME NULL,
//     REMARKS       VARCHAR(200) NULL
//   );
// =====================================================================
const monthFirst = (iso) => `${String(iso || '').slice(0, 7)}-01`;
const mmyyyy = (iso) => `${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}`;
const noTable = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146);
const locked = (message) => Object.assign(new Error(message), { status: 423 });

/** Closed months between two dates (pay or job), oldest first. */
async function closedMonths(run, from, to, col = 'STATUS') {
  try {
    const rows = await run(
      `SELECT DATE_FORMAT(PERIOD_MONTH, '%Y-%m-%d') AS M FROM payroll_period
        WHERE ${col} = 'C' AND PERIOD_MONTH BETWEEN ? AND ? ORDER BY PERIOD_MONTH`,
      [monthFirst(from), monthFirst(to)],
    );
    return rows.map((r) => r.M);
  } catch (e) {
    if (noTable(e)) return [];
    throw e;
  }
}

async function assertPayrollOpen(run, date, what = 'This change') {
  if (!date) return;
  const c = await closedMonths(run, date, date);
  if (c.length) throw locked(`${what} is not allowed — payroll for ${mmyyyy(c[0])} is closed. Reopen the month first (Payroll → Close Month).`);
}

async function assertPayRangeOpen(run, from, to, what = 'This change') {
  if (!from) return;
  const c = await closedMonths(run, from, to || from);
  if (c.length) throw locked(`${what} is not allowed — it falls in ${c.map(mmyyyy).join(', ')}, where payroll is closed. Reopen the month first (Payroll → Close Month).`);
}

async function assertJobAllocOpen(run, date, what = 'This change') {
  if (!date) return;
  const c = await closedMonths(run, date, date, 'JOB_STATUS');
  if (c.length) throw locked(`${what} is not allowed — job allocation for ${mmyyyy(c[0])} is closed. Reopen it first (Payroll → Close Month).`);
}

module.exports = { monthFirst, closedMonths, assertPayrollOpen, assertPayRangeOpen, assertJobAllocOpen };
