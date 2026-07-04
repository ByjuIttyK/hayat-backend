// audit_api.js
// Place at: E:\hayatApi\routes\audit_api.js
// Register in HayatDb.js:
//   app.use('/api/audit', require('./routes/audit_api')(connection));

const { exportAndPurgeAudit, listArchives } = require('../utils/auditArchiver');
const fs   = require("fs");
const path = require("path");

module.exports = function (connection) {
  const router = require("express").Router();

  // ── GET /api/audit/months ─────────────────────────────────────────────────
  router.get("/months", async (req, res) => {
    try {
      const [rows] = await connection.promise().query(
        `SELECT DISTINCT DATE_FORMAT(AUDIT_TS, '%Y_%m') AS month
         FROM tran_acc_audit ORDER BY month DESC`
      );
      const archived = listArchives();
      const dbMonths = rows.map((r) => r.month);
      const all = [...new Set([...dbMonths, ...archived])].sort().reverse();
      res.json(all);
    } catch (err) {
      console.error("audit /months:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/audit/logs?month=2026_06&op=UPDATE&user=byju&vchr_no=PV001 ───
  router.get("/logs", async (req, res) => {
    try {
      const { month, op, user, vchr_no, tran_type } = req.query;
      if (!month)
        return res.status(400).json({ message: "month is required (e.g. 2026_06)" });

      const parts = month.split("_");
      const yyyy  = parts[0];
      const mm    = parts[1];

      const conditions = ["YEAR(AUDIT_TS) = ?", "MONTH(AUDIT_TS) = ?"];
      const params     = [yyyy, mm];

      if (op)        { conditions.push("OP = ?");        params.push(String(op).toUpperCase()); }
      if (user)      { conditions.push("USERNAME = ?");  params.push(String(user)); }
      if (vchr_no)   { conditions.push("VCHR_NO = ?");   params.push(String(vchr_no)); }
      if (tran_type) { conditions.push("TRAN_TYPE = ?"); params.push(String(tran_type)); }

      const [rows] = await connection.promise().query(
        `SELECT * FROM tran_acc_audit WHERE ${conditions.join(" AND ")} ORDER BY AUDIT_TS DESC`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error("audit /logs:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/audit/export-purge?month=2026_05 — manual archive trigger ────
  router.get("/export-purge", async (req, res) => {
    try {
      const month  = req.query.month || null;
      const result = await exportAndPurgeAudit(connection, month);
      res.json(result);
    } catch (err) {
      console.error("audit /export-purge:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/audit/archive?month=2026_05 — download zip ──────────────────
  router.get("/archive", (req, res) => {
    const month = req.query.month;
    if (!month) return res.status(400).json({ message: "month required" });

    const ARCHIVE_DIR = process.env.ARCHIVE_DIR ||
      path.join(__dirname, "..", "audit_archives");
    const filePath = path.join(ARCHIVE_DIR, `tran_acc_${month}.zip`);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ message: "Archive not found for " + month });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=audit_${month}.zip`);
    fs.createReadStream(filePath).pipe(res);
  });

  return router;
};
