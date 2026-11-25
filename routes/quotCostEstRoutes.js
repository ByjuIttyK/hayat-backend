// routes/quotCostEstRoutes.js
// Cost Estimation tab of the Quotation screen — five EST_* columns on quot_hdr.
// Register in HayatDb.js:
//   const quotCostEstRoutes = require("./routes/quotCostEstRoutes");
//   app.use("/api", quotCostEstRoutes(connection));

const express = require("express");

const COLS = [
  "EST_BUSBAR_COST",
  "EST_MATERIAL_COST",
  "EST_CONSUMABLE_COST",
  "EST_LABOUR_COST",
  "EST_OTHER_COST",
];

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/quotCostEst/:quotNo
  router.get("/quotCostEst/:quotNo", (req, res) => {
    const sql = `SELECT ${COLS.join(", ")} FROM quot_hdr WHERE QUOT_NO = ?`;
    connection.query(sql, [req.params.quotNo], (err, rows) => {
      if (err) {
        console.error("quotCostEst GET:", err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows[0] || {});
    });
  });

  // PUT /api/quotCostEst/:quotNo   body: { EST_BUSBAR_COST: 0, ... }
  router.put("/quotCostEst/:quotNo", (req, res) => {
    const vals = COLS.map(c => {
      const n = parseFloat(String(req.body?.[c] ?? 0).replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    });
    const sql = `UPDATE quot_hdr SET ${COLS.map(c => `${c} = ?`).join(", ")} WHERE QUOT_NO = ?`;
    connection.query(sql, [...vals, req.params.quotNo], (err, result) => {
      if (err) {
        console.error("quotCostEst PUT:", err);
        return res.status(500).json({ error: err.message });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Quotation not found — save the header first." });
      }
      res.json({ ok: true });
    });
  });

  return router;
};
