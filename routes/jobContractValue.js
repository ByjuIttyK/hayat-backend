// routes/jobContractValue.js
// GET /api/job-contract-value/:jobNo
//
// Contract value of a manufacturing job as shown on the Fabrication Invoice:
//   CONTRACT_AMT + (CONTRACT_AMT * VAT_PERC / 100) + SUM(job_variations.AMOUNT)
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/jobContractValue")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/job-contract-value/:jobNo", (req, res) => {
    const jobNo = String(req.params.jobNo || "").trim();
    if (!jobNo) return res.status(400).json({ message: "Job No required" });

    // Table names lowercase — the VPS runs lower_case_table_names=0.
    const sql = `
      SELECT jc.JOB_NO,
             IFNULL(jc.CONTRACT_AMT, 0) AS CONTRACT_AMT,
             IFNULL(jc.VAT_PERC, 0)     AS VAT_PERC,
             (SELECT IFNULL(SUM(v.AMOUNT), 0)
                FROM job_variations v
               WHERE v.JOB_NO = jc.JOB_NO) AS VAR_AMT
        FROM job_card jc
       WHERE jc.JOB_NO = ?`;

    connection.query(sql, [jobNo], (err, rows) => {
      if (err) {
        console.error("job-contract-value:", err);
        return res.status(500).json({ message: err.message });
      }
      if (!rows || rows.length === 0) {
        return res.json({ JOB_NO: jobNo, found: false, CONTRACT_AMT: 0, VAT_PERC: 0, VAT_AMT: 0, VAR_AMT: 0, CONTRACT_TOTAL: 0 });
      }
      const r = rows[0];
      const amt = Number(r.CONTRACT_AMT) || 0;
      const vatPerc = Number(r.VAT_PERC) || 0;
      const varAmt = Number(r.VAR_AMT) || 0;
      const vatAmt = Math.round(amt * vatPerc) / 100;           // amt * perc / 100, to 2 dp
      const total = Math.round((amt + vatAmt + varAmt) * 100) / 100;

      res.json({
        JOB_NO: r.JOB_NO,
        found: true,
        CONTRACT_AMT: amt,
        VAT_PERC: vatPerc,
        VAT_AMT: vatAmt,
        VAR_AMT: varAmt,
        CONTRACT_TOTAL: total,
      });
    });
  });

  return router;
};
