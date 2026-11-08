// =====================================================================
// routes/payrollPeriodApi.js — Payroll month close (PayrollClose screen)  08-Nov-2026
//
//   GET  /api/payroll-period?year=2026        months of the year with their pay / job status
//   GET  /api/payroll-period/check?month=YYYY-MM-01
//        what stops the month closing:
//          pay : missing   active employees with no time sheet for the month
//                drafts    time sheets still in Draft
//                unposted  processed sheets (salary > 0) not posted in a Salary JV
//          job : pending   sheets not yet Job approved
//   POST /api/payroll-period/close        { month, withJob, remarks }   pay closed (and job too when withJob)
//   POST /api/payroll-period/close-job    { month }                     job allocation closed (pay must be closed)
//   POST /api/payroll-period/reopen       { month, part: 'PAY'|'JOB' }  admin only; reopening PAY reopens JOB too
//
// Closing is company-wide. The lock checks themselves are in payrollPeriod.js.
//
// Register in HayatDb.js:
//   const payrollPeriodApi = require('./routes/payrollPeriodApi');
//   app.use('/api', payrollPeriodApi(connection));
// =====================================================================
const express = require('express');
const { monthFirst } = require('./payrollPeriod');

const SALARY_JV_TYPE = '15';
/** Users allowed to reopen a closed month — from the login token only (same rule as the other revokes). */
const REOPEN_USERS = ['admin'];

