// ═══════════════════════════════════════════════════════════════════════════
//  fa_dep_run_api.js  —  Fixed Assets: Monthly Depreciation Run
//
//  Mount in HayatDb.js exactly like the other FA routes:
//      const faDepRunRoutes = require("./fa_dep_run_api")(connection);
//      app.use("/api", faDepRunRoutes);
//
//  Tables:  hayat_fa.fa_dep_run_hdr / fa_dep_run_dtl / fa_asset_mst /
//           fa_category_mst   +   hayat.vouchers / hayat.tran_acc
//
//  ⚠ VERIFY these three column names against your fa_category_mst DDL.
//    From FaCategoryMst.tsx I know ASSET_GL_ACC is right; adjust the other
//    two here (one place only) if your DDL spells them differently:
const COL_DEP_EXP_GL = "DEP_EXP_GL_ACC";     // Dep. Expense G/L Account
const COL_ACCUM_GL   = "ACCUM_DEP_GL_ACC";   // Accum. Dep. G/L Account
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  // ── helpers ──────────────────────────────────────────────────────────────
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  const periodBounds = (year, month) => {
    const y = Number(year), m = Number(month);
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();          // day 0 of next month
    const to = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to };
  };

  // Monthly depreciation for one asset row (straight-line or reducing balance)
  const monthlyDep = (a) => {
    const cost   = Number(a.ACQ_COST) || 0;
    const nbv    = Number(a.NBV) || 0;
    const rate   = Number(a.DEP_RATE_PCT) || 0;
    const years  = Number(a.USEFUL_LIFE_YEARS) || 0;
    const method = String(a.DEP_METHOD || "SL").toUpperCase();

    let dep = 0;
    if (method.startsWith("W") || method.startsWith("R")) {
      // WDV / Reducing balance: rate applied to opening NBV
      dep = (nbv * rate) / 100 / 12;
    } else {
      // Straight line: rate on cost if given, else cost / life
      dep = rate > 0 ? (cost * rate) / 100 / 12
          : years > 0 ? cost / (years * 12)
          : 0;
    }
    // never depreciate below zero NBV
    return round2(Math.min(round2(dep), nbv));
  };

  // ═════════════════════════════════════════════════════════════════════════
  // 1) GET /fadep-calc?year=2026&month=7
  //    Returns the computed depreciation preview for the period —
  //    or the already-saved run if one exists for that period.
  // ═════════════════════════════════════════════════════════════════════════
  router.get("/fadep-calc", async (req, res) => {
    const { year, month } = req.query;
    if (!year || !month)
      return res.status(400).json({ message: "year and month are required" });

    const { from, to } = periodBounds(year, month);

    try {
      // Already run for this period?
      const [existing] = await db.query(
        `SELECT RUN_NO, STATUS, JV_VCHR_NO, TOTAL_DEP_AMT, ASSET_COUNT, RUN_DATE
           FROM hayat_fa.fa_dep_run_hdr
          WHERE PERIOD_FROM = ? AND PERIOD_TO = ?`,
        [from, to]
      );
      if (existing.length) {
        const [dtl] = await db.query(
          `SELECT d.ASSET_CODE, a.ASSET_NAME, a.CAT_CODE, c.CAT_NAME,
                  a.DEP_METHOD, a.DEP_RATE_PCT,
                  d.OPENING_NBV, d.DEP_AMOUNT, d.CLOSING_NBV
             FROM hayat_fa.fa_dep_run_dtl d
             JOIN hayat_fa.fa_asset_mst    a ON a.ASSET_CODE = d.ASSET_CODE
        LEFT JOIN hayat_fa.fa_category_mst c ON c.CAT_CODE   = a.CAT_CODE
            WHERE d.RUN_NO = ?
            ORDER BY d.ASSET_CODE`,
          [existing[0].RUN_NO]
        );
        return res.json({ exists: true, header: existing[0], rows: dtl, from, to });
      }

      // Fresh calculation: active assets acquired on/before period end, NBV > 0
      const [assets] = await db.query(
        `SELECT a.ASSET_CODE, a.ASSET_NAME, a.CAT_CODE, c.CAT_NAME,
                a.DEP_METHOD, a.DEP_RATE_PCT, a.USEFUL_LIFE_YEARS,
                a.ACQ_COST, a.ACCUM_DEP, a.NBV
           FROM hayat_fa.fa_asset_mst a
      LEFT JOIN hayat_fa.fa_category_mst c ON c.CAT_CODE = a.CAT_CODE
          WHERE a.STATUS = 'ACTIVE'
            AND a.NBV > 0
            AND a.ACQ_DATE <= ?
          ORDER BY a.ASSET_CODE`,
        [to]
      );

      const rows = assets.map((a) => {
        const dep = monthlyDep(a);
        return {
          ASSET_CODE:    a.ASSET_CODE,
          ASSET_NAME:    a.ASSET_NAME,
          CAT_CODE:      a.CAT_CODE,
          CAT_NAME:      a.CAT_NAME,
          DEP_METHOD:    a.DEP_METHOD,
          DEP_RATE_PCT:  a.DEP_RATE_PCT,
          OPENING_NBV:   round2(a.NBV),
          DEP_AMOUNT:    dep,
          CLOSING_NBV:   round2(Number(a.NBV) - dep),
        };
      });

      res.json({ exists: false, rows, from, to });
    } catch (err) {
      console.error("fadep-calc:", err);
      res.status(500).json({ message: "DB error", error: err.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2) POST /fadep-save
  //    Body: { year, month, runDate:'YYYY-MM-DD', username,
  //            rows: [{ ASSET_CODE, OPENING_NBV, DEP_AMOUNT, CLOSING_NBV }] }
  //    Writes hdr + dtl and rolls the depreciation into fa_asset_mst
  //    (ACCUM_DEP += dep, NBV -= dep) in ONE transaction.
  // ═════════════════════════════════════════════════════════════════════════
  router.post("/fadep-save", async (req, res) => {
    const { year, month, runDate, rows, username } = req.body;
    if (!year || !month || !runDate || !Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "year, month, runDate and rows are required" });

    const { from, to } = periodBounds(year, month);
    const runNo = `DEP-${year}${String(month).padStart(2, "0")}`;   // fits VARCHAR(15)
    const total = round2(rows.reduce((s, r) => s + (Number(r.DEP_AMOUNT) || 0), 0));

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // one run per period — RUN_NO is deterministic, so a duplicate insert
      // fails cleanly on the primary key
      await conn.query(
        `INSERT INTO hayat_fa.fa_dep_run_hdr
           (RUN_NO, RUN_DATE, PERIOD_FROM, PERIOD_TO, STATUS,
            TOTAL_DEP_AMT, ASSET_COUNT, CREATED_BY)
         VALUES (?,?,?,?,'SAVED',?,?,?)`,
        [runNo, runDate, from, to, total, rows.length, username || "SYSTEM"]
      );

      for (const r of rows) {
        const dep = round2(r.DEP_AMOUNT);
        if (!(dep > 0)) continue;

        await conn.query(
          `INSERT INTO hayat_fa.fa_dep_run_dtl
             (RUN_NO, ASSET_CODE, OPENING_NBV, DEP_AMOUNT, CLOSING_NBV)
           VALUES (?,?,?,?,?)`,
          [runNo, r.ASSET_CODE, round2(r.OPENING_NBV), dep, round2(r.CLOSING_NBV)]
        );

        // roll into the register — NBV floor-guarded at 0
        await conn.query(
          `UPDATE hayat_fa.fa_asset_mst
              SET ACCUM_DEP = ACCUM_DEP + ?,
                  NBV       = GREATEST(NBV - ?, 0)
            WHERE ASSET_CODE = ?`,
          [dep, dep, r.ASSET_CODE]
        );
      }

      await conn.commit();
      res.json({ message: "Depreciation run saved", runNo, total, assetCount: rows.length });
    } catch (err) {
      await conn.rollback();
      console.error("fadep-save:", err);
      if (err.code === "ER_DUP_ENTRY")
        return res.status(409).json({ message: `Run ${runNo} already exists for this period.` });
      res.status(500).json({ message: "Save failed — rolled back", error: err.message });
    } finally {
      conn.release();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3) POST /fadep-post-jv
  //    Body: { runNo, jvDate?:'YYYY-MM-DD', username }
  //    Groups the run's depreciation by category G/L accounts and posts:
  //        Dr  Depreciation Expense A/c   (per category)
  //        Cr  Accumulated Depreciation A/c (per category)
  //    into vouchers + tran_acc with TRAN_TYPE = '15', then stamps the
  //    header with JV_VCHR_TYPE/JV_VCHR_NO and STATUS = 'POSTED'.
  // ═════════════════════════════════════════════════════════════════════════
  router.post("/fadep-post-jv", async (req, res) => {
    const { runNo, jvDate, username } = req.body;
    if (!runNo) return res.status(400).json({ message: "runNo is required" });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // lock the header row so two clicks can't double-post
      const [hdrRows] = await conn.query(
        `SELECT * FROM hayat_fa.fa_dep_run_hdr WHERE RUN_NO = ? FOR UPDATE`,
        [runNo]
      );
      if (!hdrRows.length) throw new Error(`Run ${runNo} not found`);
      const hdr = hdrRows[0];
      if (hdr.JV_VCHR_NO)
        throw new Error(`Run ${runNo} is already posted as JV ${hdr.JV_VCHR_NO}`);

      // detail joined to category G/L accounts, grouped per category
      const [lines] = await conn.query(
        `SELECT a.CAT_CODE, c.CAT_NAME,
                c.${COL_DEP_EXP_GL} AS DEP_EXP_ACC,
                c.${COL_ACCUM_GL}   AS ACCUM_ACC,
                SUM(d.DEP_AMOUNT)   AS DEP_AMT
           FROM hayat_fa.fa_dep_run_dtl d
           JOIN hayat_fa.fa_asset_mst    a ON a.ASSET_CODE = d.ASSET_CODE
           JOIN hayat_fa.fa_category_mst c ON c.CAT_CODE   = a.CAT_CODE
          WHERE d.RUN_NO = ?
          GROUP BY a.CAT_CODE, c.CAT_NAME, c.${COL_DEP_EXP_GL}, c.${COL_ACCUM_GL}`,
        [runNo]
      );
      if (!lines.length) throw new Error("Run has no detail lines to post");

      const missing = lines.filter((l) => !l.DEP_EXP_ACC || !l.ACCUM_ACC);
      if (missing.length)
        throw new Error(
          `Category ${missing.map((m) => m.CAT_CODE).join(", ")} is missing ` +
          `Dep.Expense / Accum.Dep G/L account — fix in Asset Category Master first.`
        );

      const total  = round2(lines.reduce((s, l) => s + Number(l.DEP_AMT), 0));
      const pDate  = jvDate || new Date().toISOString().slice(0, 10);
      const period = `${String(hdr.PERIOD_FROM).slice(0, 7)}`;         // '2026-07'
      const narr   = `Depreciation for period ${period} (Run ${runNo})`;
      const now    = new Date();
      const trDate = now.toISOString().slice(0, 10);
      const trTime = now.toTimeString().slice(0, 8);
      const user   = username || "SYSTEM";

      // next VCHR_NO within TRAN_TYPE '15'
      const [[{ nextNo }]] = await conn.query(
        `SELECT COALESCE(MAX(CAST(VCHR_NO AS UNSIGNED)), 0) + 1 AS nextNo
           FROM vouchers WHERE TRAN_TYPE = '15'`
      );
      const vchrNo = String(nextNo);

      // ── vouchers header ────────────────────────────────────────────────
      await conn.query(
        `INSERT INTO vouchers
           (TRAN_TYPE, VCHR_NO, DATTE, ACC_CODE, ACC_CODE2,
            AMOUNT, NARRATION1, VCHR_TYPE, CUR_CODE, REF_NO, USERNAME)
         VALUES ('15',?,?,?,?,?,?,'DP','AED',?,?)`,
        [vchrNo, pDate,
         lines[0].DEP_EXP_ACC, lines[0].ACCUM_ACC,
         total, narr, runNo, user]
      );

      // ── tran_acc lines: Dr expense / Cr accum-dep per category ─────────
      let sr = 1;
      for (const l of lines) {
        const amt = round2(l.DEP_AMT);
        if (!(amt > 0)) continue;

        await conn.query(
          `INSERT INTO tran_acc
             (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
              NARRATION1, NARRATION2, USERNAME, SR_NO, TRANS_DATE, TRANS_TIME, REF_NO)
           VALUES ('15',?,?,?,?,'D',?,?,?,?,?,?,?)`,
          [vchrNo, pDate, l.DEP_EXP_ACC, amt, narr,
           `Cat: ${l.CAT_CODE} ${l.CAT_NAME || ""}`.trim(),
           user, String(sr++).padStart(4, "0"), trDate, trTime, runNo]
        );

        await conn.query(
          `INSERT INTO tran_acc
             (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
              NARRATION1, NARRATION2, USERNAME, SR_NO, TRANS_DATE, TRANS_TIME, REF_NO)
           VALUES ('15',?,?,?,?,'C',?,?,?,?,?,?,?)`,
          [vchrNo, pDate, l.ACCUM_ACC, amt, narr,
           `Cat: ${l.CAT_CODE} ${l.CAT_NAME || ""}`.trim(),
           user, String(sr++).padStart(4, "0"), trDate, trTime, runNo]
        );
      }

      // ── stamp the run header ───────────────────────────────────────────
      await conn.query(
        `UPDATE hayat_fa.fa_dep_run_hdr
            SET STATUS = 'POSTED', JV_VCHR_TYPE = '15', JV_VCHR_NO = ?
          WHERE RUN_NO = ?`,
        [vchrNo, runNo]
      );

      await conn.commit();
      res.json({ message: "Depreciation JV posted", vchrNo, tranType: "15", total });
    } catch (err) {
      await conn.rollback();
      console.error("fadep-post-jv:", err);
      res.status(500).json({ message: err.message || "Posting failed — rolled back" });
    } finally {
      conn.release();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4) GET /fadep-runs        — run history (for Depreciation Run History)
  //    GET /fadep-run/:runNo  — one run's header + detail
  // ═════════════════════════════════════════════════════════════════════════
  router.get("/fadep-runs", async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT RUN_NO, DATE_FORMAT(RUN_DATE,'%d/%m/%Y')    AS RUN_DATE,
                DATE_FORMAT(PERIOD_FROM,'%d/%m/%Y')          AS PERIOD_FROM,
                DATE_FORMAT(PERIOD_TO,'%d/%m/%Y')            AS PERIOD_TO,
                STATUS, TOTAL_DEP_AMT, ASSET_COUNT, JV_VCHR_NO, CREATED_BY
           FROM hayat_fa.fa_dep_run_hdr
          ORDER BY PERIOD_FROM DESC`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ message: "DB error", error: err.message });
    }
  });

  router.get("/fadep-run/:runNo", async (req, res) => {
    try {
      const [hdr] = await db.query(
        `SELECT * FROM hayat_fa.fa_dep_run_hdr WHERE RUN_NO = ?`,
        [req.params.runNo]
      );
      const [dtl] = await db.query(
        `SELECT d.*, a.ASSET_NAME, a.CAT_CODE
           FROM hayat_fa.fa_dep_run_dtl d
           JOIN hayat_fa.fa_asset_mst a ON a.ASSET_CODE = d.ASSET_CODE
          WHERE d.RUN_NO = ? ORDER BY d.ASSET_CODE`,
        [req.params.runNo]
      );
      res.json({ header: hdr[0] || null, rows: dtl });
    } catch (err) {
      res.status(500).json({ message: "DB error", error: err.message });
    }
  });

  return router;
};
