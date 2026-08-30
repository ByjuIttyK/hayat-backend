// routes/jobExpLinkRoutes.js
// Handles:
//   POST /api/save-job-exp-link       — delete + bulk insert job_expenses_link
//   PUT  /api/update-job-revenue-ac   — update REVENUE_AC on job_card
//
// Register in HayatDb.js:
//   const jobExpLinkRoutes = require('./routes/jobExpLinkRoutes');
//   app.use("/api", jobExpLinkRoutes(connection));

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/save-job-exp-link
  // Body: { jobNo: string, rows: [{ JOB_NO, EXP_CODE, ACC_CODE, COST_AC }] }
  //
  // Deletes all existing rows for the job, then bulk-inserts the new set.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/save-job-exp-link', (req, res) => {
    const { jobNo, rows } = req.body;

    if (!jobNo || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'jobNo and rows[] are required' });
    }

    const deleteSql = `DELETE FROM job_expenses_link WHERE JOB_NO = ?`;

    connection.query(deleteSql, [jobNo], (delErr) => {
      if (delErr) {
        console.error('Error deleting job_expenses_link:', delErr);
        return res.status(500).json({ error: 'Delete failed', detail: delErr.message });
      }

      const insertSql = `
        INSERT INTO job_expenses_link (JOB_NO, EXP_CODE, ACC_CODE, COST_AC)
        VALUES ?
      `;

      const values = rows.map((r) => [
        r.JOB_NO   || jobNo,
        r.EXP_CODE || '',
        r.ACC_CODE || '',
        r.COST_AC  || '',   // dummy field — always ''
      ]);

      connection.query(insertSql, [values], (insErr, result) => {
        if (insErr) {
          console.error('Error inserting job_expenses_link:', insErr);
          return res.status(500).json({ error: 'Insert failed', detail: insErr.message });
        }
        res.json({ message: 'job_expenses_link saved', affectedRows: result.affectedRows });
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /api/update-job-revenue-ac
  // Body: { jobNo: string, revenueAc: string }
  //
  // Updates the REVENUE_AC column on job_card for the given job.
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/update-job-revenue-ac', (req, res) => {
    const { jobNo, revenueAc } = req.body;

    if (!jobNo || !revenueAc) {
      return res.status(400).json({ error: 'jobNo and revenueAc are required' });
    }

    const sql = `UPDATE job_card SET REVENUE_AC = ? WHERE JOB_NO = ?`;

    connection.query(sql, [revenueAc, jobNo], (err, result) => {
      if (err) {
        console.error('Error updating REVENUE_AC:', err);
        return res.status(500).json({ error: 'Database error', detail: err.message });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: `No job_card found for JOB_NO = ${jobNo}` });
      }
      res.json({ message: 'REVENUE_AC updated', jobNo, revenueAc });
    });
  });

  return router;
};
