// =====================================================================
// mgmtSalaryApi.js — Management Staff Salary entry (table mgmt_salary)   14-Nov-2026
//
//   One voucher = one employee of category 'M' (emp_mst.EMP_CATG) for one salary month.
//
//   GET  /api/mgmt-salary/emps                 employees of category M  → { rows: [{EMP_CODE, EMP_NAME}] }
//   GET  /api/mgmt-salary/next-no              expected next Vchr No (the real one is allocated on Save)
//   GET  /api/mgmt-salary-list?month=YYYY-MM   vouchers (all months when month is empty), newest first
//   GET  /api/mgmt-salary/vchr/:vchrNo         one voucher (EDIT)
//   POST /api/mgmt-salary/save    { mode: ADD|EDIT, vchrNo, vchrDate, month, empCode, salary, remarks }
//        ADD numbers MAX+1 inside the transaction (PK clash → retry). One entry per employee per month.
//   POST /api/mgmt-salary/delete  { vchrNo }
//
//   Payroll month close (payrollPeriod.js): a closed month cannot be added, changed or deleted.
//   Salary JV (tran type 15) posts each voucher with NARRATION2 = 'MS' + VCHR_NO; a posted voucher
//   cannot be changed or deleted — delete it from the Salary JV (or update the JV) first. (14-Nov-2026)
//
// Register in HayatDb.js:
//   const mgmtSalaryApi = require('./routes/mgmtSalaryApi');
//   app.use('/api', mgmtSalaryApi(connection));
// =====================================================================
const express = require('express');

const { assertPayrollOpen } = require('./payrollPeriod');

const MGMT_CATG = 'M';
const SALARY_JV_TYPE = '15';

