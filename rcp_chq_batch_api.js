// ═══════════════════════════════════════════════════════════════════════════════
//  rcp_chq_batch_api.js
//  Express routes for the PDC Cheque RECEIVED Batch module  (TRAN_TYPE '03')
//
//  Mount in HayatDb.js:
//    const rcpChqApi = require("./routes/rcp_chq_batch_api");
//    app.use("/rcp_batch", rcpChqApi);
//
//  Customer-side mirror of pay_chq_batch_api.js:
//    received cheque  →  Dr Bank (current) / PDC Receivable (post-dated),
//                        Cr Customer.   Receipt Voucher = TRAN_TYPE '03'.
// ═══════════════════════════════════════════════════════════════════════════════
"use strict";
const express = require("express");
const router  = express.Router();
const connection = require("./db/connection");
const db = connection.promise();

const q = async (sql, params = []) => { const [rows] = await db.query(sql, params); return rows; };

// ─── PDC rule (received side) ─────────────────────────────────────────────────
const PDC_RECEIVABLE_AC = "116-024-0-001";
function pdcType(chqDt, batchDt) {
  if (!chqDt || !batchDt) return "BANK";
  return chqDt > batchDt ? "PDC" : "BANK";
}
// debit account for a received cheque: PDC Receivable if post-dated, else the bank a/c
function pdcAc(chqDt, batchDt, bankAc) {
  return pdcType(chqDt, batchDt) === "PDC" ? PDC_RECEIVABLE_AC : (bankAc || "");
}

function toSqlDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [d, m, y] = s.split("/"); return `${y}-${m}-${d}`; }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

