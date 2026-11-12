// routes/sivJobPanels.js — GET /api/sivJobPanels/:jobNo
// Panels drawn for a job, for the SIV Panel No drop-down (SivPanelPick.tsx).
//
//   drawing_register d (JOB_NO = :jobNo)
//     └─ drawing_reg_panel p (p.HDR_ROW_ID = d.srno_row_id)
//
// PANEL_NO   = p.SR_NO
// PANEL_DESC = p.PANEL_DETAILS, else the drawing's PANEL_REF
// DRAWING_NO = p.DRAWING_NO (blank when the panel has no number yet)
//
// Mount in HayatDb.js like the other routes — "/api" comes from app.use,
// the router itself only knows "/sivJobPanels/:jobNo":
//
//   app.use("/api", authMiddleware, require("./routes/sivJobPanels")(connection));
//
// Works with a callback-style connection (mysql / mysql2) and with a
// mysql2/promise pool.

const express = require("express");

// Panels come from job_panels (Panel No = SR_NO, description = PANEL_REF).
// Drawing numbers are a LEFT OUTER JOIN from the Drawing Register of the same
// job, matched on the panel serial (job_panels.SR_NO '0001' =
// drawing_reg_panel.SR_NO 1, compared as numbers). Several drawings for one
// panel are listed together, so each job panel appears once.
const SQL = `
  SELECT TRIM(jp.SR_NO)                 AS PANEL_NO,
         jp.PANEL_REF                   AS PANEL_DESC,
         COALESCE(dw.DRAWING_NO, '')    AS DRAWING_NO
    FROM job_panels jp
    LEFT OUTER JOIN (
          SELECT CAST(p.SR_NO AS UNSIGNED) AS PANEL_SR,
                 GROUP_CONCAT(DISTINCT TRIM(p.DRAWING_NO)
                              ORDER BY TRIM(p.DRAWING_NO) SEPARATOR ', ') AS DRAWING_NO
            FROM drawing_register d
            JOIN drawing_reg_panel p ON p.HDR_ROW_ID = d.srno_row_id
           WHERE TRIM(d.JOB_NO) = TRIM(?)
             AND COALESCE(TRIM(p.DRAWING_NO), '') <> ''
           GROUP BY CAST(p.SR_NO AS UNSIGNED)
         ) dw ON dw.PANEL_SR = CAST(jp.SR_NO AS UNSIGNED)
   WHERE TRIM(jp.JOB_NO) = TRIM(?)
   ORDER BY CAST(jp.SR_NO AS UNSIGNED), jp.SR_NO`;

// One query, whichever client style `connection` is
function runQuery(db, sql, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, rows) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(rows);
    };
    const ret = db.query(sql, params, (err, rows) => done(err, rows));
    // mysql2/promise ignores the callback and returns a real Promise of
    // [rows, fields]. A callback-style mysql2 Query also has a .then() that
    // throws on purpose, so only a genuine Promise is awaited.
    if (ret instanceof Promise) {
      ret.then((r) => done(null, Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r), (e) => done(e));
    }
  });
}

module.exports = function sivJobPanels(connection) {
  const router = express.Router();

  router.get("/sivJobPanels/:jobNo", async (req, res) => {
    const jobNo = String(req.params.jobNo || "").trim();
    if (!jobNo) return res.json([]);
    try {
      const rows = await runQuery(connection, SQL, [jobNo, jobNo]);
      res.json(rows || []);
    } catch (err) {
      console.error("sivJobPanels:", err);
      res.status(500).json({ message: "Could not read the job's panels" });
    }
  });

  return router;
};
