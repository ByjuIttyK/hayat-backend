// routes/sivStock.js
// Stock in hand as on a date, for many items in one call.
//
//   POST /api/siv-stock
//   body: { asOn: "yyyy-MM-dd", items: ["MICR070039", ...], excludeDoc: "0000006416" | null }
//   →    { stock: { "MICR070039": 12.000, ... } }
//
// Stock = SUM(Qty) over the stock_trans view for every transaction dated on or
// before asOn. Qty in the view is expected to be signed (receipts +, issues -).
//
// excludeDoc leaves out that voucher's own "Store Issue" lines, so when an
// existing SIV is opened the figure is the stock that was available for the
// issue, not the stock left after it. Only the Store Issue type is excluded —
// other documents can share the same number.
//
// Register in HayatDb.js:
//   const sivStock = require("./routes/sivStock");
//   app.use("/api", sivStock(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  router.post("/siv-stock", async (req, res) => {
    try {
      const { asOn, items, excludeDoc } = req.body || {};

      if (!asOn || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOn))) {
        return res.status(400).json({ error: "asOn must be yyyy-MM-dd" });
      }
      const codes = Array.from(
        new Set((Array.isArray(items) ? items : []).map((c) => String(c || "").trim()).filter(Boolean))
      );
      if (codes.length === 0) return res.json({ stock: {} });

      const stock = {};
      codes.forEach((c) => { stock[c] = 0; });

      // Chunked so a 200-line voucher doesn't build one enormous IN list.
      const CHUNK = 300;
      for (let i = 0; i < codes.length; i += CHUNK) {
        const part = codes.slice(i, i + CHUNK);

        // Doc_date is a datetime: "< next day" takes in the whole of asOn
        // and still lets MySQL use an index on the date column.
        let sql = `
          SELECT Item_code AS ITEM_CODE, COALESCE(SUM(Qty), 0) AS STOCK
            FROM stock_trans
           WHERE Item_code IN (?)
             AND Doc_date < DATE_ADD(?, INTERVAL 1 DAY)`;
        const params = [part, asOn];

        if (excludeDoc) {
          sql += `
             AND NOT (Doc_no = ? AND Stock_tran_type = 'Store Issue')`;
          params.push(String(excludeDoc));
        }
        sql += `
           GROUP BY Item_code`;

        const rows = await query(sql, params);
        rows.forEach((r) => {
          stock[String(r.ITEM_CODE).trim()] = Number(r.STOCK) || 0;
        });
      }

      res.json({ stock });
    } catch (err) {
      console.error("siv-stock error:", err);
      res.status(500).json({ error: "Stock lookup failed" });
    }
  });

  return router;
};
