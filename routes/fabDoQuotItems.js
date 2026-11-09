/**
 * routes/fabDoQuotItems.js — quotation lines for the Fab. D/O panel search
 *
 * GET /api/fabdo-quots?cust=CODE
 *   → quotations for the Quot.No dropdown: QUOT_NO, QUOT_DATE (dd/mm/yyyy), CUST_CODE, CUST_NAME,
 *     AMOUNT (items total = Σ QTY × RATE, before VAT). One customer when cust is given, else all.
 *     Newest first, at most 500.
 *
 * GET /api/fabdo-quot-items/:quotNo
 *   → [{ SR_NO, ITEM_CODE, ITEM_NAME, QTY, UNIT, RATE }] from quot_item, in quotation order.
 *   Used by FabDo.tsx (QuotItemLov) when the D/O has a Quot.No but no Job No.
 *
 * Register in HayatDb.js (same pattern as the other routes, behind the auth middleware):
 *   app.use('/api', authMiddleware, require('./routes/fabDoQuotItems')(connection));
 */
const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  // ── quotations for the Quot.No dropdown ─────────────────────────────────────
  router.get('/fabdo-quots', (req, res) => {
    const cust = String(req.query.cust || '').trim();
    connection.query(
      `SELECT q.QUOT_NO,
              DATE_FORMAT(MAX(q.QUOT_DATE), '%d/%m/%Y') AS QUOT_DATE,
              MAX(q.CUST_CODE) AS CUST_CODE,
              MAX(c.CUST_NAME) AS CUST_NAME,
              ROUND(SUM(COALESCE(q.QTY, 0) * COALESCE(q.RATE, 0)), 2) AS AMOUNT
         FROM quot_item q
         LEFT JOIN cus_mst c ON c.CUST_CODE = q.CUST_CODE
        ${cust ? 'WHERE q.CUST_CODE = ?' : ''}
        GROUP BY q.QUOT_NO
        ORDER BY MAX(q.QUOT_DATE) DESC, q.QUOT_NO DESC
        LIMIT 500`,
      cust ? [cust] : [],
      (err, rows) => {
        if (err) {
          console.error('[fabdo-quots]', err.message);
          return res.status(500).json({ message: err.message });
        }
        res.json(rows);
      },
    );
  });

  router.get('/fabdo-quot-items/:quotNo', (req, res) => {
    const quotNo = String(req.params.quotNo || '').trim();
    if (!quotNo) return res.status(400).json({ message: 'Quotation number is required.' });
    connection.query(
      `SELECT SR_NO, ITEM_CODE, ITEM_NAME, QTY, UNIT, RATE
         FROM quot_item
        WHERE QUOT_NO = ?
          AND (ITEM_CODE IS NOT NULL AND TRIM(ITEM_CODE) <> '' OR ITEM_NAME IS NOT NULL AND TRIM(ITEM_NAME) <> '')
        ORDER BY MAIN_SR_NO, SR_NO, SUB_SR_NO, temp_sr`,
      [quotNo],
      (err, rows) => {
        if (err) {
          console.error('[fabdo-quot-items]', err.message);
          return res.status(500).json({ message: err.message });
        }
        res.json(rows);
      },
    );
  });

  return router;
};
