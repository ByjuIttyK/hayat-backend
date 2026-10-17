// ─────────────────────────────────────────────────────────────────────────
//  routes/gridNumericFieldsApi.js
//
//  GET /api/grid-numeric-fields
//    → [{ FIELD: "QTY", DEC_PLACES: 3, ALLOW_NEGATIVE: 0 }, …]
//
//  Feeds components/utils/ErpAgGrid.tsx, which treats every listed field as a
//  numeric column in every grid. Register in HayatDb.js:
//      app.use("/api", require("./routes/gridNumericFieldsApi")(connection));
// ─────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/grid-numeric-fields", (req, res) => {
    const sql =
      "SELECT FIELD, DEC_PLACES, ALLOW_NEGATIVE FROM grid_numeric_fields ORDER BY FIELD";
    connection.query(sql, (err, rows) => {
      if (err) {
        // The screens fall back to their built-in list, so this is not fatal —
        // but log it: a missing table in one database shows up here.
        console.error("grid-numeric-fields:", err.message);
        return res.status(500).json({ message: "Could not read grid_numeric_fields" });
      }
      res.json(rows);
    });
  });

  return router;
};
