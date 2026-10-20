// routes/lpoPendingItemsApi.js
// Pending items of one LPO — for the Pending Qty popup on the LPO list
// (InfoGrid/LPO_NET).
// Register in HayatDb.js:
//   const lpoPendingItemsApi = require("./routes/lpoPendingItemsApi");
//   app.use("/api", lpoPendingItemsApi(connection));
//
// GET /api/lpo-pending-items/:lpoNo
//   → [{ LPO_NO, LPO_DATE, ITEM_CODE, ITEM_NAME, QTY, RCVD_QTY,
//        PENDING_QTY, RATE, AMOUNT }]      AMOUNT = PENDING_QTY × RATE
//
// Matching is LPO No + Item Code (same rule as Rcvd.Qty on the LPO screen
// and the Pending Qty on the LPO list). LOC_CODE / SR_NO are NOT used: LPO
// lines entered in the new screen carry no location and unpadded SR_NOs,
// while SRV lines carry '01' and '0001', so they never matched.
// LPO numbers migrated from Oracle are space-padded, so they are compared
// trimmed. Only items with something still to receive are returned.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/lpo-pending-items/:lpoNo", (req, res) => {
    const lpoNo = String(req.params.lpoNo ?? "").trim();
    if (!lpoNo) return res.json([]);

    connection.query(
      `SELECT o.LPO_NO,
              DATE_FORMAT(n.LPO_DATE, '%d/%m/%Y')                       AS LPO_DATE,
              o.ITEM_CODE,
              o.ITEM_NAME,
              o.QTY,
              IFNULL(r.RCVD, 0)                                         AS RCVD_QTY,
              GREATEST(o.QTY - IFNULL(r.RCVD, 0), 0)                    AS PENDING_QTY,
              o.RATE,
              ROUND(GREATEST(o.QTY - IFNULL(r.RCVD, 0), 0) * o.RATE, 2) AS AMOUNT
         FROM (
              SELECT TRIM(i.LPO_NO)          AS LPO_NO,
                     TRIM(i.ITEM_CODE)       AS ITEM_CODE,
                     MAX(i.ITEM_NAME)        AS ITEM_NAME,
                     SUM(IFNULL(i.QTY, 0))   AS QTY,
                     MAX(IFNULL(i.RATE, 0))  AS RATE,
                     MIN(i.SR_NO + 0)        AS FIRST_SR
                FROM lpo_items i
               WHERE TRIM(i.LPO_NO) = ?
                 AND i.ITEM_CODE IS NOT NULL AND TRIM(i.ITEM_CODE) <> ''
               GROUP BY TRIM(i.LPO_NO), TRIM(i.ITEM_CODE)
         ) o
         JOIN lpo_net n ON TRIM(n.LPO_NO) = o.LPO_NO
         LEFT JOIN (
              SELECT TRIM(s.ITEM_CODE) AS ITEM_CODE, SUM(IFNULL(s.QTY, 0)) AS RCVD
                FROM srv_items s
                JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO
               WHERE TRIM(h.PO_NO) = ?
               GROUP BY TRIM(s.ITEM_CODE)
         ) r ON r.ITEM_CODE = o.ITEM_CODE
       HAVING PENDING_QTY > 0
        ORDER BY o.FIRST_SR`,
      [lpoNo, lpoNo],
      (err, rows) => {
        if (err) {
          console.error("lpo-pending-items failed:", err);
          return res.status(500).json({ message: err.sqlMessage || "Query failed" });
        }
        res.json(rows);
      }
    );
  });

  return router;
};