module.exports = function payrollPeriodApi(connection) {
  const router = express.Router();
  const db = connection.promise();
  const userOf = (req) =>
    String((req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) || 'system').slice(0, 30);
  const canReopen = (req) => REOPEN_USERS.includes(String((req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) || '').trim().toLowerCase());
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const send = (res, e) => {
    if (!e.status) console.error('[payroll-period]', e);
    res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : e.sqlMessage || e.message });
  };
  const isMonth = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) || /^\d{4}-\d{2}$/.test(String(s || ''));
  const mmyyyy = (iso) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

  const periodOf = async (run, month, lock = false) =>
    (await run(
      `SELECT DATE_FORMAT(PERIOD_MONTH,'%Y-%m-%d') AS PERIOD_MONTH, STATUS, CLOSED_BY,
              DATE_FORMAT(CLOSED_DT,'%d/%m/%Y %H:%i') AS CLOSED_DT, JOB_STATUS, JOB_CLOSED_BY,
              DATE_FORMAT(JOB_CLOSED_DT,'%d/%m/%Y %H:%i') AS JOB_CLOSED_DT, REOPENED_BY,
              DATE_FORMAT(REOPENED_DT,'%d/%m/%Y %H:%i') AS REOPENED_DT, REMARKS
         FROM payroll_period WHERE PERIOD_MONTH = ?${lock ? ' FOR UPDATE' : ''}`,
      [month],
    ))[0] || null;

  /** Everything that stops a month closing. */
  async function checkMonth(run, month) {
    const missing = await run(
      `SELECT e.EMP_CODE, e.EMP_NAME, e.EMP_CATG
         FROM emp_mst e
         JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
         LEFT JOIN time_sheet_hdr h ON h.EMP_CODE = e.EMP_CODE AND h.TSHT_DATE = ?
        WHERE e.EMP_STATUS IN ('A','L') AND (e.APPT_DT IS NULL OR e.APPT_DT <= LAST_DAY(?)) AND h.TSHT_NO IS NULL
        ORDER BY e.EMP_CATG, e.EMP_CODE`,
      [month, month],
    );
    const sheets = await run(
      `SELECT h.TSHT_NO, h.EMP_CODE, e.EMP_NAME, e.EMP_CATG, h.STATUS, IFNULL(h.TOTAL_SALARY,0) AS TOTAL_SALARY,
              (SELECT MIN(t.VCHR_NO) FROM tran_acc t WHERE t.TRAN_TYPE = ? AND t.NARRATION2 = h.TSHT_NO) AS JV_NO
         FROM time_sheet_hdr h JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
        WHERE h.TSHT_DATE = ?
        ORDER BY e.EMP_CATG, h.EMP_CODE`,
      [SALARY_JV_TYPE, month],
    );
    const drafts = sheets.filter((s) => s.STATUS === 'D');
    const unposted = sheets.filter((s) => s.STATUS !== 'D' && Number(s.TOTAL_SALARY) > 0 && !s.JV_NO);
    const pending = sheets.filter((s) => s.STATUS !== 'A');
    return {
      sheetCount: sheets.length,
      pay: { ok: !missing.length && !drafts.length && !unposted.length, missing, drafts, unposted },
      job: { ok: !pending.length, pending },
    };
  }

  const listIssues = (rows, fmt, max = 8) =>
    rows.slice(0, max).map(fmt).join(', ') + (rows.length > max ? ` and ${rows.length - max} more` : '');
  const payProblems = (c) =>
    [
      c.pay.missing.length && `no time sheet for ${listIssues(c.pay.missing, (r) => r.EMP_CODE)}`,
      c.pay.drafts.length && `still in Draft: ${listIssues(c.pay.drafts, (r) => r.TSHT_NO)}`,
      c.pay.unposted.length && `not posted in a Salary JV: ${listIssues(c.pay.unposted, (r) => r.TSHT_NO)}`,
    ].filter(Boolean);

  // ---------------------------------------------------------------
  router.get('/payroll-period', async (req, res) => {
    try {
      const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : String(new Date().getFullYear());
      const run = (sql, p) => db.query(sql, p).then(([r]) => r);
      const rows = await run(
        `SELECT DATE_FORMAT(PERIOD_MONTH,'%Y-%m-%d') AS PERIOD_MONTH, STATUS, CLOSED_BY,
                DATE_FORMAT(CLOSED_DT,'%d/%m/%Y %H:%i') AS CLOSED_DT, JOB_STATUS, JOB_CLOSED_BY,
                DATE_FORMAT(JOB_CLOSED_DT,'%d/%m/%Y %H:%i') AS JOB_CLOSED_DT, REOPENED_BY,
                DATE_FORMAT(REOPENED_DT,'%d/%m/%Y %H:%i') AS REOPENED_DT, REMARKS
           FROM payroll_period WHERE YEAR(PERIOD_MONTH) = ?`,
        [year],
      );
      const counts = await run(
        `SELECT DATE_FORMAT(TSHT_DATE,'%Y-%m-%d') AS M, COUNT(*) AS N,
                SUM(STATUS = 'D') AS DRAFT, SUM(STATUS = 'T') AS TIME_APPR, SUM(STATUS = 'A') AS JOB_APPR,
                IFNULL(SUM(TOTAL_SALARY),0) AS TOTAL
           FROM time_sheet_hdr WHERE YEAR(TSHT_DATE) = ? GROUP BY TSHT_DATE`,
        [year],
      );
      const byMonth = new Map(rows.map((r) => [r.PERIOD_MONTH, r]));
      const cntBy = new Map(counts.map((c) => [c.M, c]));
      const months = Array.from({ length: 12 }, (_, i) => {
        const m = `${year}-${String(i + 1).padStart(2, '0')}-01`;
        const p = byMonth.get(m) || {};
        const c = cntBy.get(m) || {};
        return {
          month: m,
          status: p.STATUS || 'O', closedBy: p.CLOSED_BY || null, closedDt: p.CLOSED_DT || null,
          jobStatus: p.JOB_STATUS || 'O', jobClosedBy: p.JOB_CLOSED_BY || null, jobClosedDt: p.JOB_CLOSED_DT || null,
          reopenedBy: p.REOPENED_BY || null, reopenedDt: p.REOPENED_DT || null, remarks: p.REMARKS || null,
          sheets: Number(c.N) || 0, draft: Number(c.DRAFT) || 0, timeAppr: Number(c.TIME_APPR) || 0,
          jobAppr: Number(c.JOB_APPR) || 0, total: Number(c.TOTAL) || 0,
        };
      });
      res.json({ ok: true, year, months, canReopen: canReopen(req) });
    } catch (e) {
      send(res, e);
    }
  });

  router.get('/payroll-period/check', async (req, res) => {
    try {
      if (!isMonth(req.query.month)) throw fail(400, 'Month must be YYYY-MM');
      const month = monthFirst(req.query.month);
      const run = (sql, p) => db.query(sql, p).then(([r]) => r);
      const c = await checkMonth(run, month);
      res.json({ ok: true, month, period: await periodOf(run, month), ...c, canReopen: canReopen(req) });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------------------------------------------------------------
  /** Runs fn(run) in one transaction on its own connection. */
  const tx = async (fn) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn((sql, p) => conn.query(sql, p).then(([r]) => r));
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  };

  router.post('/payroll-period/close', async (req, res) => {
    try {
      const b = req.body || {};
      if (!isMonth(b.month)) throw fail(400, 'Month must be YYYY-MM');
      const month = monthFirst(b.month);
      const withJob = !!b.withJob;
      const user = userOf(req);
      const msg = await tx(async (run) => {
        // row first, locked, so two users cannot close at once
        await run(`INSERT IGNORE INTO payroll_period (PERIOD_MONTH) VALUES (?)`, [month]);
        const p = await periodOf(run, month, true);
        if (p.STATUS === 'C') throw fail(409, `Payroll for ${mmyyyy(month)} is already closed`);
        const c = await checkMonth(run, month);
        if (!c.sheetCount) throw fail(400, `There are no time sheets for ${mmyyyy(month)}`);
        const problems = payProblems(c);
        if (problems.length) throw fail(400, `Payroll for ${mmyyyy(month)} cannot be closed — ${problems.join('; ')}`);
        if (withJob && !c.job.ok) {
          throw fail(400, `Job allocation for ${mmyyyy(month)} cannot be closed with it — not Job approved: ${listIssues(c.job.pending, (r) => r.TSHT_NO)}. Close the payroll alone, and the job allocation later.`);
        }
        await run(
          `UPDATE payroll_period SET STATUS = 'C', CLOSED_BY = ?, CLOSED_DT = NOW(), REMARKS = ?
                  ${withJob ? ", JOB_STATUS = 'C', JOB_CLOSED_BY = ?, JOB_CLOSED_DT = NOW()" : ''}
            WHERE PERIOD_MONTH = ?`,
          withJob ? [user, b.remarks ? String(b.remarks).slice(0, 200) : null, user, month] : [user, b.remarks ? String(b.remarks).slice(0, 200) : null, month],
        );
        return withJob ? `Payroll and job allocation for ${mmyyyy(month)} closed` : `Payroll for ${mmyyyy(month)} closed — job allocation stays open`;
      });
      console.log(`[payroll-period] ${user}: ${msg}`);
      res.json({ ok: true, message: msg });
    } catch (e) {
      send(res, e);
    }
  });

  router.post('/payroll-period/close-job', async (req, res) => {
    try {
      const b = req.body || {};
      if (!isMonth(b.month)) throw fail(400, 'Month must be YYYY-MM');
      const month = monthFirst(b.month);
      const user = userOf(req);
      const msg = await tx(async (run) => {
        const p = await periodOf(run, month, true);
        if (!p || p.STATUS !== 'C') throw fail(400, `Close the payroll for ${mmyyyy(month)} first`);
        if (p.JOB_STATUS === 'C') throw fail(409, `Job allocation for ${mmyyyy(month)} is already closed`);
        const c = await checkMonth(run, month);
        if (!c.job.ok) throw fail(400, `Job allocation for ${mmyyyy(month)} cannot be closed — not Job approved: ${listIssues(c.job.pending, (r) => r.TSHT_NO)}`);
        await run(`UPDATE payroll_period SET JOB_STATUS = 'C', JOB_CLOSED_BY = ?, JOB_CLOSED_DT = NOW() WHERE PERIOD_MONTH = ?`, [user, month]);
        return `Job allocation for ${mmyyyy(month)} closed`;
      });
      console.log(`[payroll-period] ${user}: ${msg}`);
      res.json({ ok: true, message: msg });
    } catch (e) {
      send(res, e);
    }
  });

  router.post('/payroll-period/reopen', async (req, res) => {
    try {
      if (!canReopen(req)) throw fail(403, 'Only admin can reopen a closed month');
      const b = req.body || {};
      if (!isMonth(b.month)) throw fail(400, 'Month must be YYYY-MM');
      const month = monthFirst(b.month);
      const part = String(b.part || 'PAY').toUpperCase() === 'JOB' ? 'JOB' : 'PAY';
      const user = userOf(req);
      const msg = await tx(async (run) => {
        const p = await periodOf(run, month, true);
        if (part === 'JOB') {
          if (!p || p.JOB_STATUS !== 'C') throw fail(409, `Job allocation for ${mmyyyy(month)} is not closed`);
          await run(
            `UPDATE payroll_period SET JOB_STATUS = 'O', JOB_CLOSED_BY = NULL, JOB_CLOSED_DT = NULL, REOPENED_BY = ?, REOPENED_DT = NOW() WHERE PERIOD_MONTH = ?`,
            [user, month],
          );
          return `Job allocation for ${mmyyyy(month)} reopened`;
        }
        if (!p || p.STATUS !== 'C') throw fail(409, `Payroll for ${mmyyyy(month)} is not closed`);
        // a reopened pay month cannot keep its job allocation closed
        await run(
          `UPDATE payroll_period SET STATUS = 'O', CLOSED_BY = NULL, CLOSED_DT = NULL,
                  JOB_STATUS = 'O', JOB_CLOSED_BY = NULL, JOB_CLOSED_DT = NULL, REOPENED_BY = ?, REOPENED_DT = NOW()
            WHERE PERIOD_MONTH = ?`,
          [user, month],
        );
        return `Payroll for ${mmyyyy(month)} reopened${p.JOB_STATUS === 'C' ? ' (job allocation reopened too)' : ''}`;
      });
      console.log(`[payroll-period] ${user}: ${msg}`);
      res.json({ ok: true, message: msg });
    } catch (e) {
      send(res, e);
    }
  });

  return router;
};