// ─── GET /rcp_batch/next_no ───────────────────────────────────────────────────
router.get("/next_no", async (req, res) => {
  try {
    const yr = new Date().getFullYear();
    const rows = await q(
      `SELECT BATCH_NO FROM rcp_chq_batch
        WHERE BATCH_NO LIKE ? ORDER BY BATCH_NO DESC LIMIT 1`, [`R${yr}-%`]);
    let next = 1;
    if (rows.length) {
      const m = rows[0].BATCH_NO.match(/-(\d+)$/);
      if (m) next = parseInt(m[1], 10) + 1;
    }
    res.json({ batchNo: `R${yr}-${String(next).padStart(3, "0")}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /rcp_batch  (list) ───────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const rows = await q(
  `SELECT
       h.BATCH_NO,
       BATCH_DT,
       h.CUST_CODE,
       h.CUST_NAME,
       h.BANK_CODE,
       h.BANK_NAME,
       h.CURRENCY,
       h.NARRATION,
       h.STATUS,
       h.RV_NO,
       h.CREATED_BY,
       DATE_FORMAT(h.CREATED_DT,'%d/%m/%Y') AS CREATED_DT,
       DATE_FORMAT(h.UPDATED_DT,'%d/%m/%Y') AS UPDATED_DT,
       (SELECT COUNT(*)            FROM rcp_chq_batch_det d WHERE d.BATCH_NO = h.BATCH_NO) AS CHQ_COUNT,
       (SELECT IFNULL(SUM(d.AMOUNT),0) FROM rcp_chq_batch_det d WHERE d.BATCH_NO = h.BATCH_NO) AS CHQ_TOTAL,
       0 AS PRINTED_COUNT
     FROM rcp_chq_batch h
     ORDER BY h.BATCH_NO DESC`);
    // mysql2 returns COUNT/SUM as strings — coerce so the grid sums (not concatenates)
    const out = rows.map(r => ({
      ...r,
      CHQ_COUNT: Number(r.CHQ_COUNT) || 0,
      CHQ_TOTAL: Number(r.CHQ_TOTAL) || 0,
      PRINTED_COUNT: Number(r.PRINTED_COUNT) || 0,
    }));
    res.json(out);
    console.log (out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /rcp_batch/:batchNo  (one batch, full) ──────────────────────────────
router.get("/:batchNo", async (req, res) => {
  try {
    const [hdr] = await q(`SELECT * FROM rcp_chq_batch WHERE BATCH_NO = ?`, [req.params.batchNo]);
    if (!hdr) return res.status(404).json({ error: "Batch not found" });
    const cheques    = await q(`SELECT * FROM rcp_chq_batch_det WHERE BATCH_NO = ? ORDER BY SEQ`, [req.params.batchNo]);
    const settlement = await q(`SELECT * FROM rcp_chq_batch_stl WHERE BATCH_NO = ? ORDER BY SEQ`, [req.params.batchNo]);
    res.json({ header: hdr, cheques, settlement });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /rcp_batch  (create) ────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { header, cheques = [], settlement = [] } = req.body;
    if (!header.BATCH_NO)  throw new Error("BATCH_NO is required");
    if (!header.CUST_CODE) throw new Error("Customer is required");
    if (!header.BANK_CODE) throw new Error("Bank is required");
    const batchDt = toSqlDate(header.BATCH_DT) || new Date().toISOString().slice(0, 10);

    await conn.query(
      `INSERT INTO rcp_chq_batch
         (BATCH_NO, BATCH_DT, CUST_CODE, CUST_NAME, BANK_CODE, BANK_NAME,
          CURRENCY, NARRATION, STATUS, RV_NO, CREATED_BY)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [header.BATCH_NO, batchDt, header.CUST_CODE, header.CUST_NAME || "",
       header.BANK_CODE, header.BANK_NAME || "", header.CURRENCY || "AED",
       header.NARRATION || "", header.STATUS || "Draft", header.RV_NO || "",
       req.user?.username || "system"]);

    const validCheques = cheques.filter(c => String(c.CHQ_NO || "").trim());
    for (let i = 0; i < validCheques.length; i++) {
      const c = validCheques[i];
      const cDt = toSqlDate(c.CHQ_DT);
      const type = pdcType(cDt, batchDt);
      const debitAc = pdcAc(cDt, batchDt, c.BANK_AC || header.BANK_AC || "");
      await conn.query(
        `INSERT INTO rcp_chq_batch_det
           (BATCH_NO, SEQ, CHQ_NO, CHQ_DT, BANK_NAME, BRANCH, DEBIT_AC,
            PDC_TYPE, AMOUNT, CURRENCY, NARRATION)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [header.BATCH_NO, c.SEQ || (i + 1), String(c.CHQ_NO).trim(), cDt,
         c.BANK_NAME || header.BANK_NAME || "", c.BRANCH || "", debitAc,
         type, parseFloat(c.AMOUNT) || 0, c.CURRENCY || header.CURRENCY || "AED",
         c.NARRATION || ""]);
    }

    const validStl = settlement.filter(s =>
      String(s.DOC_NO || "").trim() && (parseFloat(s.RV_AMT) || 0) > 0);
    for (let i = 0; i < validStl.length; i++) {
      const s = validStl[i];
      await conn.query(
        `INSERT INTO rcp_chq_batch_stl
           (BATCH_NO, SEQ, DOC_NO, DOC_TYPE, DOC_DT, DETAILS, INV_AMT, RV_AMT)
         VALUES (?,?,?,?,?,?,?,?)`,
        [header.BATCH_NO, s.SEQ || (i + 1), String(s.DOC_NO).trim(), s.DOC_TYPE || "",
         toSqlDate(s.DOC_DT), s.DETAILS || "", parseFloat(s.INV_AMT) || 0,
         parseFloat(s.RV_AMT) || 0]);
    }

    await conn.commit();
    res.json({ success: true, BATCH_NO: header.BATCH_NO });
  } catch (e) {
    await conn.rollback();
    console.error("[rcp POST /]", e.message);
    if (e.code === "ER_DUP_ENTRY")
      return res.status(400).json({ error: "Duplicate cheque number — already exists." });
    res.status(500).json({ error: e.message });
  } finally { conn.release(); }
});

// ─── PUT /rcp_batch/:batchNo  (update: delete-then-insert children) ──────────
router.put("/:batchNo", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const batchNo = req.params.batchNo;
    const { header, cheques = [], settlement = [] } = req.body;
    const batchDt = toSqlDate(header.BATCH_DT) || new Date().toISOString().slice(0, 10);

    await conn.query(
      `UPDATE rcp_chq_batch SET
         BATCH_DT=?, CUST_CODE=?, CUST_NAME=?, BANK_CODE=?, BANK_NAME=?,
         CURRENCY=?, NARRATION=?, STATUS=?, RV_NO=?
       WHERE BATCH_NO=?`,
      [batchDt, header.CUST_CODE, header.CUST_NAME || "", header.BANK_CODE,
       header.BANK_NAME || "", header.CURRENCY || "AED", header.NARRATION || "",
       header.STATUS || "Saved", header.RV_NO || "", batchNo]);

    await conn.query(`DELETE FROM rcp_chq_batch_det WHERE BATCH_NO = ?`, [batchNo]);
    await conn.query(`DELETE FROM rcp_chq_batch_stl WHERE BATCH_NO = ?`, [batchNo]);

    const validCheques = cheques.filter(c => String(c.CHQ_NO || "").trim());
    for (let i = 0; i < validCheques.length; i++) {
      const c = validCheques[i];
      const cDt = toSqlDate(c.CHQ_DT);
      const type = pdcType(cDt, batchDt);
      const debitAc = pdcAc(cDt, batchDt, c.BANK_AC || header.BANK_AC || "");
      await conn.query(
        `INSERT INTO rcp_chq_batch_det
           (BATCH_NO, SEQ, CHQ_NO, CHQ_DT, BANK_NAME, BRANCH, DEBIT_AC,
            PDC_TYPE, AMOUNT, CURRENCY, NARRATION)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [batchNo, c.SEQ || (i + 1), String(c.CHQ_NO).trim(), cDt,
         c.BANK_NAME || header.BANK_NAME || "", c.BRANCH || "", debitAc,
         type, parseFloat(c.AMOUNT) || 0, c.CURRENCY || header.CURRENCY || "AED",
         c.NARRATION || ""]);
    }

    const validStl = settlement.filter(s =>
      String(s.DOC_NO || "").trim() && (parseFloat(s.RV_AMT) || 0) > 0);
    for (let i = 0; i < validStl.length; i++) {
      const s = validStl[i];
      await conn.query(
        `INSERT INTO rcp_chq_batch_stl
           (BATCH_NO, SEQ, DOC_NO, DOC_TYPE, DOC_DT, DETAILS, INV_AMT, RV_AMT)
         VALUES (?,?,?,?,?,?,?,?)`,
        [batchNo, s.SEQ || (i + 1), String(s.DOC_NO).trim(), s.DOC_TYPE || "",
         toSqlDate(s.DOC_DT), s.DETAILS || "", parseFloat(s.INV_AMT) || 0,
         parseFloat(s.RV_AMT) || 0]);
    }

    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    console.error("[rcp PUT /]", e.message);
    res.status(500).json({ error: e.message });
  } finally { conn.release(); }
});

// ─── DELETE /rcp_batch/:batchNo ───────────────────────────────────────────────
router.delete("/:batchNo", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const b = req.params.batchNo;
    const [hdr] = await q(`SELECT RV_NO FROM rcp_chq_batch WHERE BATCH_NO = ?`, [b]);
    if (hdr && hdr.RV_NO) throw new Error("Cannot delete — Receipt Voucher already generated");
    await conn.query(`DELETE FROM rcp_chq_batch_stl WHERE BATCH_NO = ?`, [b]);
    await conn.query(`DELETE FROM rcp_chq_batch_det WHERE BATCH_NO = ?`, [b]);
    await conn.query(`DELETE FROM rcp_chq_batch     WHERE BATCH_NO = ?`, [b]);
    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally { conn.release(); }
});

