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

    sql += " ORDER BY ITEM_CODE LIMIT 300";

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
