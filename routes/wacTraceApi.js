// routes/wacTraceApi.js — explains how the Weighted Average Cost (WAC) of an item was arrived at.
//
// GET /api/wacTrace/:loc/:item/:dt      (dt = yyyy-MM-dd)
//   → {
//       loc, item, date,
//       opening: { opStock, costPrice, wac },           // starting point taken from item_mst
//       steps:   [ { docNo, docDate, type, qty, rate,   // every stock_trans movement up to dt
//                    stockBefore, stockAfter, wacBefore, wacAfter,
//                    changesWac, calc } ],              // calc = the formula used on an S.R.V
//       wac,                                            // result of this step-by-step replay
//       fnWac                                           // result of the real avgcost() function
//     }
//
// The replay follows avgcost() line for line: opening = op_stock × cost_price from item_mst;
// only S.R.V rows move the average —  (stock before × WAC + SRV qty × SRV cost) ÷ (stock before + SRV qty),
// with negative stock taken as nil; every other document changes the quantity only.
// fnWac is returned alongside so any difference between the two is visible on screen.
//
// Register in HayatDb.js:
//   const wacTraceApi = require("./routes/wacTraceApi");
//   app.use("/api", wacTraceApi(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;   // mysql2 pool → promise API

  const n = (v) => (v == null || v === "" ? 0 : Number(v) || 0);
  const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  const f2 = (v) => r2(v).toFixed(2);

  router.get("/wacTrace/:loc/:item/:dt", async (req, res) => {
    const { loc, item, dt } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return res.status(400).json({ error: "Date must be yyyy-MM-dd" });

    try {
      // 1. opening position — same SELECT as avgcost()
      const [imRows] = await db.query(
        `SELECT IFNULL(op_stock,0) AS OP_STOCK, cost_price AS COST_PRICE
           FROM item_mst
          WHERE loc_code = ? AND item_code = ?
          LIMIT 1`,
        [loc, item]
      );
      const opStock = imRows.length ? n(imRows[0].OP_STOCK) : 0;
      const costPrice = imRows.length && imRows[0].COST_PRICE != null ? Number(imRows[0].COST_PRICE) : null;

      let stock = opStock;
      let wac = opStock + stock > 0 ? (opStock * n(costPrice)) / opStock : costPrice;   // as in avgcost()
      const opening = { opStock, costPrice, wac: wac == null ? null : r2(wac) };

      // 2. movements — same filter as avgcost(); sort_ord/doc_no only settle same-day order
      const [tr] = await db.query(
        `SELECT doc_no AS DOC_NO,
                DATE_FORMAT(doc_date, '%d/%m/%Y') AS DOC_DATE,
                stock_tran_type AS TYPE,
                qty AS QTY,
                std_cost AS RATE
           FROM stock_trans
          WHERE loc_code = ? AND item_code = ? AND doc_date <= ?
          ORDER BY stock_trans.doc_date, stock_trans.sort_ord, stock_trans.doc_no`,
        // ORDER BY must name the table columns: a bare "doc_date" would match the
        // formatted DOC_DATE alias above and sort dd/mm/yyyy text instead of real dates
        [loc, item, dt]
      );

      const steps = tr.map((r) => {
        const type = String(r.TYPE || "");
        const qty = n(r.QTY);
        const rate = r.RATE == null ? null : Number(r.RATE);
        const stockBefore = stock;
        const wacBefore = wac;
        let changesWac = false;
        let calc = "";

        if (type.toUpperCase() === "S.R.V") {
          changesWac = true;
          const mstock = stockBefore > 0 ? stockBefore : 0;          // negative stock taken as nil
          const opval = mstock * n(wacBefore);
          const puramt = qty * n(rate);
          if (qty + mstock > 0) {
            wac = (puramt + opval) / (qty + mstock);
            calc = `(${f2(mstock)} × ${f2(n(wacBefore))} + ${f2(qty)} × ${f2(n(rate))}) ÷ (${f2(mstock)} + ${f2(qty)}) = ${f2(wac)}`;
          } else {
            wac = 0;
            calc = "Stock + receipt qty is nil → WAC set to 0";
          }
          if (stockBefore < 0) calc += `   [stock before was ${f2(stockBefore)}, taken as nil]`;
        }

        stock = stockBefore + qty;
        return {
          docNo: r.DOC_NO,
          docDate: r.DOC_DATE,
          type,
          qty: r2(qty),
          rate: rate == null ? null : r2(rate),
          stockBefore: r2(stockBefore),
          stockAfter: r2(stock),
          wacBefore: wacBefore == null ? null : r2(wacBefore),
          wacAfter: wac == null ? null : r2(wac),
          changesWac,
          calc,
        };
      });

      // 3. the real function, for cross-checking the replay
      let fnWac = null;
      try {
        const [fr] = await db.query("SELECT avgcost(?, ?, ?) AS WAC", [loc, item, dt]);
        fnWac = fr.length && fr[0].WAC != null ? Number(fr[0].WAC) : null;
      } catch (e) {
        console.error("wacTrace avgcost():", e.message);
      }

      res.json({ loc, item, date: dt, opening, steps, wac: wac == null ? null : r2(wac), fnWac });
    } catch (err) {
      console.error("wacTrace:", err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return router;
};
