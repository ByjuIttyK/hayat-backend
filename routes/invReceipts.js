// routes/invReceipts.js
// Sales invoice detail grids — InfoGrid/FABINV (components/InfoGridDetails/InvRcptPanel.tsx)
// (purchase invoices: routes/invPayments.js)
//
//   GET /api/inv-receipts/receipts/:tranType/:invNo
//       receipt vouchers that settled the invoice (adj_dtl) + the invoice amount
//   GET /api/inv-receipts/cheques/:tranType/:invNo
//       PDC / current cheques of those RVs (pdc_rcd, current_chq on the RV's
//       TRAN_TYPE + VCHR_NO), for the invoice's customer
//
// The invoice's own A/c entries use the existing
//   GET /api/inv-settle/voucher-entries/:tranType/:vchrNo   (routes/invSettle.js)
//
// Register in HayatDb.js:
//   const invReceiptsRoutes = require("./routes/invReceipts");
//   app.use("/api", authMiddleware, invReceiptsRoutes(connection));
//
// adj_dtl direction: a receipt settling an invoice is stored with the RV as
// SOURCE_TYPE / SOURCE_DOC and the invoice as STLD_TYPE / STLD_DOC. Rows where
// the invoice itself is the SOURCE are included too (the other document is
// then the STLD side), so both ways of recording show up.

const express = require("express");

// receipt vouchers linked to one invoice: tt / vn = voucher, acc = party
const LINKED_VOUCHERS = `
      SELECT a.SOURCE_TYPE AS tt, a.SOURCE_DOC AS vn, a.ACC_CODE AS acc,
             a.SOURCE_DATE AS vdate, a.STLD_AMT AS amt, a.MAIN_SR_NO AS sr
        FROM adj_dtl a
       WHERE a.STLD_TYPE = ? AND a.STLD_DOC = ?
      UNION ALL
      SELECT a.STLD_TYPE, a.STLD_DOC, a.ACC_CODE,
             a.STLD_DATE, a.STLD_AMT, a.MAIN_SR_NO
        FROM adj_dtl a
       WHERE a.SOURCE_TYPE = ? AND a.SOURCE_DOC = ?`;

