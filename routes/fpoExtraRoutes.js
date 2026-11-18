// routes/fpoExtraRoutes.js
// Extras for Foreign Purchase Order entry (Fpoent.tsx), kept out of save-fpo:
//
//   GET /api/fpo-exp/:fpo      expense heads (git_types) with this FPO's amounts (fpo_exp)
//   PUT /api/fpo-exp           save them { fpoNo, rows: [{ expCode, amount }] }
//   GET /api/fpo-extra/:fpo    conv. rate, expenses total, currency, Yr.Ref.No, Pay Terms,
//                              Prepared / Reviewed / Approved By (fpo_net)
//   PUT /api/fpo-extra         save them { fpoNo, convRate, expAmount, curCode, ... }
//   GET /api/fpo-sman          staff list for Prepared / Reviewed / Approved By (sman_mst)
//   POST /api/fpo-save         save the FPO — header upsert, lines deleted and re-inserted
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/fpoExtraRoutes")(connection));
//
// Needs (see fpo_extra.sql):
//   CREATE TABLE fpo_exp (...);
//   ALTER TABLE fpo_net ADD CONV_RATE ..., ADD EXP_AMOUNT ...   (if not there)
//
// Column names that may differ (git_types code/description, fpo_net rate) are
// looked up from information_schema, so a missing column is skipped, not fatal.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;
  const q = async (sql, params = []) => (await db.query(sql, params))[0];
  const s = (v) => String(v ?? "").trim();
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(String(v).replace(/,/g, "")));

  // ── column lookup (2-minute cache, so an ALTER is picked up without a restart)
  const cache = new Map();
  const tableCols = async (table) => {
    const key = table.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 120000) return hit.map;
    const rows = await q(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = ?`, [key]);
    const map = new Map(rows.map((r) => [String(r.COLUMN_NAME).toUpperCase(), r.COLUMN_NAME]));
    cache.set(key, { map, at: Date.now() });
    return map;
  };
  const pick = async (table, names) => {
    const cols = await tableCols(table);
    for (const n of names) if (cols.has(n.toUpperCase())) return cols.get(n.toUpperCase());
    return null;
  };

  const gitCols = async () => ({
    code: await pick("git_types", ["TYPE_CODE", "GIT_CODE", "GIT_TYPE", "CODE"]),
    desc: await pick("git_types", ["TYPE_DES", "GIT_DESC", "GIT_NAME", "GIT_HEAD", "DESCRIPTION"]),
  });

  // ── 1. Expense heads with this FPO's amounts ──────────────────────────────
  router.get("/fpo-exp/:fpo", async (req, res) => {
    try {
      const g = await gitCols();
      if (!g.code) return res.status(500).json({ error: "git_types: code column not found" });
      const hasExp = (await tableCols("fpo_exp")).size > 0;
      const rows = await q(
        `SELECT TRIM(g.${g.code}) AS EXP_CODE,
                ${g.desc ? `g.${g.desc}` : "''"} AS EXP_HEAD,
                ${hasExp ? "e.AMOUNT" : "NULL"} AS AMOUNT
           FROM git_types g
           ${hasExp ? `LEFT JOIN fpo_exp e ON e.GIT_CODE = TRIM(g.${g.code}) AND e.FPO_NO = ?` : ""}
          ORDER BY TRIM(g.${g.code})`,
        hasExp ? [s(req.params.fpo)] : []);
      res.json(rows.map((r) => ({ ...r, AMOUNT: r.AMOUNT == null ? null : Number(r.AMOUNT) })));
    } catch (err) {
      console.error("[fpo-exp GET]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 2. Save expense amounts (rows with 0 / blank are removed) ─────────────
  router.put("/fpo-exp", async (req, res) => {
    const fpoNo = s(req.body?.fpoNo);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!fpoNo) return res.status(400).json({ error: "fpoNo required" });
    if (!(await tableCols("fpo_exp")).size) {
      const any = rows.some((r) => Math.abs(num(r.amount) || 0) >= 0.005);
      return any
        ? res.status(409).json({ error: "Table fpo_exp is missing — run fpo_extra.sql" })
        : res.json({ ok: true, saved: 0 });
    }
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM fpo_exp WHERE FPO_NO = ?`, [fpoNo]);
      const vals = rows
        .map((r) => [fpoNo, s(r.expCode), Math.round((num(r.amount) || 0) * 100) / 100])
        .filter((v) => v[1] && Math.abs(v[2]) >= 0.005);
      if (vals.length) await conn.query(`INSERT INTO fpo_exp (FPO_NO, GIT_CODE, AMOUNT) VALUES ?`, [vals]);
      await conn.commit();
      res.json({ ok: true, saved: vals.length });
    } catch (err) {
      await conn.rollback();
      console.error("[fpo-exp PUT]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    } finally {
      conn.release();
    }
  });

  // ── 3. Header extras on fpo_net ───────────────────────────────────────────
  // Conv. rate + expenses total, and the header fields /api/fponet does not
  // return (and save-fpo may not write): currency, Yr.Ref.No, Pay Terms and
  // Prepared / Reviewed / Approved By. Saved straight after save-fpo and
  // loaded back on EDIT, so they come back whatever those two routes do.
  const rateCol = () => pick("fpo_net", ["CONV_RATE", "CONVERT_RATE", "DHS_CONV_RATE", "EXCH_RATE"]);
  const expCol = () => pick("fpo_net", ["EXP_AMOUNT", "EXP_AMT", "EXPENSES"]);
  // body key → fpo_net column, max length
  const TEXT_COLS = [
    ["curCode", "CURR_ENCY", 3],
    ["yrRefNo", "YR_REF_NO", 20],
    ["payTerms", "PAY_TERMS", 30],
    ["preparedBy", "PREPARED_BY", 40],
    ["reviewedBy", "REVIEWED_BY", 40],
    ["approvedBy", "APPROVED_BY", 40],
  ];

  router.get("/fpo-extra/:fpo", async (req, res) => {
    try {
      const rc = await rateCol(), ec = await expCol();
      const txt = [];
      for (const [key, col] of TEXT_COLS) if (await pick("fpo_net", [col])) txt.push([key, col]);
      const rows = await q(
        `SELECT ${rc || "NULL"} AS R, ${ec || "NULL"} AS E
                ${txt.map(([key, col]) => `, ${col} AS \`${key}\``).join("")}
           FROM fpo_net WHERE FPO_NO = ? LIMIT 1`,
        [s(req.params.fpo)]);
      const r = rows[0] || {};
      const out = {
        convRate: r.R == null ? null : Number(r.R),
        expAmount: r.E == null ? null : Number(r.E),
      };
      for (const [key] of txt) out[key] = r[key] == null ? null : s(r[key]);
      res.json(out);
    } catch (err) {
      console.error("[fpo-extra GET]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // body: { fpoNo, convRate, expAmount, curCode, yrRefNo, payTerms, preparedBy, reviewedBy, approvedBy }
  // A text field is written only when it is present in the body.
  router.put("/fpo-extra", async (req, res) => {
    const fpoNo = s(req.body?.fpoNo);
    if (!fpoNo) return res.status(400).json({ error: "fpoNo required" });
    try {
      const rc = await rateCol(), ec = await expCol();
      const sets = [], params = [], missing = [];
      if (rc) { sets.push(`${rc} = ?`); params.push(num(req.body?.convRate)); } else missing.push("CONV_RATE");
      if (ec) { sets.push(`${ec} = ?`); params.push(num(req.body?.expAmount)); } else missing.push("EXP_AMOUNT");
      for (const [key, col, len] of TEXT_COLS) {
        if (!(key in (req.body || {}))) continue;
        if (!(await pick("fpo_net", [col]))) continue;
        const v = s(req.body[key]);
        sets.push(`${col} = ?`);
        params.push(v ? v.slice(0, len) : null);
      }
      if (sets.length) await q(`UPDATE fpo_net SET ${sets.join(", ")} WHERE FPO_NO = ?`, [...params, fpoNo]);
      if (missing.length) {
        return res.status(409).json({ error: `fpo_net has no ${missing.join(" / ")} column — run fpo_extra.sql` });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[fpo-extra PUT]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 5. Save the FPO: header upsert + lines DELETE / re-INSERT ──────────────
  // POST /api/fpo-save   { mode: 'ADD'|'EDIT', lpoNet: {...}, lpoItems: [...] }
  // (same payload shape as the old /api/save-fpo)
  //
  //  • one transaction — header and lines save together or not at all
  //  • lines: every fpo_items row of the FPO is deleted, then the screen's
  //    lines are inserted, renumbered 0001, 0002 … in screen order. No more
  //    upsert by SR_NO, so '0001' vs '1' can't leave a stale second copy.
  //  • ADD: the number on screen is taken if free; if another user saved it
  //    first, the next free one (MAX + 1, 10 digits) is used and returned.
  //  • only columns that exist in fpo_net / fpo_items are written.
  const HDR_MAP = [               // body key → fpo_net column
    ["FpoDt", "FPO_DATE"], ["SupCd", "SUP_CODE"], ["Payterms", "PAY_TERMS"],
    ["FpoNotes", "FPO_NOTES"], ["Amount", "AMOUNT"], ["Discount", "DISCOUNT"],
    ["CurCode", "CURR_ENCY"], ["ConvRate", "CONV_RATE"], ["ExpAmount", "EXP_AMOUNT"],
    ["YrRefNo", "YR_REF_NO"], ["PreparedBy", "PREPARED_BY"],
    ["ReviewedBy", "REVIEWED_BY"], ["ApprovedBy", "APPROVED_BY"],
  ];
  const HDR_LEN = { PAY_TERMS: 30, FPO_NOTES: 1000, CURR_ENCY: 3, YR_REF_NO: 20,
    PREPARED_BY: 40, REVIEWED_BY: 40, APPROVED_BY: 40, SUP_CODE: 8 };
  const ITEM_COLS = ["FPO_NO", "FPO_DATE", "SR_NO", "MAIN_SR_NO", "LOC_CODE", "CAT_CODE",
    "ITEM_CODE", "ITEM_NAME", "UNIT", "QTY", "RATE"];
  const NUMERIC = new Set(["AMOUNT", "DISCOUNT", "CONV_RATE", "EXP_AMOUNT", "QTY", "RATE", "MAIN_SR_NO"]);

  router.post("/fpo-save", async (req, res) => {
    const net = req.body?.lpoNet || {};
    const items = Array.isArray(req.body?.lpoItems) ? req.body.lpoItems : [];
    const mode = s(req.body?.mode).toUpperCase() || "EDIT";
    let fpoNo = s(net.FpoNo);
    if (!fpoNo) return res.status(400).json({ message: "FPO No is required" });
    if (!items.length) return res.status(400).json({ message: "No item lines to save" });

    const hdrCols = await tableCols("fpo_net");
    const itmCols = await tableCols("fpo_items");
    if (!hdrCols.size || !itmCols.size) return res.status(500).json({ message: "fpo_net / fpo_items not found" });

    const val = (col, v) => {
      if (v === undefined || v === null || v === "") return null;
      if (NUMERIC.has(col)) { const n = num(v); return Number.isFinite(n) ? n : null; }
      const t = s(v);
      return HDR_LEN[col] ? t.slice(0, HDR_LEN[col]) : t;
    };

    const conn = await db.getConnection();
    let changed = false;
    try {
      await conn.beginTransaction();

      // header
      const pairs = HDR_MAP.filter(([, col]) => hdrCols.has(col)).map(([key, col]) => [hdrCols.get(col), val(col, net[key])]);
      const stamp = (name) => (hdrCols.has(name) ? hdrCols.get(name) : null);
      if (mode === "ADD") {
        const [[ex]] = await conn.query(`SELECT COUNT(*) AS N FROM fpo_net WHERE FPO_NO = ? FOR UPDATE`, [fpoNo]);
        if (Number(ex.N) > 0) {
          const [[mx]] = await conn.query(
            `SELECT LPAD(COALESCE(MAX(CAST(FPO_NO AS UNSIGNED)), 0) + 1, 10, '0') AS NXT FROM fpo_net FOR UPDATE`);
          fpoNo = mx.NXT;
          changed = true;
        }
        const cols = ["FPO_NO", ...pairs.map((p) => p[0])];
        const vals = [fpoNo, ...pairs.map((p) => p[1])];
        if (stamp("CREATED_ON")) { cols.push(stamp("CREATED_ON")); vals.push(new Date()); }
        await conn.query(
          `INSERT INTO fpo_net (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
      } else {
        const [[ex]] = await conn.query(`SELECT COUNT(*) AS N FROM fpo_net WHERE FPO_NO = ? FOR UPDATE`, [fpoNo]);
        if (!Number(ex.N)) {
          await conn.rollback();
          return res.status(404).json({ message: `FPO ${fpoNo} not found` });
        }
        const sets = pairs.map((p) => `${p[0]} = ?`);
        const vals = pairs.map((p) => p[1]);
        if (stamp("LAST_EDITED_ON")) sets.push(`${stamp("LAST_EDITED_ON")} = NOW()`);
        await conn.query(`UPDATE fpo_net SET ${sets.join(", ")} WHERE FPO_NO = ?`, [...vals, fpoNo]);
      }

      // lines: delete all, re-insert in screen order
      await conn.query(`DELETE FROM fpo_items WHERE FPO_NO = ?`, [fpoNo]);
      const useCols = ITEM_COLS.filter((c) => itmCols.has(c));
      const fpoDate = val("FPO_DATE", net.FpoDt);
      const rows = items
        .filter((it) => s(it.ITEM_NAME) || s(it.ITEM_CODE))
        .map((it, i) => useCols.map((c) => {
          if (c === "FPO_NO") return fpoNo;
          if (c === "FPO_DATE") return fpoDate;
          if (c === "SR_NO") return String(i + 1).padStart(4, "0");
          if (c === "LOC_CODE") return s(it.LOC_CODE) || "01";
          if (NUMERIC.has(c)) { const n = num(it[c]); return Number.isFinite(n) ? n : null; }
          return s(it[c]) || null;
        }));
      if (rows.length) {
        await conn.query(`INSERT INTO fpo_items (${useCols.map((c) => itmCols.get(c)).join(", ")}) VALUES ?`, [rows]);
      }

      await conn.commit();
      res.json({
        ok: true,
        FpoNo: fpoNo,
        changed,
        lines: rows.length,
        message: changed
          ? `FPO No was taken by another user — saved as ${fpoNo}`
          : `FPO ${fpoNo} saved (${rows.length} line${rows.length === 1 ? "" : "s"})`,
      });
    } catch (err) {
      await conn.rollback();
      console.error("[fpo-save]", err);
      res.status(500).json({ message: err.sqlMessage || err.message });
    } finally {
      conn.release();
    }
  });

  // ── 4. Staff list (sman_mst) for Prepared / Reviewed / Approved By ────────
  router.get("/fpo-sman", async (_req, res) => {
    try {
      const rows = await q(
        `SELECT TRIM(SMAN_CODE) AS SMAN_CODE, SMAN_NAME, SMAN_DESIGNATION, SIGN_FILENAME
           FROM sman_mst
          WHERE COALESCE(TRIM(SMAN_ACTIVE), 'Y') <> 'N'
          ORDER BY SMAN_NAME`);
      res.json(rows);
    } catch (err) {
      console.error("[fpo-sman]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  return router;
};
