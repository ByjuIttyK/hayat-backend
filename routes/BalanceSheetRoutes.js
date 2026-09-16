// routes/BalanceSheetRoutes.js
// Balance Sheet as on a date.
// Returns every account (GL, customer, supplier) with a balance, tagged with the
// primary group of its report line. The screen then:
//   • shows primary groups < '03' as the balance sheet (01 assets, 02 liabilities & equity)
//   • adds up primary groups >= '03' as the profit / loss to carry into it
//     (BAL_BF = part before the year start, so the period's profit can be shown separately)
//   • lists accounts whose report line has no primary group as "not included"
// Register in HayatDb.js:
//   app.use("/api", authMiddleware, require("./routes/BalanceSheetRoutes")(connection));

const express = require("express");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/balsheet/:asdt/:yrstart   (yyyy-mm-dd)
  router.get("/balsheet/:asdt/:yrstart", (req, res) => {
    const { asdt, yrstart } = req.params;
    if (!ISO_DATE.test(asdt) || !ISO_DATE.test(yrstart) || yrstart > asdt) {
      return res.status(400).send("Invalid dates");
    }

    const sql = `
      SELECT COALESCE(r.PRIMARY_GROUP, '')             AS PRIMARY_GROUP,
             COALESCE(l.REPORT_LN, '')                 AS REPORT_LN,
             COALESCE(r.RP_HEAD, '')                   AS RP_HEAD,
             x.ACC_CODE                                AS AC_CODE,
             COALESCE(l.AC_HEAD, '** Not in A/c master **') AS AC_HEAD,
             x.BAL,
             x.BAL_BF
        FROM (
              SELECT ACC_CODE,
                     ROUND(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END), 2) AS BAL,
                     ROUND(SUM(CASE WHEN DATTE < ?
                                    THEN CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END
                                    ELSE 0 END), 2)                                AS BAL_BF
                FROM tran_acc
               WHERE DATTE < DATE_ADD(?, INTERVAL 1 DAY)
               GROUP BY ACC_CODE
             ) x
        LEFT JOIN (SELECT AC_CODE,
                          MAX(AC_HEAD)   AS AC_HEAD,
                          MAX(REPORT_LN) AS REPORT_LN
                     FROM ac_list
                    GROUP BY AC_CODE) l ON l.AC_CODE = x.ACC_CODE
        LEFT JOIN (SELECT REPORT_LN,
                          MIN(PRIMARY_GROUP) AS PRIMARY_GROUP,
                          MAX(RP_HEAD)       AS RP_HEAD
                     FROM rpln_mst
                    GROUP BY REPORT_LN) r ON r.REPORT_LN = l.REPORT_LN
       WHERE x.BAL <> 0 OR x.BAL_BF <> 0
       ORDER BY x.ACC_CODE`;

    connection.query(sql, [yrstart, asdt], (error, result) => {
      if (error) {
        console.log("Balance sheet select error", error);
        return res.status(500).send("Server error - balance sheet");
      }
      res.send(result);
    });
  });

  return router;
};
