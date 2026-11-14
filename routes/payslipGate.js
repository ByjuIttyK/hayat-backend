// =====================================================================
// payslipGate.js — password gate for payslips opened from the Ledger of Accounts (14-Nov-2026)
//
//   POST /api/payslip/unlock          { password }
//        The logged-in user re-enters their own login password (users.password_hash, bcrypt — same check as
//        /api/login). On success: a payslip token valid for 10 minutes, bound to this user.
//        5 wrong passwords → payslips locked for that user for 15 minutes.
//
//   GET  /api/payslip/ledger/:refNo   header X-Payslip-Token
//        refNo = tran_acc.REF_NO of a Salary JV line (tran type 15): a time sheet no. (TSHT_NO) or
//        'MS' + mgmt_salary VCHR_NO. Refused without a valid token of the same user.
//        → { ok, src: 'TS'|'MS', key, empCode, empName, salMonth, slip | salary }
//          TS: slip = PayslipPrint.PayslipData, built by timeSheetApi (router.payslipsFor) — the same
//              figures as the Payslip Print list. MS: salary = mgmt_salary.SALARY (simple slip).
//
//   Both routes need the normal login JWT (authMiddleware) — req.user.id / username come from it.
//
// Register in HayatDb.js (after JWT_SECRET and authMiddleware are defined):
//   const tsRouter = timeSheetApi(connection);          // instead of app.use('/api', timeSheetApi(connection))
//   app.use('/api', tsRouter);
//   const payslipGate = require('./routes/payslipGate');
//   app.use('/api', authMiddleware, payslipGate(connection, { JWT_SECRET, payslipsFor: tsRouter.payslipsFor }));
//
// Access right: the Payslip right (acledger_payslip) hides the 🧾 icon in the ledger. To refuse it on the
// server as well, pass canSeePayslip: async (req, q) => true | false (role permission lookup).
// =====================================================================
const express = require('express');
const bcrypt = require('bcrypt');       // same package as the login route (use 'bcryptjs' if that is what HayatDb.js loads)
const jwt = require('jsonwebtoken');

const TOKEN_MINUTES = 10;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const SALARY_JV_TYPE = '15';