// sales invoices: customer Dr invoice / Cr receipt, cheques in pdc_rcd
const MODES = {
  cus: { invSide: "D", paySide: "C", master: "cus_mst", code: "CUST_CODE",
         pdc: "pdc_rcd", pdcParty: "CUST_CODE", pdcFc: "AMOUNT_FC", pdcSrc: "PDC_RCD" },
};

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const fail = (res, err, where) => {
    console.error(`[invReceipts] ${where}:`, err);
    res.status(500).json({ error: `${where} failed`, detail: err.message });
  };

  // --- 1. receipts against the invoice --------------------------------------
  router.get("/inv-receipts/receipts/:tranType/:invNo", async (req, res) => {
    const { tranType, invNo } = req.params;
    const m = MODES.cus;
    try {
      const linesQ = db.execute(
        `SELECT u.tt                                        AS rvType,
                u.vn                                        AS rvNo,
                tt.TYPE_ABBR                                AS rvAbbr,
                DATE_FORMAT(COALESCE(u.vdate,
                  (SELECT MIN(t.DATTE) FROM tran_acc t
                    WHERE t.TRAN_TYPE = u.tt AND t.vchr_no = u.vn)), '%d/%m/%Y') AS rvDate,
                u.acc                                       AS acCode,
                COALESCE(c.CUST_NAME, s.SUP_NAME)           AS acName,
                u.amt                                       AS stldAmt,
                (SELECT SUM(t.AMOUNT) FROM tran_acc t
                  WHERE t.TRAN_TYPE = u.tt AND t.vchr_no = u.vn
                    AND t.ACC_CODE = u.acc AND t.DB_CR = '${m.paySide}') AS rvAmount,
                (SELECT MAX(TRIM(CONCAT_WS(' ', t.NARRATION1, t.NARRATION2))) FROM tran_acc t
                  WHERE t.TRAN_TYPE = u.tt AND t.vchr_no = u.vn
                    AND t.ACC_CODE = u.acc)                              AS narration
           FROM (${LINKED_VOUCHERS}) u
      LEFT JOIN tran_type tt ON tt.TRAN_TYPE = u.tt
      LEFT JOIN cus_mst  c  ON c.CUST_CODE  = u.acc
      LEFT JOIN sup_mst  s  ON s.SUP_CODE   = u.acc
       ORDER BY COALESCE(u.vdate, '9999-12-31'), u.vn, u.sr`,
        [tranType, invNo, tranType, invNo]
      );

      // invoice amount = the party line(s) of the invoice
      //   sales: customer Dr  ·  purchase: supplier Cr
      const invQ = db.execute(
        `SELECT SUM(t.AMOUNT) AS amt
           FROM tran_acc t
          WHERE t.TRAN_TYPE = ? AND t.vchr_no = ? AND t.DB_CR = '${m.invSide}'
            AND EXISTS (SELECT 1 FROM ${m.master} p WHERE p.${m.code} = t.ACC_CODE)`,
        [tranType, invNo]
      );

      const [[lines], [inv]] = await Promise.all([linesQ, invQ]);
      res.json({
        lines,
        invAmount: inv[0]?.amt == null ? null : Number(inv[0].amt),
      });
    } catch (err) {
      fail(res, err, "invoice receipts");
    }
  });

  // --- 2. cheques of those receipt vouchers ---------------------------------
  router.get("/inv-receipts/cheques/:tranType/:invNo", async (req, res) => {
    const { tranType, invNo } = req.params;
    const m = MODES.cus;
    const cols = (p, partyCol, fcCol) => `
          ${p}.MAIN_SR_NO                            AS mainSrNo,
          ${p}.CHQ_NO                                AS chqNo,
          DATE_FORMAT(${p}.CHQ_DATE, '%d/%m/%Y')     AS chqDate,
          DATE_FORMAT(${p}.CHQ_DATE, '%Y-%m-%d')     AS chqDateIso,
          ${p}.CHQ_BANK                              AS chqBank,
          ${p}.PDC_CODE                              AS pdcCode,
          ${p}.${partyCol}                           AS partyCode,
          ${p}.AMOUNT                                AS amount,
          ${fcCol ? `${p}.${fcCol}` : "NULL"}        AS amountFc,
          ${p}.NARRATION                             AS narration,
          ${p}.JV_NO_RLZ                             AS jvNoRlz,
          DATE_FORMAT(${p}.JV_DATE_RLZ, '%d/%m/%Y')  AS jvDateRlz,
          ${p}.REALISED                              AS realised`;
    try {
      const [rows] = await db.execute(
        `WITH rv AS (
           SELECT DISTINCT tt, vn, acc FROM (${LINKED_VOUCHERS}) x
         )
         SELECT u.*,
                tt.TYPE_ABBR AS rvAbbr,
                COALESCE(c.CUST_NAME, s.SUP_NAME,
                         (SELECT MAX(l.AC_HEAD) FROM ac_list l WHERE l.AC_CODE = u.partyCode)) AS partyName,
                (SELECT MAX(l.AC_HEAD) FROM ac_list l WHERE l.AC_CODE = u.pdcCode)           AS pdcHead
           FROM (
                 SELECT '${m.pdcSrc}' AS src, p.TRAN_TYPE AS rvType, p.VCHR_NO AS rvNo,
                        ${cols("p", m.pdcParty, m.pdcFc)}
                   FROM ${m.pdc} p
                   JOIN rv ON rv.tt = p.TRAN_TYPE AND rv.vn = p.VCHR_NO
                          AND (p.${m.pdcParty} IS NULL OR p.${m.pdcParty} = '' OR p.${m.pdcParty} = rv.acc)
                 UNION ALL
                 SELECT 'CURRENT' AS src, q.TRAN_TYPE, q.VCHR_NO,
                        ${cols("q", "SUP_CODE", "AMOUNT_FC")}
                   FROM current_chq q
                   JOIN rv ON rv.tt = q.TRAN_TYPE AND rv.vn = q.VCHR_NO
                          AND (q.SUP_CODE IS NULL OR q.SUP_CODE = '' OR q.SUP_CODE = rv.acc)
                ) u
      LEFT JOIN tran_type tt ON tt.TRAN_TYPE = u.rvType
      LEFT JOIN cus_mst  c  ON c.CUST_CODE  = u.partyCode
      LEFT JOIN sup_mst  s  ON s.SUP_CODE   = u.partyCode
       ORDER BY u.rvNo, u.chqDateIso, u.chqNo`,
        [tranType, invNo, tranType, invNo]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "invoice cheques");
    }
  });

  return router;
};
