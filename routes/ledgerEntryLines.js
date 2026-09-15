// ============================================================================
//  routes/ledgerEntryLines.js
//  ---------------------------------------------------------------------------
//  Returns the COMPLETE double-entry of one voucher from tran_acc, so the
//  Ledger of A/c screen can show the full Dr/Cr entry of the row under the
//  cursor in its footer grid.
//
//  Key            : TRAN_TYPE + VCHR_NO
//  A/c Head       : ac_list union view (ac_code, ac_head)
//
//  Register in HayatDb.js with the usual factory pattern:
//      app.use("/api", authMiddleware, require("./routes/ledgerEntryLines")(connection));
//
//  NOTE (VPS): table names must stay lowercase — tran_acc, ac_list.
// ============================================================================
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/ledger-entry-lines/:tranType/:vchrNo", (req, res) => {
    const tranType = String(req.params.tranType || "").trim();
    const vchrNo = String(req.params.vchrNo || "").trim();

    if (!tranType || !vchrNo) {
      return res.status(400).json({ error: "tranType and vchrNo are required" });
    }

    const sql = `
      SELECT  t.TRAN_TYPE,
              t.vchr_no                                   AS VCHR_NO,
              t.SR_NO,
              t.DATTE,
              t.ACC_CODE,
              COALESCE(a.ac_head, '')                     AS AC_HEAD,
              t.NARRATION1,
              t.NARRATION2,
              CASE WHEN UPPER(t.DB_CR) = 'D' THEN t.AMOUNT ELSE 0 END AS AMOUNT_DR,
              CASE WHEN UPPER(t.DB_CR) = 'C' THEN t.AMOUNT ELSE 0 END AS AMOUNT_CR
      FROM    tran_acc t
      LEFT JOIN ac_list a ON a.ac_code = t.ACC_CODE
      WHERE   t.TRAN_TYPE = ?
        AND   t.vchr_no   = ?
      ORDER BY CAST(t.SR_NO AS UNSIGNED), t.SR_NO
    `;

    connection.getConnection((err, conn) => {
      if (err) {
        console.error("ledger-entry-lines: pool error", err);
        return res.status(500).json({ error: "Database connection error" });
      }
      conn.query(sql, [tranType, vchrNo], (qErr, rows) => {
        conn.release();
        if (qErr) {
          console.error("ledger-entry-lines: query error", qErr);
          return res.status(500).json({ error: "Query failed" });
        }
        // DECIMAL columns arrive as strings from mysql2 — send them as numbers
        const out = (rows || []).map((r) => ({
          ...r,
          AMOUNT_DR: Number(r.AMOUNT_DR) || 0,
          AMOUNT_CR: Number(r.AMOUNT_CR) || 0,
        }));
        res.json(out);
      });
    });
  });

  return router;
};
