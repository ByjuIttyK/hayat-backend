// routes/rvListApi.js
// Receipt Voucher list — TRAN_TYPE 01 and 03 (vouchers + pdc_rcd / current_chq)
// Mounted in HayatDb.js as: app.use("/api", require("./routes/rvListApi")(connection));
// Endpoint: GET /api/rvlist/:tranId

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/rvlist/:tranId", function (req, res) {
    const tranId = String(req.params.tranId || "");

    if (tranId !== "01" && tranId !== "03") {
      return res.status(400).json({ error: "RV list supports TRAN_TYPE 01 or 03 only" });
    }

    connection.query(
      "SELECT v.TRAN_TYPE, v.VCHR_NO, DATE_FORMAT(v.DATTE,'%d/%m/%Y') AS DATTE, " +
      "COALESCE(v.ACC_CODE, v.CUST_CODE) AS ACC_CODE, v.CUST_CODE, " +
      "chq.CHEQUE_NO, DATE_FORMAT(chq.CHEQUE_DT,'%d/%m/%y') AS CHEQUE_DT, chq.CHQ_COUNT, " +
      "v.AMOUNT, v.BANK_NAME AS NARRATION1, v.NARRATION2, ac_list.AC_HEAD AS ACC_HEAD, " +
      "v.BANK_NAME, v.PAID_TO, v.CAN_CEL, " +
      "v.ACC_CODE2, v.AMOUNT2, v.JOB_NO, v.CUR_CODE, v.CONV_RATE, v.AMOUNT_FRGN " +
      "FROM vouchers AS v " +
      "LEFT OUTER JOIN ac_list " +
      "  ON ac_list.AC_CODE = COALESCE(v.ACC_CODE, v.CUST_CODE) " +
      "LEFT OUTER JOIN (" +
      "  SELECT TRAN_TYPE, VCHR_NO, MIN(CHQ) AS CHEQUE_NO, MIN(CHQ_DATE) AS CHEQUE_DT, " +
      "         COUNT(DISTINCT CHQ) AS CHQ_COUNT FROM (" +
      "    SELECT TRAN_TYPE, VCHR_NO, CHQ_NO AS CHQ, CHQ_DATE FROM pdc_rcd WHERE TRAN_TYPE = ? " +
      "    UNION ALL " +
      "    SELECT TRAN_TYPE, VCHR_NO, CHQ_NO AS CHQ, CHQ_DATE FROM current_chq WHERE TRAN_TYPE = ? " +
      "  ) u GROUP BY TRAN_TYPE, VCHR_NO) chq " +
      "  ON chq.TRAN_TYPE = v.TRAN_TYPE AND chq.VCHR_NO = v.VCHR_NO " +
      "WHERE v.TRAN_TYPE = ? " +
      "ORDER BY v.VCHR_NO DESC",
      [tranId, tranId, tranId],
      function (error, result) {
        if (error) {
          console.error("RV list error:", error);
          return res.status(500).json({ error: error.message });
        }
        res.json(result);
      }
    );
  });

  return router;
};
