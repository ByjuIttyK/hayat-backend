// ═══════════════════════════════════════════════════════════════════════════════
//  pay_chq_batch_api.js
//  Express routes for PDC Payment Cheque Batch module
//
//  Mount in HayatDb.js:
//    const payChqApi = require("./routes/pay_chq_batch_api");
//    app.use("/pdc_batch", payChqApi);
//    app.use("/pay_chq",   payChqApi.chqRouter);
// ═══════════════════════════════════════════════════════════════════════════════
"use strict";
const express = require("express");
const router  = express.Router();
//const db      = require("../db");   // mysql2/promise pool — adjust path if needed
const db = require('./db/connection')

// ─── Helper: run query, return rows ──────────────────────────────────────────
const q = async (sql, params = []) => {
  const [rows] = await db.query(sql, params);
  return rows;
};

// ─── PDC rule helper ──────────────────────────────────────────────────────────
const PDC_PAYABLE_AC = "201-002-0-001";
function pdcType(chqDt, batchDt) {
  if (!chqDt || !batchDt) return "BANK";
  return chqDt > batchDt ? "PDC" : "BANK";
}
function pdcAc(chqDt, batchDt, bankAc) {
  return pdcType(chqDt, batchDt) === "PDC" ? PDC_PAYABLE_AC : (bankAc || "");
}

// ─── Date normaliser: accepts "DD/MM/YYYY", "YYYY-MM-DD", JS Date ─────────────
function toSqlDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // DD/MM/YYYY → YYYY-MM-DD
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split("/");
    return `${y}-${m}-${d}`;
  }
  // already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BATCH ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /pdc_batch/next_no ────────────────────────────────────────────────────
