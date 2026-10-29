// routes/quotCopyRoutes.js — "Copy as New Quotation" (not a revision)
//
//   GET  /api/quot-copy/next   -> { nextNo }            preview of the next quotation no
//   POST /api/quot-copy        -> { newQuotNo, counts }  body: { sourceQuotNo, quotDate (yyyy-MM-dd), userName }
//
// Copies quot_hdr and every quotation child table from the source quotation (a base
// number or a revision like 0000006494/02) to the NEXT base quotation number.
// Numbering follows the save-fabinv pattern: MAX(base no)+1 read inside the transaction,
// plain INSERT, the primary key catches a clash with another user, and we retry.
//
// Column lists are read from information_schema, so a column added to any of these
// tables later is copied automatically. Auto-increment / generated columns
// (srno_row_id) are left out and get fresh values.
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/quotCopyRoutes")(connection));

const express = require("express");

// Child tables copied with the quotation (same set the revision copies).
const CHILD_TABLES = [
  "quot_item",
  "quot_terms_cond",
  "quot_notes",
  "quot_technical_details",
  "quot_inq_docs",
];

// Header columns reset on the copy — applied only where the column exists in quot_hdr.
// Make this match the fields the revision route clears (approvals, cancellation…).
const HDR_RESET_NULL = [
  "REV_NO",
  "CANCELLED",
  "QUOT_LIMIT_APPROVED",
  "QUOT_LIMIT_APPROVED_BY",
  "JOB_APPROVED",
  "JOB_APPROVED_BY",
  "JOB_NO",
];

const MAX_TRIES = 3;

module.exports = function (connection) {
  const router = express.Router();
  const db = typeof connection.promise === "function" ? connection.promise() : connection;

  // Copyable column names of a table (upper-case), excluding auto-increment/generated.
  async function columnsOf(conn, table) {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME, EXTRA
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ?
        ORDER BY ORDINAL_POSITION`,
      [table]
    );
    return rows
      .filter((r) => !/auto_increment|generated/i.test(String(r.EXTRA || "")))
      .map((r) => String(r.COLUMN_NAME));
  }

  // Next base quotation no: MAX of the part before any "/" + 1, padded to 10.
  async function nextBaseNo(conn, lock) {
    const [[r]] = await conn.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(QUOT_NO, '/', 1) AS UNSIGNED)), 0) AS mx
         FROM quot_hdr` + (lock ? " FOR UPDATE" : "")
    );
    return String(Number(r.mx) + 1).padStart(10, "0");
  }

  // INSERT INTO t (cols) SELECT <cols, with overrides> FROM t WHERE QUOT_NO = ?
  // overrides: { COLUMN: { sql: "?", val } | { sql: "NOW()" } }
  async function copyRows(conn, table, srcNo, overrides) {
    const cols = await columnsOf(conn, table);
    if (!cols.length || !cols.some((c) => c.toUpperCase() === "QUOT_NO")) return null; // table missing / no QUOT_NO
    const params = [];
    const sel = cols.map((c) => {
      const o = overrides[c.toUpperCase()];
      if (!o) return `\`${c}\``;
      if (o.sql === "?") params.push(o.val);
      return o.sql;
    });
    params.push(srcNo);
    const colList = cols.map((c) => `\`${c}\``).join(", ");
    const [res] = await conn.query(
      `INSERT INTO ${table} (${colList}) SELECT ${sel.join(", ")} FROM ${table} WHERE QUOT_NO = ?`,
      params
    );
    return res.affectedRows;
  }

  // ── preview of the next number (not reserved) ─────────────────
  router.get("/quot-copy/next", async (req, res) => {
    try {
      const conn = await db.getConnection();
      try {
        res.json({ nextNo: await nextBaseNo(conn, false) });
      } finally {
        conn.release();
      }
    } catch (e) {
      console.error("quot-copy/next:", e);
      res.status(500).json({ error: e.message || "Could not read the next quotation no." });
    }
  });

  // ── copy ──────────────────────────────────────────────────────
  router.post("/quot-copy", async (req, res) => {
    const srcNo = String(req.body?.sourceQuotNo || "").trim();
    const quotDate = req.body?.quotDate || null; // yyyy-MM-dd, null = today
    const userName = req.body?.userName || null;
    if (!srcNo) return res.status(400).json({ error: "sourceQuotNo is required." });

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        const [[src]] = await conn.query("SELECT QUOT_NO FROM quot_hdr WHERE QUOT_NO = ?", [srcNo]);
        if (!src) {
          await conn.rollback();
          return res.status(404).json({ error: `Quotation ${srcNo} not found.` });
        }

        const newNo = await nextBaseNo(conn, true);
        const dateOv = quotDate ? { sql: "?", val: quotDate } : { sql: "CURDATE()" };

        // header
        const hdrOv = {
          QUOT_NO: { sql: "?", val: newNo },
          QUOT_DATE: dateOv,
          CREATED_BY: { sql: "?", val: userName },
          CREATED_DATE: { sql: "NOW()" },
          CREATED_ON: { sql: "NOW()" },
        };
        HDR_RESET_NULL.forEach((c) => { hdrOv[c] = { sql: "NULL" }; });
        await copyRows(conn, "quot_hdr", srcNo, hdrOv);

        // children — new QUOT_NO, and the new date wherever a line carries QUOT_DATE
        const counts = {};
        for (const t of CHILD_TABLES) {
          counts[t] = await copyRows(conn, t, srcNo, {
            QUOT_NO: { sql: "?", val: newNo },
            QUOT_DATE: dateOv,
          });
        }

        await conn.commit();
        return res.json({ newQuotNo: newNo, counts });
      } catch (e) {
        try { await conn.rollback(); } catch (_) { /* ignore */ }
        if (e && e.code === "ER_DUP_ENTRY" && attempt < MAX_TRIES) continue; // another user took the number
        console.error("quot-copy:", e);
        return res.status(500).json({ error: e.message || "Could not copy the quotation." });
      } finally {
        conn.release();
      }
    }
  });

  return router;
};
