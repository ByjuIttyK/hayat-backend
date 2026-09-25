// routes/jvListApi.js
// Journal Voucher list — tran_acc lines
// Mounted in HayatDb.js as: app.use("/api", require("./routes/jvListApi")(connection));
// Endpoints: GET /api/jvlist  and  GET /api/jvlist/:tranType  (e.g. /api/jvlist/05)

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get(["/jvlist", "/jvlist/:tranType"], function (req, res) {
    const tranType = req.params.tranType || "05";

    connection.query(
      "SELECT a.TRAN_TYPE, a.VCHR_NO, DATE_FORMAT(a.DATTE,'%d/%m/%Y') AS DATTE, '' AS CUST_CODE, " +
      "       c.AC_HEAD AS ACC_HEAD, " +
      "       a.ACC_CODE, '' AS CHEQUE_NO, a.AMOUNT, a.NARRATION1, a.NARRATION2, a.DB_CR " +
      "  FROM tran_acc a " +
      "  LEFT OUTER JOIN ac_list AS c ON c.AC_CODE = a.ACC_CODE " +
      " WHERE a.TRAN_TYPE = ? " +
      " ORDER BY a.VCHR_NO DESC",
      [tranType],
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