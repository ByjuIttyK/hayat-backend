// routes/quotRevisionApi.js — Quotation revision: copy a quote to <base>/<nn>
// Register in HayatDb.js:
//   const quotRevisionApi = require("./routes/quotRevisionApi");
//   app.use("/api", quotRevisionApi(connection));
//
//   GET  /api/quot-revision/info?quotNo=0000006494/01
//        → the quote, all revisions of its base number, and the next revision number
//   POST /api/quot-revision   { sourceQuotNo, revDate?, userName? }
//        → copies quot_hdr + the child tables below to the next revision number
//
// Numbering: base = the part before "/" (0000006494). Next revision = highest "/nn"
// already used for that base + 1, two digits (/01, /02 … /99, then /100).
// The copy is taken from the quote number entered — so entering /02 makes /03 a copy
// of /02, entering the base makes it a copy of the original.
//
// Columns are read from information_schema, so every column of each table is copied
// (new columns added later are copied too) — only the quote number and the fields in
// HDR_RESET change. Auto-increment / generated columns (srno_row_id) are left to MySQL.

const express = require("express");

// Tables that hold the content of a quotation, keyed by the quote number.
// ── Add the notes / terms tables here if they are separate tables keyed by QUOT_NO. ──
// GET /api/quot-revision/info returns `otherTables`: every other table that has a
// QUOT_NO column and is NOT copied — use it to check nothing is missing.
const CHILD_TABLES = [
  { table: "quot_item", key: "QUOT_NO" },
  { table: "quot_technical_details", key: "QUOT_NO" },
];

// Header fields that must not carry over to a fresh revision.
const HDR_RESET = {
  QUOT_APPROVED: null,
  QUOT_APPROVED_BY: null,
  QUOT_LIMIT_APPROVED: null,
  QUOT_LIMIT_APPROVED_BY: null,
  STATUS_DATE: null,
  PRINTED_BY: null,
  CANCELLED: null,
};

const baseOf = (no) => String(no || "").trim().split("/")[0].trim();
const revOf = (no, base) => {
  const s = String(no || "").trim();
  if (!s.startsWith(base + "/")) return 0;
  const n = s.slice(base.length + 1);
  return /^\d+$/.test(n) ? Number(n) : 0;
};
const pad2 = (n) => String(n).padStart(2, "0");

