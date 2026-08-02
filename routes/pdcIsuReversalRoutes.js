// ---------------------------------------------------------------------------
// pdcIsuReversalRoutes.js
//
// Backend for PdcIssueReversal.tsx — reversal of un-realised PDC issued
// (payable) cheques. Mirrors whatever pdc-rcd-reversal route already backs
// PdcRcdReversal.tsx, but sourced from pdc_isu and posting TRAN_TYPE = '25'.
//
// *** VERIFY BEFORE USE ***
// I don't have visibility into your actual `vouchers` / `tran_acc` /
// `acc_mst` / `sup_mst` / `bank_mst` schemas beyond what's been confirmed
// in prior sessions (DATTE date field, single AMOUNT + DB_CR pattern on
// tran_acc). The column/table names below are my best inference from your
// existing conventions (ACC_MST/SUP_MST joins used in gl_suggest_api.js,
// bank_mst joined for BANK_NAME on the received-PDC screen). Everything
// assumption-dependent is centralised in the CONFIG block so you can
// correct it in one place if a name doesn't match.
// ---------------------------------------------------------------------------

const CONFIG = {
  vouchers: {
    table: "vouchers",
    tranType: "TRAN_TYPE",
    vchrNo: "VCHR_NO",
    date: "DATTE",
    narration: "NARRATION1",
  },
  tranAcc: {
    table: "tran_acc",
    tranType: "TRAN_TYPE",
    vchrNo: "VCHR_NO",
    date: "DATTE",
    accCode: "ACC_CODE",
    amount: "AMOUNT",
    dbCr: "DB_CR", // 'D' / 'C'
    narration: "NARRATION1",
  },
  accMst: { table: "acc_mst", code: "ACC_CODE", desc: "ACC_HEAD" },
  supMst: { table: "sup_mst", code: "SUP_CODE", name: "SUP_NAME" },
  bankMst: { table: "bank_mst", code: "BANK_CODE", name: "BANK_NAME" },
};

const TRAN_TYPE_REVERSAL = "25";

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
      const { accMst, supMst, bankMst } = CONFIG;
      const sql = `
        SELECT
          p.TRAN_TYPE,
          p.VCHR_NO,
          p.CHQ_NO,
          p.CHQ_DATE,
          p.PDC_CODE,
          COALESCE(a.${accMst.desc}, '') AS PDC_HEAD,
          p.CHQ_BANK,
          COALESCE(b.${bankMst.name}, '') AS BANK_NAME,
          p.AMOUNT,
          p.SUP_CODE,
          COALESCE(s.${supMst.name}, '') AS PARTY,
          p.JV_NO_RLZ,
          p.JV_DATE_RLZ
        FROM pdc_isu p
        LEFT JOIN ${accMst.table} a ON a.${accMst.code} = p.PDC_CODE
        LEFT JOIN ${bankMst.table} b ON b.${bankMst.code} = p.CHQ_BANK
        LEFT JOIN ${supMst.table} s ON s.${supMst.code} = p.SUP_CODE
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
      const nextVchrNo = (rows[0]?.maxVchr || 0) + 1;
      res.json({ nextVchrNo });
    } catch (err) {
      console.error("[pdc-isu-reversal/next-jv]", err);
      res.status(500).json({ message: "Failed to get next JV number" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/pdc-isu-reversal/save
  // Body: { asOnDate, username, rows: [{ tranType, vchrNo, chqNo, pdcCode,
  //         pdcHead, supCode, amount }, ...] }
  //
  // For each selected row:
  //   1. Get next JV number (TRAN_TYPE = '25') inside the transaction, so
  //      concurrent saves can't collide.
  //   2. Insert voucher header.
  //   3. Insert two tran_acc legs — Dr PDC_CODE (suspense), Cr SUP_CODE
  //      (supplier) — the mirror of the received-PDC reversal's legs.
  //   4. Update the pdc_isu row: JV_NO_RLZ / JV_DATE_RLZ / REALISED = 'Y'
  //      (REALISED is reused here to mean "closed", same as the received
  //      side — verify this matches your intended semantics for a reversal
  //      vs. an actual realisation).
  //
  // Returns { vouchers: JvPrintRow[] } for the frontend's print hook.
  // -------------------------------------------------------------------------
  router.post("/save", async (req, res) => {
    const { asOnDate, username, rows } = req.body || {};
    if (!asOnDate || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "asOnDate and rows[] are required" });
    }

    const { vouchers, tranAcc } = CONFIG;
    const conn = await connection.promise().getConnection();

    try {
      await conn.beginTransaction();

      const savedVouchers = [];

      for (const row of rows) {
        const amount = Number(row.amount) || 0;
        if (amount <= 0) continue;

        // 1. Provisional -> locked JV number for this row, inside the txn.
        const [maxRows] = await conn.query(
          `SELECT MAX(CAST(${vouchers.vchrNo} AS UNSIGNED)) AS maxVchr
           FROM ${vouchers.table} WHERE ${vouchers.tranType} = ? FOR UPDATE`,
          [TRAN_TYPE_REVERSAL]
        );
        const vchrNo = String((maxRows[0]?.maxVchr || 0) + 1);
        const narration = `Reversal of PDC issued - Chq No ${row.chqNo}`;

        // 2. Voucher header.
        await conn.query(
          `INSERT INTO ${vouchers.table}
             (${vouchers.tranType}, ${vouchers.vchrNo}, ${vouchers.date}, ${vouchers.narration})
           VALUES (?, ?, ?, ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, narration]
        );

        // 3. Dr PDC Head (suspense) / Cr Supplier — mirror of the
        //    received-side reversal's Dr Party / Cr PDC Head.
        await conn.query(
          `INSERT INTO ${tranAcc.table}
             (${tranAcc.tranType}, ${tranAcc.vchrNo}, ${tranAcc.date}, ${tranAcc.accCode}, ${tranAcc.amount}, ${tranAcc.dbCr}, ${tranAcc.narration})
           VALUES (?, ?, ?, ?, ?, 'D', ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, row.pdcCode, amount, narration]
        );
        await conn.query(
          `INSERT INTO ${tranAcc.table}
             (${tranAcc.tranType}, ${tranAcc.vchrNo}, ${tranAcc.date}, ${tranAcc.accCode}, ${tranAcc.amount}, ${tranAcc.dbCr}, ${tranAcc.narration})
           VALUES (?, ?, ?, ?, ?, 'C', ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, row.supCode, amount, narration]
        );

        // 4. Close out the original pdc_isu row.
        await conn.query(
          `UPDATE pdc_isu
             SET JV_NO_RLZ = ?, JV_DATE_RLZ = ?, REALISED = 'Y'
           WHERE TRAN_TYPE = ? AND VCHR_NO = ? AND CHQ_NO = ?`,
          [vchrNo, asOnDate, row.tranType, row.vchrNo, row.chqNo]
        );

        // Supplier name isn't posted from the frontend — look it up here
        // for the print payload (JvPrintRow.partyName).
        const { supMst } = CONFIG;
        const [supRows] = await conn.query(
          `SELECT ${supMst.name} AS partyName FROM ${supMst.table} WHERE ${supMst.code} = ?`,
          [row.supCode]
        );
        const partyName = supRows[0]?.partyName || row.supCode;

        savedVouchers.push({
          vchrNo,
          jvDate: asOnDate,
          chqNo: row.chqNo,
          partyCode: row.supCode,
          partyName,
          pdcHead: row.pdcHead,
          amount,
        });
      }

      await conn.commit();
      res.json({ vouchers: savedVouchers });
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
