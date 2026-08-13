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

  return router;
};