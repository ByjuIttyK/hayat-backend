// docModuleApi.js — tran_type ↔ attachment module lookups for the Ledger of A/c.
// Register in HayatDb.js:
//   const docModuleApi = require("./routes/docModuleApi");
//   app.use("/api", docModuleApi(connection));
//
// NOTE: doc_attachments columns are assumed to be MODULE and REF_NO. If your
// existing /api/docs/counts query uses different names, change DOC_MODULE_COL /
// DOC_REF_COL below to match it.

const express = require("express");

const DOC_MODULE_COL = "MODULE";
const DOC_REF_COL = "REF_NO";
const CHUNK = 1000; // keys per query (2 placeholders each)

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
  return router;
};
