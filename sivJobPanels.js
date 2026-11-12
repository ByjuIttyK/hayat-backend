// sivJobPanels.js — GET /api/sivJobPanels/:jobNo
// Panels drawn for a job, for the SIV Panel No drop-down (SivPanelPick.tsx).
//
//   drawing_register d (JOB_NO = :jobNo)
//     └─ drawing_reg_panel p (p.HDR_ROW_ID = d.srno_row_id)
//
// PANEL_NO   = p.SR_NO
// PANEL_DESC = p.PANEL_DETAILS, else the drawing's PANEL_REF
// DRAWING_NO = p.DRAWING_NO (blank when the panel has no number yet)
//
// Register it in the server file, next to the other routes, with the same
// `app` and DB connection/pool the other routes use:
//
//   require("./sivJobPanels")(app, db);
//
// Works with mysql2/promise (pool.query returns a promise) and with the
// callback style mysql / mysql2 (db.query(sql, params, cb)).
// Restart the Node server afterwards — a 404 means it is not registered yet.

const SQL = `
  SELECT CAST(p.SR_NO AS CHAR)                                     AS PANEL_NO,
         COALESCE(NULLIF(TRIM(p.PANEL_DETAILS), ''), d.PANEL_REF) AS PANEL_DESC,
         COALESCE(TRIM(p.DRAWING_NO), '')                         AS DRAWING_NO,
         d.DRAWING_NO                                             AS SET_NO,
         d.srno_row_id                                            AS HDR_ROW_ID
    FROM drawing_register d
    JOIN drawing_reg_panel p ON p.HDR_ROW_ID = d.srno_row_id
   WHERE TRIM(d.JOB_NO) = TRIM(?)
   ORDER BY p.SR_NO, d.DRAW_DATE, d.srno_row_id`;

function runQuery(db, sql, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, rows) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(rows);
    };
    const ret = db.query(sql, params, (err, rows) => done(err, rows));
    // mysql2/promise ignores the callback and returns a promise of [rows, fields]
    if (ret && typeof ret.then === "function") {
      ret.then((r) => done(null, Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r), (e) => done(e));
    }
  });
}

module.exports = function registerSivJobPanels(app, db) {
  app.get("/api/sivJobPanels/:jobNo", async (req, res) => {
    const jobNo = String(req.params.jobNo || "").trim();
    if (!jobNo) return res.json([]);
    try {
      const rows = await runQuery(db, SQL, [jobNo]);
      res.json(rows || []);
    } catch (err) {
      console.error("sivJobPanels:", err);
      res.status(500).json({ message: "Could not read the job's panels" });
    }
  });
};
