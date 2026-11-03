// routes/jobCommissionRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Commission paid against a job — the Commission tab of Project Job Creation.
//
//   GET /api/job-commission/:jobNo            (default A/c 622-005-0-001)
//   GET /api/job-commission/:jobNo?acc=...    (another commission account)
//
// Returns the tran_acc lines of the commission account that carry this job's
// JOB_NO, oldest first (DATTE, then voucher and line). Debit = paid, Credit =
// reversed / recovered; the screen nets the two.
//
// Register in HayatDb.js like the other job-card routes, e.g.
//   app.use("/api", authMiddleware, require("./routes/jobCommissionRoutes")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

const COMMISSION_ACC = "622-005-0-001";   // Commission Paid A/c

module.exports = function (connection) {
  const router = express.Router();

  router.get("/job-commission/:jobNo", (req, res) => {
    const jobNo = String(req.params.jobNo || "").trim();
    const acc = String(req.query.acc || COMMISSION_ACC).trim();
    if (!jobNo) return res.json([]);

    const sql = `
      SELECT t.TRAN_TYPE,
             COALESCE(tt.TYPE_ABBR, t.TRAN_TYPE)        AS TYPE_ABBR,
             t.VCHR_NO, t.SR_NO,
             DATE_FORMAT(t.DATTE, '%d/%m/%Y')           AS DATTE,
             t.DB_CR,
             CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE 0 END AS AMOUNT_DR,
             CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE 0 END AS AMOUNT_CR,
             t.NARRATION1, t.NARRATION2, t.REF_NO
        FROM tran_acc t
        LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
       WHERE t.ACC_CODE = ?
         AND TRIM(t.JOB_NO) = ?
       ORDER BY t.DATTE, t.VCHR_NO, t.SR_NO`;

    connection.query(sql, [acc, jobNo], (err, rows) => {
      if (err) {
        console.error("job-commission:", err);
        return res.status(500).json({ error: "Could not load commission entries" });
      }
      res.json(rows);
    });
  });

  return router;
};
