// routes/voucherChequeRoutes.js
// -----------------------------------------------------------------------------
// Cheque detail lookup for the voucher registers (RV / PV InfoGrid hover popup).
//
// Register in HayatDb.js:
//   const voucherChequeRoutes = require("./routes/voucherChequeRoutes");
//   app.use("/api", authMiddleware, voucherChequeRoutes(connection));
//
// Receipts  (TRAN_TYPE 01 / 03) hold post-dated cheques in pdc_rcd.
// Payments  (TRAN_TYPE 02 / 04) hold post-dated cheques in pdc_isu.
// Cheques dated on or before the voucher date sit in current_chq for both sides.
// -----------------------------------------------------------------------------

const express = require("express");

// Tran types that are payments; anything else is treated as a receipt.
const PAYMENT_TYPES = ["02", "04"];

module.exports = function (connection) {
  const router = express.Router();

  router.get("/voucher-cheques/:tranType/:vchrNo", function (req, res) {
    const tranType = String(req.params.tranType || "").trim();
    const vchrNo = String(req.params.vchrNo || "").trim();

    if (!tranType || !vchrNo) {
      return res.status(400).json({ error: "tranType and vchrNo are required" });
    }

    // The table name is interpolated, so it is chosen from a fixed pair here and
    // never taken from the request. Lowercase for the case-sensitive VPS.
    const pdcTable = PAYMENT_TYPES.includes(tranType) ? "pdc_isu" : "pdc_rcd";

    const sql =
      "SELECT t.CHQ_NO, " +
      "       DATE_FORMAT(t.CHQ_DATE,'%d/%m/%Y') AS CHQ_DATE, " +
      "       t.CHQ_BANK, t.AMOUNT, t.SOURCE, t.REALISED " +
      "FROM ( " +
      "  SELECT CHQ_NO, CHQ_DATE, CHQ_BANK, AMOUNT, REALISED, " +
      "         COALESCE(MAIN_SR_NO, 0) AS SR, 'PDC' AS SOURCE " +
      "  FROM " + pdcTable + " " +
      "  WHERE TRAN_TYPE = ? AND VCHR_NO = ? " +
      "  UNION ALL " +
      "  SELECT CHQ_NO, CHQ_DATE, CHQ_BANK, AMOUNT, REALISED, " +
      "         COALESCE(MAIN_SR_NO, 0) AS SR, 'CUR' AS SOURCE " +
      "  FROM current_chq " +
      "  WHERE TRAN_TYPE = ? AND VCHR_NO = ? " +
      ") t " +
      "ORDER BY t.SR, t.CHQ_DATE, t.CHQ_NO";

    connection.getConnection(function (err, conn) {
      if (err) {
        console.error("voucher-cheques: pool error", err);
        return res.status(500).json({ error: "Database connection failed" });
      }

      conn.query(sql, [tranType, vchrNo, tranType, vchrNo], function (error, rows) {
        conn.release();
        if (error) {
          console.error("voucher-cheques: query failed", error);
          return res.status(500).json({ error: "Cheque lookup failed" });
        }
        res.json(rows || []);
      });
    });
  });

  return router;
};
