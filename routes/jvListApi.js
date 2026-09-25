// routes/jvListApi.js
// Journal Voucher list — TRAN_TYPE 05 (tran_acc lines)
// Mounted in HayatDb.js as: app.use("/api", require("./routes/jvListApi")(connection));
// Endpoint: GET /api/jvlist

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/jvlist", function (req, res) {
    connection.query(
      "SELECT a.TRAN_TYPE, a.VCHR_NO, DATE_FORMAT(a.DATTE,'%d/%m/%Y') AS DATTE, '' AS CUST_CODE, " +
      "       c.AC_HEAD AS ACC_HEAD, " +
      "       a.ACC_CODE, '' AS CHEQUE_NO, a.AMOUNT, a.NARRATION1, a.NARRATION2, a.DB_CR " +
      "  FROM tran_acc a " +
      "  LEFT OUTER JOIN ac_list AS c ON c.AC_CODE = a.ACC_CODE " +
      " WHERE a.TRAN_TYPE = '05' " +
      " ORDER BY a.VCHR_NO DESC",
      [],
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
