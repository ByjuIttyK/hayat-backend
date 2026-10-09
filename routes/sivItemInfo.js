// routes/sivItemInfo.js
//
// Part No and stock in hand for the items on a Store Issue Voucher (SivEnt).
//
//   POST /api/siv-item-info
//   body: { items: ["ITEM001", "ITEM002", ...] }
//   resp: { info: { "ITEM001": { PART_NO: "AB-123", STOCK: 42 }, ... } }
//
//   PART_NO = item_mst.ARTICLE_CODE
//   STOCK   = SUM(QTY) FROM stock_trans WHERE ITEM_CODE = :item
//
// One request for the whole grid (two queries, both IN (...)), so opening a
// saved SIV with many lines costs two round trips, not two per line.
// Table names are lowercase for the Linux VPS.
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/sivItemInfo")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const pool = typeof connection.promise === "function" ? connection.promise() : connection;

  router.post("/siv-item-info", async (req, res) => {
    const items = Array.from(new Set(
      (Array.isArray(req.body?.items) ? req.body.items : [])
        .map((c) => String(c ?? "").trim())
        .filter(Boolean)
    ));
    if (items.length === 0) return res.json({ info: {} });

    try {
      const [[parts], [stock]] = await Promise.all([
        pool.query(
          "SELECT ITEM_CODE, ARTICLE_CODE FROM item_mst WHERE ITEM_CODE IN (?)",
          [items]
        ),
        pool.query(
          "SELECT ITEM_CODE, COALESCE(SUM(QTY), 0) AS STOCK FROM stock_trans WHERE ITEM_CODE IN (?) GROUP BY ITEM_CODE",
          [items]
        ),
      ]);

      const info = {};
      for (const code of items) info[code] = { PART_NO: null, STOCK: 0 };
      for (const p of parts) {
        const k = String(p.ITEM_CODE).trim();
        if (info[k]) info[k].PART_NO = p.ARTICLE_CODE ?? null;
      }
      for (const s of stock) {
        const k = String(s.ITEM_CODE).trim();
        if (info[k]) info[k].STOCK = Number(s.STOCK) || 0;
      }

      res.json({ info });
    } catch (err) {
      console.error("siv-item-info:", err);
      res.status(500).json({ message: err.sqlMessage || err.message || "Lookup failed" });
    }
  });

  return router;
};
