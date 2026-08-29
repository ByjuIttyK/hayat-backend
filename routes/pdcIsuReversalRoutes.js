// ---------------------------------------------------------------------------
// pdcIsuReversalRoutes.js
//
// Backend for PdcIssueReversal.tsx — reversal of un-realised PDC issued
// (payable) cheques. Sourced from pdc_isu, posting TRAN_TYPE = '25'.
//
// Accounting direction: the original PDC issue was Dr Supplier / Cr PDC
// Payable suspense. Reversing an un-realised issued cheque therefore
// debits the PDC suspense head (pdcCode) and credits the cheque bank
// (chqBank) — clearing the suspense and restoring the bank balance.
//
// Batch handling: one BatchNo per save run, written to REF_NO on both the
// voucher header and every tran_acc leg, so a whole reversal run can be
// pulled back or reported on as a unit.
// ---------------------------------------------------------------------------

const CONFIG = {
  vouchers: {
    table: "vouchers",
    tranType: "TRAN_TYPE",
    vchrNo: "VCHR_NO",
    date: "DATTE",
    refNo: "REF_NO",
    narration: "NARRATION1",
  },
  tranAcc: {
    table: "tran_acc",
    tranType: "TRAN_TYPE",
    vchrNo: "VCHR_NO",
    date: "DATTE",
    srNo: "SR_NO",
    refNo: "REF_NO",
    accCode: "ACC_CODE",
    amount: "AMOUNT",
    dbCr: "DB_CR", // 'D' / 'C'
    narration: "NARRATION1",
    narration2: "NARRATION2",
  },
  accMst: { table: "acc_mst", code: "ACC_CODE", desc: "ACC_HEAD" },
  supMst: { table: "sup_mst", code: "SUP_CODE", name: "SUP_NAME" },
  bankMst: { table: "bank_mst", code: "BANK_CODE", name: "BANK_NAME" },
};

const TRAN_TYPE_REVERSAL = "25";
const BATCH_PREFIX = "PIR"; // PDC Issue Reversal
const VCHR_NO_WIDTH = 10; // zero-padded: 0000000001

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// MySQL/ISO datetime -> DD/MM/YY, for narration text. NARRATION1 is
// varchar(60), so the short form matters here.
const toDdMmYy = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = String(dt.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
};

