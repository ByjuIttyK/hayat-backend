// ============================================================================
// File: routes/purchNsJvRoutes.js
//
// Mount in HayatDb.js:
//     const purchNsJvRoutes = require("./routes/purchNsJvRoutes")(connection);
//     app.use("/api", purchNsJvRoutes);
//
// GET /api/purch-ns/jv/:pjvNo
//   Returns the GL journal entries posted to tran_acc for a Non-Stock Purchase
//   voucher. tran_type for Purchase Non-Stock is '07'.
//   Account names are resolved from the Ac_lsi view, which covers GL codes,
//   suppliers, and customers in one place (unlike acc_mst which holds GL only).
// ============================================================================

module.exports = function (connection) {
  const express = require('express');
  const router  = express.Router();
  const db      = connection.promise();

  // Transaction type for Purchase Non-Stock vouchers.
  const TRAN_TYPE_PURCH_NS = '07';

  const pick = (row, names, dflt = null) => {
    for (const n of names) {
      if (row[n] !== undefined && row[n] !== null) return row[n];
    }
    return dflt;
  };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  router.get('/purch-ns/jv/:pjvNo', async (req, res) => {
    const pjvNo = (req.params.pjvNo || '').trim();
    if (!pjvNo) {
      return res.status(400).json({ message: 'Voucher number is required' });
    }

    try {
      // Ac_lsi view covers GL accounts, suppliers, and customers —
      // join on ACC_CODE / TRIM so space-padded CHAR columns match cleanly.
      const sql = `
        SELECT t.*, a.AC_HEAD AS ACC_HEAD
        FROM   tran_acc t
        LEFT   JOIN Ac_list a ON TRIM(a.AC_CODE) = TRIM(t.ACC_CODE)
        WHERE  TRIM(t.TRAN_TYPE) = ?
          AND  TRIM(t.VCHR_NO)   = ?
        ORDER  BY t.SR_NO
      `;
      const [rows] = await db.query(sql, [TRAN_TYPE_PURCH_NS, pjvNo]);

      const lines = rows.map((r, i) => {
        const dbCr = String(pick(r, ['DB_CR'], '')).trim().toUpperCase();
        const amt  = num(pick(r, ['AMOUNT'], 0));
        return {
          SR_NO:      pick(r, ['SR_NO', 'SRNO', 'LINE_NO'], i + 1),
          ACC_CODE:   String(pick(r, ['ACC_CODE'], '')).trim(),
          ACC_HEAD:   String(pick(r, ['ACC_HEAD'], '')).trim(),
          NARRATION1: String(pick(r, ['NARRATION1', 'NARRATION'], '')).trim(),
          NARRATION2: String(pick(r, ['NARRATION2'], '')).trim(),
          DB_CR:      dbCr,
          DEBIT:      dbCr === 'D' ? amt : 0,
          CREDIT:     dbCr === 'C' ? amt : 0,
          // tran_acc stores the date in the misspelled column DATTE (Oracle migration).
          VCHR_DATE:  pick(r, ['DATTE', 'TRANS_DATE', 'VCHR_DATE'], null),
        };
      });

      // Standard JV presentation: debits first, then credits; within each
      // side preserve the stored SR_NO sequence.
      lines.sort((x, y) => {
        const side = (y.DEBIT > 0 ? 1 : 0) - (x.DEBIT > 0 ? 1 : 0);
        return side !== 0 ? side : num(x.SR_NO) - num(y.SR_NO);
      });

      const totalDebit  = lines.reduce((s, l) => s + l.DEBIT,  0);
      const totalCredit = lines.reduce((s, l) => s + l.CREDIT, 0);

      res.json({
        pjvNo,
        tranType:    TRAN_TYPE_PURCH_NS,
        vchrDate:    lines[0]?.VCHR_DATE ?? null,
        lines,
        totalDebit:  Math.round(totalDebit  * 100) / 100,
        totalCredit: Math.round(totalCredit * 100) / 100,
        balanced:    Math.abs(totalDebit - totalCredit) < 0.005,
        posted:      lines.length > 0,
      });
    } catch (err) {
      console.error('purch-ns/jv error:', err);
      res.status(500).json({ message: 'Failed to load JV entries', error: err.message });
    }
  });

  return router;
};
