// routes/jobPanelMatCost.js
//
// Material cost issued to each panel of a job, from Store Issue Vouchers.
//
//   GET /api/job-panel-matcost/:jobNo
//   resp: [ { PANEL_NO: "001", MAT_COST: 12345.67 }, ... ]
//
// Same formula as the query used at the mysql prompt:
//   SUM(siv_items.QTY * AVGCOST('01', siv_items.ITEM_CODE, siv_hdr.SIV_DATE))
// with JOB_NO / PANEL_NO taken from siv_hdr, grouped by panel. AVGCOST is the
// existing stored function (location '01', average cost as on the issue date).
//
// Consumables issues (no PANEL_NO) are left out — they belong to the job, not
// to a panel, so they have no row on the panel grid to land in.
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/jobPanelMatCost")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const pool = typeof connection.promise === "function" ? connection.promise() : connection;

  router.get("/job-panel-matcost/:jobNo", async (req, res) => {
    const jobNo = String(req.params.jobNo ?? "").trim();
    if (!jobNo) return res.json([]);
    try {
      const [rows] = await pool.query(
        `SELECT TRIM(b.PANEL_NO) AS PANEL_NO,
                ROUND(SUM(a.QTY * AVGCOST('01', a.ITEM_CODE, b.SIV_DATE)), 2) AS MAT_COST
           FROM siv_items AS a
           JOIN siv_hdr   AS b ON a.SIV_NO = b.SIV_NO
          WHERE b.JOB_NO = ?
            AND b.PANEL_NO IS NOT NULL AND TRIM(b.PANEL_NO) <> ''
          GROUP BY TRIM(b.PANEL_NO)`,
        [jobNo]
      );
      res.json(rows.map((r) => ({ PANEL_NO: r.PANEL_NO, MAT_COST: Number(r.MAT_COST) || 0 })));
    } catch (err) {
      console.error("job-panel-matcost:", err);
      res.status(500).json({ message: err.sqlMessage || err.message || "Lookup failed" });
    }
  });

  return router;
};