//  Returns { BATCH_NO: "B2026-004" }
//  Logic: MAX(BATCH_NO) for current year, then +1
router.get("/next_no", async (req, res) => {
  try {
    const year = new Date().getFullYear();
    const rows = await q(
      `SELECT BATCH_NO
         FROM PAY_CHQ_BATCH
        WHERE BATCH_NO LIKE ?
        ORDER BY BATCH_NO DESC
        LIMIT 1`,
      [`B${year}-%`]
    );
    let nextSeq = 1;
    if (rows.length > 0) {
      // BATCH_NO format: B2026-003  → extract "003" → 3 → +1 → 4
      const last = rows[0].BATCH_NO;                     // "B2026-003"
      const parts = last.split("-");                     // ["B2026","003"]
      const seq   = parseInt(parts[parts.length - 1], 10); // 3
      if (!isNaN(seq)) nextSeq = seq + 1;
    }
    const batchNo = `B${year}-${String(nextSeq).padStart(3, "0")}`;
    res.json({ BATCH_NO: batchNo });
  } catch (e) {
    console.error("[next_no]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /pdc_batch  (master list) ────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const rows = await q(
      `SELECT
         b.BATCH_NO, b.BATCH_DT, b.SUP_CODE, b.SUP_NAME,
         b.BANK_CODE, b.BANK_NAME, b.CURRENCY, b.NARRATION,
         b.STATUS, b.PV_NO,
         COUNT(d.SEQ)                                  AS CHQ_COUNT,
         COALESCE(SUM(d.AMOUNT), 0)                    AS CHQ_TOTAL,
         SUM(d.PRINT_STATUS IN ('Printed','Cleared'))  AS PRINTED_COUNT
       FROM PAY_CHQ_BATCH b
       LEFT JOIN PAY_CHQ_BATCH_DET d ON d.BATCH_NO = b.BATCH_NO
       GROUP BY b.BATCH_NO,
                b.BATCH_DT, b.SUP_CODE, b.SUP_NAME,
                b.BANK_CODE, b.BANK_NAME, b.CURRENCY,
                b.NARRATION, b.STATUS, b.PV_NO
       ORDER BY b.BATCH_DT DESC, b.BATCH_NO DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error("[GET /]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /pdc_batch/:batchNo  (single batch for edit form) ────────────────────
router.get("/:batchNo", async (req, res) => {
  try {
    const { batchNo } = req.params;

    const [header] = await q(
      `SELECT * FROM PAY_CHQ_BATCH WHERE BATCH_NO = ?`,
      [batchNo]
    );
    if (!header) return res.status(404).json({ error: "Batch not found" });

    const cheques = await q(
      `SELECT SEQ, CHQ_NO, CHQ_DT, BANK_NAME, BRANCH, BANK_AC,
              PDC_TYPE, PDC_AC, AMOUNT, CURRENCY, NARRATION, PRINT_STATUS, PRINT_DT
         FROM PAY_CHQ_BATCH_DET
        WHERE BATCH_NO = ?
        ORDER BY CHQ_DT, SEQ`,
      [batchNo]
    );

    const settlement = await q(
      `SELECT SEQ, DOC_NO, DOC_DT, DETAILS, INV_AMT, PV_AMT
         FROM PAY_CHQ_BATCH_STL
        WHERE BATCH_NO = ?
        ORDER BY SEQ`,
      [batchNo]
    );

    res.json({ header, cheques, settlement });
  } catch (e) {
    console.error("[GET /:batchNo]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /pdc_batch  (create new batch) ──────────────────────────────────────
router.post("/", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { header, cheques = [], settlement = [] } = req.body;

    // Validate required fields
    if (!header.BATCH_NO) throw new Error("BATCH_NO is required");
    if (!header.SUP_CODE)  throw new Error("Supplier is required");
    if (!header.BANK_CODE) throw new Error("Bank is required");

    const batchDt = toSqlDate(header.BATCH_DT) || new Date().toISOString().slice(0,10);

    // ── Insert header ──────────────────────────────────────────────────────
    await conn.query(
      `INSERT INTO PAY_CHQ_BATCH
         (BATCH_NO, BATCH_DT, SUP_CODE, SUP_NAME,
          BANK_CODE, BANK_NAME, CURRENCY, NARRATION, STATUS, PV_NO,
          CREATED_BY)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        header.BATCH_NO,
        batchDt,
        header.SUP_CODE,
        header.SUP_NAME  || "",
        header.BANK_CODE,
        header.BANK_NAME || "",
        header.CURRENCY  || "AED",
        header.NARRATION || "",
        header.STATUS    || "Draft",
        "",
        header.CREATED_BY || req.user?.userId || "",
      ]
    );

    // ── Insert cheque rows ────────────────────────────────────────────────
    const validCheques = cheques.filter(c => String(c.CHQ_NO || "").trim());
    for (let i = 0; i < validCheques.length; i++) {
      const c    = validCheques[i];
      const cDt  = toSqlDate(c.CHQ_DT);
      const type = pdcType(cDt, batchDt);
      const ac   = pdcAc(cDt, batchDt, c.BANK_AC || header.BANK_AC || "");

      await conn.query(
        `INSERT INTO PAY_CHQ_BATCH_DET
           (BATCH_NO, SEQ, CHQ_NO, CHQ_DT,
            BANK_NAME, BRANCH, BANK_AC,
            PDC_TYPE, PDC_AC,
            AMOUNT, CURRENCY, NARRATION,
            PRINT_STATUS)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          header.BATCH_NO,
          c.SEQ || (i + 1),
          String(c.CHQ_NO).trim(),
          cDt,
          c.BANK_NAME    || header.BANK_NAME || "",
          c.BRANCH       || "",
          c.BANK_AC      || header.BANK_AC   || "",
          type,
          ac,
          parseFloat(c.AMOUNT)   || 0,
          c.CURRENCY     || header.CURRENCY  || "AED",
          c.NARRATION    || "",
          c.PRINT_STATUS || "Pending",
        ]
      );
    }

    // ── Insert settlement rows ────────────────────────────────────────────
    const validStl = settlement.filter(s => String(s.DOC_NO || "").trim());
    for (let i = 0; i < validStl.length; i++) {
      const s = validStl[i];
      await conn.query(
        `INSERT INTO PAY_CHQ_BATCH_STL
           (BATCH_NO, SEQ, DOC_NO, DOC_DT, DETAILS, INV_AMT, PV_AMT)
         VALUES (?,?,?,?,?,?,?)`,
        [
          header.BATCH_NO,
          s.SEQ || (i + 1),
          String(s.DOC_NO).trim(),
          toSqlDate(s.DOC_DT),
          s.DETAILS || "",
          parseFloat(s.INV_AMT) || 0,
          parseFloat(s.PV_AMT)  || 0,
        ]
      );
    }

    await conn.commit();
    console.log(`[POST] Batch ${header.BATCH_NO} created — ${validCheques.length} cheques`);
    res.json({ success: true, BATCH_NO: header.BATCH_NO });

  } catch (e) {
    await conn.rollback();
    console.error("[POST /]", e.message);
    // Duplicate cheque number gives a cleaner message
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        error: "Duplicate cheque number — one or more cheque numbers already exist in the system."
      });
    }
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ── PUT /pdc_batch/:batchNo  (update existing batch) ─────────────────────────
router.put("/:batchNo", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { batchNo } = req.params;
    const { header, cheques = [], settlement = [] } = req.body;

    // Guard: cannot edit PV Done or Closed
    const [existing] = await q(
      `SELECT STATUS FROM PAY_CHQ_BATCH WHERE BATCH_NO = ?`, [batchNo]
    );
    if (!existing) return res.status(404).json({ error: "Batch not found" });
    if (["PV Done","Closed"].includes(existing.STATUS))
      return res.status(400).json({ error: `Cannot edit a ${existing.STATUS} batch` });

    const batchDt = toSqlDate(header.BATCH_DT) || new Date().toISOString().slice(0,10);

    // ── Update header ──────────────────────────────────────────────────────
    await conn.query(
      `UPDATE PAY_CHQ_BATCH SET
         BATCH_DT   = ?,
         SUP_CODE   = ?,
         SUP_NAME   = ?,
         BANK_CODE  = ?,
         BANK_NAME  = ?,
         CURRENCY   = ?,
         NARRATION  = ?,
         STATUS     = ?,
         UPDATED_DT = NOW()
       WHERE BATCH_NO = ?`,
      [
        batchDt,
        header.SUP_CODE,
        header.SUP_NAME  || "",
        header.BANK_CODE,
        header.BANK_NAME || "",
        header.CURRENCY  || "AED",
        header.NARRATION || "",
        header.STATUS    || "Draft",
        batchNo,
      ]
    );

    // ── Delete old detail rows, re-insert ─────────────────────────────────
    // Only delete cheque rows that are NOT already Printed/Cleared
    await conn.query(
      `DELETE FROM PAY_CHQ_BATCH_DET
        WHERE BATCH_NO = ? AND PRINT_STATUS = 'Pending'`,
      [batchNo]
    );
    await conn.query(
      `DELETE FROM PAY_CHQ_BATCH_STL WHERE BATCH_NO = ?`,
      [batchNo]
    );

    // Re-insert cheque rows
    const validCheques = cheques.filter(c => String(c.CHQ_NO || "").trim());
    for (let i = 0; i < validCheques.length; i++) {
      const c    = validCheques[i];
      const cDt  = toSqlDate(c.CHQ_DT);
      const type = c.PDC_TYPE || pdcType(cDt, batchDt);
      const ac   = c.PDC_AC   || pdcAc(cDt, batchDt, c.BANK_AC || header.BANK_AC || "");

      await conn.query(
        `INSERT INTO PAY_CHQ_BATCH_DET
           (BATCH_NO, SEQ, CHQ_NO, CHQ_DT,
            BANK_NAME, BRANCH, BANK_AC,
            PDC_TYPE, PDC_AC,
            AMOUNT, CURRENCY, NARRATION,
            PRINT_STATUS)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           CHQ_DT       = VALUES(CHQ_DT),
           BANK_NAME    = VALUES(BANK_NAME),
           BRANCH       = VALUES(BRANCH),
           BANK_AC      = VALUES(BANK_AC),
           PDC_TYPE     = VALUES(PDC_TYPE),
           PDC_AC       = VALUES(PDC_AC),
           AMOUNT       = VALUES(AMOUNT),
           CURRENCY     = VALUES(CURRENCY),
           NARRATION    = VALUES(NARRATION)`,
        [
          batchNo,
          c.SEQ || (i + 1),
          String(c.CHQ_NO).trim(),
          cDt,
          c.BANK_NAME    || header.BANK_NAME || "",
          c.BRANCH       || "",
          c.BANK_AC      || header.BANK_AC   || "",
          type,
          ac,
          parseFloat(c.AMOUNT)  || 0,
          c.CURRENCY     || header.CURRENCY  || "AED",
          c.NARRATION    || "",
          c.PRINT_STATUS || "Pending",
        ]
      );
    }

    // Re-insert settlement rows
    const validStl = settlement.filter(s => String(s.DOC_NO || "").trim());
    for (let i = 0; i < validStl.length; i++) {
      const s = validStl[i];
      await conn.query(
        `INSERT INTO PAY_CHQ_BATCH_STL
           (BATCH_NO, SEQ, DOC_NO, DOC_DT, DETAILS, INV_AMT, PV_AMT)
         VALUES (?,?,?,?,?,?,?)`,
        [
          batchNo,
          s.SEQ || (i + 1),
          String(s.DOC_NO).trim(),
          toSqlDate(s.DOC_DT),
          s.DETAILS || "",
          parseFloat(s.INV_AMT) || 0,
          parseFloat(s.PV_AMT)  || 0,
        ]
      );
    }

    await conn.commit();
    console.log(`[PUT] Batch ${batchNo} updated — ${validCheques.length} cheques`);
    res.json({ success: true, BATCH_NO: batchNo });

  } catch (e) {
    await conn.rollback();
    console.error("[PUT /:batchNo]", e.message);
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        error: "Duplicate cheque number — one or more cheque numbers already exist."
      });
    }
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ── DELETE /pdc_batch/:batchNo  (cascade delete) ─────────────────────────────
router.delete("/:batchNo", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { batchNo } = req.params;

    const [existing] = await q(
      `SELECT STATUS FROM PAY_CHQ_BATCH WHERE BATCH_NO = ?`, [batchNo]
    );
    if (!existing) return res.status(404).json({ error: "Batch not found" });
    if (["PV Done","Closed"].includes(existing.STATUS))
      return res.status(400).json({ error: `Cannot delete a ${existing.STATUS} batch` });

    await conn.query(`DELETE FROM PAY_CHQ_BATCH_STL WHERE BATCH_NO = ?`, [batchNo]);
    await conn.query(`DELETE FROM PAY_CHQ_BATCH_DET WHERE BATCH_NO = ?`, [batchNo]);
    await conn.query(`DELETE FROM PAY_CHQ_BATCH     WHERE BATCH_NO = ?`, [batchNo]);

    await conn.commit();
    console.log(`[DELETE] Batch ${batchNo} deleted`);
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    console.error("[DELETE /:batchNo]", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ── POST /pdc_batch/:batchNo/gen_pv  (generate PV from batch) ────────────────
router.post("/:batchNo/gen_pv", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { batchNo } = req.params;

    const [batch] = await q(
      `SELECT * FROM PAY_CHQ_BATCH WHERE BATCH_NO = ?`, [batchNo]
    );
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    if (batch.STATUS === "PV Done")
      return res.status(400).json({ error: "PV already generated for this batch" });

    const cheques    = await q(
      `SELECT * FROM PAY_CHQ_BATCH_DET WHERE BATCH_NO = ? ORDER BY CHQ_DT, SEQ`, [batchNo]
    );
    const settlement = await q(
      `SELECT * FROM PAY_CHQ_BATCH_STL WHERE BATCH_NO = ? ORDER BY SEQ`, [batchNo]
    );
    const chqTotal = cheques.reduce((s, c) => s + parseFloat(c.AMOUNT), 0);

    // Generate next PV number
    const [lastPv] = await q(
      `SELECT PV_NO FROM GL_VOUCHER
        WHERE TRAN_TYPE = '04'
        ORDER BY PV_NO DESC LIMIT 1`
    );
    let pvSeq = 1;
    if (lastPv?.PV_NO) {
      const n = parseInt(lastPv.PV_NO.replace(/\D/g, ""));
      if (!isNaN(n)) pvSeq = n + 1;
    }
    const year  = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, "0");
    const pvNo  = `PV${year}${month}${String(pvSeq).padStart(4, "0")}`;
    const today = new Date().toISOString().slice(0, 10);

    // Insert GL_VOUCHER header
    await conn.query(
      `INSERT INTO GL_VOUCHER
         (PV_NO, TRAN_TYPE, VOU_DT, ACC_CODE_DR, ACC_CODE_CR,
          AMOUNT_LC, CURRENCY, NARRATION, STATUS, BATCH_NO)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [pvNo, "04", today,
       batch.SUP_CODE,
       batch.BANK_CODE,
       chqTotal,
       batch.CURRENCY,
       batch.NARRATION || `PDC Payment — Batch ${batchNo}`,
       "Posted",
       batchNo]
    );

    // Insert cheque rows into GL_VOU_CHQ
    for (const c of cheques) {
      await conn.query(
        `INSERT INTO GL_VOU_CHQ
           (PV_NO, CHQ_NO, CHQ_DT, BANK_NAME, BRANCH, BANK_AC,
            PDC_TYPE, PDC_AC, AMOUNT, CURRENCY, NARRATION, STATUS)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [pvNo, c.CHQ_NO, c.CHQ_DT,
         c.BANK_NAME, c.BRANCH, c.BANK_AC,
         c.PDC_TYPE, c.PDC_AC,
         c.AMOUNT, c.CURRENCY, c.NARRATION || "", "Pending"]
      );
    }

    // Insert settlement rows
    for (const s of settlement) {
      if (!s.DOC_NO) continue;
      await conn.query(
        `INSERT INTO GL_VOU_STL
           (PV_NO, DOC_NO, DOC_DT, DETAILS, INV_AMT, PV_AMT)
         VALUES (?,?,?,?,?,?)`,
        [pvNo, s.DOC_NO, s.DOC_DT, s.DETAILS, s.INV_AMT, s.PV_AMT]
      );
    }

    // Update batch status
    await conn.query(
      `UPDATE PAY_CHQ_BATCH SET STATUS = 'PV Done', PV_NO = ? WHERE BATCH_NO = ?`,
      [pvNo, batchNo]
    );

    await conn.commit();
    console.log(`[gen_pv] Batch ${batchNo} → PV ${pvNo}`);
    res.json({ success: true, pvNo, batchNo });

  } catch (e) {
    await conn.rollback();
    console.error("[gen_pv]", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CHQ ROUTER  — individual cheque operations  (app.use("/pay_chq", chqRouter))
// ═══════════════════════════════════════════════════════════════════════════════
const chqRouter = express.Router();

// GET /pay_chq  — all cheques (for PayChqPrint list tab)
chqRouter.get("/", async (req, res) => {
  try {
    const rows = await q(
      `SELECT d.CHQ_NO, d.CHQ_DT, d.BANK_NAME, d.BRANCH, d.BANK_AC,
              d.PDC_TYPE, d.PDC_AC, d.AMOUNT, d.CURRENCY,
              d.NARRATION, d.PRINT_STATUS, d.PRINT_DT,
              d.BATCH_NO, b.PV_NO,
              b.SUP_NAME AS PAYEE, b.SUP_CODE
         FROM PAY_CHQ_BATCH_DET d
         JOIN PAY_CHQ_BATCH b ON b.BATCH_NO = d.BATCH_NO
        ORDER BY d.CHQ_DT DESC, d.CHQ_NO DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pay_chq/print_queue/batch/:batchNo
chqRouter.get("/print_queue/batch/:batchNo", async (req, res) => {
  try {
    const { batchNo } = req.params;
    const cheques = await q(
      `SELECT d.*, b.SUP_NAME AS PAYEE, b.SUP_CODE, b.PV_NO
         FROM PAY_CHQ_BATCH_DET d
         JOIN PAY_CHQ_BATCH b ON b.BATCH_NO = d.BATCH_NO
        WHERE d.BATCH_NO = ?
        ORDER BY d.CHQ_DT, d.SEQ`,
      [batchNo]
    );
    const [batchInfo] = await q(
      `SELECT BATCH_NO, PV_NO, SUP_NAME, BANK_NAME
         FROM PAY_CHQ_BATCH WHERE BATCH_NO = ?`,
      [batchNo]
    );
    res.json({ cheques, batchInfo: batchInfo || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pay_chq/print_queue/pv/:pvNo
chqRouter.get("/print_queue/pv/:pvNo", async (req, res) => {
  try {
    const { pvNo } = req.params;
    const cheques = await q(
      `SELECT d.*, b.SUP_NAME AS PAYEE, b.SUP_CODE, b.PV_NO
         FROM PAY_CHQ_BATCH_DET d
         JOIN PAY_CHQ_BATCH b ON b.BATCH_NO = d.BATCH_NO
        WHERE b.PV_NO = ?
        ORDER BY d.CHQ_DT, d.SEQ`,
      [pvNo]
    );
    const [batchInfo] = await q(
      `SELECT BATCH_NO, PV_NO, SUP_NAME, BANK_NAME
         FROM PAY_CHQ_BATCH WHERE PV_NO = ? LIMIT 1`,
      [pvNo]
    );
    res.json({ cheques, batchInfo: batchInfo || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /pay_chq/print/:chqNo  — trigger physical print (hook JasperReports here)
chqRouter.post("/print/:chqNo", async (req, res) => {
  try {
    const { chqNo } = req.params;
    console.log(`[PayChqPrint] Printing cheque: ${chqNo}`);
    // TODO: call JasperReports / print service here
    res.json({ success: true, chqNo, message: "Print job sent" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /pay_chq/mark_printed/:chqNo
chqRouter.put("/mark_printed/:chqNo", async (req, res) => {
  try {
    const { chqNo } = req.params;
    await q(
      `UPDATE PAY_CHQ_BATCH_DET
          SET PRINT_STATUS = 'Printed', PRINT_DT = NOW()
        WHERE CHQ_NO = ?`,
      [chqNo]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────
module.exports           = router;
module.exports.chqRouter = chqRouter;
