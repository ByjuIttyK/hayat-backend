// routes/ledger-row-settlements.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ledger-row-settlements/:tranType/:vchrNo?acc=<ACC_CODE>
//
// Returns the adj_dtl rows that settle (or are settled by) the given voucher.
//
// The direction of the join depends on the voucher's TRAN_TYPE:
//
//   RV / PV / JV  (01, 03, 02, 04, 05)
//        The voucher is the SOURCE of the settlement (money in/out), so
//        match  adj_dtl.SOURCE_TYPE + adj_dtl.SOURCE_DOC
//        and DISPLAY the settled side (STLD_TYPE / STLD_DOC) — i.e. which
//        invoices this receipt/payment/JV settled.
//
//   Sales (06) / Purchase (07)
//        The voucher is the INVOICE being settled, so
//        match  adj_dtl.STLD_TYPE + adj_dtl.STLD_DOC
//        and DISPLAY the source side (SOURCE_TYPE / SOURCE_DOC) — i.e. which
//        receipts/payments settled this invoice.
//
// DISP_TYPE / DISP_DOC are computed in SQL so the front-end grid can bind
// to one pair of fields regardless of direction.
//
// Wire up in HayatDb.js:
//   const ledgerRowSettlements = require("./routes/ledger-row-settlements");
//   app.use("/api/ledger-row-settlements", authMiddleware, ledgerRowSettlements(connection));
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");

// TRAN_TYPEs where the voucher is the SOURCE side of adj_dtl
const SOURCE_SIDE_TYPES = ["01", "02", "03", "04", "05"];
// TRAN_TYPEs where the voucher is the SETTLED side of adj_dtl
const STLD_SIDE_TYPES = ["06", "07"];

module.exports = (connection) => {
  const router = express.Router();

  router.get("/:tranType/:vchrNo", (req, res) => {
    const { tranType, vchrNo } = req.params;
    const acc = (req.query.acc || "").trim();

    const isSourceSide = SOURCE_SIDE_TYPES.includes(tranType);
    const isStldSide = STLD_SIDE_TYPES.includes(tranType);

    // Voucher type has no settlement concept (e.g. petty cash 17)
    if (!isSourceSide && !isStldSide) {
      return res.json([]);
    }

    // Which pair we MATCH on, and which pair we DISPLAY
    const matchType = isSourceSide ? "SOURCE_TYPE" : "STLD_TYPE";
    const matchDoc = isSourceSide ? "SOURCE_DOC" : "STLD_DOC";
    const dispType = isSourceSide ? "STLD_TYPE" : "SOURCE_TYPE";
    const dispDoc = isSourceSide ? "STLD_DOC" : "SOURCE_DOC";

    // Optional account restriction (Customer / Supplier ledgers)
    const accFilter = acc ? " AND a.ACC_CODE = ? " : "";
    const params = acc ? [tranType, vchrNo, acc] : [tranType, vchrNo];

    const sql = `
      SELECT
        a.SOURCE_TYPE,
        a.SOURCE_DOC,
        a.SOURCE_DATE,
        a.STLD_TYPE,
        a.STLD_DOC,
        a.STLD_DATE,
        a.STLD_AMT,
        a.STLD_DBCR,
        a.ACC_CODE,
        a.REF_NO,
        a.MAIN_SR_NO,
        a.DIV_CODE,
        a.${dispType} AS DISP_TYPE,
        a.${dispDoc}  AS DISP_DOC
      FROM adj_dtl a
      WHERE a.${matchType} = ?
        AND a.${matchDoc}  = ?
        ${accFilter}
      ORDER BY a.STLD_DATE, a.MAIN_SR_NO
    `;

    connection.query(sql, params, (err, rows) => {
      if (err) {
        console.error("ledger-row-settlements error:", err);
        return res.status(500).json({ error: "Failed to fetch settlements" });
      }
      res.json(rows);
    });
  });

  return router;
};
