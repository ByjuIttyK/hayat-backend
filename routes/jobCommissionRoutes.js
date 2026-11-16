// routes/jobCommissionRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Commission / sales incentives paid against a job — the Commission tab of
// Project Job Creation.
//
//   GET /api/job-commission/:jobNo            (all accounts in job_sales_incen_ac)
//   GET /api/job-commission/:jobNo?acc=...    (just one of those accounts)
//   GET /api/job-commission-accounts          (the accounts list itself)
//
// Accounts: only those listed in the job_sales_incen_ac table
//   (601-004-0-006 Staff Incentives, 620-001-0-006 Management Performance
//    Bonus, 622-005-0-001 Commission Paid — add or remove rows there, no code
//    change needed).
//
// Returns the tran_acc lines of those accounts that carry this job's JOB_NO,
// oldest first (DATTE, then voucher and line). Debit and Credit come back as
// separate columns (AMOUNT_DR / AMOUNT_CR) — they are NOT netted here.
//
// Register in HayatDb.js like the other job-card routes, e.g.
//   app.use("/api", authMiddleware, require("./routes/jobCommissionRoutes")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  // The commission / incentive accounts themselves, so the screen can list
  // every account (even one with no entries for the job).
  router.get("/job-commission-accounts", (req, res) => {
    connection.query(
      "SELECT acc_code AS ACC_CODE, acc_head AS ACC_HEAD FROM job_sales_incen_ac ORDER BY acc_code",
      (err, rows) => {
        if (err) {
          console.error("job-commission-accounts:", err);
          return res.status(500).json({ error: "Could not load commission accounts" });
        }
        res.json(rows);
      });
  });

  router.get("/job-commission/:jobNo", (req, res) => {
    const jobNo = String(req.params.jobNo || "").trim();
    const acc = String(req.query.acc || "").trim();   // optional: one account only
    if (!jobNo) return res.json([]);

    const sql = `
      SELECT t.ACC_CODE,
             a.ACC_HEAD,
             t.TRAN_TYPE,
             COALESCE(tt.TYPE_ABBR, t.TRAN_TYPE)        AS TYPE_ABBR,
             t.VCHR_NO, t.SR_NO,
             DATE_FORMAT(t.DATTE, '%d/%m/%Y')           AS DATTE,
             t.DB_CR,
             CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE 0 END AS AMOUNT_DR,
             CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE 0 END AS AMOUNT_CR,
             t.NARRATION1, t.NARRATION2, t.REF_NO
        FROM tran_acc t
        JOIN job_sales_incen_ac a ON a.acc_code = t.ACC_CODE
        LEFT JOIN tran_type tt    ON tt.TRAN_TYPE = t.TRAN_TYPE
       WHERE TRIM(t.JOB_NO) = ?
         ${acc ? "AND t.ACC_CODE = ?" : ""}
       ORDER BY t.DATTE, t.VCHR_NO, t.SR_NO`;

    const params = acc ? [jobNo, acc] : [jobNo];

    connection.query(sql, params, (err, rows) => {
      if (err) {
        console.error("job-commission:", err);
        return res.status(500).json({ error: "Could not load commission entries" });
      }
      res.json(rows);
    });
  });

  return router;
};
