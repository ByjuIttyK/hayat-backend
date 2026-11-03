// routes/jvListApi.js
// Journal Voucher list — tran_acc lines
// Mounted in HayatDb.js as: app.use("/api", require("./routes/jvListApi")(connection));
// Endpoints: GET /api/jvlist  and  GET /api/jvlist/:tranType  (e.g. /api/jvlist/05)
// Period: InfoGrid's period chip sends ?fromDate=yyyy-MM-dd&toDate=yyyy-MM-dd;
// without them the current ac_period is used (utils/periodFilter.js).

const express = require("express");
const periodFilter = require("../utils/periodFilter");

module.exports = function (connection) {
  const router = express.Router();

  router.get(["/jvlist", "/jvlist/:tranType"], function (req, res) {
    const tranType = req.params.tranType || "05";
    const pf = periodFilter(req, "a.DATTE");

    connection.query(
      "SELECT a.TRAN_TYPE, a.VCHR_NO, DATE_FORMAT(a.DATTE,'%d/%m/%Y') AS DATTE, '' AS CUST_CODE, " +
      "       c.AC_HEAD AS ACC_HEAD, " +
      "       a.ACC_CODE, '' AS CHEQUE_NO, a.AMOUNT, a.NARRATION1, a.NARRATION2, a.DB_CR, " +
      // contra flag lives on the voucher header (vouchers.CONTRA_FLG)
      "       COALESCE(v.CONTRA_FLG, 'N') AS CONTRA_FLG " +
      "  FROM tran_acc a " +
      "  LEFT OUTER JOIN ac_list AS c ON c.AC_CODE = a.ACC_CODE " +
      "  LEFT OUTER JOIN vouchers AS v " +
      "    ON v.TRAN_TYPE = a.TRAN_TYPE AND v.VCHR_NO = a.VCHR_NO " +
      " WHERE a.TRAN_TYPE = ? " + pf.sql +
      " ORDER BY a.VCHR_NO DESC",
      [tranType, ...pf.params],
      function (error, result) {
        if (error) {
          console.error("JV list error:", error);
          return res.status(500).json({ error: error.message });
        }
        res.json(result);
      }
    );
  });

  return router;
};
