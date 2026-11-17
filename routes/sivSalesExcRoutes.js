// routes/sivSalesExcRoutes.js
// Exception Centre — "Panel SIV value below % of sales".
//
// For every job panel (job_panels.SR_NO) that has been invoiced.
// Panel No on invoices / SIVs is matched to LPAD(job_panels.SR_NO, 4, '0'):
//   Sales value = Σ fab_inv_dtl.INV_QTY × INV_RATE for that job + panel (cancelled invoices excluded)
//   SIV value   = Σ siv_items.QTY × siv_items.STD_COST for SIVs issued to that job + panel
// Reports the panels whose SIV value is below <pct>% of the sales value,
// ordered by Job No, then Panel No.
//
// GET /api/exception-centre/siv-vs-sales?pct=50
// Returns one check in the same shape as the /api/exception-centre checks,
// so the screen can list it with the others.
//
// Register in HayatDb.js:
//   const sivSalesExcRoutes = require("./routes/sivSalesExcRoutes");
//   app.use("/api", sivSalesExcRoutes(connection));

const express = require("express");

const MAX_ROWS = 1000;

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  router.get("/exception-centre/siv-vs-sales", async (req, res) => {
    let pct = Number(req.query.pct);
    if (!Number.isFinite(pct) || pct <= 0) pct = 50;
    if (pct > 1000) pct = 1000;

    const check = {
      key: "siv_vs_sales",
      area: "Manufacturing",
      title: `Panel SIV value below ${pct}% of sales`,
      description:
        `Job panels whose material issued (Σ SIV Qty × Std Cost) is less than ${pct}% ` +
        `of the amount invoiced (Σ Fab. Invoice Qty × Rate). Cancelled invoices excluded. Ordered by Job No.`,
      severity: "medium",
      pct,
      count: 0,
      capped: false,
      error: null,
      columns: [
        { field: "JOB_NO", header: "Job No", type: "text" },
        { field: "PANEL_NO", header: "Panel No", type: "text" },
        { field: "PANEL_REF", header: "Panel Desc", type: "text" },
        { field: "SALES_AMT", header: "Sales Value", type: "amount" },
        { field: "SIV_AMT", header: "SIV Value", type: "amount" },
        { field: "SIV_PCT", header: "SIV % of Sales", type: "qty" },
        { field: "SHORT_AMT", header: `Short of ${pct}%`, type: "amount" },
      ],
      rows: [],
    };

    // Each side is summed on its own first, so a panel with several invoice
    // lines and several SIV lines isn't multiplied by the join.
    const sql = `
      SELECT jp.JOB_NO,
             LPAD(jp.SR_NO, 4, '0')                     AS PANEL_NO,
             jp.PANEL_REF,
             s.SALES_AMT,
             COALESCE(v.SIV_AMT, 0)                     AS SIV_AMT,
             ROUND(COALESCE(v.SIV_AMT, 0) * 100 / s.SALES_AMT, 2) AS SIV_PCT,
             ROUND(s.SALES_AMT * ? / 100 - COALESCE(v.SIV_AMT, 0), 2) AS SHORT_AMT
        FROM job_panels jp
        JOIN (SELECT h.JOB_NO, TRIM(d.PANEL_NO) AS PANEL_NO,
                     SUM(COALESCE(d.INV_QTY, 0) * COALESCE(d.INV_RATE, 0)) AS SALES_AMT
                FROM fab_inv_dtl d
                JOIN fab_inv_hdr h ON h.INV_NO = d.INV_NO
               WHERE COALESCE(h.INV_CANCELLED, 'N') <> 'Y'
                 AND COALESCE(TRIM(d.PANEL_NO), '') <> ''
               GROUP BY h.JOB_NO, TRIM(d.PANEL_NO)) s
          ON s.JOB_NO = jp.JOB_NO AND s.PANEL_NO = LPAD(jp.SR_NO, 4, '0')
        LEFT JOIN (SELECT h.JOB_NO, TRIM(h.PANEL_NO) AS PANEL_NO, SUM(i.QTY * i.STD_COST) AS SIV_AMT
                     FROM siv_items i
                     JOIN siv_hdr h ON h.SIV_NO = i.SIV_NO
                    WHERE COALESCE(TRIM(h.PANEL_NO), '') <> ''
                    GROUP BY h.JOB_NO, TRIM(h.PANEL_NO)) v
          ON v.JOB_NO = jp.JOB_NO AND v.PANEL_NO = LPAD(jp.SR_NO, 4, '0')
       WHERE s.SALES_AMT > 0
         AND COALESCE(v.SIV_AMT, 0) < s.SALES_AMT * ? / 100
       ORDER BY jp.JOB_NO, jp.SR_NO`;

    try {
      const rows = await q(sql, [pct, pct]);
      check.count = rows.length;
      check.capped = rows.length > MAX_ROWS;
      check.rows = rows.slice(0, MAX_ROWS);
    } catch (err) {
      console.error("[siv-vs-sales]", err);
      check.error = err.sqlMessage || err.message || "Query failed";
    }
    res.json(check);
  });

  return router;
};
