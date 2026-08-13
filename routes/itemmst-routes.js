// itemmst-routes.js
module.exports = function (connection) {
  const express = require('express');
  const router = express.Router();

  router.get('/api/itemmst-list', function (req, res) {
    let sql = "SELECT * FROM item_mst WHERE 1=1";
    const params = [];

    // Search box on ItemMst.tsx sends ?search=<term> — match it against
    // both Item Code and Item Name so typing either finds the row.
    const search = (req.query.search || "").trim();
    if (search) {
      sql += " AND (ITEM_CODE LIKE ? OR ITEM_NAME1 LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    // Cat.Code field on ItemMst.tsx (default "ABB", F9 LOV) — filters the
    // grid to the selected category. Exact match, not LIKE, since CAT_CODE
    // is a fixed code (e.g. "ABB"), not free text.
    const catCode = (req.query.catCode || "").trim();
    if (catCode) {
      sql += " AND CAT_CODE = ?";
      params.push(catCode);
    }

    sql += " ORDER BY ITEM_CODE";

    connection.query(sql, params, function (err, results) {
      if (err) {
        console.error("itemmst-list error:", err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // ── Delete an item ────────────────────────────────────────────────────
  // item_mst's real PK is (LOC_CODE, ITEM_CODE) — both are required to
  // identify a unique row. Called immediately by the trash icon on
  // ItemMst.tsx (not deferred to the Save button).
  router.delete('/api/delete-itemmst/:locCode/:itemCode', function (req, res) {
    const { locCode, itemCode } = req.params;

    if (!locCode || !itemCode) {
      return res.status(400).json({ error: "locCode and itemCode are required" });
    }

    const sql = "DELETE FROM item_mst WHERE LOC_CODE = ? AND ITEM_CODE = ?";
    connection.query(sql, [locCode, itemCode], function (err, result) {
      if (err) {
        console.error("delete-itemmst error:", err);
        return res.status(500).json({ error: err.message });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Item not found" });
      }
      res.json({ message: "Item deleted successfully" });
    });
  });

  return router;
};
