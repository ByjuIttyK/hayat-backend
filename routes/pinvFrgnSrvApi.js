// routes/pinvFrgnSrvApi.js
// Foreign Purchase Entry (PinvFrgn.tsx) — load from an Overseas SRV.
//
//   GET /api/frgn-srv-lov?pjv=..     → overseas SRVs (srv_hdr.PUR_TYPE = 'O') not yet
//        booked in pur_frgn_hdr (except to voucher ?pjv itself)
//        SRV_NO, SRV_DATE (dd/mm/yyyy), SUP_CODE, SUP_NAME, CURR_CODE, INV_AMT_FC
//   GET /api/frgn-srv/:srvNo         → { hdr, items, exp } of one SRV
//        hdr   : srv_hdr + supplier name (dates as yyyy-mm-dd)
//        items : srv_items with item name, QTY, COST_FC
//        exp   : lcst_trn landed-cost lines (GIT_TYPE, AMOUNT)
//
// Register in HayatDb.js:
//   const pinvFrgnSrvApi = require("./routes/pinvFrgnSrvApi");
//   app.use("/api", pinvFrgnSrvApi(connection));
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  // ── LOV ───────────────────────────────────────────────────────────────────
  router.get("/frgn-srv-lov", async (req, res) => {
    // SRVs already booked to a (non-cancelled) foreign purchase are left out.
    // ?pjv=<current voucher> keeps that voucher's own SRV in the list (EDIT).
    const pjv = String(req.query.pjv || "").trim();
    try {
      const rows = await q(
        `SELECT h.SRV_NO,
                DATE_FORMAT(h.SRV_DATE, '%d/%m/%Y') AS SRV_DATE,
                h.SUP_CODE, s.SUP_NAME, h.CURR_CODE, h.INV_AMT_FC
           FROM srv_hdr h
      LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
          WHERE h.PUR_TYPE = 'O'
            AND NOT EXISTS (SELECT 1 FROM pur_frgn_hdr p
                             WHERE p.SRV_NO = h.SRV_NO
                               AND COALESCE(p.CAN_CEL, 'N') <> 'Y'
                               AND p.PJV_NO <> ?)
       ORDER BY h.SRV_NO DESC`,
        [pjv]
      );
      res.json(rows);
    } catch (err) {
      console.error("frgn-srv-lov:", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── One SRV: header, items, landed-cost expenses ──────────────────────────
  router.get("/frgn-srv/:srvNo", async (req, res) => {
    const srvNo = String(req.params.srvNo || "").trim();
    try {
      const hdr = await q(
        `SELECT h.SRV_NO,
                DATE_FORMAT(h.SRV_DATE, '%Y-%m-%d') AS SRV_DATE,
                h.PO_NO, h.SUP_CODE, s.SUP_NAME, h.NARRATION,
                h.INV_NO, DATE_FORMAT(h.INV_DATE, '%Y-%m-%d') AS INV_DATE,
                h.CURR_CODE, h.CONVERT_RATE, h.INV_AMT_FC, h.FREIGHT_FOB,
                h.INV_AMT_LOCAL, h.EXP_AMOUNT, h.EFF_RATE, h.PUR_TYPE
           FROM srv_hdr h
      LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
          WHERE h.SRV_NO = ?`,
        [srvNo]
      );
      if (!hdr.length) return res.status(404).json({ error: `SRV ${srvNo} not found` });

      const items = await q(
        `SELECT i.SR_NO, i.ITEM_CODE, m.ITEM_NAME1 AS ITEM_NAME, i.QTY, i.COST_FC, i.COST
           FROM srv_items i
      LEFT JOIN item_mst m ON m.ITEM_CODE = i.ITEM_CODE
          WHERE i.SRV_NO = ?
       ORDER BY CAST(i.SR_NO AS UNSIGNED)`,
        [srvNo]
      );

      const exp = await q(
        "SELECT GIT_TYPE, SUM(AMOUNT) AS AMOUNT FROM lcst_trn WHERE VCHR_NO = ? GROUP BY GIT_TYPE",
        [srvNo]
      );

      res.json({ hdr: hdr[0], items, exp });
    } catch (err) {
      console.error("frgn-srv:", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  return router;
};
