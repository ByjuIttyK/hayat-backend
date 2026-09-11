/**
 * G/L Posting Audit
 * GET /api/gl-audit/missing-postings?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * For every sub-system listed in AUDIT_CHECKS, returns the header documents dated
 * inside the range that have NO row in tran_acc for their tran_type + voucher no.
 *
 * Register in HayatDb.js:
 *   const glAuditRoutes = require("./routes/glAuditRoutes");
 *   app.use("/api", glAuditRoutes(connection));
 */
const express = require("express");

// To add a sub-system later, add one entry here. The screen and Excel export pick it up automatically.
// Table/column names come ONLY from this list (never from the request), so interpolating them is safe.
// Table names in lowercase: the VPS MySQL is case-sensitive.
const AUDIT_CHECKS = [
  {
    key: "purchase",
    title: "Purchase invoices",
    table: "purchase_hdr",
    noCol: "PJV_NO",
    dateCol: "PJV_DATE",
    tranType: "07",
  },
  {
    // TODO: the 2nd query pasted was identical to the 1st.
    // Replace table / noCol / dateCol / tranType with the intended sub-system.
    key: "purchase_2",
    title: "Purchase invoices (2)",
    table: "purchase_hdr",
    noCol: "PJV_NO",
    dateCol: "PJV_DATE",
    tranType: "07",
  },
  {
    key: "fab_invoice",
    title: "Fabrication invoices",
    table: "fab_inv_hdr",
    noCol: "INV_NO",
    dateCol: "INV_DATE",
    tranType: "06",
  },
    {
    key: "ngp",
    title: "Non-Goods Purchases",
    table: "ngp_net",
    noCol: "PRCH_NO",
    dateCol: "PRCH_DATE",
    tranType: "07",
  },
];

const isValidIsoDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

module.exports = function (connection) {
  const router = express.Router();

  const query = (sql, params) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  const runCheck = async (c, from, to) => {
    // "< to + 1 day" keeps the whole last day even if the column is DATETIME
    const inRange = `h.${c.dateCol} >= ? AND h.${c.dateCol} < DATE_ADD(?, INTERVAL 1 DAY)`;

    const [rows, countRows] = await Promise.all([
      query(
        `SELECT h.${c.noCol} AS doc_no,
                DATE_FORMAT(h.${c.dateCol}, '%Y-%m-%d') AS doc_date
           FROM ${c.table} h
          WHERE ${inRange}
            AND NOT EXISTS (SELECT 1
                              FROM tran_acc t
                             WHERE t.tran_type = ?
                               AND t.VCHR_NO   = h.${c.noCol})
          ORDER BY h.${c.noCol}`,
        [from, to, c.tranType]
      ),
      // Total documents in range, so "0 missing" is visibly "0 of N", not an empty table
      query(`SELECT COUNT(*) AS total FROM ${c.table} h WHERE ${inRange}`, [from, to]),
    ]);

    return { total: Number(countRows[0].total), missing: rows.length, rows };
  };

  router.get("/gl-audit/missing-postings", async (req, res) => {
    const { from, to } = req.query;

    if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
      return res.status(400).json({ error: "From and To must be valid dates." });
    }
    if (from > to) {
      return res.status(400).json({ error: "From date is after To date." });
    }

    // allSettled: one bad check (e.g. wrong table name) does not blank the other grids
    const settled = await Promise.allSettled(AUDIT_CHECKS.map((c) => runCheck(c, from, to)));

    const checks = AUDIT_CHECKS.map((c, i) => {
      const base = { key: c.key, title: c.title, table: c.table, tranType: c.tranType };
      const r = settled[i];
      if (r.status === "fulfilled") return { ...base, ...r.value, error: null };

      console.error(`gl-audit [${c.key}]:`, r.reason);
      return {
        ...base,
        total: 0,
        missing: 0,
        rows: [],
        error: (r.reason && (r.reason.sqlMessage || r.reason.message)) || "Query failed",
      };
    });

    res.json({ from, to, checks });
  });

  return router;
};