const padVchr = (n) => String(n).padStart(VCHR_NO_WIDTH, "0");

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  // -------------------------------------------------------------------------
  // GET /api/pdc-isu-reversal/pending?asOnDate=YYYY-MM-DD
  // Un-realised (and not-yet-reversed) issued PDCs with a cheque date on or
  // before asOnDate.
  // -------------------------------------------------------------------------
  router.get("/pending", async (req, res) => {
    const { asOnDate } = req.query;
    if (!asOnDate) {
      return res.status(400).json({ message: "asOnDate is required" });
    }
    try {
      const { accMst, supMst } = CONFIG;
      // CHQ_BANK holds an acc_mst code (e.g. 111-011-0-001), so the bank
      // description comes from acc_mst — not bank_mst.
      const sql = `
        SELECT
          p.TRAN_TYPE,
          p.VCHR_NO,
          p.CHQ_NO,
          p.CHQ_DATE,
          DATE_FORMAT(p.CHQ_DATE, '%d/%m/%y') AS CHQ_DATE_FMT,
          p.PDC_CODE,
          COALESCE(a.${accMst.desc}, '') AS PDC_HEAD,
          p.CHQ_BANK,
          COALESCE(bk.${accMst.desc}, '') AS BANK_NAME,
          p.AMOUNT,
          p.SUP_CODE,
          COALESCE(s.${supMst.name}, '') AS PARTY,
          p.JV_NO_RLZ,
          p.JV_DATE_RLZ
        FROM pdc_isu p
        LEFT JOIN ${accMst.table} a  ON a.${accMst.code}  = p.PDC_CODE
        LEFT JOIN ${accMst.table} bk ON bk.${accMst.code} = p.CHQ_BANK
        LEFT JOIN ${supMst.table} s  ON s.${supMst.code}  = p.SUP_CODE
        WHERE (p.REALISED IS NULL OR p.REALISED = 'N')
          AND p.CHQ_DATE <= ?
        ORDER BY p.CHQ_DATE, p.CHQ_NO
      `;
      const [rows] = await db.query(sql, [asOnDate]);
      res.json(rows);
    } catch (err) {
      console.error("[pdc-isu-reversal/pending]", err);
      res.status(500).json({ message: "Failed to fetch pending PDC issues" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/pdc-isu-reversal/next-jv
  // Next voucher number for TRAN_TYPE = '25' (provisional; the real number
  // is re-derived and locked inside the /save transaction below).
  // -------------------------------------------------------------------------
  router.get("/next-jv", async (req, res) => {
    try {
      const { vouchers } = CONFIG;
      const [rows] = await db.query(
        `SELECT MAX(CAST(${vouchers.vchrNo} AS UNSIGNED)) AS maxVchr
         FROM ${vouchers.table}
         WHERE ${vouchers.tranType} = ?`,
        [TRAN_TYPE_REVERSAL]
      );
      const nextVchrNo = padVchr((rows[0]?.maxVchr || 0) + 1);
      res.json({ nextVchrNo });
    } catch (err) {
      console.error("[pdc-isu-reversal/next-jv]", err);
      res.status(500).json({ message: "Failed to get next JV number" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/pdc-isu-reversal/batch/:batchNo
  // Everything posted under one batch — for review or a reprint.
  // -------------------------------------------------------------------------
  router.get("/batch/:batchNo", async (req, res) => {
    try {
      const { tranAcc, accMst } = CONFIG;
      const [rows] = await db.query(
        `SELECT t.${tranAcc.vchrNo}   AS VCHR_NO,
                t.${tranAcc.srNo}     AS SR_NO,
                t.${tranAcc.accCode}  AS ACC_CODE,
                COALESCE(a.${accMst.desc}, '') AS ACC_HEAD,
                t.${tranAcc.amount}   AS AMOUNT,
                t.${tranAcc.dbCr}     AS DB_CR,
                t.${tranAcc.narration}  AS NARRATION1,
                t.${tranAcc.narration2} AS NARRATION2,
                t.${tranAcc.date}     AS DATTE
         FROM ${tranAcc.table} t
         LEFT JOIN ${accMst.table} a ON a.${accMst.code} = t.${tranAcc.accCode}
         WHERE t.${tranAcc.tranType} = ? AND t.${tranAcc.refNo} = ?
         ORDER BY CAST(t.${tranAcc.vchrNo} AS UNSIGNED), t.${tranAcc.srNo}`,
        [TRAN_TYPE_REVERSAL, req.params.batchNo]
      );
      res.json(rows);
    } catch (err) {
      console.error("[pdc-isu-reversal/batch]", err);
      res.status(500).json({ message: "Failed to fetch batch" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/pdc-isu-reversal/save
  // Body: { asOnDate, username, rows: [{ tranType, vchrNo, chqNo, chqDt,
  //         pdcCode, pdcHead, chqBank, supCode, amount }, ...] }
  //
  // Per selected row:
  //   1. Lock and derive the next JV number (TRAN_TYPE = '25').
  //   2. Insert the voucher header, carrying the batch no in REF_NO.
  //   3. Insert two tran_acc legs — Dr pdcCode (SR_NO 1) / Cr chqBank
  //      (SR_NO 2). Supplier name goes in NARRATION2 on both legs.
  //   4. Close the pdc_isu row (JV_NO_RLZ / JV_DATE_RLZ / REALISED).
  //
  // Returns { batchNo, vouchers: JvPrintRow[] } for the print hook.
  // -------------------------------------------------------------------------
  router.post("/save", async (req, res) => {
    const { asOnDate, username, rows } = req.body || {};
    if (!asOnDate || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "asOnDate and rows[] are required" });
    }

    const { vouchers, tranAcc, supMst, accMst } = CONFIG;
    const conn = await connection.promise().getConnection();

    try {
      await conn.beginTransaction();

      // ── One BatchNo for this entire reversal run ────────────────────────
      // Derived from the max existing batch on the voucher header (one row
      // per voucher, so a smaller scan than tran_acc). FOR UPDATE keeps
      // concurrent saves from landing on the same number.
      const [batchRows] = await conn.query(
        `SELECT MAX(CAST(SUBSTRING(${vouchers.refNo}, ${BATCH_PREFIX.length + 1}) AS UNSIGNED)) AS maxBatch
         FROM ${vouchers.table}
         WHERE ${vouchers.tranType} = ? AND ${vouchers.refNo} LIKE '${BATCH_PREFIX}%'
         FOR UPDATE`,
        [TRAN_TYPE_REVERSAL]
      );
      const nextBatchSeq = (batchRows[0]?.maxBatch || 0) + 1;
      const batchNo = `${BATCH_PREFIX}${String(nextBatchSeq).padStart(6, "0")}`;

      const savedVouchers = [];

      for (const row of rows) {
        const amount = Number(row.amount) || 0;
        if (amount <= 0) continue;

        // 1. Locked JV number for this row, inside the txn.
        const [maxRows] = await conn.query(
          `SELECT MAX(CAST(${vouchers.vchrNo} AS UNSIGNED)) AS maxVchr
           FROM ${vouchers.table} WHERE ${vouchers.tranType} = ? FOR UPDATE`,
          [TRAN_TYPE_REVERSAL]
        );
        const vchrNo = padVchr((maxRows[0]?.maxVchr || 0) + 1);
        const narration =
          `Reversal of PDC issued - Chq No ${row.chqNo} Dt ${toDdMmYy(row.chqDt)}`;

        // Descriptions for NARRATION2 and the print payload. Looked up here
        // rather than trusted from the client, so the posted voucher and the
        // printout can't disagree with the masters.
        const [supRows] = await conn.query(
          `SELECT ${supMst.name} AS partyName FROM ${supMst.table} WHERE ${supMst.code} = ?`,
          [row.supCode]
        );
        const partyName = supRows[0]?.partyName || row.supCode;

        const [bankRows] = await conn.query(
          `SELECT ${accMst.desc} AS bankName FROM ${accMst.table} WHERE ${accMst.code} = ?`,
          [row.chqBank]
        );
        const bankName = bankRows[0]?.bankName || row.chqBank;

        const [pdcRows] = await conn.query(
          `SELECT ${accMst.desc} AS pdcHead FROM ${accMst.table} WHERE ${accMst.code} = ?`,
          [row.pdcCode]
        );
        const pdcHead = pdcRows[0]?.pdcHead || row.pdcHead || row.pdcCode;

        // 2. Voucher header — carries the batch no.
        await conn.query(
          `INSERT INTO ${vouchers.table}
             (${vouchers.tranType}, ${vouchers.vchrNo}, ${vouchers.date}, ${vouchers.refNo}, ${vouchers.narration})
           VALUES (?, ?, ?, ?, ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, batchNo, narration]
        );

        // 3a. Dr — PDC Payable suspense (clears the accrual).
        await conn.query(
          `INSERT INTO ${tranAcc.table}
             (${tranAcc.tranType}, ${tranAcc.vchrNo}, ${tranAcc.date}, ${tranAcc.srNo}, ${tranAcc.refNo}, ${tranAcc.accCode}, ${tranAcc.amount}, ${tranAcc.dbCr}, ${tranAcc.narration}, ${tranAcc.narration2})
           VALUES (?, ?, ?, ?, ?, ?, ?, 'D', ?, ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, 1, batchNo, row.pdcCode, amount, narration, partyName]
        );

        // 3b. Cr — Cheque bank (restores the balance the issue had reduced).
        await conn.query(
          `INSERT INTO ${tranAcc.table}
             (${tranAcc.tranType}, ${tranAcc.vchrNo}, ${tranAcc.date}, ${tranAcc.srNo}, ${tranAcc.refNo}, ${tranAcc.accCode}, ${tranAcc.amount}, ${tranAcc.dbCr}, ${tranAcc.narration}, ${tranAcc.narration2})
           VALUES (?, ?, ?, ?, ?, ?, ?, 'C', ?, ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, 2, batchNo, row.chqBank, amount, narration, partyName]
        );

        // 4. Close out the original pdc_isu row.
        await conn.query(
          `UPDATE pdc_isu
             SET JV_NO_RLZ = ?, JV_DATE_RLZ = ?, REALISED = 'Y'
           WHERE TRAN_TYPE = ? AND VCHR_NO = ? AND CHQ_NO = ?`,
          [vchrNo, asOnDate, row.tranType, row.vchrNo, row.chqNo]
        );

        savedVouchers.push({
          batchNo,
          vchrNo,
          jvDate: asOnDate,
          chqNo: row.chqNo,
          chqDt: row.chqDt,
          partyCode: row.supCode,
          partyName,
          pdcCode: row.pdcCode,
          pdcHead,
          chqBank: row.chqBank,
          bankName,
          amount,
        });
      }

      if (savedVouchers.length === 0) {
        await conn.rollback();
        return res.status(400).json({ message: "No rows with a positive amount" });
      }

      await conn.commit();
      console.log(
        `[pdc-isu-reversal] ${batchNo}: ${savedVouchers.length} voucher(s) by ${username || "unknown"}`
      );
      res.json({ batchNo, vouchers: savedVouchers });
    } catch (err) {
      await conn.rollback();
      console.error("[pdc-isu-reversal/save]", err);
      res.status(500).json({ message: err.message || "Failed to save reversal" });
    } finally {
      conn.release();
    }
  });

  return router;
};
