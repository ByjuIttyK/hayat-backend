/**
 * routes/fabDoQuotItems.js — quotation lines for the Fab. D/O panel search
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
