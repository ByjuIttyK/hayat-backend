// routes/pvListApi.js
// Payment Voucher list — TRAN_TYPE 02 (tran_acc lines) and 04 (vouchers + pdc_isu)
// Mounted in HayatDb.js as: app.use("/api", require("./routes/pvListApi")(connection));
// Endpoint: GET /api/pvlist/:tranId[?fromDate=yyyy-MM-dd&toDate=yyyy-MM-dd]
// Period: InfoGrid's period chip sends fromDate/toDate; without them the
// current ac_period is used (utils/periodFilter.js).
// 11-Nov-2026: TRAN_TYPE 04 rows carry ALL_CHQ_NOS (every cheque no. of the voucher, space separated)
//   so InfoGrid's Cheque No filter finds a voucher by its 2nd / 3rd … cheque (InfoGridChequeSearch.ts).

const express = require("express");
const periodFilter = require("../utils/periodFilter");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/pvlist/:tranId", function (req, res) {
    const tranId = String(req.params.tranId || "");
    const drMode = String(req.query.dr || "single").toLowerCase() === "all" ? "all" : "single";
    if (tranId === "02") {
      const pf = periodFilter(req, "a.DATTE");
      connection.query(
        "SELECT a.TRAN_TYPE, a.VCHR_NO, DATE_FORMAT(a.DATTE,'%d/%m/%Y') AS DATTE, '' AS CUST_CODE, " +
        "       c.AC_HEAD AS ACC_HEAD, " +
        "       a.ACC_CODE, '' AS CHEQUE_NO, a.AMOUNT, b.PAID_TO, a.NARRATION1, a.NARRATION2, " +
        "       a.DB_CR ,b.CONTRA_FLG ," +
        " b.CREATED_BY," +
        " DATE_FORMAT(b.CREATED_ON,     '%Y-%m-%d %H:%i:%s') AS CREATED_ON," +
        " b.LAST_EDITED_BY," +
        " DATE_FORMAT(b.LAST_EDITED_ON, '%Y-%m-%d %H:%i:%s') AS LAST_EDITED_ON " +
        "  FROM tran_acc a " +
        "  LEFT OUTER JOIN ac_list AS c " +
        "    ON c.AC_CODE = a.ACC_CODE " +
        "  LEFT OUTER JOIN vouchers AS b " +
        "    ON b.TRAN_TYPE = a.TRAN_TYPE AND b.VCHR_NO = a.VCHR_NO " +
        " WHERE a.TRAN_TYPE = ? " + pf.sql +
        " ORDER BY a.VCHR_NO DESC, a.SR_NO",
        [tranId, ...pf.params],
        function (error, result) {
          if (error) {
            console.error("PV list 02 error:", error);
            return res.status(500).json({ error: error.message });
          }
          res.json(result);
        }
      );
    } else if (tranId === "04") {
      const pf = periodFilter(req, "v.DATTE");

      // Debit-side join, chosen by mode.
      //  single: the voucher's first debit line, i.e. the lowest SR_NO among DB_CR='D'.
      //          That is SR_NO 1 whenever line 1 is a debit, and it still finds a
      //          debit if line 1 happens to be the credit. CAST copes with SR_NO
      //          stored as '001' or as 1.
      //  all:    every DB_CR='D' line, so a voucher with 3 debits gives 3 rows.
      const drJoin = drMode === "all"
        ? "LEFT OUTER JOIN tran_acc AS dr " +
        "  ON dr.TRAN_TYPE = v.TRAN_TYPE AND dr.VCHR_NO = v.VCHR_NO AND dr.DB_CR = 'D' "
        : "LEFT OUTER JOIN (" +
        "  SELECT t.TRAN_TYPE, t.VCHR_NO, t.SR_NO, t.ACC_CODE, t.AMOUNT " +
        "    FROM tran_acc t " +
        "    JOIN (SELECT TRAN_TYPE, VCHR_NO, MIN(CAST(SR_NO AS UNSIGNED)) AS FIRST_SR " +
        "            FROM tran_acc WHERE TRAN_TYPE = ? AND DB_CR = 'D' " +
        "           GROUP BY TRAN_TYPE, VCHR_NO) f " +
        "      ON f.TRAN_TYPE = t.TRAN_TYPE AND f.VCHR_NO = t.VCHR_NO " +
        "     AND CAST(t.SR_NO AS UNSIGNED) = f.FIRST_SR " +
        "   WHERE t.TRAN_TYPE = ? AND t.DB_CR = 'D') dr " +
        "  ON dr.TRAN_TYPE = v.TRAN_TYPE AND dr.VCHR_NO = v.VCHR_NO ";

      // In 'all' mode AMOUNT is the debit line's own amount, so grid totals,
      // the chart and Excel don't count the voucher once per line.
      // VCHR_AMOUNT keeps the voucher total available either way.
      const amountCol = drMode === "all"
        ? "COALESCE(dr.AMOUNT, v.AMOUNT) AS AMOUNT, "
        : "v.AMOUNT AS AMOUNT, ";

      const sql =
        "SELECT v.TRAN_TYPE, v.VCHR_NO, DATE_FORMAT(v.DATTE,'%d/%m/%Y') AS DATTE, " +
        "v.ACC_CODE, v.CUST_CODE, " +
        "chq.CHEQUE_NO, DATE_FORMAT(chq.CHEQUE_DT,'%d/%m/%y') AS CHEQUE_DT, chq.CHQ_COUNT, chq.ALL_CHQ_NOS, " +
        amountCol + "v.AMOUNT AS VCHR_AMOUNT, " +
        "v.NARRATION1, v.NARRATION2, ac_list.AC_HEAD AS ACC_HEAD, " +
        "v.BANK_NAME, v.PAID_TO, v.CAN_CEL, v.CONTRA_FLG, " +
        "COALESCE(NULLIF(v.JOB_NO,''), tj.JOB_NOS) AS JOB_NO, " +
        "v.ACC_CODE2, v.AMOUNT2,  v.CUR_CODE, v.CONV_RATE, v.AMOUNT_FRGN, " +
        " v.CREATED_BY," +
        " DATE_FORMAT(v.CREATED_ON,     '%Y-%m-%d %H:%i:%s') AS CREATED_ON," +
        " v.LAST_EDITED_BY," +
        " DATE_FORMAT(v.LAST_EDITED_ON, '%Y-%m-%d %H:%i:%s') AS LAST_EDITED_ON ," +

        "dr.SR_NO AS DR_SR_NO, dr.ACC_CODE AS DR_CODE, dra.AC_HEAD AS DR_HEAD, " +
        "dr.AMOUNT AS DR_AMOUNT, drc.DR_COUNT " +
        "FROM vouchers AS v " +
        "LEFT OUTER JOIN ac_list ON ac_list.AC_CODE = v.CUST_CODE " +
        "LEFT OUTER JOIN (" +
        "  SELECT TRAN_TYPE, VCHR_NO, MIN(CHQ) AS CHEQUE_NO, MIN(CHQ_DATE) AS CHEQUE_DT, " +
        "         COUNT(DISTINCT CHQ) AS CHQ_COUNT, " +
        // every cheque no. of the voucher — the list's Cheque No filter finds a voucher by any of them
        "         GROUP_CONCAT(DISTINCT CHQ ORDER BY CHQ SEPARATOR ' ') AS ALL_CHQ_NOS FROM (" +
        "    SELECT TRAN_TYPE, VCHR_NO, CHQ_NO AS CHQ, CHQ_DATE FROM pdc_isu WHERE TRAN_TYPE = ? " +
        "    UNION ALL " +
        "    SELECT TRAN_TYPE, VCHR_NO, CHQ_NO AS CHQ, CHQ_DATE FROM current_chq WHERE TRAN_TYPE = ? " +
        "  ) u GROUP BY TRAN_TYPE, VCHR_NO) chq " +
        "  ON chq.TRAN_TYPE = v.TRAN_TYPE AND chq.VCHR_NO = v.VCHR_NO " +
        drJoin +
        "LEFT OUTER JOIN ac_list AS dra ON dra.AC_CODE = dr.ACC_CODE " +
        // Debit count per voucher — same in both modes, useful as a hint in Single
        "LEFT OUTER JOIN (" +
        "  SELECT TRAN_TYPE, VCHR_NO, COUNT(DISTINCT ACC_CODE) AS DR_COUNT " +
        "    FROM tran_acc WHERE TRAN_TYPE = ? AND DB_CR = 'D' " +
        "   GROUP BY TRAN_TYPE, VCHR_NO) drc " +
        "  ON drc.TRAN_TYPE = v.TRAN_TYPE AND drc.VCHR_NO = v.VCHR_NO " +
        "LEFT OUTER JOIN (" +
        "   SELECT TRAN_TYPE, VCHR_NO, " +
        "          GROUP_CONCAT(DISTINCT JOB_NO ORDER BY JOB_NO SEPARATOR ', ') AS JOB_NOS " +
        "   FROM tran_acc " +
        "   WHERE TRAN_TYPE = ? AND JOB_NO IS NOT NULL AND JOB_NO <> '' " +
        "   GROUP BY TRAN_TYPE, VCHR_NO) tj " +
        "  ON tj.TRAN_TYPE = v.TRAN_TYPE AND tj.VCHR_NO = v.VCHR_NO " +
        "WHERE v.TRAN_TYPE = ? " + pf.sql +
        "ORDER BY v.VCHR_NO DESC, CAST(dr.SR_NO AS UNSIGNED)";

      // Placeholders in SQL order: chq(2), [single-mode drJoin(2)], drc(1), where(1), period(2)
      const params = drMode === "all"
        ? [tranId, tranId, tranId, tranId,tranId ,...pf.params]
        : [tranId, tranId, tranId, tranId, tranId, tranId,tranId, ...pf.params];

      connection.query(sql, params, function (error, result) {
        if (error) {
          console.error("PV list 04 error:", error);
          return res.status(500).json({ error: error.message });
        }
        res.json(result);
      });
    } else {
      res.status(400).json({ error: "PV list supports TRAN_TYPE 02 or 04 only" });
    }
  });
  return router;
};
