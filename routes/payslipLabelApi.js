// =====================================================================
// routes/payslipLabelApi.js — payslip deduction descriptions (payslip_ded_label), 09-Nov-2026
//
//   Descriptions of the calculated deduction lines on the payslip (PayslipPrint.tsx DedKey):
//     NOT_JOINED, ABSENT, ANNUAL_LEAVE, UNPAID_LEAVE, ALLOW_CUT, LATE_SHORT
//   TSHT_NO '*' = default for all payslips; a row with the time sheet no. is that payslip's own text.
//   Payslip uses: sheet row → default row → built-in text (frontend).
//
//   GET  /api/payslip-labels/:tshtNo   → { defaults: { KEY: descr }, sheet: { KEY: descr } }
//   POST /api/payslip-labels           { tshtNo, labels: { KEY: descr }, asDefault }
//        asDefault → rows saved under '*', and this sheet's own rows for those keys removed.
//        An empty descr removes the row (the line then inherits).
//
// Register in HayatDb.js:
//   app.use('/api', require('./routes/payslipLabelApi')(connection));
// =====================================================================
const express = require('express');

const LINE_KEYS = ['NOT_JOINED', 'ABSENT', 'ANNUAL_LEAVE', 'UNPAID_LEAVE', 'ALLOW_CUT', 'LATE_SHORT'];
const DEFAULT_ROW = '*';

/** user name from the JWT (auth middleware), for CREATED_BY / LAST_EDITED_BY */
const userOf = (req) => {
  const u = req.user || {};
  return String(u.USER_NAME || u.username || u.userName || u.user_name || u.name || u.sub || '').slice(0, 30) || null;
};

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get('/payslip-labels/:tshtNo', async (req, res) => {
    try {
      const tshtNo = String(req.params.tshtNo || DEFAULT_ROW).trim() || DEFAULT_ROW;
      const [rows] = await db.query(
        'SELECT TSHT_NO, LINE_KEY, DESCR FROM payslip_ded_label WHERE TSHT_NO IN (?, ?)',
        [DEFAULT_ROW, tshtNo],
      );
      const defaults = {};
      const sheet = {};
      for (const r of rows) {
        if (r.TSHT_NO === DEFAULT_ROW) defaults[r.LINE_KEY] = r.DESCR;
        else sheet[r.LINE_KEY] = r.DESCR;
      }
      res.json({ defaults, sheet });
    } catch (err) {
      console.error('payslip-labels get', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/payslip-labels', async (req, res) => {
    const { labels, asDefault } = req.body || {};
    const tshtNo = String((req.body || {}).tshtNo || '').trim();
    const target = asDefault ? DEFAULT_ROW : tshtNo;
    if (!target || target === DEFAULT_ROW && !asDefault) return res.status(400).json({ error: 'Time sheet no. missing' });
    const entries = Object.entries(labels || {}).filter(([key]) => LINE_KEYS.includes(key));
    if (!entries.length) return res.json({ ok: true, saved: 0 });

    const user = userOf(req);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      let saved = 0;
      for (const [key, raw] of entries) {
        const descr = String(raw ?? '').trim().slice(0, 100);
        if (!descr) {
          await conn.query('DELETE FROM payslip_ded_label WHERE TSHT_NO = ? AND LINE_KEY = ?', [target, key]);
        } else {
          await conn.query(
            `INSERT INTO payslip_ded_label (TSHT_NO, LINE_KEY, DESCR, CREATED_BY, CREATED_ON)
             VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE DESCR = VALUES(DESCR), LAST_EDITED_BY = VALUES(CREATED_BY), LAST_EDITED_ON = NOW()`,
            [target, key, descr, user],
          );
          saved += 1;
        }
        // saved as the default: this payslip follows the default too
        if (asDefault && tshtNo && tshtNo !== DEFAULT_ROW) {
          await conn.query('DELETE FROM payslip_ded_label WHERE TSHT_NO = ? AND LINE_KEY = ?', [tshtNo, key]);
        }
      }
      await conn.commit();
      res.json({ ok: true, saved });
    } catch (err) {
      await conn.rollback();
      console.error('payslip-labels save', err);
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};
