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
      // Same figures as v_lpo_srv's SRV branch (QTY < 0), read from the base
      // tables; numbers compared trimmed (old LPO numbers are space-padded).
      `SELECT TRIM(s.ITEM_CODE)          AS ITEM_CODE,
              SUM(ABS(IFNULL(s.QTY, 0)))  AS RCVD_QTY
         FROM srv_items s
         JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO
        WHERE TRIM(h.PO_NO) = TRIM(?)
          AND s.ITEM_CODE IS NOT NULL
        GROUP BY TRIM(s.ITEM_CODE)`,
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
