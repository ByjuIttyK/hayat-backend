// routes/jobVariations.js
//
// Save the variations of one job from JobVariationsGrid.
//
//   POST /api/save-job-variations
//   body: { jobNo: "3635",
//           rows: [ { VAR_DATE: "2026-10-09", VAR_DESC: "...", AMOUNT: 2835 }, ... ] }
//
// The grid always sends the job's COMPLETE list, so the save replaces the
// job's rows in job_variations: DELETE then INSERT, inside one transaction —
// a failure halfway leaves the old variations untouched, never half a list.
//
// /api/job-contract-value/:jobNo sums job_variations.AMOUNT into Contract Amt.,
// so once rows are saved here the invoice screen's Contract Amt. and
// Bal.To Invoice pick them up automatically.
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/jobVariations")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  // mysql2 pool → promise API for the transaction.
  const pool = typeof connection.promise === "function" ? connection.promise() : connection;

  router.post("/save-job-variations", async (req, res) => {
    const jobNo = String(req.body?.jobNo ?? "").trim();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!jobNo) return res.status(400).json({ message: "Job No is required" });

    // Validate before touching the table.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.VAR_DATE ?? ""))) {
        return res.status(400).json({ message: `Line ${i + 1}: invalid Variation Date` });
      }
      if (!Number.isFinite(Number(r.AMOUNT))) {
        return res.status(400).json({ message: `Line ${i + 1}: invalid Amount` });
      }
    }

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      await conn.query("DELETE FROM job_variations WHERE JOB_NO = ?", [jobNo]);

      if (rows.length > 0) {
        // job_variations: JOB_NO varchar(10), AMOUNT decimal(12,2),
        // VAR_DESC varchar(100), VAR_DATE datetime, MAIN_SR_NO decimal(4,0).
        // No key and no auto-increment column, so MAIN_SR_NO is written here
        // as the line's serial (1, 2, 3 ... in grid order). VAR_DESC is cut at
        // 100 so a long description can't fail the whole save.
        const values = rows.map((r, i) => [
          jobNo,
          i + 1,
          r.VAR_DATE,
          String(r.VAR_DESC ?? "").trim().slice(0, 100) || null,
          Number(r.AMOUNT) || 0,
        ]);
        await conn.query(
          "INSERT INTO job_variations (JOB_NO, MAIN_SR_NO, VAR_DATE, VAR_DESC, AMOUNT) VALUES ?",
          [values]
        );
      }

      await conn.commit();
      res.json({ message: `Saved ${rows.length} variation(s) for job ${jobNo}`, count: rows.length });
    } catch (err) {
      if (conn) { try { await conn.rollback(); } catch (_) { /* ignore */ } }
      console.error("save-job-variations:", err);
      res.status(500).json({ message: err.sqlMessage || err.message || "Save failed" });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
