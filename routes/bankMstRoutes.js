// routes/bankMstRoutes.js
//
// Bank / Cash Account Master — bank_mst.
// Factory-pattern module, same convention as pfInvoiceRoutes.js:
//   const bankMstRoutes = require('./routes/bankMstRoutes');
//   app.use(bankMstRoutes(connection));
//
// NOTE: bank_mst is the GL bank/cash ACCOUNT master (BANK_CODE is a GL code
// like 111-011-0-001). It is a different table from sales_bank_dtl, which holds
// the printable bank block on invoices. Do not conflate the two.

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  const db = typeof connection.promise === 'function' ? connection.promise() : connection;

  const COLS = `BANK_CODE, BANK_NAME, CASH, USER_NAME, PDC_IND, ACC_INDICATOR`;

  // ── Browser list for InfoGrid (module_name = 'BANKMST') ──
  router.get('/bank-list', async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ${COLS},
                CASE WHEN CASH = 'C' THEN 'Cash' ELSE 'Bank' END AS ACC_TYPE
           FROM bank_mst
          ORDER BY BANK_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error('bank-list error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── One record for EDIT / VIEW ──
  router.get('/getBankMst/:bankCode', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ${COLS} FROM bank_mst WHERE BANK_CODE = ? LIMIT 1`,
        [req.params.bankCode]
      );
      if (!rows.length) return res.status(404).json({ message: 'Bank account not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('getBankMst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Create ──
  router.post('/saveBankMst', async (req, res) => {
    const b = req.body || {};
    const code = String(b.BANK_CODE || '').trim();
    if (!code) return res.status(400).json({ message: 'Bank Code is required' });
    if (!String(b.BANK_NAME || '').trim()) return res.status(400).json({ message: 'Bank Name is required' });

    try {
      await db.query(
        `INSERT INTO bank_mst (${COLS}) VALUES (?,?,?,?,?,?)`,
        [code, b.BANK_NAME, b.CASH || 'B', b.USER_NAME || null,
         b.PDC_IND || null, b.ACC_INDICATOR || null]
      );
      res.json({ message: 'Saved', BANK_CODE: code });
    } catch (err) {
      // BANK_CODE is the primary key, so a repeat gets a specific 409 rather
      // than a generic 500 — the screen shows this message verbatim.
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: `Bank Code "${code}" already exists` });
      }
      console.error('saveBankMst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Update. BANK_CODE is never reassigned: every posting in tran_acc
  //    references it, and MySQL will not cascade a change made here. ──
  router.put('/updateBankMst/:bankCode', async (req, res) => {
    const b = req.body || {};
    if (!String(b.BANK_NAME || '').trim()) return res.status(400).json({ message: 'Bank Name is required' });

    try {
      const [r] = await db.query(
        `UPDATE bank_mst
            SET BANK_NAME = ?, CASH = ?, USER_NAME = ?, PDC_IND = ?, ACC_INDICATOR = ?
          WHERE BANK_CODE = ?`,
        [b.BANK_NAME, b.CASH || 'B', b.USER_NAME || null,
         b.PDC_IND || null, b.ACC_INDICATOR || null, req.params.bankCode]
      );
      if (r.affectedRows === 0) return res.status(404).json({ message: 'Bank account not found' });
      res.json({ message: 'Updated', BANK_CODE: req.params.bankCode });
    } catch (err) {
      console.error('updateBankMst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Delete ──
  router.delete('/deleteBankMst/:bankCode', async (req, res) => {
    const code = req.params.bankCode;
    try {
      // Refuse if the account has been used. A master row deleted out from
      // under its postings leaves a ledger that cannot be explained, and there
      // is no FK on tran_acc to stop it — so the check has to live here.
      // ⚠ Confirm the column: this assumes tran_acc.ACC_CODE holds the GL code.
      let used = 0;
      try {
        const [u] = await db.query(
          `SELECT COUNT(*) AS n FROM tran_acc WHERE ACC_CODE = ?`, [code]);
        used = Number(u[0] && u[0].n) || 0;
      } catch (e) {
        // Column or table named differently — fail closed rather than deleting
        // blind, and say so plainly.
        console.error('deleteBankMst usage check failed:', e.message);
        return res.status(500).json({
          message: 'Could not verify whether this account has postings — delete blocked',
        });
      }
      if (used > 0) {
        return res.status(409).json({
          message: `Cannot delete: ${used} posting(s) reference this account`,
        });
      }

      const [r] = await db.query(`DELETE FROM bank_mst WHERE BANK_CODE = ?`, [code]);
      if (r.affectedRows === 0) return res.status(404).json({ message: 'Bank account not found' });
      res.json({ message: 'Deleted', BANK_CODE: code });
    } catch (err) {
      console.error('deleteBankMst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Mount shim: expose under both / and /api ──
  const mount = express.Router();
  mount.use('/api', router);
  mount.use('/', router);
  return mount;
};
