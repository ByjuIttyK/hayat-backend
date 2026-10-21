// routes/lpoPendingItemsApi.js
// Pending items of one LPO — for the Pending Qty popup on the LPO list
// (InfoGrid/LPO_NET).
// Register in HayatDb.js:
//   const lpoPendingItemsApi = require("./routes/lpoPendingItemsApi");
//   app.use("/api", lpoPendingItemsApi(connection));
//
// GET /api/lpo-pending-items/:lpoNo
//   → [{ LPO_NO, LPO_DATE, SR_NO, ITEM_CODE, ITEM_NAME, QTY, RCVD_QTY,
//        PENDING_QTY, RATE, AMOUNT }]      AMOUNT = PENDING_QTY × RATE
//
// Matching rule (LPO line → SRV lines):
//   - LPO No   : srv_hdr.PO_NO = lpo_items.LPO_NO (both trimmed — Oracle
//                migrated numbers are space-padded)
//   - Sr No    : compared numerically (SR_NO + 0), so '1', '01' and '0001'
//                are the same line
//   - Item Code: also matched when the LPO line has one; when the LPO
//                line's item code is blank, LPO No + Sr No alone is used
// LOC_CODE is not used. Lines with a blank item code are now included.
// Received qty is computed per LPO line in a correlated subquery, so a
// blank-item line can never be duplicated by several SRV item codes.
// Only lines with something still to receive are returned.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/lpo-pending-items/:lpoNo", (req, res) => {
    const lpoNo = String(req.params.lpoNo ?? "").trim();
    if (!lpoNo) return res.json([]);

    connection.query(
      `SELECT x.LPO_NO,
              x.LPO_DATE,
              x.SR_NO,
              x.ITEM_CODE,
              x.ITEM_NAME,
              x.QTY,
              x.RCVD_QTY,
              GREATEST(x.QTY - x.RCVD_QTY, 0)                    AS PENDING_QTY,
              x.RATE,
              ROUND(GREATEST(x.QTY - x.RCVD_QTY, 0) * x.RATE, 2) AS AMOUNT
         FROM (
              SELECT o.LPO_NO,
                     DATE_FORMAT(n.LPO_DATE, '%d/%m/%Y') AS LPO_DATE,
                     o.SR_NO,
                     o.ITEM_CODE,
                     o.ITEM_NAME,
                     o.QTY,
                     o.RATE,
                     IFNULL((
                        SELECT SUM(IFNULL(s.QTY, 0))
                          FROM srv_items s
                          JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO
                         WHERE TRIM(h.PO_NO) = o.LPO_NO
                           AND (s.SR_NO + 0) = o.SR_NO
                           AND (o.ITEM_CODE = ''
                                OR TRIM(IFNULL(s.ITEM_CODE, '')) = o.ITEM_CODE)
                     ), 0) AS RCVD_QTY
                FROM (
                     SELECT TRIM(i.LPO_NO)                  AS LPO_NO,
                            (i.SR_NO + 0)                   AS SR_NO,
                            TRIM(IFNULL(i.ITEM_CODE, ''))   AS ITEM_CODE,
                            MAX(i.ITEM_NAME)                AS ITEM_NAME,
                            SUM(IFNULL(i.QTY, 0))           AS QTY,
                            MAX(IFNULL(i.RATE, 0))          AS RATE
                       FROM lpo_items i
                      WHERE TRIM(i.LPO_NO) = ?
                      GROUP BY TRIM(i.LPO_NO), (i.SR_NO + 0),
                               TRIM(IFNULL(i.ITEM_CODE, ''))
                ) o
                JOIN lpo_net n ON TRIM(n.LPO_NO) = o.LPO_NO
         ) x
        WHERE x.QTY - x.RCVD_QTY > 0
        ORDER BY x.SR_NO`,
      [lpoNo],
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
