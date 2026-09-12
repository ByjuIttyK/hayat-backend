/**
 * Stock Adjustment routes  —  stk_adj_hdr (header) / stk_adj (lines)
 *
 * ── Register in HayatDb.js ────────────────────────────────────────────────
 *     const stkAdjRoutes = require("./routes/stkAdjRoutes");
 *     app.use("/api", stkAdjRoutes(connection));
 *
 *   IMPORTANT: if an older /api/save-sadj handler still exists anywhere in
 *   HayatDb.js, delete it.  Express runs the FIRST matching handler, so an
 *   old one pointing at stk_hdr will keep throwing 500 even after this file
 *   is registered.  Search for "save-sadj" and remove the earlier block.
 *
 * ── Endpoints ────────────────────────────────────────────────────────────
 *   GET  /api/sadj-nextno        → { VchrNo: "0000000012" }
 *   GET  /api/sadjhdr/:vchrNo    → [{ VCHR_NO, VCHR_DATE, NARRATION }]
 *   GET  /api/sadjitems/:vchrNo  → [{ SR_NO, ITEM_CODE, ITEM_NAME, ... }]
 *   POST /api/save-sadj          → { ok, VchrNo, lines }
 *
 * ── Tables (as created) ──────────────────────────────────────────────────
 *   stk_adj_hdr : VCHR_NO varchar(10) NOT NULL, VCHR_DATE datetime,
 *                 NARRATION varchar(100)
 *   stk_adj     : VCHR_NO varchar(10) PK, SR_NO varchar(4) PK, VCHR_DATE,
 *                 LOC_CODE varchar(2), ITEM_CODE varchar(20),
 *                 QTY decimal(12,2), STD_COST decimal(12,2),
 *                 NARRATION varchar(30), APPROVED varchar(1) default 'N',
 *                 DR_ACC varchar(9), CR_ACC varchar(9), USER_NAME varchar(30),
 *                 srno_row_id bigint auto_increment (never inserted)
 *
 * Table names are lowercase — the VPS runs lower_case_table_names=0.
 */
const express = require("express");

const HDR = "stk_adj_hdr";
const DTL = "stk_adj";
const ITEM_MST = "item_mst";     // ← adjust if your item master is named differently
const ITEM_NAME_COL = "ITEM_NAME";
const DOC_WIDTH = 10;            // VCHR_NO is varchar(10), zero padded
const SR_WIDTH = 4;              // SR_NO is varchar(4), zero padded
const DEFAULT_LOC = "01";        // location the screen defaults to

