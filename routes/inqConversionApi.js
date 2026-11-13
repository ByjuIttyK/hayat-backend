// ---------------------------------------------------------------------------
// inqConversionApi.js
//
// Backend for InqConversion.tsx — "Inquiry Conversion Analysis" (MIS).
// Register in HayatDb.js:
//   app.use("/api", require("./routes/inqConversionApi")(connection));
//
// Endpoints:
//   GET /api/inq-conversion/period          -> current ac_period (default range)
//   GET /api/inq-conversion?from=&to=       -> one row per inquiry in the range
//                                              (from/to as YYYY-MM-DD, on INQ_DATE)
//
// All statistics (funnel, pie, monthly, customer, salesman, avg days) are
// worked out on the client from these rows — a year is only a few hundred
// inquiries, and it keeps every drill-down instant.
//
// An inquiry counts as WON when a job_card exists whose QUOT_REF is ANY quote
// of that inquiry (so a job on revision /02 still counts). The SALESINQ list
// only looks at MAX(QUOT_NO); this is deliberately wider.
//
// *** VERIFY BEFORE USE ***
//   job_card.JOB_DATE  — the job creation date column (used for "Avg days to
//                        job"). Change it below if yours is named differently.
//   quot_hdr.INQ_NO, job_card.QUOT_REF, sman_mst — as already used in
//                        salesInquiryRoutes.js.
// ---------------------------------------------------------------------------

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // -------------------------------------------------------------------------
  // GET /api/inq-conversion/period
  // -------------------------------------------------------------------------
  router.get("/inq-conversion/period", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT DATE_FORMAT(START_DATE,'%Y-%m-%d') AS START_DATE,
                DATE_FORMAT(END_DATE,'%Y-%m-%d')   AS END_DATE
           FROM ac_period LIMIT 1`
      );
      res.json(rows[0] || {});
    } catch (err) {
      console.error("[inq-conversion/period] failed:", err);
      res.status(500).json({ message: "Failed to fetch accounting period" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/inq-conversion?from=YYYY-MM-DD&to=YYYY-MM-DD
  // -------------------------------------------------------------------------
  router.get("/inq-conversion", async (req, res) => {
    const { from, to } = req.query;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return res.status(400).json({ message: "from and to are required as YYYY-MM-DD" });
    }
    try {
      const [rows] = await db.query(
        `SELECT s.INQ_NO,
                DATE_FORMAT(s.INQ_DATE,'%Y-%m-%d') AS INQ_DATE,
                s.CUST_CODE,
                c.CUST_NAME,
                s.SMAN_CODE,
                sm.SMAN_NAME,
                s.REGRET,
                q.QUOT_NO,
                j.JOB_NO,
                DATE_FORMAT(j.JOB_DATE,'%Y-%m-%d') AS JOB_DATE
           FROM sales_inquiry s
           LEFT JOIN cus_mst  c  ON c.CUST_CODE  = s.CUST_CODE
           LEFT JOIN sman_mst sm ON sm.SMAN_CODE = s.SMAN_CODE
           LEFT JOIN (SELECT INQ_NO, MAX(QUOT_NO) AS QUOT_NO
                        FROM quot_hdr
                       GROUP BY INQ_NO) q ON q.INQ_NO = s.INQ_NO
           LEFT JOIN (SELECT qh.INQ_NO,
                             MAX(jc.JOB_NO)   AS JOB_NO,
                             MIN(jc.START_DATE) AS JOB_DATE
                        FROM job_card jc
                        JOIN quot_hdr qh ON qh.QUOT_NO = jc.QUOT_REF
                       GROUP BY qh.INQ_NO) j ON j.INQ_NO = s.INQ_NO
          WHERE s.INQ_DATE BETWEEN ? AND ?
          ORDER BY s.INQ_NO`,
        [from, to]
      );
      res.json(rows);
    } catch (err) {
      console.error("[inq-conversion] failed:", err);
      res.status(500).json({ message: err.sqlMessage || "Failed to fetch inquiry conversion data" });
    }
  });

  return router;
};
