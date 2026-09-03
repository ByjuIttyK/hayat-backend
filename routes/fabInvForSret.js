// ─────────────────────────────────────────────────────────────
//  GET /api/fabinv-for-sret/:invNo
//  Feeds the "Get Data" button on the Sales Return Entry screen.
//  Returns { hdr, items } where items carry the still-returnable qty.
//
//  Register in HayatDb.js:
//      const fabInvForSret = require("./routes/fabInvForSret");
//      app.use("/api", fabInvForSret(connection));
//
//  ⚠ Table/column names below follow the usual pattern — adjust the
//    ones marked CHECK to match your actual FAB_INV_* definitions.
//    All table names are lowercase for the Linux VPS.
// ─────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const HDR_SQL = `
    SELECT
      h.INV_NO,
      DATE_FORMAT(h.INV_DATE, '%d/%m/%Y')            AS INV_DATE,
      h.JOB_NO,                                      -- CHECK
      j.PROJ_NAME AS JOB_NAME,                                    -- CHECK
      h.CUST_CODE,
      c.CUST_NAME,
      j.SMAN_CODE,
      s.SMAN_NAME,
      j.REVENUE_AC AS DR_CODE,                                     -- CHECK (may not exist)
      a.ACC_HEAD                                     -- CHECK
    FROM fab_inv_hdr h
    LEFT JOIN cus_mst  c ON c.CUST_CODE = h.CUST_CODE
     LEFT JOIN job_card  j ON j.JOB_NO    = h.JOB_NO
    LEFT JOIN sman_mst s ON s.SMAN_CODE = j.SMAN_CODE
    LEFT JOIN acc_mst  a ON a.ACC_CODE  = j.REVENUE_AC
    WHERE h.INV_NO = ?
    LIMIT 1
  `;

  // Balance qty = invoiced qty  −  qty already returned against this invoice
  const DTL_SQL = `
    SELECT
      d.SR_NO,
      d.PANEL_NO AS ITEM_CODE,
      d.INV_ITEM_DESC AS ITEM_DES1,
      d.INV_UNIT,
      d.INV_QTY AS QTY,
      d.INV_RATE,
      d.VAT_PERC,
      IFNULL(r.RET_QTY, 0)                AS RET_QTY,
      (d.INV_QTY - IFNULL(r.RET_QTY, 0))      AS BAL_QTY
    FROM fab_inv_dtl d
    LEFT JOIN (
      SELECT sd.ITEM_CODE, SUM(sd.QTY) AS RET_QTY
      FROM sret_items sd
      JOIN sret_hdr sh ON sh.SRET_NO = sd.SRET_NO
      WHERE sh.INV_NO = ?
      GROUP BY sd.ITEM_CODE
    ) r ON r.ITEM_CODE = d.PANEL_NO
    WHERE d.INV_NO = ?
    ORDER BY d.SR_NO
  `;

  router.get("/fabinv-for-sret/:invNo", (req, res) => {
    const invNo = req.params.invNo;

    connection.getConnection((connErr, conn) => {
      if (connErr) {
        console.error("fabinv-for-sret pool error:", connErr);
        return res.status(500).json({ message: "DB connection error" });
      }

      conn.query(HDR_SQL, [invNo], (hdrErr, hdrRows) => {
        if (hdrErr) {
          conn.release();
          console.error("fabinv-for-sret header error:", hdrErr);
          return res.status(500).json({ message: "Error reading invoice header" });
        }

        if (!hdrRows || hdrRows.length === 0) {
          conn.release();
          return res.json({ hdr: null, items: [] });
        }

        conn.query(DTL_SQL, [invNo, invNo], (dtlErr, dtlRows) => {
          conn.release();
          if (dtlErr) {
            console.error("fabinv-for-sret detail error:", dtlErr);
            return res.status(500).json({ message: "Error reading invoice lines" });
          }

          // Drop fully-returned lines. Remove this filter if you would
          // rather show every line and let the user see zero balances.
          const items = (dtlRows || []).filter(r => Number(r.BAL_QTY) > 0);

          res.json({ hdr: hdrRows[0], items });
        });
      });
    });
  });

  return router;
};
