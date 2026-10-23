// ============================================================================
//  routes/stockRecalApi.js — Stock Recalculation
//  ---------------------------------------------------------------------------
//  Resets item_mst.CL_STOCK to   OP_STOCK + SUM(stock_trans.Qty)   per item.
//  stock_trans already carries Qty signed (+ inward, - outward), so a plain
//  SUM gives the net movement.
//
//  GET  /api/stock-recal/preview  → items whose CL_STOCK is wrong (no change)
//  POST /api/stock-recal/run      → updates those items in one transaction
//
//  The view is aggregated ONCE (GROUP BY Item_code) and joined to item_mst,
//  never queried per item, so the run stays one pass over stock_trans.
//
//  Register in HayatDb.js with the usual factory pattern:
//    app.use("/api", require("./routes/stockRecalApi")(connection));
// ============================================================================
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, p = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, p, (err, rows) => (err ? reject(err) : resolve(rows))));

  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, c) => (err ? reject(err) : resolve(c))));

  const cq = (c, sql, p = []) =>
    new Promise((resolve, reject) =>
      c.query(sql, p, (err, rows) => (err ? reject(err) : resolve(rows))));

  // Item description column — found once from item_mst so the name is not guessed
  let descCol;
  const resolveDesc = async () => {
    if (descCol !== undefined) return descCol;
    try {
      const cols = (await q("SHOW COLUMNS FROM item_mst")).map(r => String(r.Field));
      descCol =
        cols.find(c => /^(item_)?desc(ription)?$/i.test(c)) ||
        cols.find(c => /^item_name$/i.test(c)) ||
        cols.find(c => /desc|name/i.test(c)) || null;
    } catch {
      descCol = null;
    }
    return descCol;
  };

  // Net movement per item, one pass over the view
  const MOVES = `
    SELECT Item_code, SUM(IFNULL(Qty,0)) AS MOVE_QTY
      FROM stock_trans
     GROUP BY Item_code`;

  const NEW_CL = "ROUND(IFNULL(m.OP_STOCK,0) + IFNULL(s.MOVE_QTY,0), 3)";
  const OUT_BY = `ABS(${NEW_CL} - IFNULL(m.CL_STOCK,0)) >= 0.0005`;

  const diffSql = (desc) => `
    SELECT m.ITEM_CODE,
           ${desc ? `m.${desc}` : "''"}  AS ITEM_DESC,
           IFNULL(m.OP_STOCK,0)          AS OP_STOCK,
           IFNULL(s.MOVE_QTY,0)          AS MOVE_QTY,
           IFNULL(m.CL_STOCK,0)          AS OLD_CL_STOCK,
           ${NEW_CL}                     AS NEW_CL_STOCK
      FROM item_mst m
      LEFT JOIN (${MOVES}) s ON s.Item_code = m.ITEM_CODE
     WHERE ${OUT_BY}
     ORDER BY m.ITEM_CODE`;

  // Movements whose item code has no item_mst row — they can never be posted
  const ORPHAN_SQL = `
    SELECT s.Item_code AS ITEM_CODE, s.MOVE_QTY
      FROM (${MOVES}) s
      LEFT JOIN item_mst m ON m.ITEM_CODE = s.Item_code
     WHERE m.ITEM_CODE IS NULL
     ORDER BY s.Item_code`;

  const num = (v) => Number(v ?? 0) || 0;
  const shape = (r) => ({
    ITEM_CODE: r.ITEM_CODE,
    ITEM_DESC: r.ITEM_DESC ?? "",
    OP_STOCK: num(r.OP_STOCK),
    MOVE_QTY: num(r.MOVE_QTY),
    OLD_CL_STOCK: num(r.OLD_CL_STOCK),
    NEW_CL_STOCK: num(r.NEW_CL_STOCK),
  });

  // ── Preview — read only ─────────────────────────────────────────────────
  router.get("/stock-recal/preview", async (req, res) => {
    try {
      const desc = await resolveDesc();
      const [cnt] = await q("SELECT COUNT(*) AS N FROM item_mst");
      const rows = await q(diffSql(desc));
      const orphans = await q(ORPHAN_SQL);
      res.json({
        mode: "preview",
        totalItems: num(cnt?.N),
        rows: rows.map(shape),
        orphans: orphans.map(o => ({ ITEM_CODE: o.ITEM_CODE, MOVE_QTY: num(o.MOVE_QTY) })),
        updated: 0,
        ranAt: new Date().toISOString(),
      });
    } catch (err) {
      console.log("stock-recal preview failed:", err);
      res.status(500).json({ message: err.sqlMessage || err.message });
    }
  });

  // ── Run — update CL_STOCK in one transaction ─────────────────────────────
  router.post("/stock-recal/run", async (req, res) => {
    let c;
    try {
      const desc = await resolveDesc();
      c = await getConn();
      await cq(c, "START TRANSACTION");

      // What is about to change, read inside the same transaction
      const rows = await cq(c, diffSql(desc));

      // Only the items that are out are written
      const upd = await cq(c, `
        UPDATE item_mst m
          LEFT JOIN (${MOVES}) s ON s.Item_code = m.ITEM_CODE
           SET m.CL_STOCK = ${NEW_CL}
         WHERE ${OUT_BY}`);

      await cq(c, "COMMIT");

      const [cnt] = await q("SELECT COUNT(*) AS N FROM item_mst");
      const orphans = await q(ORPHAN_SQL);
      res.json({
        mode: "run",
        totalItems: num(cnt?.N),
        rows: rows.map(shape),
        orphans: orphans.map(o => ({ ITEM_CODE: o.ITEM_CODE, MOVE_QTY: num(o.MOVE_QTY) })),
        updated: num(upd?.affectedRows),
        ranAt: new Date().toISOString(),
      });
    } catch (err) {
      if (c) await cq(c, "ROLLBACK").catch(() => {});
      console.log("stock-recal run failed:", err);
      res.status(500).json({ message: err.sqlMessage || err.message });
    } finally {
      if (c) c.release();
    }
  });

  return router;
};
