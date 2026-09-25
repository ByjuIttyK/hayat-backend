// routes/customerCodeApi.js
// Next customer code for Customer Entry (ADD mode): "1CS" + (highest existing number + 1).
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/customerCodeApi")(connection));

const express = require("express");

const PREFIX = "1CS";

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/next-cust-code  →  { code: "1CS1548" }
  // Only codes of the form 1CS<digits> count, so older or hand-made codes don't break the series.
  router.get("/next-cust-code", (req, res) => {
    const sql = `
      SELECT COALESCE(MAX(CAST(SUBSTRING(CUST_CODE, ?) AS UNSIGNED)), 0) + 1 AS next_no
        FROM cus_mst
       WHERE CUST_CODE REGEXP ?`;
    connection.query(sql, [PREFIX.length + 1, `^${PREFIX}[0-9]+$`], (err, rows) => {
      if (err) {
        console.error("next-cust-code:", err.message);
        return res.status(500).json({ error: "Could not work out the next customer code." });
      }
      res.json({ code: `${PREFIX}${rows?.[0]?.next_no ?? 1}` });
    });
  });

  return router;
};
