// ============================================================================
// File: routes/fabInvJvRoutes.js
// Mount in HayatDb.js (matches the convention used by every other route file
// there — the prefix lives in the path, not in the mount):
//     const fabInvJvRoutes = require("./routes/fabInvJvRoutes")(connection);
//     app.use("/api", fabInvJvRoutes);
//
// GET /api/fab-inv/jv/:invNo
//   Returns the GL posting (journal voucher) raised for a fabrication invoice.
//   The invoice is located in tran_acc by TRAN_TYPE '06' + VCHR_NO = INV_NO.
// ============================================================================

module.exports = function (connection) {
  const express = require('express');
  const router = express.Router();
  const db = connection.promise();   // promise wrapper — callback pool otherwise

  // Invoices post under transaction type 06.
  const TRAN_TYPE_FAB_INV = '06';

  // tran_acc does NOT hold separate debit and credit columns. It stores ONE
  // signed-by-flag figure:
  //
  //     AMOUNT   decimal      the value
  //     DB_CR    char(1)      'D' = debit, 'C' = credit
  //
  // The first version of this route looked for DEBIT/CREDIT (and DR_AMT/
  // CR_AMT etc.) and found none of them, so every line came back as 0.00 —
  // which is exactly what the JV tab was showing. The split happens here.
  const pick = (row, names, dflt = null) => {
    for (const n of names) {
      if (row[n] !== undefined && row[n] !== null) return row[n];
    }
    return dflt;
  };
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  router.get('/fab-inv/jv/:invNo', async (req, res) => {
    const invNo = (req.params.invNo || '').trim();
    if (!invNo) {
      return res.status(400).json({ message: 'Invoice number is required' });
    }

    try {
      // TRIM on both sides: VCHR_NO and TRAN_TYPE are CHAR/VARCHAR carried over
      // from the Oracle migration and are frequently space-padded, so a bare =
      // silently returns nothing.
      const sql = `
        SELECT t.*, a.ACC_HEAD
        FROM tran_acc t
        LEFT JOIN acc_mst a ON TRIM(a.ACC_CODE) = TRIM(t.ACC_CODE)
        WHERE TRIM(t.TRAN_TYPE) = ?
          AND TRIM(t.VCHR_NO)   = ?
      `;
      const [rows] = await db.query(sql, [TRAN_TYPE_FAB_INV, invNo]);

      const lines = rows.map((r, i) => ({
        SR_NO:       pick(r, ['SR_NO', 'SRNO', 'LINE_NO'], i + 1),
        ACC_CODE:    String(pick(r, ['ACC_CODE'], '')).trim(),
        ACC_HEAD:    String(pick(r, ['ACC_HEAD'], '')).trim(),
        JOB_NO:      String(pick(r, ['JOB_NO'], '')).trim(),
        PANEL_NO:    String(pick(r, ['PANEL_NO'], '')).trim(),
        NARRATION1:  String(pick(r, ['NARRATION1', 'NARRATION'], '')).trim(),
        NARRATION2:  String(pick(r, ['NARRATION2'], '')).trim(),
        // Split the single AMOUNT by the DB_CR flag. TRIM+upper because the
        // flag is CHAR(1) and Oracle-migrated CHAR values can carry padding.
        DEBIT:  String(pick(r, ['DB_CR'], '')).trim().toUpperCase() === 'D'
                  ? num(pick(r, ['AMOUNT'], 0)) : 0,
        CREDIT: String(pick(r, ['DB_CR'], '')).trim().toUpperCase() === 'C'
                  ? num(pick(r, ['AMOUNT'], 0)) : 0,
        // The date column is spelled DATTE in tran_acc (sic).
        VCHR_DATE:   pick(r, ['DATTE', 'TRANS_DATE', 'VCHR_DATE'], null),
      }));

      // Debits first, then credits — how a JV is read. Within each side the
      // stored sequence is preserved.
      lines.sort((x, y) => {
        const side = (y.DEBIT > 0 ? 1 : 0) - (x.DEBIT > 0 ? 1 : 0);
        return side !== 0 ? side : num(x.SR_NO) - num(y.SR_NO);
      });

      const totalDebit  = lines.reduce((s, l) => s + l.DEBIT, 0);
      const totalCredit = lines.reduce((s, l) => s + l.CREDIT, 0);

      res.json({
        invNo,
        tranType: TRAN_TYPE_FAB_INV,
        vchrDate: lines[0]?.VCHR_DATE ?? null,
        lines,
        totalDebit:  Math.round(totalDebit  * 100) / 100,
        totalCredit: Math.round(totalCredit * 100) / 100,
        // Surfaced so the screen can flag it. An out-of-balance posting is the
        // whole reason for looking at this view, so the API states it outright
        // rather than leaving the caller to compare two floats.
        balanced: Math.abs(totalDebit - totalCredit) < 0.005,
        posted: lines.length > 0,
      });
    } catch (err) {
      console.error('fab-inv/jv error:', err);
      res.status(500).json({ message: 'Failed to load JV', error: err.message });
    }
  });

  return router;
};
