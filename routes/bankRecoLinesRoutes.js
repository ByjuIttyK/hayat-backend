// routes/bankRecoLinesRoutes.js
// G/L side of Bank Reconciliation (GlBnkTxnAutoPopulate) — one row per cheque,
// from view v_bank_reco_lines, plus the tran_acc control total for the period.
//
// Register in HayatDb.js:
//   const bankRecoLinesRoutes = require("./routes/bankRecoLinesRoutes");
//   app.use("/api", bankRecoLinesRoutes(connection));
//
// GET /api/bank-reco-lines/:acode/:stdt/:enddt     (dates YYYY-MM-DD)
//   → { rows: [...], ledgerTotal: number }

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/bank-reco-lines/:acode/:stdt/:enddt", (req, res) => {
    const { acode, stdt, enddt } = req.params;
    const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!acode || !isDate(stdt) || !isDate(enddt)) {
      return res.status(400).json({ error: "acode, stdt, enddt (YYYY-MM-DD) required" });
    }

    // POST_DATE can be DATETIME (JV_DATE_RLZ) — use < end+1 day so the last day is included.
    // Dates are formatted in SQL so mysql2 never shifts them through JS Date / timezone.
    const sqlRows = `
      SELECT SRC, ROW_ID, BANK_ACODE,
             DATE_FORMAT(POST_DATE, '%Y-%m-%d') AS POST_DATE,
             GL_VCHR_NO, TRAN_TYPE, VCHR_NO,
             DATE_FORMAT(VCHR_DATE, '%Y-%m-%d') AS VCHR_DATE,
             CHQ_NO,
             DATE_FORMAT(CHQ_DATE,  '%Y-%m-%d') AS CHQ_DATE,
             AMOUNT, PARTY_CODE, NARRATION
        FROM v_bank_reco_lines
       WHERE BANK_ACODE = ?
         AND POST_DATE >= ?
         AND POST_DATE <  DATE_ADD(?, INTERVAL 1 DAY)
       ORDER BY POST_DATE, VCHR_NO, CHQ_NO`;

    const sqlLedger = `
      SELECT COALESCE(SUM(IF(DB_CR = 'D', AMOUNT, -AMOUNT)), 0) AS LEDGER_TOTAL
        FROM tran_acc
       WHERE ACC_CODE = ?
         AND DATTE >= ?
         AND DATTE <  DATE_ADD(?, INTERVAL 1 DAY)`;

    connection.query(sqlRows, [acode, stdt, enddt], (err, rows) => {
      if (err) {
        console.error("bank-reco-lines:", err);
        return res.status(500).json({ error: err.sqlMessage || err.message });
      }
      connection.query(sqlLedger, [acode, stdt, enddt], (err2, led) => {
        if (err2) {
          console.error("bank-reco-lines ledger total:", err2);
          return res.json({ rows, ledgerTotal: null });   // lines still usable without the check
        }
        res.json({ rows, ledgerTotal: Number(led?.[0]?.LEDGER_TOTAL ?? 0) });
      });
    });
  });

  return router;
};