module.exports = function (connection) {
  const router = express.Router();

  // ── Promise helpers over the callback-style pool ──
  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (err, r) => (err ? reject(err) : resolve(r))));
  const begin = (conn) => new Promise((res, rej) => conn.beginTransaction((e) => (e ? rej(e) : res())));
  const commit = (conn) => new Promise((res, rej) => conn.commit((e) => (e ? rej(e) : res())));
  const rollback = (conn) => new Promise((res) => conn.rollback(() => res()));

  // Copyable columns of a table (skips auto_increment and generated columns).
  const copyCols = async (conn, table) => {
    const rows = await q(
      conn,
      `SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table]
    );
    return rows
      .filter((c) => !/auto_increment|generated/i.test(c.EXTRA || ""))
      .map((c) => c.COLUMN_NAME);
  };

  // INSERT INTO t (cols) SELECT cols-with-overrides FROM t WHERE key = source
  const copyRows = async (conn, table, key, sourceNo, overrides) => {
    const cols = await copyCols(conn, table);
    if (!cols.length) return { skipped: true, rows: 0 };
    const ov = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k.toUpperCase(), v]));
    const params = [];
    const sel = cols.map((c) => {
      if (Object.prototype.hasOwnProperty.call(ov, c.toUpperCase())) {
        params.push(ov[c.toUpperCase()]);
        return "?";
      }
      return `\`${c}\``;
    });
    params.push(sourceNo);
    const r = await q(
      conn,
      `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(", ")})
       SELECT ${sel.join(", ")} FROM \`${table}\` WHERE \`${key}\` = ?`,
      params
    );
    return { skipped: false, rows: r.affectedRows };
  };

  // All quote numbers of one base, and the next revision number.
  const family = async (conn, base, lock = false) => {
    const rows = await q(
      conn,
      `SELECT h.QUOT_NO, DATE_FORMAT(h.QUOT_DATE,'%d/%m/%Y') AS QUOT_DATE, h.AMOUNT, h.REV_NO
         FROM quot_hdr h
        WHERE h.QUOT_NO = ? OR h.QUOT_NO LIKE CONCAT(?, '/%')
        ORDER BY h.QUOT_NO${lock ? " FOR UPDATE" : ""}`,
      [base, base]
    );
    const maxRev = rows.reduce((m, r) => Math.max(m, revOf(r.QUOT_NO, base)), 0);
    return { rows, nextNo: `${base}/${pad2(maxRev + 1)}`, nextRev: pad2(maxRev + 1) };
  };

  // ── GET /api/quot-revision/info?quotNo=... ──
  router.get("/quot-revision/info", async (req, res) => {
    const quotNo = String(req.query.quotNo || "").trim();
    if (!quotNo) return res.status(400).json({ error: "Enter a quotation number." });
    let conn;
    try {
      conn = await getConn();
      const src = await q(
        conn,
        `SELECT h.QUOT_NO, DATE_FORMAT(h.QUOT_DATE,'%d/%m/%Y') AS QUOT_DATE, h.CUST_CODE,
                c.CUST_NAME, h.SUBJECT, h.PROJECT_NAME, h.AMOUNT, h.CANCELLED
           FROM quot_hdr h
           LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
          WHERE h.QUOT_NO = ?`,
        [quotNo]
      );
      if (!src.length) return res.status(404).json({ error: `Quotation ${quotNo} not found.` });

      const base = baseOf(quotNo);
      const fam = await family(conn, base);

      // Line counts of what will be copied, and tables with a QUOT_NO that are not copied
      const counts = {};
      for (const t of CHILD_TABLES) {
        try {
          const [r] = await q(conn, `SELECT COUNT(*) AS n FROM \`${t.table}\` WHERE \`${t.key}\` = ?`, [quotNo]);
          counts[t.table] = Number(r.n) || 0;
        } catch {
          counts[t.table] = null;   // table missing in this database
        }
      }
      const others = await q(
        conn,
        `SELECT c.TABLE_NAME FROM information_schema.COLUMNS c
           JOIN information_schema.TABLES t
             ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
          WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'QUOT_NO'`,
        []
      );
      const copied = new Set(["quot_hdr", ...CHILD_TABLES.map((t) => t.table)].map((s) => s.toLowerCase()));
      const otherTables = others.map((o) => o.TABLE_NAME).filter((n) => !copied.has(String(n).toLowerCase()));

      res.json({ source: src[0], base, revisions: fam.rows, nextNo: fam.nextNo, counts, otherTables });
    } catch (e) {
      console.error("quot-revision/info:", e);
      res.status(500).json({ error: e.sqlMessage || e.message });
    } finally {
      conn?.release();
    }
  });

  // ── POST /api/quot-revision ──
  router.post("/quot-revision", async (req, res) => {
    const sourceQuotNo = String(req.body?.sourceQuotNo || "").trim();
    const revDate = req.body?.revDate || null;          // yyyy-MM-dd; null keeps the original date
    const userName = req.body?.userName || null;
    if (!sourceQuotNo) return res.status(400).json({ error: "sourceQuotNo is required." });
    const base = baseOf(sourceQuotNo);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const conn = await getConn();
      try {
        await begin(conn);

        const src = await q(conn, "SELECT QUOT_NO FROM quot_hdr WHERE QUOT_NO = ?", [sourceQuotNo]);
        if (!src.length) throw Object.assign(new Error(`Quotation ${sourceQuotNo} not found.`), { status: 404 });

        // Locks the base's rows so two users can't take the same revision number
        const { nextNo, nextRev } = await family(conn, base, true);
        if (nextNo.length > 20) throw Object.assign(new Error(`${nextNo} is longer than QUOT_NO allows (20).`), { status: 400 });

        const hdrOv = { ...HDR_RESET, QUOT_NO: nextNo, REV_NO: nextRev };
        if (revDate) hdrOv.QUOT_DATE = revDate;
        if (userName) hdrOv.CREATED_BY = userName;

        const copied = {};
        copied.quot_hdr = (await copyRows(conn, "quot_hdr", "QUOT_NO", sourceQuotNo, hdrOv)).rows;
        for (const t of CHILD_TABLES) {
          const r = await copyRows(conn, t.table, t.key, sourceQuotNo, { [t.key]: nextNo });
          copied[t.table] = r.skipped ? "table not found" : r.rows;
        }

        await commit(conn);
        console.log(`quot-revision: ${sourceQuotNo} → ${nextNo}`, copied);
        return res.json({ newQuotNo: nextNo, source: sourceQuotNo, copied, message: `Revision ${nextNo} created from ${sourceQuotNo}.` });
      } catch (e) {
        await rollback(conn);
        // Someone took the same number at the same instant → try the next one
        if (e.code === "ER_DUP_ENTRY" && /quot_hdr/i.test(e.sqlMessage || "") && attempt < 3) continue;
        console.error("quot-revision:", e);
        return res.status(e.status || 500).json({ error: e.sqlMessage || e.message });
      } finally {
        conn.release();
      }
    }
  });

  return router;
};
