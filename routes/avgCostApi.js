// ─────────────────────────────────────────────────────────────────────────
//  routes/avgCostApi.js
//
//  GET /api/avgcost/:loc/:item/:date        (date = yyyy-MM-dd)
//    → { AVGCOST: 12.345 }
//
//  Wraps the MySQL function AVGCOST(loc, item_code, as_on_date). Used by the
//  Stock Adjustment screen (StkAdj.tsx) to price outward lines.
//  Register in HayatDb.js:
//      app.use("/api", require("./routes/avgCostApi")(connection));
// ─────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/avgcost/:loc/:item/:date", (req, res) => {
    const { loc, item, date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "date must be yyyy-MM-dd" });
    }
    connection.query(
      "SELECT AVGCOST(?, ?, ?) AS AVGCOST",
      [loc, item, date],
      (err, rows) => {
        if (err) {
          console.error("avgcost:", err.message);
          return res.status(500).json({ message: "AVGCOST failed" });
        }
        res.json({ AVGCOST: Number(rows?.[0]?.AVGCOST ?? 0) });
      }
    );
  });

  return router;
};
