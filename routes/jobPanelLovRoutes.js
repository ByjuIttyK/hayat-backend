// ============================================================================
// File: routes/jobPanelLovRoutes.js
//
// Mount in HayatDb.js:
//     const jobPanelLovRoutes = require("./routes/jobPanelLovRoutes")(connection);
//     app.use("/api", jobPanelLovRoutes);
//
// Feeds the Job No / Panel No dropdowns in the PinvNonStock items grid.
//
//   GET /api/joblov/jobs           → [{ code, label, extra }]
//   GET /api/joblov/panels/:jobNo  → [{ code, label }]
//
// Paths sit under /joblov, NOT /lov — lovRoutes.js already owns /lov/:lovHdr
// and, being mounted first, would swallow /lov/jobs and answer 404.
//
// `code` / `label` / `extra` become the three columns of the dropdown, and
// the client-side filter searches all three.
// ============================================================================

module.exports = function (connection) {
  const express = require('express');
  const router  = express.Router();
  const db      = connection.promise();

  // ── All jobs: number, project, customer ──────────────────────────────────
  // LEFT JOIN, not inner: a job with a missing or unmatched CUST_CODE must
  // still appear in the list rather than vanishing from the dropdown.
  router.get('/joblov/jobs', async (_req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT TRIM(j.JOB_NO)                   AS code,
               TRIM(COALESCE(j.PROJ_NAME, ''))  AS label,
               TRIM(COALESCE(c.CUST_NAME, ''))  AS extra
        FROM   job_card j
        LEFT   JOIN cus_mst c ON TRIM(c.CUST_CODE) = TRIM(j.CUST_CODE)
        ORDER  BY j.JOB_NO DESC
      `);
      res.json(rows);
    } catch (err) {
      console.error('joblov/jobs error:', err);
      res.status(500).json({ message: 'Failed to load jobs', error: err.message });
    }
  });

  // ── Panels of one job ────────────────────────────────────────────────────
  // job_panels is keyed (JOB_NO, SR_NO). SR_NO varchar(4) is what the grid
  // stores in PANEL_NO — it matches the 4-digit values ("0003", "0004")
  // already in existing rows. PANEL_REF is the description.
  router.get('/joblov/panels/:jobNo', async (req, res) => {
    const jobNo = (req.params.jobNo || '').trim();
    if (!jobNo) return res.json([]);   // no job chosen — empty list, not an error

    try {
      const [rows] = await db.query(`
        SELECT TRIM(SR_NO)                   AS code,
               TRIM(COALESCE(PANEL_REF, '')) AS label,
               COALESCE(QTY, 0)              AS extra
        FROM   job_panels
        WHERE  TRIM(JOB_NO) = ?
        ORDER  BY SR_NO
      `, [jobNo]);
      res.json(rows);
    } catch (err) {
      console.error('joblov/panels error:', err);
      res.status(500).json({ message: 'Failed to load panels', error: err.message });
    }
  });

  return router;
};
