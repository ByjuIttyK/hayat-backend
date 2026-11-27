// routes/empDocFilesApi.js — scanned copies for Employee Master "Documents" tab
// One file per employee per document type, kept in emp_doc_files (separate from
// emp_docs, so the Documents save that rewrites emp_docs never loses a file link).
//
//   GET    /api/emp-doc-files/:empCode              → list of files for the employee
//   POST   /api/emp-doc-files/:empCode/:docType     → upload / replace (form field "file")
//   GET    /api/emp-doc-files/:empCode/:docType/file → open the file (inline)
//   DELETE /api/emp-doc-files/:empCode/:docType     → remove file and row
//
// Register in HayatDb.js:
//   const empDocFilesApi = require("./routes/empDocFilesApi");
//   app.use("/api", empDocFilesApi(connection));
// Needs: npm i multer

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Files live outside the code folder's Git tree; override with EMP_DOC_DIR in .env.
const ROOT = path.resolve(process.env.EMP_DOC_DIR || path.join(__dirname, "..", "uploads", "emp_docs"));
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

// codes are used in folder/file names — keep only safe characters
const safe = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  const fullPath = (empCode, storedName) => {
    const p = path.resolve(ROOT, safe(empCode), path.basename(storedName || ""));
    if (!p.startsWith(ROOT + path.sep)) throw new Error("Bad file path");
    return p;
  };

  // ── list ──
  router.get("/emp-doc-files/:empCode", async (req, res) => {
    try {
      const rows = await q(
        `SELECT DOC_TYPE, FILE_NAME, MIME_TYPE, FILE_SIZE, UPLOADED_BY, UPLOADED_ON
           FROM emp_doc_files WHERE EMP_CODE = ?`,
        [req.params.empCode]);
      res.json(rows);
    } catch (e) {
      console.error("emp-doc-files list:", e);
      res.status(500).json({ error: "Could not load document files" });
    }
  });

  // ── upload / replace ──
  router.post("/emp-doc-files/:empCode/:docType", (req, res) => {
    upload.single("file")(req, res, async (mErr) => {
      if (mErr) {
        const msg = mErr.code === "LIMIT_FILE_SIZE" ? "File is larger than 5 MB" : mErr.message;
        return res.status(400).json({ error: msg });
      }
      const empCode = safe(req.params.empCode);
      const docType = safe(req.params.docType);
      const f = req.file;
      if (!empCode || !docType) return res.status(400).json({ error: "Employee and document type are required" });
      if (!f) return res.status(400).json({ error: "No file received" });

      const ext = path.extname(f.originalname || "").toLowerCase();
      if (!ALLOWED[ext]) return res.status(400).json({ error: "Only PDF, JPG or PNG files can be uploaded" });

      try {
        const emp = await q(`SELECT 1 FROM emp_mst WHERE EMP_CODE = ? LIMIT 1`, [empCode]);
        if (!emp.length) return res.status(400).json({ error: "Save the employee before uploading documents" });

        const old = await q(
          `SELECT STORED_NAME FROM emp_doc_files WHERE EMP_CODE = ? AND DOC_TYPE = ?`, [empCode, docType]);

        const dir = path.join(ROOT, empCode);
        fs.mkdirSync(dir, { recursive: true });
        const storedName = `${docType}_${Date.now()}${ext}`;
        fs.writeFileSync(path.join(dir, storedName), f.buffer);

        const user = (req.user && (req.user.username || req.user.user_name || req.user.USER_NAME)) || null;
        await q(
          `INSERT INTO emp_doc_files
             (EMP_CODE, DOC_TYPE, FILE_NAME, STORED_NAME, MIME_TYPE, FILE_SIZE, UPLOADED_BY, UPLOADED_ON)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             FILE_NAME = VALUES(FILE_NAME), STORED_NAME = VALUES(STORED_NAME),
             MIME_TYPE = VALUES(MIME_TYPE), FILE_SIZE = VALUES(FILE_SIZE),
             UPLOADED_BY = VALUES(UPLOADED_BY), UPLOADED_ON = NOW()`,
          [empCode, docType, String(f.originalname).slice(0, 200), storedName, ALLOWED[ext], f.size, user]);

        // replaced file: remove the old copy from disk
        if (old.length && old[0].STORED_NAME && old[0].STORED_NAME !== storedName) {
          try { fs.unlinkSync(fullPath(empCode, old[0].STORED_NAME)); } catch { /* already gone */ }
        }

        res.json({
          DOC_TYPE: docType, FILE_NAME: f.originalname, MIME_TYPE: ALLOWED[ext],
          FILE_SIZE: f.size, UPLOADED_BY: user, UPLOADED_ON: new Date(),
        });
      } catch (e) {
        console.error("emp-doc-files upload:", e);
        res.status(500).json({ error: "Upload failed" });
      }
    });
  });

  // ── open file ──
  router.get("/emp-doc-files/:empCode/:docType/file", async (req, res) => {
    try {
      const rows = await q(
        `SELECT FILE_NAME, STORED_NAME, MIME_TYPE FROM emp_doc_files WHERE EMP_CODE = ? AND DOC_TYPE = ?`,
        [req.params.empCode, req.params.docType]);
      if (!rows.length) return res.status(404).json({ error: "No file for this document" });
      const p = fullPath(req.params.empCode, rows[0].STORED_NAME);
      if (!fs.existsSync(p)) return res.status(404).json({ error: "File missing on server" });
      res.setHeader("Content-Type", rows[0].MIME_TYPE || "application/octet-stream");
      res.setHeader("Content-Disposition",
        `inline; filename="${String(rows[0].FILE_NAME || "document").replace(/"/g, "")}"`);
      fs.createReadStream(p).pipe(res);
    } catch (e) {
      console.error("emp-doc-files open:", e);
      res.status(500).json({ error: "Could not open the file" });
    }
  });

  // ── delete ──
  router.delete("/emp-doc-files/:empCode/:docType", async (req, res) => {
    try {
      const rows = await q(
        `SELECT STORED_NAME FROM emp_doc_files WHERE EMP_CODE = ? AND DOC_TYPE = ?`,
        [req.params.empCode, req.params.docType]);
      await q(`DELETE FROM emp_doc_files WHERE EMP_CODE = ? AND DOC_TYPE = ?`,
        [req.params.empCode, req.params.docType]);
      if (rows.length && rows[0].STORED_NAME) {
        try { fs.unlinkSync(fullPath(req.params.empCode, rows[0].STORED_NAME)); } catch { /* already gone */ }
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("emp-doc-files delete:", e);
      res.status(500).json({ error: "Could not remove the file" });
    }
  });

  return router;
};

/* ── Table (run on laptop and VPS) ──
CREATE TABLE emp_doc_files (
  srno_row_id  BIGINT       NOT NULL AUTO_INCREMENT,
  EMP_CODE     VARCHAR(10)  NOT NULL,
  DOC_TYPE     VARCHAR(10)  NOT NULL,
  FILE_NAME    VARCHAR(200) NULL,      -- original name shown to the user
  STORED_NAME  VARCHAR(200) NULL,      -- name on disk: <DOC_TYPE>_<timestamp>.<ext>
  MIME_TYPE    VARCHAR(100) NULL,
  FILE_SIZE    INT          NULL,
  UPLOADED_BY  VARCHAR(30)  NULL,
  UPLOADED_ON  DATETIME     NULL,
  PRIMARY KEY (EMP_CODE, DOC_TYPE),
  UNIQUE KEY uk_emp_doc_files_row (srno_row_id)
);
*/
