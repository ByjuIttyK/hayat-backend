// docModuleApi.js — tran_type ↔ attachment module lookups for the Ledger of A/c.
// Register in HayatDb.js:
//   const docModuleApi = require("./routes/docModuleApi");
//   app.use("/api", docModuleApi(connection));
//
// NOTE: doc_attachments columns are assumed to be MODULE and REF_NO. If your
// existing /api/docs/counts query uses different names, change DOC_MODULE_COL /
// DOC_REF_COL below to match it.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DOC_MODULE_COL = "MODULE";
const DOC_REF_COL = "REF_NO";
const CHUNK = 1000; // keys per query (2 placeholders each)

// Root of the attachment store. Files are kept as
//   <DOC_DIR>/<MODULE>/<REF_NO>/<STORED_NAME>
//   e.g. E:\hayatApi\uploads\SRV\0000007776\a9acccde-....pdf
// __dirname is the routes folder, hence "..".
const DOC_DIR = path.join(__dirname, "..", "uploads");

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/doc-module-map → [{ TRAN_TYPE, MODULE_CODE }]
  router.get("/doc-module-map", (req, res) => {
    const sql = `SELECT tran_type AS TRAN_TYPE, module_code AS MODULE_CODE
                   FROM doc_module_tran_type
                  ORDER BY tran_type, module_code`;
    connection.query(sql, (err, rows) => {
      if (err) {
        console.error("doc-module-map:", err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    });
  });

  // POST /api/docs/counts-by-tran   body: { keys: [{ tranType, vchrNo }] }
  // → [{ TRAN_TYPE, VCHR_NO, MODULE_CODE, CNT }] — only keys that have documents.
  // The join resolves a tran_type shared by several modules (e.g. 07) to the
  // module the documents were actually saved under.
  router.post("/docs/counts-by-tran", async (req, res) => {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const clean = keys
      .map((k) => [String(k?.tranType ?? "").trim(), String(k?.vchrNo ?? "").trim()])
      .filter(([t, v]) => t && v);
    if (clean.length === 0) return res.json([]);

    const runChunk = (chunk) =>
      new Promise((resolve, reject) => {
        const tuples = chunk.map(() => "(?, ?)").join(", ");
        const sql = `
          SELECT m.tran_type           AS TRAN_TYPE,
                 d.${DOC_REF_COL}      AS VCHR_NO,
                 d.${DOC_MODULE_COL}   AS MODULE_CODE,
                 COUNT(*)              AS CNT
            FROM doc_attachments d
            JOIN doc_module_tran_type m
              ON m.module_code = d.${DOC_MODULE_COL}
           WHERE (m.tran_type, d.${DOC_REF_COL}) IN (${tuples})
           GROUP BY m.tran_type, d.${DOC_REF_COL}, d.${DOC_MODULE_COL}`;
        connection.query(sql, chunk.flat(), (err, rows) => (err ? reject(err) : resolve(rows)));
      });

    try {
      const out = [];
      for (let i = 0; i < clean.length; i += CHUNK) {
        out.push(...(await runChunk(clean.slice(i, i + CHUNK))));
      }
      res.json(out);
    } catch (err) {
      console.error("docs/counts-by-tran:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/docs/counts-by-ref', function (req, res) {
    const moduleCode = String(req.body?.moduleCode || '').trim();
    const refNos = Array.isArray(req.body?.refNos)
      ? [...new Set(req.body.refNos.map((r) => String(r).trim()).filter(Boolean))]
      : [];
    if (!moduleCode || refNos.length === 0) return res.json([]);

    connection.query(
      "SELECT REF_NO, COUNT(*) AS CNT, MIN(ID) AS FIRST_ID, " +
      "       SUBSTRING_INDEX(GROUP_CONCAT(FILE_NAME ORDER BY ID SEPARATOR '|'), '|', 10) AS FILES " +
      "  FROM doc_attachments " +
      " WHERE MODULE = ? AND REF_NO IN (?) " +
      " GROUP BY REF_NO",
      [moduleCode, refNos],
      function (error, result) {
        if (error) {
          console.error('counts-by-ref error:', error);
          return res.status(500).json({ error: error.message });
        }
        res.json(result);
      }
    );
  });

  // POST /api/docs/copy-from
  // body: { fromModule, fromRefs: [...], toModule, toRef }
  // Copies every document of the source refs (e.g. SRV) to the target voucher
  // (e.g. PURLOCAL / PJV No). Each file is physically copied under a new stored
  // name, so deleting one side never removes the other. Rows already brought
  // over (same REMARKS + FILE_NAME) are skipped, so re-saving is safe.
  // → { copied, skipped, missing }
  router.post("/docs/copy-from", async (req, res) => {
    const fromModule = String(req.body?.fromModule || "").trim();
    const toModule   = String(req.body?.toModule || "").trim();
    const toRef      = String(req.body?.toRef || "").trim();
    const fromRefs   = Array.isArray(req.body?.fromRefs)
      ? [...new Set(req.body.fromRefs.map((r) => String(r).trim()).filter(Boolean))]
      : [];
    if (!fromModule || !toModule || !toRef || fromRefs.length === 0) {
      return res.json({ copied: 0, skipped: 0, missing: 0 });
    }

    const q = (sql, params) => new Promise((ok, ko) =>
      connection.query(sql, params, (e, r) => (e ? ko(e) : ok(r))));
    const user = req.user?.username || req.user?.USER_ID || "system";

    try {
      const src = await q(
        `SELECT * FROM doc_attachments
          WHERE ${DOC_MODULE_COL} = ? AND ${DOC_REF_COL} IN (?) ORDER BY ID`,
        [fromModule, fromRefs]);
      const existing = await q(
        `SELECT FILE_NAME, REMARKS FROM doc_attachments
          WHERE ${DOC_MODULE_COL} = ? AND ${DOC_REF_COL} = ?`,
        [toModule, toRef]);
      const have = new Set(existing.map((r) => `${r.REMARKS}|${r.FILE_NAME}`));

      let copied = 0, skipped = 0, missing = 0;
      for (const d of src) {
        const remark = `From ${fromModule} ${d[DOC_REF_COL]}`;
        if (have.has(`${remark}|${d.FILE_NAME}`)) { skipped++; continue; }

        const newName = crypto.randomUUID() + path.extname(d.STORED_NAME || "");
        // Source: uploads/<SRV>/<srv no>/<stored>  →  target: uploads/<PURLOCAL>/<pjv no>/<new>
        const srcPath = path.join(DOC_DIR, String(d[DOC_MODULE_COL]).trim(),
                                  String(d[DOC_REF_COL]).trim(), d.STORED_NAME);
        const dstDir  = path.join(DOC_DIR, toModule, toRef);
        try {
          await fs.promises.mkdir(dstDir, { recursive: true });
          await fs.promises.copyFile(srcPath, path.join(dstDir, newName));
        } catch (e) {
          console.warn("copy-from: source file missing", d.STORED_NAME, e.message);
          missing++; continue;
        }

        await q(
          `INSERT INTO doc_attachments
             (${DOC_MODULE_COL}, ${DOC_REF_COL}, FILE_NAME, STORED_NAME, FILE_EXT,
              FILE_SIZE, MIME_TYPE, REMARKS, UPLOADED_BY)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [toModule, toRef, d.FILE_NAME, newName, d.FILE_EXT, d.FILE_SIZE,
           d.MIME_TYPE, remark, user]);
        have.add(`${remark}|${d.FILE_NAME}`);
        copied++;
      }
      res.json({ copied, skipped, missing });
    } catch (error) {
      console.error("docs/copy-from:", error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