module.exports = function (connection, { JWT_SECRET, canSeePayslip, payslipsFor } = {}) {
  if (!JWT_SECRET) throw new Error('payslipGate: JWT_SECRET is required');
  const router = express.Router();
  const q = (sql, params = []) =>
    new Promise((resolve, reject) => connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  // wrong-password counter per user (memory only — a server restart clears it)
  const fails = new Map();   // userId → { n, lockedUntil }

  const userIdOf = (req) => (req.user && (req.user.id ?? req.user.userId)) ?? null;
  const send = (res, status, message, code) => res.status(status).json({ ok: false, message, code });

  router.post('/payslip/unlock', async (req, res) => {
    try {
      const uid = userIdOf(req);
      if (uid == null) return send(res, 401, 'Please log in again');
      if (canSeePayslip && !(await canSeePayslip(req, q))) return send(res, 403, 'You do not have the Payslip right', 'NO_RIGHT');

      const f = fails.get(uid);
      if (f && f.lockedUntil > Date.now()) {
        const min = Math.ceil((f.lockedUntil - Date.now()) / 60000);
        return send(res, 429, `Too many wrong passwords — payslips are locked for ${min} more minute(s)`, 'LOCKED');
      }

      const password = String((req.body || {}).password || '');
      if (!password) return send(res, 400, 'Enter your password');
      const [u] = await q('SELECT password_hash FROM users WHERE id = ? AND is_active = 1', [uid]);
      if (!u) return send(res, 401, 'User not found or inactive');

      const match = await bcrypt.compare(password, u.password_hash);
      if (!match) {
        const n = (f && f.lockedUntil <= Date.now() ? 0 : (f?.n || 0)) + 1;
        const locked = n >= MAX_FAILS;
        fails.set(uid, { n: locked ? 0 : n, lockedUntil: locked ? Date.now() + LOCK_MINUTES * 60000 : 0 });
        console.warn(`[payslip] wrong password — user ${req.user.username || uid} (${n}/${MAX_FAILS})`);
        return send(res, 401, locked
          ? `Wrong password — payslips are now locked for ${LOCK_MINUTES} minutes`
          : `Wrong password (${MAX_FAILS - n} attempt(s) left)`, locked ? 'LOCKED' : 'BAD_PASSWORD');
      }

      fails.delete(uid);
      const token = jwt.sign({ uid, purpose: 'payslip' }, JWT_SECRET, { expiresIn: `${TOKEN_MINUTES}m` });
      res.json({ ok: true, token, expiresAt: Date.now() + TOKEN_MINUTES * 60000 });
    } catch (e) {
      console.error('[payslip] unlock', e);
      send(res, 500, 'Password check failed');
    }
  });

  // payslip token of this same user, still in its 10 minutes
  const requirePayslipToken = (req, res, next) => {
    const t = req.get('X-Payslip-Token');
    if (!t) return send(res, 401, 'Password required', 'PAYSLIP_TOKEN');
    try {
      const p = jwt.verify(t, JWT_SECRET);
      if (p.purpose !== 'payslip' || String(p.uid) !== String(userIdOf(req))) throw new Error('wrong token');
      next();
    } catch {
      send(res, 401, 'Payslip unlock has expired — enter your password again', 'PAYSLIP_TOKEN');
    }
  };

  router.get('/payslip/ledger/:refNo', requirePayslipToken, async (req, res) => {
    try {
      if (canSeePayslip && !(await canSeePayslip(req, q))) return send(res, 403, 'You do not have the Payslip right', 'NO_RIGHT');
      const refNo = String(req.params.refNo || '').trim();
      // only references that really are on a Salary JV line
      const [used] = await q('SELECT 1 AS X FROM tran_acc WHERE TRAN_TYPE = ? AND REF_NO = ? LIMIT 1', [SALARY_JV_TYPE, refNo]);
      if (!used) return send(res, 404, `${refNo} is not on any Salary JV`);

      let row;
      if (/^MS/i.test(refNo)) {
        [row] = await q(
          `SELECT 'MS' AS src, s.VCHR_NO AS \`key\`, s.EMP_CODE AS empCode, e.EMP_NAME AS empName,
                  DATE_FORMAT(s.SAL_MONTH, '%Y-%m-%d') AS salMonth, s.SALARY AS salary
             FROM mgmt_salary s JOIN emp_mst e ON e.EMP_CODE = s.EMP_CODE
            WHERE s.VCHR_NO = ?`,
          [refNo.slice(2)],
        );
      } else {
        [row] = await q(
          `SELECT 'TS' AS src, h.TSHT_NO AS \`key\`, h.EMP_CODE AS empCode, e.EMP_NAME AS empName,
                  DATE_FORMAT(h.TSHT_DATE, '%Y-%m-%d') AS salMonth
             FROM time_sheet_hdr h JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
            WHERE h.TSHT_NO = ?`,
          [refNo],
        );
      }
      if (!row) return send(res, 404, `No time sheet / management salary found for ${refNo}`);
      if (row.src === 'TS') {
        if (!payslipsFor) return send(res, 500, 'Payslip builder not connected (payslipsFor) — see the note at the top of payslipGate.js');
        const { slips, skipped } = await payslipsFor([row.key]);
        if (!slips.length) return send(res, 409, `Payslip ${row.key} cannot be printed: ${(skipped || []).join('; ') || 'not processed'}`);
        row.slip = slips[0];
      } else {
        row.salary = Number(row.salary) || 0;
      }
      console.log(`[payslip] ${req.user.username || userIdOf(req)} opened payslip ${refNo} (${row.empCode})`);
      res.json({ ok: true, ...row });
    } catch (e) {
      console.error('[payslip] ledger', e);
      send(res, 500, e.sqlMessage || e.message);
    }
  });

  return router;
};
