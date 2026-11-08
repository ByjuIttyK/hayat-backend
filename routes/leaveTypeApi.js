// =====================================================================
// routes/leaveTypeApi.js — Leave Type master (LeaveTypeMst screen)  08-Nov-2026
//
//   GET  /api/leave-type-mst            every leave type, with how many applications use it (USED)
//   POST /api/save-leave-type           { mode: 'ADD'|'EDIT', row }
//   POST /api/delete-leave-type         { code }   only when no leave application uses it
//
// Table leave_type_mst:
//   LEAVE_TYPE   code (3, upper case) — PK, fixed once saved
//   LEAVE_NAME   name
//   IS_ANNUAL    Y = counts against the annual leave balance (paid as leave salary)
//   PAY_FLAG     Y paid · N unpaid — the time sheet deducts salary for N (tsLeaveDays.js)
//   PAY_TYPE     F full pay · H half pay · U unpaid — kept in step with PAY_FLAG: N ⇔ U
//   MAX_DAYS_PA  days allowed per calendar year (blank = no limit)
//   MIN_SERVICE_M months of service before it can be taken (blank = none)
//   GENDER       M / F only, blank = everyone
//   DOC_REQ      Y = supporting document needed (e.g. medical certificate)
//   SORT_NO      order in the lists
//   ACTIVE       N = no longer offered on new applications (old ones keep it)
//
// Register in HayatDb.js:
//   const leaveTypeApi = require('./routes/leaveTypeApi');
//   app.use('/api', leaveTypeApi(connection));
// =====================================================================
const express = require('express');

module.exports = function leaveTypeApi(connection) {
  const router = express.Router();
  const db = connection.promise();
  const userOf = (req) =>
    String((req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) || 'system').slice(0, 30);
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const send = (res, e) => {
    if (!e.status) console.error('[leave-type]', e);
    res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : e.sqlMessage || e.message });
  };
  const yn = (v, dflt = 'N') => (v === 'Y' || v === true ? 'Y' : v === 'N' || v === false ? 'N' : dflt);
  const optNum = (v, label, max, dec) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw fail(400, `${label} must be a number from 0 to ${max}`);
    return dec ? Math.round(n * 10) / 10 : Math.round(n);
  };

  router.get('/leave-type-mst', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT t.LEAVE_TYPE, t.LEAVE_NAME, t.IS_ANNUAL, t.PAY_TYPE, t.PAY_FLAG, t.MAX_DAYS_PA, t.MIN_SERVICE_M,
                t.GENDER, t.DOC_REQ, t.SORT_NO, t.ACTIVE, t.CREATED_BY,
                DATE_FORMAT(t.CREATED_ON,'%d/%m/%Y %H:%i') AS CREATED_ON, t.LAST_EDITED_BY,
                DATE_FORMAT(t.LAST_EDITED_ON,'%d/%m/%Y %H:%i') AS LAST_EDITED_ON,
                (SELECT COUNT(*) FROM leave_appl a WHERE a.LEAVE_TYPE = t.LEAVE_TYPE) AS USED
           FROM leave_type_mst t
          ORDER BY t.SORT_NO, t.LEAVE_TYPE`,
      );
      res.json({ ok: true, rows });
    } catch (e) {
      send(res, e);
    }
  });

  router.post('/save-leave-type', async (req, res) => {
    try {
      const { mode, row = {} } = req.body || {};
      const isAdd = String(mode).toUpperCase() === 'ADD';
      const code = String(row.LEAVE_TYPE || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,3}$/.test(code)) throw fail(400, 'Code must be 1 to 3 letters or digits, e.g. AL');
      const name = String(row.LEAVE_NAME || '').trim().slice(0, 40);
      if (!name) throw fail(400, 'Enter the leave name');

      // pay: PAY_FLAG drives the time sheet; PAY_TYPE kept in step (unpaid ⇔ U)
      let payFlag = yn(row.PAY_FLAG, 'Y');
      let payType = ['F', 'H', 'U'].includes(String(row.PAY_TYPE)) ? String(row.PAY_TYPE) : 'F';
      if (payFlag === 'N') payType = 'U';
      else if (payType === 'U') payFlag = 'N';
      const isAnnual = yn(row.IS_ANNUAL);
      if (isAnnual === 'Y' && payFlag === 'N') throw fail(400, 'An annual-type leave is paid as leave salary — it cannot be unpaid');

      const gender = ['M', 'F'].includes(String(row.GENDER)) ? String(row.GENDER) : null;
      const vals = [
        name, isAnnual, payType, payFlag,
        optNum(row.MAX_DAYS_PA, 'Days per year', 9999.9, true),
        optNum(row.MIN_SERVICE_M, 'Minimum service (months)', 255, false),
        gender, yn(row.DOC_REQ), optNum(row.SORT_NO, 'Sort order', 255, false) ?? 50, yn(row.ACTIVE, 'Y'),
      ];
      const user = userOf(req);

      if (isAdd) {
        const [ex] = await db.query('SELECT 1 FROM leave_type_mst WHERE LEAVE_TYPE = ?', [code]);
        if (ex.length) throw fail(409, `Leave type ${code} already exists`);
        await db.query(
          `INSERT INTO leave_type_mst
             (LEAVE_TYPE, LEAVE_NAME, IS_ANNUAL, PAY_TYPE, PAY_FLAG, MAX_DAYS_PA, MIN_SERVICE_M, GENDER, DOC_REQ, SORT_NO, ACTIVE, CREATED_BY)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [code, ...vals, user],
        );
      } else {
        const [r] = await db.query(
          `UPDATE leave_type_mst
              SET LEAVE_NAME = ?, IS_ANNUAL = ?, PAY_TYPE = ?, PAY_FLAG = ?, MAX_DAYS_PA = ?, MIN_SERVICE_M = ?,
                  GENDER = ?, DOC_REQ = ?, SORT_NO = ?, ACTIVE = ?, LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()
            WHERE LEAVE_TYPE = ?`,
          [...vals, user, code],
        );
        if (!r.affectedRows) throw fail(404, `Leave type ${code} not found`);
      }
      res.json({ ok: true, code, message: `Leave type ${code} saved` });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') e = fail(409, 'This leave type already exists');
      send(res, e);
    }
  });

  router.post('/delete-leave-type', async (req, res) => {
    try {
      const code = String((req.body || {}).code || '').trim().toUpperCase();
      if (!code) throw fail(400, 'Code missing');
      const [used] = await db.query('SELECT COUNT(*) AS N FROM leave_appl WHERE LEAVE_TYPE = ?', [code]);
      if (Number(used[0].N)) throw fail(409, `Leave type ${code} is used in ${used[0].N} leave application(s) — set it Inactive instead`);
      const [r] = await db.query('DELETE FROM leave_type_mst WHERE LEAVE_TYPE = ?', [code]);
      if (!r.affectedRows) throw fail(404, `Leave type ${code} not found`);
      res.json({ ok: true, message: `Leave type ${code} deleted` });
    } catch (e) {
      send(res, e);
    }
  });

  return router;
};
