// ---------------------------------------------------------------------------
// pdc-rcd-reversal.js
//
// Backend for PdcRcdReversal.tsx — reversal of un-realised PDC received
// (receivable) cheques. Sourced from pdc_rcd, posting TRAN_TYPE = '24'.
//
// Accounting direction: the original PDC receipt was Dr PDC Receivable
// suspense / Cr Customer. Reversing an un-realised received cheque therefore
// debits the Cheque Bank (CHQ_BANK) and credits the PDC Receivable suspense
// head (PDC_CODE) — clearing the suspense.
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
    username: "USERNAME",
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
  company: {
    table: "company",
    name: "NAME",
    place: "PLACE",
    address1: "ADDRESS1",
    address2: "ADDRESS2",
    phone: "PHONE",
    email: "EMAIL",
    website: "WEB_SITE",
  },
  cusMst:  { table: "cus_mst",  code: "CUST_CODE", name: "CUST_NAME" },
  bankMst: { table: "bank_mst", code: "BANK_CODE",  name: "BANK_NAME" },
};

const TRAN_TYPE_REVERSAL = "24";
const BATCH_PREFIX  = "PRR";  // PDC Received Reversal
const VCHR_NO_WIDTH = 10;     // zero-padded: 0000000001

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// MySQL/ISO datetime -> DD/MM/YY for narration text (NARRATION1 is varchar(60))
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
  const router  = express.Router();
  const db      = connection.promise();

  // Company letterhead — read once and cached.
  let companyCache = null;
  const getCompany = async () => {
    if (companyCache) return companyCache;
    const { company } = CONFIG;
    try {
      const [rows] = await db.query(
        `SELECT ${company.name}     AS name,
                ${company.place}    AS place,
                ${company.address1} AS address1,
                ${company.address2} AS address2,
                ${company.phone}    AS phone,
                ${company.email}    AS email,
                ${company.website}  AS website
         FROM ${company.table} LIMIT 1`
      );
      const r = rows[0] || {};
      companyCache = {
        name:    r.name    || "",
        address: [r.address1, r.address2].filter(Boolean).join(", "),
        contact: [r.phone, r.email, r.website].filter(Boolean).join("  |  "),
      };
    } catch (err) {
      console.error("[pdc-rcd-reversal/company]", err.message);
      companyCache = { name: "", address: "", contact: "" };
    }
    return companyCache;
  };

  // -------------------------------------------------------------------------
  // GET /api/pdc-rcd-reversal/pending?asOnDate=YYYY-MM-DD
  // Un-realised received PDCs with a cheque date on or before asOnDate.
  // -------------------------------------------------------------------------
  router.get("/pending", async (req, res) => {
    const { asOnDate } = req.query;
    if (!asOnDate) {
      return res.status(400).json({ message: "asOnDate is required" });
    }
    try {
      const { accMst, cusMst } = CONFIG;
      // CHQ_BANK holds an acc_mst code (same as pdc_isu), so bank description
      // comes from acc_mst — not bank_mst.
      const sql = `
        SELECT
          p.TRAN_TYPE,
          p.VCHR_NO,
          p.CHQ_NO,
          p.CHQ_DATE,
          DATE_FORMAT(p.CHQ_DATE, '%d/%m/%y')  AS CHQ_DATE_FMT,
          p.PDC_CODE,
          COALESCE(a.${accMst.desc},  '')       AS PDC_HEAD,
          p.CHQ_BANK,
          COALESCE(bk.${accMst.desc}, '')       AS BANK_NAME,
          p.AMOUNT,
          p.CUST_CODE,
          COALESCE(c.${cusMst.name},  '')       AS PARTY,
          p.JV_NO_RLZ,
          p.JV_DATE_RLZ
        FROM pdc_rcd p
        LEFT JOIN ${accMst.table} a  ON a.${accMst.code}  = p.PDC_CODE
        LEFT JOIN ${accMst.table} bk ON bk.${accMst.code} = p.CHQ_BANK
        LEFT JOIN ${cusMst.table} c  ON c.${cusMst.code}  = p.CUST_CODE
        WHERE (p.REALISED IS NULL OR p.REALISED = 'N')
          AND p.CHQ_DATE <= ?
        ORDER BY p.CHQ_DATE, p.CHQ_NO
      `;
      const [rows] = await db.query(sql, [asOnDate]);
      res.json(rows);
    } catch (err) {
      console.error("[pdc-rcd-reversal/pending]", err);
      res.status(500).json({ message: "Failed to fetch pending PDC receipts" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/pdc-rcd-reversal/next-jv
  // Next voucher number for TRAN_TYPE = '24' (provisional; re-derived and
  // locked inside the /save transaction).
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
      console.error("[pdc-rcd-reversal/next-jv]", err);
      res.status(500).json({ message: "Failed to get next JV number" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/pdc-rcd-reversal/batches?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Batch list for the lookup screen — one row per batch, newest first.
  // -------------------------------------------------------------------------
  router.get("/batches", async (req, res) => {
    const { from, to } = req.query;
    try {
      const { vouchers, tranAcc } = CONFIG;
      const where = [
        `${vouchers.tranType} = ?`,
        `${vouchers.refNo} LIKE '${BATCH_PREFIX}%'`,
      ];
      const args = [TRAN_TYPE_REVERSAL];
      if (from) { where.push(`${vouchers.date} >= ?`); args.push(from); }
      if (to)   { where.push(`${vouchers.date} <= ?`); args.push(to);   }

      const [rows] = await db.query(
        `SELECT ${vouchers.refNo}                                   AS BATCH_NO,
                MIN(${vouchers.date})                               AS BATCH_DATE,
                DATE_FORMAT(MIN(${vouchers.date}), '%d/%m/%Y')      AS BATCH_DATE_FMT,
                COUNT(*)                                            AS VOUCHER_COUNT,
                MIN(${vouchers.vchrNo})                             AS FIRST_VCHR,
                MAX(${vouchers.vchrNo})                             AS LAST_VCHR,
                MAX(${vouchers.username})                           AS CREATED_BY
         FROM ${vouchers.table}
         WHERE ${where.join(" AND ")}
         GROUP BY ${vouchers.refNo}
         ORDER BY ${vouchers.refNo} DESC`,
        args
      );

      // Batch totals from tran_acc Dr legs (header carries no amount).
      const [totRows] = await db.query(
        `SELECT ${tranAcc.refNo} AS BATCH_NO,
                SUM(${tranAcc.amount}) AS TOTAL_AMOUNT
         FROM ${tranAcc.table}
         WHERE ${tranAcc.tranType} = ?
           AND ${tranAcc.dbCr}     = 'D'
           AND ${tranAcc.refNo} LIKE '${BATCH_PREFIX}%'
         GROUP BY ${tranAcc.refNo}`,
        [TRAN_TYPE_REVERSAL]
      );
      const totals = Object.fromEntries(
        totRows.map((r) => [r.BATCH_NO, Number(r.TOTAL_AMOUNT) || 0])
      );

      res.json(rows.map((r) => ({ ...r, TOTAL_AMOUNT: totals[r.BATCH_NO] ?? 0 })));
    } catch (err) {
      console.error("[pdc-rcd-reversal/batches]", err);
      res.status(500).json({ message: "Failed to fetch batch list" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/pdc-rcd-reversal/batch/:batchNo
  // Everything posted under one batch, shaped for the register print.
  // Returns { batchNo, batchDate, createdBy, company, vouchers: [...], total }
  // -------------------------------------------------------------------------
  router.get("/batch/:batchNo", async (req, res) => {
    const batchNo = req.params.batchNo;
    try {
      const { vouchers, tranAcc, accMst, cusMst } = CONFIG;

      // One row per voucher: Dr/Cr legs pivoted. Every reversal is exactly
      // two legs:
      //   Dr  CHQ_BANK   (SR_NO 1) — bank account debited
      //   Cr  PDC_CODE   (SR_NO 2) — PDC suspense cleared
      //
      // pdc_rcd.JV_NO_RLZ is a bare voucher number with no TRAN_TYPE beside
      // it, so matching on the number alone pulls in rows closed by other
      // processes that reused the same number — one JV then rendered twice.
      // The join is therefore scoped by the accounts and amount that this
      // voucher actually posted, and GROUP BY guarantees one row per voucher
      // even if a residual collision survives.
      //
      // JV_NO_RLZ may be unpadded (old rows) or padded (new rows), so both
      // sides are CAST to UNSIGNED for a reliable numeric comparison.
      const [rows] = await db.query(
        `SELECT
           v.${vouchers.vchrNo}                                 AS VCHR_NO,
           MIN(v.${vouchers.date})                              AS JV_DATE,
           DATE_FORMAT(MIN(v.${vouchers.date}), '%d/%m/%Y')     AS JV_DATE_FMT,
           MIN(v.${vouchers.username})                          AS CREATED_BY,
           MIN(cr.${tranAcc.accCode})                           AS PDC_CODE,
           COALESCE(MIN(ca.${accMst.desc}), '')                 AS PDC_HEAD,
           MIN(dr.${tranAcc.accCode})                           AS CHQ_BANK,
           COALESCE(MIN(bk.${accMst.desc}), '')                 AS BANK_NAME,
           COALESCE(MIN(c.${cusMst.name}),  '')                 AS PARTY,
           MIN(p.CUST_CODE)                                     AS CUST_CODE,
           MIN(p.CHQ_NO)                                        AS CHQ_NO,
           DATE_FORMAT(MIN(p.CHQ_DATE), '%d/%m/%y')             AS CHQ_DATE_FMT,
           MIN(dr.${tranAcc.amount})                            AS AMOUNT
         FROM ${vouchers.table} v
         JOIN ${tranAcc.table} dr
           ON dr.${tranAcc.tranType} = v.${vouchers.tranType}
          AND dr.${tranAcc.vchrNo}   = v.${vouchers.vchrNo}
          AND dr.${tranAcc.dbCr}     = 'D'
         JOIN ${tranAcc.table} cr
           ON cr.${tranAcc.tranType} = v.${vouchers.tranType}
          AND cr.${tranAcc.vchrNo}   = v.${vouchers.vchrNo}
          AND cr.${tranAcc.dbCr}     = 'C'
         LEFT JOIN ${accMst.table} ca  ON ca.${accMst.code}  = cr.${tranAcc.accCode}
         LEFT JOIN ${accMst.table} bk  ON bk.${accMst.code}  = dr.${tranAcc.accCode}
         LEFT JOIN pdc_rcd p
           ON  CAST(p.JV_NO_RLZ AS UNSIGNED) = CAST(v.${vouchers.vchrNo} AS UNSIGNED)
          AND  p.PDC_CODE    = cr.${tranAcc.accCode}
          AND  p.CHQ_BANK    = dr.${tranAcc.accCode}
          AND  p.AMOUNT      = dr.${tranAcc.amount}
          AND  p.JV_DATE_RLZ = v.${vouchers.date}
         LEFT JOIN ${cusMst.table} c   ON c.${cusMst.code}   = p.CUST_CODE
         WHERE v.${vouchers.tranType} = ?
           AND v.${vouchers.refNo}    = ?
         GROUP BY v.${vouchers.vchrNo}
         ORDER BY CAST(v.${vouchers.vchrNo} AS UNSIGNED)`,
        [TRAN_TYPE_REVERSAL, batchNo]
      );

      if (rows.length === 0) {
        return res.status(404).json({ message: `Batch ${batchNo} not found` });
      }

      const out = rows.map((r) => ({
        vchrNo:    r.VCHR_NO,
        jvDate:    r.JV_DATE_FMT,
        chqNo:     r.CHQ_NO       || "",
        chqDt:     r.CHQ_DATE_FMT || "",
        party:     r.PARTY        || r.CUST_CODE || "",
        partyCode: r.CUST_CODE    || "",
        pdcCode:   r.PDC_CODE     || "",   // Cr leg — PDC suspense
        pdcHead:   r.PDC_HEAD     || "",
        chqBank:   r.CHQ_BANK     || "",   // Dr leg — bank account
        bankName:  r.BANK_NAME    || "",
        amount:    Number(r.AMOUNT) || 0,
      }));

      res.json({
        batchNo,
        batchDate: rows[0].JV_DATE_FMT,
        createdBy: rows[0].CREATED_BY || "",
        company:   await getCompany(),
        vouchers:  out,
        total:     out.reduce((s, v) => s + v.amount, 0),
      });
    } catch (err) {
      console.error("[pdc-rcd-reversal/batch]", err);
      res.status(500).json({ message: "Failed to fetch batch" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/pdc-rcd-reversal/save
  // Body: { asOnDate, username, rows: [{ tranType, vchrNo, chqNo, chqDt,
  //         pdcCode, pdcHead, chqBank, custCode, amount }, ...] }
  //
  // Per selected row:
  //   1. Lock and derive the next JV number (TRAN_TYPE = '24').
  //   2. Insert the voucher header, carrying the batch no in REF_NO.
  //   3. Insert two tran_acc legs:
  //        Dr  CHQ_BANK   (SR_NO 1) — debit the bank account
  //        Cr  PDC_CODE   (SR_NO 2) — clear the PDC suspense
  //   4. Close the pdc_rcd row (JV_NO_RLZ / JV_DATE_RLZ / REALISED = 'Y').
  //
  // Returns { batchNo, vouchers: JvPrintRow[] } for the print hook.
  // -------------------------------------------------------------------------
  router.post("/save", async (req, res) => {
    const { asOnDate, username, rows } = req.body || {};
    if (!asOnDate || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "asOnDate and rows[] are required" });
    }

    const { vouchers, tranAcc, cusMst, accMst } = CONFIG;
    const conn = await connection.promise().getConnection();

    try {
      await conn.beginTransaction();

      // ── One BatchNo for the entire reversal run ────────────────────────────
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

        // 1. Locked JV number for this row.
        const [maxRows] = await conn.query(
          `SELECT MAX(CAST(${vouchers.vchrNo} AS UNSIGNED)) AS maxVchr
           FROM ${vouchers.table}
           WHERE ${vouchers.tranType} = ? FOR UPDATE`,
          [TRAN_TYPE_REVERSAL]
        );
        const vchrNo    = padVchr((maxRows[0]?.maxVchr || 0) + 1);
        const narration = `Reversal of PDC received - Chq No ${row.chqNo} Dt ${toDdMmYy(row.chqDt)}`;

        // Look up descriptions from masters (don't trust client).
        const [cusRows] = await conn.query(
          `SELECT ${cusMst.name} AS partyName FROM ${cusMst.table} WHERE ${cusMst.code} = ?`,
          [row.custCode]
        );
        const partyName = cusRows[0]?.partyName || row.custCode;

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
             (${vouchers.tranType}, ${vouchers.vchrNo}, ${vouchers.date},
              ${vouchers.refNo}, ${vouchers.narration}, ${vouchers.username})
           VALUES (?, ?, ?, ?, ?, ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, batchNo, narration, username || null]
        );

        // 3a. Dr — Cheque Bank (debit the bank account).
        await conn.query(
          `INSERT INTO ${tranAcc.table}
             (${tranAcc.tranType}, ${tranAcc.vchrNo}, ${tranAcc.date}, ${tranAcc.srNo},
              ${tranAcc.refNo}, ${tranAcc.accCode}, ${tranAcc.amount}, ${tranAcc.dbCr},
              ${tranAcc.narration}, ${tranAcc.narration2})
           VALUES (?, ?, ?, ?, ?, ?, ?, 'D', ?, ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, 1, batchNo,
           row.chqBank, amount, narration, partyName]
        );

        // 3b. Cr — PDC Receivable suspense (clear the suspense).
        await conn.query(
          `INSERT INTO ${tranAcc.table}
             (${tranAcc.tranType}, ${tranAcc.vchrNo}, ${tranAcc.date}, ${tranAcc.srNo},
              ${tranAcc.refNo}, ${tranAcc.accCode}, ${tranAcc.amount}, ${tranAcc.dbCr},
              ${tranAcc.narration}, ${tranAcc.narration2})
           VALUES (?, ?, ?, ?, ?, ?, ?, 'C', ?, ?)`,
          [TRAN_TYPE_REVERSAL, vchrNo, asOnDate, 2, batchNo,
           row.pdcCode, amount, narration, partyName]
        );

        // 4. Close out the original pdc_rcd row.
        await conn.query(
          `UPDATE pdc_rcd
             SET JV_NO_RLZ = ?, JV_DATE_RLZ = ?, REALISED = 'Y'
           WHERE TRAN_TYPE = ? AND VCHR_NO = ? AND CHQ_NO = ?`,
          [vchrNo, asOnDate, row.tranType, row.vchrNo, row.chqNo]
        );

        savedVouchers.push({
          batchNo,
          vchrNo,
          jvDate:    asOnDate,
          chqNo:     row.chqNo,
          chqDt:     row.chqDt,
          partyCode: row.custCode,
          partyName,
          pdcCode:   row.pdcCode,
          pdcHead,
          chqBank:   row.chqBank,
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
        `[pdc-rcd-reversal] ${batchNo}: ${savedVouchers.length} voucher(s) by ${username || "unknown"}`
      );
      res.json({ batchNo, vouchers: savedVouchers });
    } catch (err) {
      await conn.rollback();
      console.error("[pdc-rcd-reversal/save]", err);
      res.status(500).json({ message: err.message || "Failed to save reversal" });
    } finally {
      conn.release();
    }
  });

  return router;
};
