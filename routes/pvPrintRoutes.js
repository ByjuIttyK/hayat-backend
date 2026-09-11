// routes/pvPrintRoutes.js
// ---------------------------------------------------------------------------
// Payment Voucher printout details — Telltron ERP
//
//   GET /api/pv-print/:tranType/:vchrNo?curr=01
//     → { CURR_NAME, cheques: [...], settlements: [...] }
//
//   cheques      pdc_isu (post-dated) + current_chq (current-dated) for the PV
//   settlements  adj_dtl rows whose SOURCE is this PV (supplier invoices settled)
//
// Table names are lowercase for the Linux VPS (lower_case_table_names=0).
//
// Register in HayatDb.js:
//   const pvPrintRoutes = require("./routes/pvPrintRoutes");
//   app.use("/api", pvPrintRoutes(connection));
// ---------------------------------------------------------------------------
const express = require("express");

const CHEQUE_SQL = `
  SELECT c.SRC,
         c.CHQ_NO,
         DATE_FORMAT(c.CHQ_DATE, '%d/%m/%Y') AS CHQ_DATE,
         c.PDC_CODE,
         c.CHQ_BANK,
         COALESCE(NULLIF(TRIM(b.acc_head), ''), NULLIF(TRIM(c.CHQ_BANK), ''), c.PDC_CODE) AS BANK_NAME,
         c.AMOUNT
    FROM (
          SELECT 'PDC' AS SRC, MAIN_SR_NO, CHQ_NO, CHQ_DATE, CHQ_BANK, PDC_CODE, AMOUNT
            FROM pdc_isu
           WHERE TRAN_TYPE = ? AND VCHR_NO = ?
          UNION ALL
          SELECT 'CUR' AS SRC, MAIN_SR_NO, CHQ_NO, CHQ_DATE, CHQ_BANK, PDC_CODE, AMOUNT
            FROM current_chq
           WHERE TRAN_TYPE = ? AND VCHR_NO = ?
         ) c
    LEFT JOIN acc_mst b ON b.acc_code = c.PDC_CODE
   ORDER BY c.CHQ_DATE, c.CHQ_NO, c.MAIN_SR_NO`;

// Invoice amount  = net of the supplier's lines on the settled document
// Already settled = other adj_dtl settlements of that document dated on or
//                   before this PV (this PV itself excluded)
const SETTLE_SQL = `
  SELECT a.STLD_TYPE AS DOC_TYPE,
         a.STLD_DOC  AS DOC_NO,
         DATE_FORMAT(a.STLD_DATE, '%d/%m/%Y') AS DOC_DATE,
         a.ACC_CODE,
         ABS(a.STLD_AMT) AS AMOUNT_STL,
         (SELECT MAX(t.NARRATION1)
            FROM tran_acc t
           WHERE t.TRAN_TYPE = a.STLD_TYPE AND t.vchr_no = a.STLD_DOC
             AND t.ACC_CODE = a.ACC_CODE) AS NAR,
         (SELECT ABS(SUM(CASE WHEN UPPER(LEFT(t.DB_CR, 1)) = 'C' THEN t.AMOUNT ELSE -t.AMOUNT END))
            FROM tran_acc t
           WHERE t.TRAN_TYPE = a.STLD_TYPE AND t.vchr_no = a.STLD_DOC
             AND t.ACC_CODE = a.ACC_CODE) AS INV_AMOUNT,
         (SELECT COALESCE(SUM(ABS(o.STLD_AMT)), 0)
            FROM adj_dtl o
           WHERE o.STLD_TYPE = a.STLD_TYPE AND o.STLD_DOC = a.STLD_DOC
             AND o.ACC_CODE = a.ACC_CODE
             AND NOT (o.SOURCE_TYPE = a.SOURCE_TYPE AND o.SOURCE_DOC = a.SOURCE_DOC)
             AND o.SOURCE_DATE <= a.SOURCE_DATE) AS ALREADY_SETTLED
    FROM adj_dtl a
   WHERE a.SOURCE_TYPE = ? AND a.SOURCE_DOC = ?
   ORDER BY a.STLD_DATE, a.STLD_DOC, a.MAIN_SR_NO`;

const num = (v) => (v === null || v === undefined ? null : Number(v)); // DECIMAL arrives as string

module.exports = function (connection) {
  const router = express.Router();
  const db = typeof connection.promise === "function" ? connection.promise() : connection;

  router.get("/pv-print/:tranType/:vchrNo", async (req, res) => {
    const tranType = String(req.params.tranType || "").trim();
    const vchrNo = String(req.params.vchrNo || "").trim();

    if (!/^\d{2}$/.test(tranType) || !vchrNo) {
      return res.status(400).json({ error: "Transaction type (2 digits) and voucher number are required." });
    }

    try {
      // ?curr= is the voucher's stored currency — a CUR_CODE ('01') or a CUR_NAME ('AED')
      const curr = String(req.query.curr ?? "").trim();

      const [[chqRows], [stlRows], [curRows]] = await Promise.all([
        tranType === "04"
          ? db.query(CHEQUE_SQL, [tranType, vchrNo, tranType, vchrNo])
          : Promise.resolve([[]]),
        db.query(SETTLE_SQL, [tranType, vchrNo]),
        curr
          ? db.query(
              `SELECT CUR_NAME FROM nation_mst
                WHERE CUR_CODE = ? OR CUR_NAME = ?
                ORDER BY (CUR_CODE = ?) DESC
                LIMIT 1`,
              [curr, curr, curr]
            )
          : Promise.resolve([[]]),
      ]);

      res.json({
        CURR_NAME: curRows[0]?.CUR_NAME ? String(curRows[0].CUR_NAME).trim() : "",
        cheques: chqRows.map((r) => ({
          SRC: r.SRC,
          CHQ_NO: r.CHQ_NO ? String(r.CHQ_NO).trim() : "",
          CHQ_DATE: r.CHQ_DATE || "",
          PDC_CODE: r.PDC_CODE || "",
          CHQ_BANK: r.CHQ_BANK || "",
          BANK_NAME: r.BANK_NAME || "",
          AMOUNT: num(r.AMOUNT) || 0,
        })),
        settlements: stlRows.map((r, i) => ({
          SR_NO: i + 1,
          DOC_TYPE: r.DOC_TYPE || "",
          DOC_NO: r.DOC_NO ? String(r.DOC_NO).trim() : "",
          DOC_DATE: r.DOC_DATE || "",
          ACC_CODE: r.ACC_CODE || "",
          NAR: r.NAR ? String(r.NAR).trim() : "",
          INV_AMOUNT: num(r.INV_AMOUNT),
          ALREADY_SETTLED: num(r.ALREADY_SETTLED) || 0,
          AMOUNT_STL: num(r.AMOUNT_STL) || 0,
        })),
      });
    } catch (err) {
      console.error("pv-print:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
