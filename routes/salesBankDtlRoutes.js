// routes/salesBankDtlRoutes.js
//
// Sales Bank Details Master — sales_bank_dtl.
// Register in HayatDb.js alongside the others:
//   const salesBankDtlRoutes = require("./routes/salesBankDtlRoutes");
//   app.use("/api", salesBankDtlRoutes(connection));
//
// This is the PRINTABLE bank block that appears in the invoice footer, keyed by
// pfinv_net.BANK_CODE. It is NOT bank_mst, which is the GL account master.
//
// ⚠ sales_bank_dtl has NO primary key (see `desc sales_bank_dtl` — the Key
//   column is empty on both fields). MySQL will therefore happily accept a
//   duplicate BANK_CODE, and there is no ER_DUP_ENTRY to catch. Uniqueness is
//   enforced by hand in saveSalesBank below. Better still, add the key:
//
//     ALTER TABLE sales_bank_dtl ADD PRIMARY KEY (BANK_CODE);
//
//   which will fail if duplicates already exist — worth checking first:
//     SELECT BANK_CODE, COUNT(*) FROM sales_bank_dtl GROUP BY 1 HAVING COUNT(*)>1;

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  const db = typeof connection.promise === 'function' ? connection.promise() : connection;

  // ── Browser list for InfoGrid (module_name = 'SLSBANK') ──
  router.get('/sales-bank-list', async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT BANK_CODE,
                BANK_DETAILS,
                -- Flattened one-line version for the grid. The stored value is
                -- multi-line, and raw newlines in a grid cell either collapse
                -- or blow the row height out.
                REPLACE(REPLACE(IFNULL(BANK_DETAILS,''), '\\r', ''), '\\n', ' · ') AS BANK_SUMMARY,
                -- First line is conventionally "Bank: RAK BANK", so this gives
                -- the grid a short readable name column.
                TRIM(SUBSTRING_INDEX(REPLACE(IFNULL(BANK_DETAILS,''), '\\r', ''), '\\n', 1)) AS BANK_NAME
           FROM sales_bank_dtl
          ORDER BY BANK_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error('sales-bank-list error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── One record for EDIT / VIEW ──
  router.get('/getSalesBank/:bankCode', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT BANK_CODE, BANK_DETAILS FROM sales_bank_dtl WHERE BANK_CODE = ? LIMIT 1`,
        [req.params.bankCode]
      );
      if (!rows.length) return res.status(404).json({ message: 'Bank code not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('getSalesBank error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Create ──
  router.post('/saveSalesBank', async (req, res) => {
    const b = req.body || {};
    const code = String(b.BANK_CODE || '').trim().toUpperCase();
    const dtl = String(b.BANK_DETAILS || '').trim();
    if (!code) return res.status(400).json({ message: 'Bank Code is required' });
    if (!dtl) return res.status(400).json({ message: 'Bank Details are required' });

    try {
      // No primary key on this table, so the duplicate check is ours to make.
      // Without it a second '01' inserts cleanly and the invoice LOV then shows
      // two identical codes with different details.
      const [dup] = await db.query(
        `SELECT 1 FROM sales_bank_dtl WHERE BANK_CODE = ? LIMIT 1`, [code]);
      if (dup.length) {
        return res.status(409).json({ message: `Bank Code "${code}" already exists` });
      }

      await db.query(
        `INSERT INTO sales_bank_dtl (BANK_CODE, BANK_DETAILS) VALUES (?,?)`,
        [code, dtl]
      );
      res.json({ message: 'Saved', BANK_CODE: code });
    } catch (err) {
      console.error('saveSalesBank error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Update. BANK_CODE is not reassigned: pfinv_net rows point at it. ──
  router.put('/updateSalesBank/:bankCode', async (req, res) => {
    const dtl = String((req.body || {}).BANK_DETAILS || '').trim();
    if (!dtl) return res.status(400).json({ message: 'Bank Details are required' });

    try {
      const [r] = await db.query(
        `UPDATE sales_bank_dtl SET BANK_DETAILS = ? WHERE BANK_CODE = ?`,
        [dtl, req.params.bankCode]
      );
      if (r.affectedRows === 0) return res.status(404).json({ message: 'Bank code not found' });
      res.json({ message: 'Updated', BANK_CODE: req.params.bankCode });
    } catch (err) {
      console.error('updateSalesBank error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Delete ──
  router.delete('/deleteSalesBank/:bankCode', async (req, res) => {
    const code = req.params.bankCode;
    try {
      // Warn rather than block: unlike a GL account, deleting this only means
      // future prints of those invoices lose their bank block. The count lets
      // the user judge, and the screen surfaces this message.
      const [u] = await db.query(
        `SELECT COUNT(*) AS n FROM pfinv_net WHERE BANK_CODE = ?`, [code]);
      const used = Number(u[0] && u[0].n) || 0;
      if (used > 0 && String(req.query.force || '') !== '1') {
        return res.status(409).json({
          message: `${used} invoice(s) use this bank code — their printed bank block would be blank. Re-send with ?force=1 to delete anyway.`,
        });
      }

      const [r] = await db.query(`DELETE FROM sales_bank_dtl WHERE BANK_CODE = ?`, [code]);
      if (r.affectedRows === 0) return res.status(404).json({ message: 'Bank code not found' });
      res.json({ message: 'Deleted', BANK_CODE: code });
    } catch (err) {
      console.error('deleteSalesBank error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Mount shim: expose under both / and /api ──
  const mount = express.Router();
  mount.use('/api', router);
  mount.use('/', router);
  return mount;
};
