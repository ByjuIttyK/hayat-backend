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
//
// GET /api/lpo-srv-list/:lpoNo
//   → [{ SRV_NO, SRV_DATE, INV_NO, INV_DATE, SRV_QTY, INV_AMT_VAT, CAN_CEL }]
//   Every SRV raised against the LPO (srv_hdr.PO_NO = LPO No, both trimmed)
//   — for the Received Qty list icon on the LPO list. SRV_QTY is the SRV's
//   total qty (ABS, same as /lpo-rcvd).
//
// GET /api/lpo-srv-detail/:lpoNo
//   → [{ LPO_NO, SR_NO, ITEM_CODE, ITEM_NAME, QTY, SRV_NO, SRV_DATE,
//        SRV_SR_NO, RCVD_QTY, PENDING_QTY, GRP_ROW, GRP_CNT }]
//   LPO line × SRV line, for the bottom detail grid on the LPO list.
//   Same matching rule as above (LPO No + Sr No, + Item Code when present).
//   PENDING_QTY is the running balance of the LPO line after each SRV, in
//   SRV date order; a line with no SRV comes once with PENDING_QTY = QTY.
//   GRP_ROW / GRP_CNT = position / count of the row within its LPO line.

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

  router.get("/lpo-srv-list/:lpoNo", (req, res) => {
    const lpoNo = String(req.params.lpoNo ?? "").trim();
    if (!lpoNo) return res.json([]);

    connection.query(
      `SELECT h.SRV_NO,
              DATE_FORMAT(h.SRV_DATE, '%d/%m/%Y') AS SRV_DATE,
              h.INV_NO,
              DATE_FORMAT(h.INV_DATE, '%d/%m/%Y') AS INV_DATE,
              IFNULL(SUM(ABS(IFNULL(s.QTY, 0))), 0) AS SRV_QTY,
              IFNULL(h.INV_AMT_VAT, 0)            AS INV_AMT_VAT,
              h.CAN_CEL
         FROM srv_hdr h
         LEFT JOIN srv_items s ON s.SRV_NO = h.SRV_NO
        WHERE TRIM(h.PO_NO) = ?
        GROUP BY h.SRV_NO, h.SRV_DATE, h.INV_NO, h.INV_DATE, h.INV_AMT_VAT, h.CAN_CEL
        ORDER BY h.SRV_DATE, h.SRV_NO`,
      [lpoNo],
      (err, rows) => {
        if (err) {
          console.error("lpo-srv-list failed:", err);
          return res.status(500).json({ message: err.sqlMessage || "Query failed" });
        }
        res.json(rows);
      }
    );
  });

  router.get("/lpo-srv-detail/:lpoNo", (req, res) => {
    const lpoNo = String(req.params.lpoNo ?? "").trim();
    if (!lpoNo) return res.json([]);

    connection.query(
      `SELECT x.LPO_NO, x.SR_NO, x.ITEM_CODE, x.ITEM_NAME, x.QTY,
              x.SRV_NO,
              DATE_FORMAT(x.SRV_DT, '%d/%m/%Y') AS SRV_DATE,
              x.SRV_SR_NO,
              x.RCVD_QTY,
              x.QTY - SUM(x.RCVD_QTY) OVER w                       AS PENDING_QTY,
              ROW_NUMBER() OVER w                                  AS GRP_ROW,
              COUNT(*) OVER (PARTITION BY x.SR_NO, x.ITEM_CODE)    AS GRP_CNT
         FROM (
              SELECT o.LPO_NO, o.SR_NO, o.ITEM_CODE, o.ITEM_NAME, o.QTY,
                     r.SRV_NO, r.SRV_DT, r.SRV_SR_NO,
                     IFNULL(SUM(r.QTY), 0) AS RCVD_QTY
                FROM (
                     SELECT TRIM(i.LPO_NO)                AS LPO_NO,
                            (i.SR_NO + 0)                 AS SR_NO,
                            TRIM(IFNULL(i.ITEM_CODE, '')) AS ITEM_CODE,
                            MAX(i.ITEM_NAME)              AS ITEM_NAME,
                            SUM(IFNULL(i.QTY, 0))         AS QTY
                       FROM lpo_items i
                      WHERE TRIM(i.LPO_NO) = ?
                      GROUP BY TRIM(i.LPO_NO), (i.SR_NO + 0),
                               TRIM(IFNULL(i.ITEM_CODE, ''))
                ) o
                LEFT JOIN (
                     SELECT h.SRV_NO,
                            h.SRV_DATE                    AS SRV_DT,
                            s.SR_NO                       AS SRV_SR_NO,
                            (s.SR_NO + 0)                 AS SRN,
                            TRIM(IFNULL(s.ITEM_CODE, '')) AS ITEM_CODE,
                            ABS(IFNULL(s.QTY, 0))         AS QTY
                       FROM srv_items s
                       JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO
                      WHERE TRIM(h.PO_NO) = ?
                ) r
                  ON r.SRN = o.SR_NO
                 AND (o.ITEM_CODE = '' OR r.ITEM_CODE = o.ITEM_CODE)
               GROUP BY o.LPO_NO, o.SR_NO, o.ITEM_CODE, o.ITEM_NAME, o.QTY,
                        r.SRV_NO, r.SRV_DT, r.SRV_SR_NO
         ) x
       WINDOW w AS (PARTITION BY x.SR_NO, x.ITEM_CODE
                    ORDER BY x.SRV_DT, x.SRV_NO
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
        ORDER BY x.SR_NO, x.ITEM_CODE, GRP_ROW`,
      [lpoNo, lpoNo],
      (err, rows) => {
        if (err) {
          console.error("lpo-srv-detail failed:", err);
          return res.status(500).json({ message: err.sqlMessage || "Query failed" });
        }
        res.json(rows);
      }
    );
  });

  return router;
};
