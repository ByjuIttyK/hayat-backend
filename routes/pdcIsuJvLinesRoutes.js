/* ── PDC Issued Reversal — "Reversal JVs" tab (PdcIsuJvLines.tsx) ─────────────
   Lists and edits the posted reversal JVs (tran_acc TRAN_TYPE '25') batch by
   batch. The batch number (PIR + 6 digits) is carried in tran_acc.REF_NO and
   stamped on pdc_isu.BATCH_NO by the /save route in pdcIsuReversalRoutes.js.

   Shares the /api/pdc-isu-reversal prefix with that file; Express runs both
   routers, so nothing there has to change. Register in HayatDb.js:

     const pdcIsuJvLinesRoutes = require("./routes/pdcIsuJvLinesRoutes");
     app.use("/api", pdcIsuJvLinesRoutes(connection));

   GET  /pdc-isu-reversal/jv-batches   ?from&to&batchNo
   GET  /pdc-isu-reversal/jv-cheques   ?batchNo
   GET  /pdc-isu-reversal/jv-lines     ?batchNo
   GET  /pdc-isu-reversal/acc-name     ?code
   PUT  /pdc-isu-reversal/jv-lines     { batchNo, lines: [...] }              */

const express = require("express");

const TRAN_TYPE = "25";

module.exports = function (connection) {
  const router = express.Router();
  // Callback pool → promise API (mysql2).
  const pool = typeof connection.promise === "function" ? connection.promise() : connection;

  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
  const cents = (n) => Math.round((Number(n) || 0) * 100);

  /* ── batches in a period ── */
  router.get("/pdc-isu-reversal/jv-batches", async (req, res) => {
    try {
      const { from, to, batchNo } = req.query;
      const where = ["t.TRAN_TYPE = ?", "t.REF_NO LIKE 'PIR%'"];
      const args = [TRAN_TYPE];
      if (isIso(from)) { where.push("t.DATTE >= ?"); args.push(from); }
      if (isIso(to))   { where.push("t.DATTE <= ?"); args.push(to); }
      if (batchNo && String(batchNo).trim()) {
        where.push("t.REF_NO LIKE ?");
        args.push(`%${String(batchNo).trim()}%`);
      }
      const [rows] = await pool.query(
        `SELECT t.REF_NO                                   AS BATCH_NO,
                DATE_FORMAT(MIN(t.DATTE), '%Y-%m-%d')      AS JV_DATE,
                COUNT(DISTINCT t.VCHR_NO)                  AS JV_COUNT,
                SUM(CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE 0 END) AS DR_TOTAL,
                SUM(CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE 0 END) AS CR_TOTAL
           FROM tran_acc t
          WHERE ${where.join(" AND ")}
          GROUP BY t.REF_NO
          ORDER BY t.REF_NO DESC`,
        args
      );
      res.json(rows.map((r) => ({
        ...r,
        DR_TOTAL: Number(r.DR_TOTAL) || 0,
        CR_TOTAL: Number(r.CR_TOTAL) || 0,
      })));
    } catch (err) {
      console.error("[pdc-isu jv-batches]", err);
      res.status(500).json({ message: err.sqlMessage || err.message });
    }
  });

  /* ── the cheques behind a batch (pdc_isu) ── */
  router.get("/pdc-isu-reversal/jv-cheques", async (req, res) => {
    const batchNo = String(req.query.batchNo || "").trim();
    if (!batchNo) return res.status(400).json({ message: "batchNo is required" });
    try {
      // ASSUMPTION: pdc_isu carries the supplier in SUP_CODE and the reversal
      // JV in JV_NO_RLZ, like pdc_rcd does for the customer. Adjust the two
      // column names here if pdc_isu names them differently.
      const [rows] = await pool.query(
        `SELECT p.VCHR_NO,
                p.CHQ_NO,
                DATE_FORMAT(p.CHQ_DATE, '%Y-%m-%d') AS CHQ_DATE,
                p.CHQ_BANK,
                b.AC_HEAD                           AS BANK_HEAD,
                s.AC_HEAD                           AS PARTY,
                p.AMOUNT,
                p.JV_NO_RLZ
           FROM pdc_isu p
           LEFT JOIN ac_list b ON b.AC_CODE = p.CHQ_BANK
           LEFT JOIN ac_list s ON s.AC_CODE = p.SUP_CODE
          WHERE p.BATCH_NO = ?
          ORDER BY p.JV_NO_RLZ, p.CHQ_NO`,
        [batchNo]
      );
      res.json(rows);
    } catch (err) {
      console.error("[pdc-isu jv-cheques]", err);
      res.status(500).json({ message: err.sqlMessage || err.message });
    }
  });

  /* ── tran_acc lines of every JV in a batch ── */
  router.get("/pdc-isu-reversal/jv-lines", async (req, res) => {
    const batchNo = String(req.query.batchNo || "").trim();
    if (!batchNo) return res.status(400).json({ message: "batchNo is required" });
    try {
      const [rows] = await pool.query(
        `SELECT t.srno_row_id                      AS ROW_ID,
                t.TRAN_TYPE,
                t.VCHR_NO,
                DATE_FORMAT(t.DATTE, '%Y-%m-%d')   AS DATTE,
                t.SR_NO,
                t.ACC_CODE,
                a.AC_HEAD                          AS ACC_HEAD,
                t.DB_CR,
                t.AMOUNT,
                t.NARRATION1,
                t.REF_NO
           FROM tran_acc t
           LEFT JOIN ac_list a ON a.AC_CODE = t.ACC_CODE
          WHERE t.TRAN_TYPE = ? AND t.REF_NO = ?
          ORDER BY t.VCHR_NO, t.SR_NO + 0`,
        [TRAN_TYPE, batchNo]
      );
      res.json(rows);
    } catch (err) {
      console.error("[pdc-isu jv-lines]", err);
      res.status(500).json({ message: err.sqlMessage || err.message });
    }
  });

  /* ── account head for a typed / LOV-picked code ── */
  router.get("/pdc-isu-reversal/acc-name", async (req, res) => {
    const code = String(req.query.code || "").trim();
    if (!code) return res.status(400).json({ message: "code is required" });
    try {
      const [rows] = await pool.query(
        "SELECT AC_HEAD FROM ac_list WHERE AC_CODE = ? LIMIT 1", [code]
      );
      if (!rows.length) return res.status(404).json({ message: `${code} not found` });
      res.json({ ACC_HEAD: rows[0].AC_HEAD });
    } catch (err) {
      console.error("[pdc-isu acc-name]", err);
      res.status(500).json({ message: err.sqlMessage || err.message });
    }
  });

  /* ── save edited lines ──
     The client sends every line of every JV it touched. Before writing:
       • each ROW_ID must be a TRAN_TYPE 25 line of this batch and this JV
       • each touched JV must be sent complete (no line left out)
       • each JV must balance, every amount > 0, Dr/Cr D or C, date valid
       • every A/c code must exist in ac_list
     All in one transaction — any failure leaves tran_acc untouched.        */
  router.put("/pdc-isu-reversal/jv-lines", async (req, res) => {
    const batchNo = String(req.body?.batchNo || "").trim();
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!batchNo || !lines.length) {
      return res.status(400).json({ message: "batchNo and lines are required" });
    }

    // Shape + per-JV balance, before touching the database.
    const byJv = new Map();
    for (const l of lines) {
      const dbCr = String(l.DB_CR || "").trim().toUpperCase();
      if (!Number.isInteger(Number(l.ROW_ID))) return res.status(400).json({ message: "Bad ROW_ID" });
      if (!isIso(l.DATTE)) return res.status(400).json({ message: `JV ${l.VCHR_NO}: invalid date` });
      if (dbCr !== "D" && dbCr !== "C") return res.status(400).json({ message: `JV ${l.VCHR_NO}: Dr/Cr must be D or C` });
      if (!(Number(l.AMOUNT) > 0)) return res.status(400).json({ message: `JV ${l.VCHR_NO}: amount must be greater than zero` });
      if (!String(l.ACC_CODE || "").trim()) return res.status(400).json({ message: `JV ${l.VCHR_NO}: A/c code is blank` });
      const e = byJv.get(l.VCHR_NO) || { dr: 0, cr: 0, dates: new Set(), n: 0 };
      if (dbCr === "D") e.dr += cents(l.AMOUNT); else e.cr += cents(l.AMOUNT);
      e.dates.add(l.DATTE);
      e.n += 1;
      byJv.set(l.VCHR_NO, e);
    }
    for (const [v, e] of byJv) {
      if (e.dr !== e.cr) {
        return res.status(400).json({
          message: `JV ${v} does not balance (Dr ${(e.dr / 100).toFixed(2)} / Cr ${(e.cr / 100).toFixed(2)})`,
        });
      }
      if (e.dates.size > 1) return res.status(400).json({ message: `JV ${v} has more than one date` });
    }

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      // Every line of the touched JVs, locked, as they stand now.
      const jvNos = [...byJv.keys()];
      const [current] = await conn.query(
        `SELECT srno_row_id AS ROW_ID, VCHR_NO
           FROM tran_acc
          WHERE TRAN_TYPE = ? AND REF_NO = ? AND VCHR_NO IN (?)
          FOR UPDATE`,
        [TRAN_TYPE, batchNo, jvNos]
      );
      const owner = new Map(current.map((r) => [Number(r.ROW_ID), r.VCHR_NO]));

      for (const l of lines) {
        if (owner.get(Number(l.ROW_ID)) !== l.VCHR_NO) {
          throw Object.assign(new Error(
            `Line ${l.ROW_ID} is not part of JV ${l.VCHR_NO} in batch ${batchNo} — reload and try again`
          ), { status: 409 });
        }
      }
      for (const v of jvNos) {
        const onFile = current.filter((r) => r.VCHR_NO === v).length;
        if (onFile !== byJv.get(v).n) {
          throw Object.assign(new Error(
            `JV ${v} has ${onFile} line(s) on file but ${byJv.get(v).n} were sent — reload and try again`
          ), { status: 409 });
        }
      }

      // Every A/c code must be a real account.
      const codes = [...new Set(lines.map((l) => String(l.ACC_CODE).trim()))];
      const [known] = await conn.query("SELECT AC_CODE FROM ac_list WHERE AC_CODE IN (?)", [codes]);
      const knownSet = new Set(known.map((r) => r.AC_CODE));
      const missing = codes.filter((c) => !knownSet.has(c));
      if (missing.length) {
        throw Object.assign(new Error(`Not in the chart of accounts: ${missing.join(", ")}`), { status: 400 });
      }

      let updated = 0;
      for (const l of lines) {
        const [r] = await conn.query(
          `UPDATE tran_acc
              SET DATTE = ?, ACC_CODE = ?, DB_CR = ?, AMOUNT = ?, NARRATION1 = ?
            WHERE srno_row_id = ? AND TRAN_TYPE = ? AND REF_NO = ?`,
          [
            l.DATTE,
            String(l.ACC_CODE).trim(),
            String(l.DB_CR).trim().toUpperCase(),
            Math.round(Number(l.AMOUNT) * 100) / 100,
            l.NARRATION1 ?? null,
            Number(l.ROW_ID),
            TRAN_TYPE,
            batchNo,
          ]
        );
        updated += r.changedRows || 0;
      }

      await conn.commit();
      res.json({ updated });
    } catch (err) {
      if (conn) { try { await conn.rollback(); } catch (_) { /* ignore */ } }
      console.error("[pdc-isu jv-lines PUT]", err);
      res.status(err.status || 500).json({ message: err.sqlMessage || err.message || "Save failed" });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
