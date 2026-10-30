// =====================================================================
// empAllowDedApi.js — employee fixed allowances / deductions (EmpMst Payroll tab)  30-Oct-2026
//
//   GET  /api/emp-allow-ded/:empCode   { allow: [{ALLOW_CODE, ALLOW_DESC, ALLOW_TYPE, AMOUNT}], ded: [...] }
//   GET  /api/allow-ded-codes          { allow: allow_mst rows, ded: ded_mst rows }   (F9 lists)
//   POST /api/save-emp-allow-ded       { empCode, allow: [{ALLOW_CODE, AMOUNT}], ded: [{DED_CODE, AMOUNT}] }
//                                       replaces the employee's rows in one transaction
//
// Register in HayatDb.js:
//   const empAllowDedApi = require('./routes/empAllowDedApi');
//   app.use('/api', empAllowDedApi(connection));
// =====================================================================
const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  const getConn = () =>
    new Promise((resolve, reject) => connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) => conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  const userOf = (req) => (req.user && (req.user.username || req.user.USER_NAME || req.user.userId)) || null;
  const amt = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

  router.get('/emp-allow-ded/:empCode', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const code = String(req.params.empCode || '').trim().toUpperCase();
      const allow = await q(
        conn,
        `SELECT e.ALLOW_CODE, a.ALLOW_DESC, a.ALLOW_TYPE, e.AMOUNT
           FROM emp_allow_mst e LEFT JOIN allow_mst a ON a.ALLOW_CODE = e.ALLOW_CODE
          WHERE e.EMP_CODE = ? ORDER BY e.srno_row_id`,
        [code],
      );
      const ded = await q(
        conn,
        `SELECT e.DED_CODE, d.DED_DESC, d.DED_TYPE, e.AMOUNT
           FROM emp_ded_mst e LEFT JOIN ded_mst d ON d.DED_CODE = e.DED_CODE
          WHERE e.EMP_CODE = ? ORDER BY e.srno_row_id`,
        [code],
      );
      res.json({ allow, ded });
    } catch (err) {
      console.error('emp-allow-ded:', err);
      res.status(500).json({ message: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  router.get('/allow-ded-codes', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const allow = await q(conn, `SELECT ALLOW_CODE, ALLOW_DESC, ALLOW_TYPE FROM allow_mst ORDER BY ALLOW_CODE`);
      const ded = await q(conn, `SELECT DED_CODE, DED_DESC, DED_TYPE FROM ded_mst ORDER BY DED_CODE`);
      res.json({ allow, ded });
    } catch (err) {
      console.error('allow-ded-codes:', err);
      res.status(500).json({ message: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  router.post('/save-emp-allow-ded', async (req, res) => {
    const { empCode, allow = [], ded = [] } = req.body || {};
    const code = String(empCode || '').trim().toUpperCase();
    let conn;
    try {
      if (!code) throw new Error('Emp Code missing');
      // one row per code; blank / zero lines are dropped
      const clean = (rows, key) => {
        const seen = new Set();
        return rows
          .filter((r) => r && r[key] !== null && r[key] !== '' && r[key] !== undefined && amt(r.AMOUNT) > 0)
          .map((r) => {
            const c = Number(r[key]);
            if (seen.has(c)) throw new Error(`Code ${c} is entered twice`);
            seen.add(c);
            return { code: c, amount: amt(r.AMOUNT) };
          });
      };
      const a = clean(allow, 'ALLOW_CODE');
      const d = clean(ded, 'DED_CODE');

      conn = await getConn();
      await q(conn, 'START TRANSACTION');
      await q(conn, `DELETE FROM emp_allow_mst WHERE EMP_CODE = ?`, [code]);
      await q(conn, `DELETE FROM emp_ded_mst WHERE EMP_CODE = ?`, [code]);
      const who = userOf(req);
      for (const r of a)
        await q(conn, `INSERT INTO emp_allow_mst (EMP_CODE, ALLOW_CODE, AMOUNT, CREATED_BY) VALUES (?,?,?,?)`, [code, r.code, r.amount, who]);
      for (const r of d)
        await q(conn, `INSERT INTO emp_ded_mst (EMP_CODE, DED_CODE, AMOUNT, CREATED_BY) VALUES (?,?,?,?)`, [code, r.code, r.amount, who]);
      await q(conn, 'COMMIT');
      res.json({ ok: true, message: 'Allowances and deductions saved' });
    } catch (err) {
      if (conn) await q(conn, 'ROLLBACK').catch(() => {});
      console.error('save-emp-allow-ded:', err);
      res.status(400).json({ ok: false, message: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
