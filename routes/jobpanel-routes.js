// ---------------------------------------------------------------------------
// /api/jobpanel/:jobNo/:ssrNo — panel validation for FabInvoice.tsx.
//
// Paste into HayatDb.js alongside /api/joblist.
//
// The screen used to validate the Panel No column against /api/items/:code —
// ITEM_MST — which is the wrong master: it accepted any stock item code and
// rejected legitimate panels. A panel only exists in the context of a job, so
// it is looked up by JOB_NO + SSR_NO.
//
// SELECT * is deliberate here: the description column on job_panels differs by
// vintage (PANEL_REF / PANEL_DESC / PANEL_NAME / DESCRIPTION), and the frontend
// probes the row for whichever is present and logs the key names it found. Once
// you confirm the real column with `DESC job_panels;`, narrow this to an
// explicit column list and simplify pickPanelDesc() in the screen.
// ---------------------------------------------------------------------------

app.get("/api/jobpanel/:jobNo/:ssrNo", function (req, res) {
  const { jobNo, ssrNo } = req.params;
  // TRIM on both sides: job/panel codes in the migrated Oracle data are often
  // space-padded CHAR columns, so a plain = comparison misses.
  const sql = `
    SELECT *
      FROM job_panels
     WHERE TRIM(JOB_NO) = TRIM(?)
       AND TRIM(SSR_NO) = TRIM(?)
     LIMIT 1
  `;
  connection.query(sql, [jobNo, ssrNo], function (err, rows) {
    if (err) {
      console.error("jobpanel lookup failed:", err.message);
      return res.status(500).json({ message: err.message });
    }
    if (!rows || rows.length === 0) {
      // 200 with found:false, NOT 404. The screen has to distinguish "this
      // panel isn't on this job" (clear the cell) from "this route isn't
      // deployed" (keep what the user typed) — and a missing Express route
      // also answers 404, so the status alone can't carry that difference.
      return res.json({ found: false, JOB_NO: jobNo, SSR_NO: ssrNo });
    }
    res.json({ found: true, ...rows[0] });
  });
});

// ---------------------------------------------------------------------------
// Panels LOV, scoped to a job.
//
// The screen now passes dataFilter={formik.values.JobNo} to the PANELS
// ModalLov. Whether that reaches the database depends on how your PANELS row in
// column_metadata_lov is written — if its query has no placeholder for the
// filter, the value is accepted and ignored, and the list still shows every
// panel of every job. Check with:
//
//   SELECT * FROM column_metadata_lov WHERE LOV_HDR = 'PANELS';
//
// The query there needs a bind spot for the filter, e.g.
//
//   SELECT SSR_NO AS code, PANEL_REF AS label
//     FROM job_panels
//    WHERE TRIM(JOB_NO) = TRIM(?)
//    ORDER BY SSR_NO
//
// If your metadata-driven LOV can't take a parameter, this standalone route is
// the fallback — point ModalLov at it for PANELS specifically:
// ---------------------------------------------------------------------------

app.get("/api/panels/:jobNo", function (req, res) {
  const sql = `
    SELECT *
      FROM job_panels
     WHERE TRIM(JOB_NO) = TRIM(?)
     ORDER BY SSR_NO
  `;
  connection.query(sql, [req.params.jobNo], function (err, rows) {
    if (err) {
      console.error("panels lov failed:", err.message);
      return res.status(500).json({ message: err.message });
    }
    res.json(rows || []);
  });
});
