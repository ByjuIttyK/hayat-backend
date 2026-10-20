// routes/lpoRcvdApi.js
// Received quantity per item for one LPO, from the v_lpo_srv view
// (SRV lines come into that view with negative QTY).
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
      `SELECT TRIM(ITEM_CODE)  AS ITEM_CODE,
              SUM(ABS(QTY))    AS RCVD_QTY
         FROM v_lpo_srv
        WHERE QTY < 0
          AND LPO_NO = ?
          AND ITEM_CODE IS NOT NULL
        GROUP BY TRIM(ITEM_CODE)`,
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
