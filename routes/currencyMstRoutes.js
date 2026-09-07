// ---------------------------------------------------------------------------
// currencyMstRoutes.js — mounted at /api/currencymst
//
// Currencies live in nation_mst: CUR_CODE ('01'), CUR_NAME ('AED') and
// DHS_CONV_RATE. Just over half the rows are countries with no currency of
// their own and carry a NULL CUR_CODE — those are filtered out everywhere here,
// or they would show up as blank entries in the PvEnt currency dropdown.
//
// Mount in the main server file alongside the other routes:
//   app.use("/api/currencymst", require("./routes/currencyMstRoutes")(connection));
//
// If a currencymst route already exists, take the router.get("/") handler
// below and paste it into that file instead of mounting this one, so the two
// don't both claim the same path.
// ---------------------------------------------------------------------------

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  const COLS = `CUR_CODE, CUR_NAME, DHS_CONV_RATE`;

  // -------------------------------------------------------------------------
  // GET /api/currencymst
  // Every selectable currency, for the PvEnt dropdown. Ordered by code so the
  // list reads the same way every time.
  // -------------------------------------------------------------------------
  router.get("/", async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ${COLS}
           FROM nation_mst
          WHERE CUR_CODE IS NOT NULL AND TRIM(CUR_CODE) <> ''
          ORDER BY CUR_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error("[currencymst/list]", err.message);
      res.status(500).json({ message: "Error reading the currency master" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/currencymst/:code
  // Single currency. The key may be a CUR_CODE ('01') or a CUR_NAME ('US$') —
  // vouchers in the live data hold both forms — so either column can match.
  // Returns an array so existing callers reading res.data[0] keep working.
  // -------------------------------------------------------------------------
  router.get("/:code", async (req, res) => {
    const key = (req.params.code || "").trim();
    if (!key) return res.json([]);

    try {
      const [rows] = await db.query(
        `SELECT ${COLS}
           FROM nation_mst
          WHERE CUR_CODE = ? OR CUR_NAME = ?
          LIMIT 1`,
        [key, key]
      );
      res.json(rows);
    } catch (err) {
      console.error("[currencymst/one]", err.message);
      res.status(500).json({ message: "Error reading the currency master" });
    }
  });

  return router;
};