module.exports = function (connection) {
  const router = express.Router();
  const getConn = () =>
    new Promise((resolve, reject) => connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) => conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  const userOf = (req) => (req.user && (req.user.username || req.user.USER_NAME || req.user.userId)) || null;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const monthOf = (s) => {
    const m = /^(\d{4})-(\d{2})/.exec(String(s || ''));
    return m && +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${m[2]}-01` : null;
  };
  const mmyyyy = (iso) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  /** Salary JV that posted this voucher (tran_acc NARRATION2 = 'MS' + VCHR_NO), or null. */
  const postedJv = async (conn, vchrNo) => {
    const [r] = await q(conn, `SELECT MIN(VCHR_NO) AS JV FROM tran_acc WHERE TRAN_TYPE = ? AND NARRATION2 = ?`, [SALARY_JV_TYPE, `MS${vchrNo}`]);
    return r && r.JV ? r.JV : null;
  };

  const withConn = (fn) => async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      await fn(conn, req, res);
    } catch (e) {
      if (conn) await q(conn, 'ROLLBACK').catch(() => {});
      console.error('[mgmt-salary]', e);
      res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : e.sqlMessage || e.message, code: e.code });
    } finally {
      if (conn) conn.release();
    }
  };

  const SELECT_VCHR = `
    SELECT s.VCHR_NO, DATE_FORMAT(s.VCHR_DATE, '%Y-%m-%d') AS VCHR_DATE, DATE_FORMAT(s.SAL_MONTH, '%Y-%m-%d') AS SAL_MONTH,
           s.EMP_CODE, e.EMP_NAME, s.SALARY, s.REMARKS, IFNULL(s.UPDATED_BY, s.CREATED_BY) AS USER_NAME
      FROM mgmt_salary s LEFT JOIN emp_mst e ON e.EMP_CODE = s.EMP_CODE`;

  // ---------------------------------------------------------------------
  router.get('/mgmt-salary/emps', withConn(async (conn, req, res) => {
    const rows = await q(conn, `SELECT EMP_CODE, EMP_NAME FROM emp_mst WHERE EMP_CATG = ? ORDER BY EMP_CODE`, [MGMT_CATG]);
    res.json({ ok: true, rows });
  }));

  router.get('/mgmt-salary/next-no', withConn(async (conn, req, res) => {
    const [m] = await q(conn, `SELECT IFNULL(MAX(CAST(VCHR_NO AS UNSIGNED)), 0) AS MX FROM mgmt_salary`);
    res.json({ ok: true, vchrNo: String(Number(m.MX || 0) + 1).padStart(10, '0') });
  }));

  router.get('/mgmt-salary-list', withConn(async (conn, req, res) => {
    const month = monthOf(req.query.month);
    const rows = await q(
      conn,
      `${SELECT_VCHR} ${month ? 'WHERE s.SAL_MONTH = ?' : ''} ORDER BY s.SAL_MONTH DESC, s.EMP_CODE, s.VCHR_NO DESC`,
      month ? [month] : [],
    );
    res.json({ ok: true, rows: rows.map((r) => ({ ...r, SALARY: Number(r.SALARY) || 0 })) });
  }));

  router.get('/mgmt-salary/vchr/:vchrNo', withConn(async (conn, req, res) => {
    const vchrNo = String(req.params.vchrNo || '').trim();
    const [r] = await q(conn, `${SELECT_VCHR} WHERE s.VCHR_NO = ?`, [vchrNo]);
    if (!r) throw fail(404, `Salary voucher ${vchrNo} not found`);
    res.json({ ok: true, row: { ...r, SALARY: Number(r.SALARY) || 0 } });
  }));

  // ---------------------------------------------------------------------
  router.post('/mgmt-salary/save', withConn(async (conn, req, res) => {
    const b = req.body || {};
    const mode = String(b.mode || 'ADD').toUpperCase() === 'EDIT' ? 'EDIT' : 'ADD';
    const month = monthOf(b.month);
    const empCode = String(b.empCode || '').trim().toUpperCase();
    const salary = r2(b.salary);
    const remarks = b.remarks ? String(b.remarks).slice(0, 500) : null;
    const who = userOf(req);
    if (mode === 'EDIT' && !b.vchrNo) throw fail(400, 'Voucher number missing');
    if (!isIso(b.vchrDate)) throw fail(400, 'Enter a valid Vchr. Date');
    if (!month) throw fail(400, 'Enter the Salary Month as MM/YYYY');
    if (!empCode) throw fail(400, 'Select the employee');
    if (!(salary > 0)) throw fail(400, 'Salary must be more than 0');

    for (let attempt = 0; ; attempt += 1) {
      try {
        await q(conn, 'START TRANSACTION');
        await assertPayrollOpen((sql, p) => q(conn, sql, p), month, mode === 'ADD' ? 'Adding a management salary' : 'Changing this management salary');

        const [emp] = await q(conn, `SELECT EMP_CODE, EMP_NAME, EMP_CATG FROM emp_mst WHERE EMP_CODE = ?`, [empCode]);
        if (!emp) throw fail(400, `Employee ${empCode} not found`);
        if (String(emp.EMP_CATG || '').toUpperCase() !== MGMT_CATG) throw fail(400, `${empCode} ${emp.EMP_NAME} is not management staff (category ${emp.EMP_CATG || '—'})`);

        let vchrNo = mode === 'EDIT' ? String(b.vchrNo).trim() : '';
        if (mode === 'EDIT') {
          const [old] = await q(conn, `SELECT DATE_FORMAT(SAL_MONTH, '%Y-%m-%d') AS SAL_MONTH FROM mgmt_salary WHERE VCHR_NO = ? FOR UPDATE`, [vchrNo]);
          if (!old) throw fail(404, `Salary voucher ${vchrNo} no longer exists`);
          const jv = await postedJv(conn, vchrNo);
          if (jv) throw fail(423, `Salary voucher ${vchrNo} is posted in Salary JV ${jv} — delete it from that JV first, then change it`);
          // moving the voucher out of a closed month is a change to that month too
          if (old.SAL_MONTH !== month) await assertPayrollOpen((sql, p) => q(conn, sql, p), old.SAL_MONTH, 'Changing this management salary');
        }

        // one entry per employee per month
        const [dup] = await q(
          conn,
          `SELECT VCHR_NO FROM mgmt_salary WHERE EMP_CODE = ? AND SAL_MONTH = ? AND VCHR_NO <> ? FOR UPDATE`,
          [empCode, month, vchrNo],
        );
        if (dup) throw fail(409, `Salary for ${empCode} ${emp.EMP_NAME} for ${mmyyyy(month)} is already entered in voucher ${dup.VCHR_NO}`);

        if (mode === 'ADD') {
          const [m] = await q(conn, `SELECT IFNULL(MAX(CAST(VCHR_NO AS UNSIGNED)), 0) AS MX FROM mgmt_salary`);
          vchrNo = String(Number(m.MX || 0) + 1).padStart(10, '0');
          await q(
            conn,
            `INSERT INTO mgmt_salary (VCHR_NO, VCHR_DATE, SAL_MONTH, EMP_CODE, SALARY, REMARKS, CREATED_BY, CREATED_DT)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [vchrNo, b.vchrDate, month, empCode, salary, remarks, who],
          );
        } else {
          await q(
            conn,
            `UPDATE mgmt_salary SET VCHR_DATE = ?, SAL_MONTH = ?, EMP_CODE = ?, SALARY = ?, REMARKS = ?, UPDATED_BY = ?, UPDATED_DT = NOW()
              WHERE VCHR_NO = ?`,
            [b.vchrDate, month, empCode, salary, remarks, who, vchrNo],
          );
        }
        await q(conn, 'COMMIT');
        console.log(`[mgmt-salary] ${who} ${mode === 'ADD' ? 'added' : 'updated'} ${vchrNo} — ${empCode} ${mmyyyy(month)} ${salary}`);
        return res.json({ ok: true, vchrNo, message: `Salary voucher ${vchrNo} ${mode === 'ADD' ? 'saved' : 'updated'} — ${empCode} ${emp.EMP_NAME}, ${mmyyyy(month)}, ${salary.toFixed(2)}` });
      } catch (e) {
        await q(conn, 'ROLLBACK').catch(() => {});
        // another user took this number a moment ago — take the next one (the emp/month clash is checked above)
        if (mode === 'ADD' && e.code === 'ER_DUP_ENTRY' && /PRIMARY/i.test(e.sqlMessage || '') && attempt < 3) continue;
        if (e.code === 'ER_DUP_ENTRY') throw fail(409, `Salary for ${empCode} for ${mmyyyy(month)} is already entered`);
        throw e;
      }
    }
  }));

  router.post('/mgmt-salary/delete', withConn(async (conn, req, res) => {
    const vchrNo = String((req.body || {}).vchrNo || '').trim();
    if (!vchrNo) throw fail(400, 'Voucher number missing');
    await q(conn, 'START TRANSACTION');
    const [r] = await q(conn, `SELECT DATE_FORMAT(SAL_MONTH, '%Y-%m-%d') AS SAL_MONTH FROM mgmt_salary WHERE VCHR_NO = ? FOR UPDATE`, [vchrNo]);
    if (!r) throw fail(404, `Salary voucher ${vchrNo} not found`);
    const jv = await postedJv(conn, vchrNo);
    if (jv) throw fail(423, `Salary voucher ${vchrNo} is posted in Salary JV ${jv} — delete it from that JV first`);
    await assertPayrollOpen((sql, p) => q(conn, sql, p), r.SAL_MONTH, `Deleting salary voucher ${vchrNo}`);
    await q(conn, 'DELETE FROM mgmt_salary WHERE VCHR_NO = ?', [vchrNo]);
    await q(conn, 'COMMIT');
    console.log(`[mgmt-salary] ${userOf(req)} deleted ${vchrNo}`);
    res.json({ ok: true, message: `Salary voucher ${vchrNo} deleted` });
  }));

  return router;
};
