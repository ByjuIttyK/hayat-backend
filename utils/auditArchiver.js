// auditArchiver.js
// Place at: E:\hayatApi\utils\auditArchiver.js
//
// Hybrid approach:
//   1. Auto  — node-cron fires on 1st of every month at 01:00 AM
//   2. Manual — exportAndPurgeAudit() called from audit_api.js endpoint
//
// npm install node-cron archiver

const fs       = require("fs");
const path     = require("path");
const cron     = require("node-cron");
//const archiver = require("archiver");

// ── Folder paths — override via .env ─────────────────────────────────────────
// Windows dev : E:\hayatApi\audit_logs\  and  E:\hayatApi\audit_archives\
// VPS (Linux) : /home/hayat/audit_logs\  and  /home/hayat/audit_archives\
const AUDIT_DIR   = process.env.AUDIT_DIR
  || path.join(__dirname, "..", "audit_logs");

const ARCHIVE_DIR = process.env.ARCHIVE_DIR
  || path.join(__dirname, "..", "audit_archives");

// Ensure both folders exist on startup
[AUDIT_DIR, ARCHIVE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[AuditArchiver] Created folder: ${dir}`);
  }
});

// ── Helper: returns previous month as "YYYY_MM" ───────────────────────────────
function getPrevMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}_${mm}`;
}

// ── Helper: zip a .jsonl file into audit_archives/ ────────────────────────────
const zlib = require("zlib");

function zipAuditFile(month) {
  return new Promise((resolve, reject) => {
    const srcFile  = path.join(AUDIT_DIR,   `tran_acc_${month}.jsonl`);
    const destFile = path.join(ARCHIVE_DIR, `tran_acc_${month}.gz`);  // .gz not .zip

    if (!fs.existsSync(srcFile)) {
      console.log(`[AuditArchiver] No .jsonl found for ${month}`);
      return resolve(null);
    }
    if (fs.existsSync(destFile)) {
      console.log(`[AuditArchiver] Archive already exists for ${month}`);
      return resolve(destFile);
    }

    const src  = fs.createReadStream(srcFile);
    const dest = fs.createWriteStream(destFile);
    const gz   = zlib.createGzip();

    src.pipe(gz).pipe(dest);

    dest.on("finish", () => {
      console.log(`[AuditArchiver] Compressed → ${destFile}`);
      resolve(destFile);
    });
    src.on("error",  reject);
    dest.on("error", reject);
  });
}
// ── Core function — export DB rows to .jsonl, zip, purge DB ──────────────────
// Called by both cron (auto) and API endpoint (manual)
// month param is optional — defaults to previous month
async function exportAndPurgeAudit(connection, month) {
  month = month || getPrevMonth();
  const [yyyy, mm] = month.split("_");

  console.log(`[AuditArchiver] Starting export for month: ${month}`);

  // Step 1 — Read rows from tran_acc_audit for this month
  const [rows] = await connection.promise().query(
    `SELECT * FROM tran_acc_audit
     WHERE YEAR(AUDIT_TS) = ? AND MONTH(AUDIT_TS) = ?
     ORDER BY AUDIT_TS ASC`,
    [yyyy, mm]
  );

  if (rows.length === 0) {
    console.log(`[AuditArchiver] No audit rows found for ${month} — skipping.`);
    return { month, rows: 0, status: "empty" };
  }

  console.log(`[AuditArchiver] Found ${rows.length} rows for ${month}`);

  // Step 2 — Write to .jsonl file (one JSON object per line)
  const filePath = path.join(AUDIT_DIR, `tran_acc_${month}.jsonl`);
  const lines    = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines, "utf8");
  console.log(`[AuditArchiver] Written → ${filePath}`);

  // Step 3 — Zip the .jsonl into audit_archives/
  const zipPath = await zipAuditFile(month);

  // Step 4 — Delete original .jsonl now that zip exists
  if (zipPath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`[AuditArchiver] Deleted .jsonl for ${month} (zip retained)`);
  }

  // Step 5 — Purge those rows from DB
  const [result] = await connection.promise().query(
    `DELETE FROM tran_acc_audit
     WHERE YEAR(AUDIT_TS) = ? AND MONTH(AUDIT_TS) = ?`,
    [yyyy, mm]
  );
  console.log(`[AuditArchiver] Purged ${result.affectedRows} rows from tran_acc_audit for ${month}`);

  return { month, rows: rows.length, zip: zipPath, status: "done" };
}

// ── Start cron — auto fires on 1st of every month at 01:00 AM ────────────────
function startAuditArchiver(connection) {
  // "0 1 1 * *" = minute:0, hour:1, day:1, every month, any weekday
  cron.schedule("0 1 1 * *", async () => {
    console.log("[AuditArchiver] ── Cron triggered ──");
    try {
      const result = await exportAndPurgeAudit(connection);  // no month = prev month
      console.log(`[AuditArchiver] Cron complete:`, result);
    } catch (err) {
      console.error("[AuditArchiver] Cron error:", err.message);
    }
  });

  console.log("[AuditArchiver] Cron scheduled — auto runs 1st of every month at 01:00 AM.");
}

// ── List available zip archives ───────────────────────────────────────────────
function listArchives() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs.readdirSync(ARCHIVE_DIR)
    .filter(f => f.endsWith(".zip"))
    .map(f => f.replace("tran_acc_", "").replace(".zip", ""))
    .sort()
    .reverse();
}

module.exports = { startAuditArchiver, exportAndPurgeAudit, listArchives, AUDIT_DIR, ARCHIVE_DIR };