// ─── POST /rcp_batch/:batchNo/generate_rv ────────────────────────────────────
//  Assigns next RV (TRAN_TYPE '03'); writes VOUCHERS, TRAN_ACC, pdc_rcd, ADJ_DTL.
//  Received cheque: Dr Bank/PDC Receivable, Cr Customer.
router.post("/:batchNo/generate_rv", async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { batchNo } = req.params;
    const username = req.user?.username || "system";

    const [[hdr]] = await conn.query(
      `SELECT * FROM rcp_chq_batch WHERE BATCH_NO = ? FOR UPDATE`, [batchNo]);
    if (!hdr) throw new Error("Batch not found");
    if (hdr.RV_NO) throw new Error(`RV ${hdr.RV_NO} already generated for this batch`);

    const [cheques] = await conn.query(
      `SELECT * FROM rcp_chq_batch_det WHERE BATCH_NO = ? ORDER BY SEQ`, [batchNo]);
    const [settlement] = await conn.query(
      `SELECT * FROM rcp_chq_batch_stl WHERE BATCH_NO = ? ORDER BY SEQ`, [batchNo]);
    if (!cheques.length) throw new Error("No cheques to post");

    const [[mx]] = await conn.query(
      `SELECT IFNULL(MAX(CAST(VCHR_NO AS UNSIGNED)),0)+1 AS NEXT_NO
         FROM VOUCHERS WHERE TRAN_TYPE = '03'`);
    const rvNo = String(mx.NEXT_NO).padStart(10, "0");

    const rvDate = hdr.BATCH_DT;
    const total  = cheques.reduce((t, c) => t + (Number(c.AMOUNT) || 0), 0);
    const now    = new Date();
    const trDate = now.toISOString().slice(0, 10);
    const trTime = now.toTimeString().slice(0, 8);

    // a) VOUCHERS — RV header. ACC_CODE = bank (the receiving account).
    await conn.query(
      `INSERT INTO VOUCHERS
         (TRAN_TYPE, VCHR_NO, DATTE, CUST_CODE, ACC_CODE, AMOUNT,
          NARRATION1, PAID_TO, CUR_CODE, REF_NO)
       VALUES ('03',?,?,?,?,?,?,?,'AED',?)`,
      [rvNo, rvDate, hdr.CUST_CODE, hdr.BANK_CODE, total,
       hdr.NARRATION || "", hdr.CUST_NAME || "", hdr.BATCH_NO]);

    // b) TRAN_ACC — Debit bank (total) + Credit customer per cheque
    let sr = 1;
    await conn.query(
      `INSERT INTO TRAN_ACC
         (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
          NARRATION1, USERNAME, SR_NO, TRANS_DATE, TRANS_TIME, REF_NO)
       VALUES ('03',?,?,?,?,'D',?,?,?,?,?,?)`,
      [rvNo, rvDate, hdr.BANK_CODE, total, hdr.NARRATION || "",
       username, String(sr++), trDate, trTime, hdr.BATCH_NO]);
    for (const c of cheques) {
      await conn.query(
        `INSERT INTO TRAN_ACC
           (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
            NARRATION1, NARRATION2, USERNAME, SR_NO, TRANS_DATE, TRANS_TIME, REF_NO)
         VALUES ('03',?,?,?,?,'C',?,?,?,?,?,?,?)`,
        [rvNo, rvDate, hdr.CUST_CODE, Number(c.AMOUNT) || 0, hdr.NARRATION || "",
         `Chq: ${c.CHQ_NO} Dt: ${c.CHQ_DT}`,
         username, String(sr++), trDate, trTime, hdr.BATCH_NO]);
    }

    // c) pdc_rcd — one row per cheque
    let psr = 1;
    for (const c of cheques) {
      await conn.query(
        `INSERT INTO pdc_rcd
           (TRAN_TYPE, VCHR_NO, VCHR_DATE, CHQ_NO, CHQ_DATE, CHQ_BANK,
            PDC_CODE, CUST_CODE, AMOUNT, NARRATION, REALISED, MAIN_SR_NO, REF_NO)
         VALUES ('03',?,?,?,?,?,?,?,?,?,'N',?,?)`,
        [rvNo, rvDate, c.CHQ_NO, c.CHQ_DT, hdr.BANK_CODE,
         hdr.BANK_CODE, hdr.CUST_CODE, Number(c.AMOUNT) || 0,
         (c.NARRATION || "").slice(0, 80), psr++, hdr.BATCH_NO]);
    }

    // d) ADJ_DTL — one row per settled invoice (RV_AMT > 0); customer debit settled
    let asr = 1;
    for (const s of settlement) {
      if (!(Number(s.RV_AMT) > 0)) continue;
      await conn.query(
        `INSERT INTO ADJ_DTL
           (SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE, ACC_CODE,
            STLD_DOC, STLD_TYPE, STLD_AMT, STLD_DBCR, STLD_DATE, MAIN_SR_NO, REF_NO)
         VALUES (?,'03',?,?,?,?,?,'D',?,?,?)`,
        [rvNo, rvDate, hdr.CUST_CODE,
         s.DOC_NO, s.DOC_TYPE || "", Number(s.RV_AMT) || 0, s.DOC_DT, asr++, hdr.BATCH_NO]);
    }

    await conn.query(
      `UPDATE rcp_chq_batch SET RV_NO = ?, STATUS = 'RV Generated' WHERE BATCH_NO = ?`,
      [rvNo, batchNo]);

    await conn.commit();
    console.log(`[generate_rv] Batch ${batchNo} → RV ${rvNo} (${cheques.length} chqs, total ${total})`);
    res.json({ success: true, RV_NO: rvNo });
  } catch (e) {
    await conn.rollback();
    console.error("[generate_rv]", e.message);
    res.status(500).json({ error: e.message });
  } finally { conn.release(); }
});

module.exports = router;