module.exports = function (connection) {
  const router = express.Router();

  // Works whether `connection` is a mysql2 pool or a single connection.
  const pool = connection.promise ? connection.promise() : connection;
  const canTransact = typeof pool.getConnection === "function";

  const pad = (v, w) => String(v).padStart(w, "0");
  const trimStr = (v, n) =>
    v === null || v === undefined ? null : String(v).trim().slice(0, n) || null;
  const toNum = (v) => {
    const n = parseFloat(String(v ?? "").replace(/,/g, ""));
    return isNaN(n) ? 0 : n;
  };

  /** yyyy-MM-dd for MySQL, accepting dd/MM/yyyy or ISO in. */
  const toDbDate = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  /** max numeric VCHR_NO + 1, zero padded to 10 */
  const nextVoucherNo = async (runner) => {
    const r = runner || pool;
    const [rows] = await r.query(
      `SELECT COALESCE(MAX(CAST(TRIM(VCHR_NO) AS UNSIGNED)), 0) AS mx FROM ${HDR}`
    );
    return pad(Number(rows[0].mx) + 1, DOC_WIDTH);
  };

  const fail = (res, err, where, msg) => {
    console.error(`[${where}]`, err);
    res.status(500).json({
      message: msg,
      detail: err && (err.sqlMessage || err.message),
      code: err && err.code,
    });
  };

  // ── next voucher number ────────────────────────────────────────────────
  router.get("/sadj-nextno", async (req, res) => {
    try {
      res.json({ VchrNo: await nextVoucherNo() });
    } catch (err) {
      fail(res, err, "sadj-nextno", "Could not allocate a voucher number");
    }
  });

  // ── header ─────────────────────────────────────────────────────────────
  router.get("/sadjhdr/:vchrNo", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT TRIM(VCHR_NO) AS VCHR_NO,
                DATE_FORMAT(VCHR_DATE, '%d/%m/%Y') AS VCHR_DATE,
                NARRATION
           FROM ${HDR}
          WHERE TRIM(VCHR_NO) = TRIM(?)`,
        [req.params.vchrNo]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "sadjhdr", "Could not read the voucher header");
    }
  });

  // ── lines ──────────────────────────────────────────────────────────────
  router.get("/sadjitems/:vchrNo", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT TRIM(a.SR_NO)     AS SR_NO,
                TRIM(a.VCHR_NO)   AS VCHR_NO,
                a.LOC_CODE,
                TRIM(a.ITEM_CODE) AS ITEM_CODE,
                COALESCE(i.${ITEM_NAME_COL}, '') AS ITEM_NAME,
                COALESCE(i.${ITEM_NAME_COL}, '') AS ITEM_DESC,
                a.NARRATION,
                a.QTY,
                a.STD_COST
           FROM ${DTL} a
           LEFT JOIN ${ITEM_MST} i
                  ON TRIM(i.ITEM_CODE) = TRIM(a.ITEM_CODE)
          WHERE TRIM(a.VCHR_NO) = TRIM(?)
          ORDER BY CAST(a.SR_NO AS UNSIGNED)`,
        [req.params.vchrNo]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "sadjitems", "Could not read the voucher lines");
    }
  });

  // ── save (insert for ADD, rewrite for EDIT) ────────────────────────────
  router.post("/save-sadj", async (req, res) => {
    const { netData = {}, itemsData = [] } = req.body || {};

    const vchrDate = toDbDate(netData.VchrDt);
    const narration = trimStr(netData.Narration, 100);
    const userName = trimStr(netData.UserName, 30);
    const mode = String(netData.Mode || "ADD").toUpperCase();

    const lines = (itemsData || []).filter((r) => r && String(r.ITEM_CODE || "").trim());

    if (!vchrDate) return res.status(400).json({ message: "Voucher date is required" });
    if (!lines.length) return res.status(400).json({ message: "At least one item line is required" });

    let conn = null;
    try {
      conn = canTransact ? await pool.getConnection() : pool;
      if (canTransact) await conn.beginTransaction();

      let vchrNo = String(netData.VchrNo || "").trim();

      const [existing] = await conn.query(
        `SELECT TRIM(VCHR_NO) AS VCHR_NO FROM ${HDR} WHERE TRIM(VCHR_NO) = TRIM(?)`,
        [vchrNo]
      );

      if (mode === "EDIT") {
        if (!existing.length) {
          if (canTransact) await conn.rollback();
          return res.status(404).json({ message: `Voucher ${vchrNo} was not found` });
        }
        await conn.query(
          `UPDATE ${HDR} SET VCHR_DATE = ?, NARRATION = ? WHERE TRIM(VCHR_NO) = TRIM(?)`,
          [vchrDate, narration, vchrNo]
        );
      } else {
        // ADD — the number may have been taken since the screen was opened
        if (!vchrNo || existing.length) vchrNo = await nextVoucherNo(conn);
        await conn.query(
          `INSERT INTO ${HDR} (VCHR_NO, VCHR_DATE, NARRATION) VALUES (?, ?, ?)`,
          [vchrNo, vchrDate, narration]
        );
      }

      // lines are always rewritten as a block, renumbered from 1
      await conn.query(`DELETE FROM ${DTL} WHERE TRIM(VCHR_NO) = TRIM(?)`, [vchrNo]);

      const values = lines.map((r, i) => [
        vchrNo,                                   // VCHR_NO
        pad(i + 1, SR_WIDTH),                     // SR_NO  (varchar(4))
        vchrDate,                                 // VCHR_DATE
        trimStr(r.LOC_CODE, 2) || DEFAULT_LOC,    // LOC_CODE
        trimStr(r.ITEM_CODE, 20),                 // ITEM_CODE
        toNum(r.QTY),                             // QTY
        toNum(r.STD_COST),                        // STD_COST — filled below if 0
        trimStr(r.NARRATION, 30),                 // NARRATION
        "N",                                      // APPROVED
        trimStr(r.DR_ACC, 9),                     // DR_ACC
        trimStr(r.CR_ACC, 9),                     // CR_ACC
        userName,                                 // USER_NAME
      ]);

      await conn.query(
        `INSERT INTO ${DTL}
           (VCHR_NO, SR_NO, VCHR_DATE, LOC_CODE, ITEM_CODE, QTY, STD_COST,
            NARRATION, APPROVED, DR_ACC, CR_ACC, USER_NAME)
         VALUES ?`,
        [values]
      );

      // Cost: the screen sends 0, so take the standing cost from the item
      // master for any line that arrived without one.  Remove this statement
      // if you would rather key the cost on the screen, or if your item
      // master has no STD_COST column.
      try {
        await conn.query(
          `UPDATE ${DTL} a
             JOIN ${ITEM_MST} i ON TRIM(i.ITEM_CODE) = TRIM(a.ITEM_CODE)
              SET a.STD_COST = COALESCE(i.STD_COST, 0)
            WHERE TRIM(a.VCHR_NO) = TRIM(?)
              AND (a.STD_COST IS NULL OR a.STD_COST = 0)`,
          [vchrNo]
        );
      } catch (e) {
        console.warn("[save-sadj] cost fill skipped:", e.sqlMessage || e.message);
      }

      if (canTransact) await conn.commit();
      res.json({ ok: true, VchrNo: vchrNo, lines: values.length });
    } catch (err) {
      if (conn && canTransact) {
        try { await conn.rollback(); } catch (e) { /* ignore */ }
      }
      fail(res, err, "save-sadj", "Could not save the stock adjustment");
    } finally {
      if (conn && canTransact && conn.release) conn.release();
    }
  });

  return router;
};
