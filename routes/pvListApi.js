// routes/pvListApi.js
// Payment Voucher list — TRAN_TYPE 02 (tran_acc lines) and 04 (vouchers + pdc_isu)
// Mounted in HayatDb.js as: app.use("/api", require("./routes/pvListApi")(connection));
// Endpoint: GET /api/pvlist/:tranId

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/pvlist/:tranId", function (req, res) {
    const tranId = String(req.params.tranId || "");

    if (tranId === "02") {
      connection.query(
        "SELECT a.TRAN_TYPE, a.VCHR_NO, DATE_FORMAT(a.DATTE,'%d/%m/%Y') AS DATTE, '' AS CUST_CODE, " +
        "       c.AC_HEAD AS ACC_HEAD, " +
        "       a.ACC_CODE, '' AS CHEQUE_NO, a.AMOUNT, b.PAID_TO, a.NARRATION1, a.NARRATION2, " +
        "       a.DB_CR " +
        "  FROM tran_acc a " +
        "  LEFT OUTER JOIN ac_list AS c " +
        "    ON c.AC_CODE = a.ACC_CODE " +
        "  LEFT OUTER JOIN vouchers AS b " +
        "    ON b.TRAN_TYPE = a.TRAN_TYPE AND b.VCHR_NO = a.VCHR_NO " +
        " WHERE a.TRAN_TYPE = ? " +
        " ORDER BY a.VCHR_NO DESC, a.SR_NO",
        [tranId],
        function (error, result) {
          if (error) {
            console.error("PV list 02 error:", error);
            return res.status(500).json({ error: error.message });
          }
          res.json(result);
        }
      );
    } else if (tranId === "04") {
      connection.query(
        "SELECT v.TRAN_TYPE, v.VCHR_NO, DATE_FORMAT(v.DATTE,'%d/%m/%Y') AS DATTE, " +
        "COALESCE( v.CUST_CODE,v.ACC_CODE) AS ACC_CODE, v.CUST_CODE, " +
        "chq.CHEQUE_NO, DATE_FORMAT(chq.CHEQUE_DT,'%d/%m/%y') AS CHEQUE_DT, chq.CHQ_COUNT, " +
        "v.AMOUNT, v.NARRATION1, v.NARRATION2, ac_list.AC_HEAD AS ACC_HEAD, " +
        "v.BANK_NAME, v.PAID_TO, v.CAN_CEL, " +
        "v.ACC_CODE2, v.AMOUNT2, v.JOB_NO, v.CUR_CODE, v.CONV_RATE, v.AMOUNT_FRGN, " +
        "dr.DR_CODE, dra.AC_HEAD AS DR_HEAD, dr.DR_COUNT " +
        "FROM vouchers AS v " +
        "LEFT OUTER JOIN ac_list " +
        "  ON ac_list.AC_CODE = COALESCE(v.ACC_CODE, v.CUST_CODE) " +
        "LEFT OUTER JOIN (" +
        "  SELECT TRAN_TYPE, VCHR_NO, MIN(CHQ) AS CHEQUE_NO, MIN(CHQ_DATE) AS CHEQUE_DT, " +
        "         COUNT(DISTINCT CHQ) AS CHQ_COUNT FROM (" +
        "    SELECT TRAN_TYPE, VCHR_NO, CHQ_NO AS CHQ, CHQ_DATE FROM pdc_isu WHERE TRAN_TYPE = ? " +
        "    UNION ALL " +
        "    SELECT TRAN_TYPE, VCHR_NO, CHQ_NO AS CHQ, CHQ_DATE FROM current_chq WHERE TRAN_TYPE = ? " +
        "  ) u GROUP BY TRAN_TYPE, VCHR_NO) chq " +
        "  ON chq.TRAN_TYPE = v.TRAN_TYPE AND chq.VCHR_NO = v.VCHR_NO " +
        "LEFT OUTER JOIN (" +
        "  SELECT TRAN_TYPE, VCHR_NO, MIN(ACC_CODE) AS DR_CODE, " +
        "         COUNT(DISTINCT ACC_CODE) AS DR_COUNT " +
        "    FROM tran_acc " +
        "   WHERE TRAN_TYPE = ? AND DB_CR = 'D' " +
        "   GROUP BY TRAN_TYPE, VCHR_NO) dr " +
        "  ON dr.TRAN_TYPE = v.TRAN_TYPE AND dr.VCHR_NO = v.VCHR_NO " +
        "LEFT OUTER JOIN ac_list AS dra " +
        "  ON dra.AC_CODE = dr.DR_CODE " +
        "WHERE v.TRAN_TYPE = ? " +
        "ORDER BY v.VCHR_NO DESC",
        [tranId, tranId, tranId, tranId],
        function (error, result) {
          if (error) {
            console.error("PV list 04 error:", error);
            return res.status(500).json({ error: error.message });
          }
          res.json(result);
        }
      );
    } else {
      res.status(400).json({ error: "PV list supports TRAN_TYPE 02 or 04 only" });
    }
  });

  return router;
};
