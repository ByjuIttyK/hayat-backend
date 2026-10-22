// routes/payStatus.js
// Amount settled against each document of one tran type, from adj_dtl
// (written by Invoice Settlement and the voucher entry screens).
// Used by InfoGrid to colour the amount column: GET /api/pay-status/07
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/payStatus")(connection));
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/pay-status/:tranType", (req, res) => {
    const tranType = String(req.params.tranType || "").trim();
    if (!/^[0-9A-Za-z]{1,4}$/.test(tranType)) {
      return res.status(400).json({ error: "Invalid tran type" });
    }

    const sql = `
      SELECT STLD_DOC              AS DOC_NO,
             ROUND(SUM(STLD_AMT), 2) AS SETTLED
        FROM adj_dtl
       WHERE STLD_TYPE = ?
       GROUP BY STLD_DOC`;

    connection.query(sql, [tranType], (err, rows) => {
      if (err) {
        console.error("pay-status query failed:", err);
        return res.status(500).json({ error: "Failed to fetch settlement status" });
      }
      res.json(rows);
    });
  });

  return router;
};
