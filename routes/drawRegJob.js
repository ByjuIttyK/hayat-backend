// drawRegJob.js — Job No for a Drawing Register record, taken from job_card
// by the quotation (job_card.QUOT_REF = drawing_register.QUOTE_REF).
//
// Use in the Drawing Register routes (Hyatdb):
//
//   const { jobsForQuote, resolveDrawJobNo } = require("./drawRegJob");
//
//   // /api/drawRegQuote  →  jobs list for the screen
//   const jobs = await jobsForQuote(conn, req.query.quot);
//   res.json({ quote, items, jobs });
//
//   // /api/saveDrawReg and /api/updateDrawReg  →  before the INSERT / UPDATE
//   body.JOB_NO = await resolveDrawJobNo(conn, body.QUOTE_REF, body.JOB_NO);
//   ...and make sure JOB_NO is in the column list and the values array of
//   both statements.
//
// `conn` is a mysql2/promise connection or pool.

const JOB_SQL = `
  SELECT TRIM(JOB_NO) AS JOB_NO, PROJ_NAME, CUST_CODE
    FROM job_card
   WHERE TRIM(LEADING '0' FROM TRIM(QUOT_REF)) = TRIM(LEADING '0' FROM TRIM(?))
     AND COALESCE(CANCEL_IND, 'N') <> 'Y'
   ORDER BY JOB_NO`;

// All live jobs raised against a quotation
async function jobsForQuote(conn, quoteRef) {
  const q = String(quoteRef || "").trim();
  if (!q) return [];
  const [rows] = await conn.query(JOB_SQL, [q]);
  return rows;
}

// Job No to save: the one typed/picked on screen, otherwise the quotation's
// job when there is exactly one; null when none or ambiguous.
async function resolveDrawJobNo(conn, quoteRef, jobNo) {
  const typed = String(jobNo || "").trim();
  if (typed) return typed;
  const jobs = await jobsForQuote(conn, quoteRef);
  return jobs.length === 1 ? jobs[0].JOB_NO : null;
}

module.exports = { jobsForQuote, resolveDrawJobNo };
