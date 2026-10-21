// routes/lpoRcvdApi.js
// Received quantity per item for one LPO (sum of SRV lines against it).
// Register in HayatDb.js:
//   const lpoRcvdApi = require("./routes/lpoRcvdApi");
//   app.use("/api", lpoRcvdApi(connection));
//
// GET /api/lpo-rcvd/:lpoNo
//   → [{ ITEM_CODE: "A001", RCVD_QTY: 12 }, ...]
// Items with nothing received yet are simply absent.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

    router.get("/lpo-rcvd/:lpoNo", (req, res) => {
    const lpoNo = String(req.params.lpoNo ?? "").trim();
    if (!lpoNo) return res.json([]);

    connection.query(
      // Rcvd qty per LPO line: matched on LPO No + Sr No (numeric, so '1' =
      // '0001'), plus Item Code when the LPO line has one. Numbers compared
      // trimmed (old LPO numbers are space-padded).
      `SELECT o.SR_NO,
              o.ITEM_CODE,
              IFNULL((
                 SELECT SUM(ABS(IFNULL(s.QTY, 0)))
                   FROM srv_items s
                   JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO
                  WHERE TRIM(h.PO_NO) = o.LPO_NO
                    AND (s.SR_NO + 0) = o.SR_NO
                    AND (o.ITEM_CODE = ''
                         OR TRIM(IFNULL(s.ITEM_CODE, '')) = o.ITEM_CODE)
              ), 0) AS RCVD_QTY
         FROM (
              SELECT DISTINCT
                     TRIM(i.LPO_NO)                AS LPO_NO,
                     (i.SR_NO + 0)                 AS SR_NO,
                     TRIM(IFNULL(i.ITEM_CODE, '')) AS ITEM_CODE
                FROM lpo_items i
               WHERE TRIM(i.LPO_NO) = ?
         ) o
        ORDER BY o.SR_NO`,
      [lpoNo],
      (err, rows) => {
        if (err) {
          console.error("lpo-rcvd failed:", err);
          return res.status(500).json({ message: err.sqlMessage || "Query failed" });
        }
        res.json(rows);
      }
    );
  });

  return router;
};
