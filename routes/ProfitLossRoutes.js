// routes/ProfitLossRoutes.js
// Profit & Loss — GL accounts (acc_mst) whose report line belongs to a
// primary group >= '03' (03 = trading / income section, 04 = costs).
// BAL is signed: + Dr (expense), - Cr (income).
//   Periodic : postings from stdt to enddt only (no opening balance)
//   As On    : all postings up to asdt
// Register in HayatDb.js:
//   app.use("/api", authMiddleware, require("./routes/ProfitLossRoutes")(connection));

const express = require("express");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// rpln_mst's key is (PRIMARY_GROUP, REPORT_LN): collapse to one row per line
const PL_SQL = (dateWhere) => `
  SELECT r.PRIMARY_GROUP,
         a.REPORT_LN,
         COALESCE(r.RP_HEAD, '')   AS RP_HEAD,
         a.ACC_CODE                AS AC_CODE,
         COALESCE(a.ACC_HEAD, '')  AS AC_HEAD,
         t.BAL
    FROM acc_mst a
    JOIN (SELECT REPORT_LN,
                 MIN(PRIMARY_GROUP) AS PRIMARY_GROUP,
                 MAX(RP_HEAD)       AS RP_HEAD
            FROM rpln_mst
           WHERE PRIMARY_GROUP >= '03'
           GROUP BY REPORT_LN) r ON r.REPORT_LN = a.REPORT_LN
    JOIN (SELECT ACC_CODE,
                 ROUND(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END), 2) AS BAL
            FROM tran_acc
           WHERE ${dateWhere}
           GROUP BY ACC_CODE) t ON t.ACC_CODE = a.ACC_CODE
   WHERE t.BAL <> 0
   ORDER BY r.PRIMARY_GROUP, a.REPORT_LN, a.ACC_CODE`;

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/profitloss/periodic/:stdt/:enddt   (yyyy-mm-dd)
  router.get("/profitloss/periodic/:stdt/:enddt", (req, res) => {
    const { stdt, enddt } = req.params;
    if (!ISO_DATE.test(stdt) || !ISO_DATE.test(enddt) || stdt > enddt) {
      return res.status(400).send("Invalid date range");
    }
    const sql = PL_SQL("DATTE >= ? AND DATTE < DATE_ADD(?, INTERVAL 1 DAY)");
    connection.query(sql, [stdt, enddt], (error, result) => {
      if (error) {
        console.log("Profit & loss (periodic) select error", error);
        return res.status(500).send("Server error - profit and loss periodic");
      }
      res.send(result);
    });
  });

  // GET /api/profitloss/ason/:asdt   (yyyy-mm-dd)
  router.get("/profitloss/ason/:asdt", (req, res) => {
    const { asdt } = req.params;
    if (!ISO_DATE.test(asdt)) {
      return res.status(400).send("Invalid date");
    }
    const sql = PL_SQL("DATTE < DATE_ADD(?, INTERVAL 1 DAY)");
    connection.query(sql, [asdt], (error, result) => {
      if (error) {
        console.log("Profit & loss (as on) select error", error);
        return res.status(500).send("Server error - profit and loss as on");
      }
      res.send(result);
    });
  });

  return router;
};
