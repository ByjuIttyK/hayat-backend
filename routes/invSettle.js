// routes/invSettle.js
// Invoice Settlement — edit adj_dtl lines against a customer's Cr receipts.
//
// Register in HayatDb.js:
//   const invSettleRoutes = require("./routes/invSettle");
//   app.use("/api", authMiddleware, invSettleRoutes(connection));
//
// Tables used (exact DDL):
//   tran_acc  TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1,
//             AMT_SETTLED, SR_NO, DIV_CODE, JOB_NO, MAIN_SR_NO, REF_NO
//   adj_dtl   SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE, ACC_CODE, STLD_DOC,
//             STLD_TYPE, STLD_AMT, STLD_DBCR, STLD_DATE, DIV_CODE,
//             MAIN_SR_NO, REF_NO

const express = require("express");

const RECEIPT_TYPES = ["03"]; // Cr side of the customer — receipt vouchers
const INVOICE_TYPE = "06";    // Sales invoice
const SYNC_AMT_SETTLED = true; // also refresh tran_acc.AMT_SETTLED on save

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const fail = (res, err, where) => {
    console.error(`[invSettle] ${where}:`, err);
    res.status(500).json({ error: `${where} failed`, detail: err.message });
  };

  // --- 1. customer type-ahead ------------------------------------------------
  router.get("/inv-settle/customers", async (req, res) => {
    const q = `%${(req.query.q || "").trim()}%`;
    try {
      const [rows] = await db.execute(
        `SELECT CUST_CODE AS acCode, CUST_NAME AS acName
           FROM cus_mst
          WHERE CUST_CODE LIKE ? OR CUST_NAME LIKE ?
       ORDER BY CUST_NAME
          LIMIT 100`,
        [q, q]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "customer lookup");
    }
  });

  // --- 2. Cr rows of the customer (display only) -----------------------------
  router.get("/inv-settle/receipts/:acCode", async (req, res) => {
    const { acCode } = req.params;
    try {
      const [rows] = await db.execute(
        `SELECT t.TRAN_TYPE                        AS tranType,
                t.vchr_no                          AS vchrNo,
                DATE_FORMAT(t.DATTE, '%d/%m/%Y')   AS vchrDate,
                t.ACC_CODE                         AS acCode,
                t.AMOUNT                           AS amount,
                t.DB_CR                            AS dbCr,
                t.NARRATION1                       AS narration,
                t.DIV_CODE                         AS divCode,
                t.JOB_NO                           AS jobNo,
                t.SR_NO                            AS srNo,
                c.CUST_NAME                        AS acName,
                COALESCE(a.settled, 0)             AS settled
           FROM tran_acc t
      LEFT JOIN cus_mst c ON c.CUST_CODE = t.ACC_CODE
      LEFT JOIN (SELECT SOURCE_TYPE st, SOURCE_DOC sd, SUM(STLD_AMT) settled
                   FROM adj_dtl
                  WHERE ACC_CODE = ?
               GROUP BY SOURCE_TYPE, SOURCE_DOC) a
             ON a.st = t.TRAN_TYPE AND a.sd = t.vchr_no
          WHERE t.ACC_CODE = ?
            AND t.DB_CR = 'C'
       ORDER BY t.DATTE DESC, t.vchr_no DESC`,
        [acCode, acCode]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "receipt list");
    }
  });

  // --- 3. adj_dtl lines of one receipt --------------------------------------
  router.get("/inv-settle/details/:tranType/:vchrNo", async (req, res) => {
    const { tranType, vchrNo } = req.params;
    try {
      const [rows] = await db.execute(
        `SELECT a.SOURCE_DOC                            AS sourceDoc,
                a.SOURCE_TYPE                           AS sourceType,
                DATE_FORMAT(a.SOURCE_DATE, '%d/%m/%Y')  AS sourceDate,
                a.ACC_CODE                              AS acCode,
                a.STLD_DOC                              AS stldDoc,
                a.STLD_TYPE                             AS stldType,
                a.STLD_AMT                              AS stldAmt,
                a.STLD_DBCR                             AS stldDbcr,
                DATE_FORMAT(a.STLD_DATE, '%d/%m/%Y')    AS stldDate,
                a.DIV_CODE                              AS divCode,
                a.MAIN_SR_NO                            AS mainSrNo,
                a.REF_NO                                AS refNo,
                t.JOB_NO                                AS jobNo
           FROM adj_dtl a
      LEFT JOIN tran_acc t
             ON t.TRAN_TYPE = a.STLD_TYPE
            AND t.vchr_no   = a.STLD_DOC
            AND t.ACC_CODE  = a.ACC_CODE
          WHERE a.SOURCE_TYPE = ? AND a.SOURCE_DOC = ?
       ORDER BY a.MAIN_SR_NO, a.STLD_DOC`,
        [tranType, vchrNo]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "settlement detail");
    }
  });

  // --- 4. invoice LOV --------------------------------------------------------
  router.get("/inv-settle/invoices/:acCode", async (req, res) => {
    const { acCode } = req.params;
    try {
      const [rows] = await db.execute(
        `SELECT t.vchr_no                          AS stldDoc,
                t.TRAN_TYPE                        AS stldType,
                DATE_FORMAT(t.DATTE, '%d/%m/%Y')   AS stldDate,
                t.AMOUNT                           AS invAmount,
                t.DIV_CODE                         AS divCode,
                t.JOB_NO                           AS jobNo,
                t.NARRATION1                       AS narration,
                COALESCE(a.adjusted, 0)            AS adjusted,
                t.AMOUNT - COALESCE(a.adjusted, 0) AS balance
           FROM tran_acc t
      LEFT JOIN (SELECT STLD_TYPE st, STLD_DOC sd, SUM(STLD_AMT) adjusted
                   FROM adj_dtl
                  WHERE ACC_CODE = ?
               GROUP BY STLD_TYPE, STLD_DOC) a
             ON a.st = t.TRAN_TYPE AND a.sd = t.vchr_no
          WHERE t.ACC_CODE = ?
            AND t.DB_CR = 'D'
            AND t.TRAN_TYPE = ?
       ORDER BY t.DATTE DESC, t.vchr_no DESC`,
        [acCode, acCode, INVOICE_TYPE]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "invoice lov");
    }
  });

  // --- 5. save ---------------------------------------------------------------
  // Replaces every adj_dtl line of the receipt inside one transaction.
  router.post("/inv-settle/save", async (req, res) => {
    const {
      tranType,
      vchrNo,
      vchrDate,        // dd/mm/yyyy
      acCode,
      receiptAmount,
      rows = [],
    } = req.body || {};

    if (!tranType || !vchrNo || !acCode) {
      return res
        .status(400)
        .json({ error: "tranType, vchrNo and acCode are required" });
    }
    if (!RECEIPT_TYPES.includes(String(tranType))) {
      return res
        .status(400)
        .json({ error: "Settlement is only allowed on receipt vouchers" });
    }

    const clean = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const doc = String(r.stldDoc || "").trim();
      const amt = Number(r.stldAmt);
      if (!doc && !amt) continue; // untouched blank line
      if (!doc) {
        return res
          .status(400)
          .json({ error: `Line ${i + 1}: pick an invoice before saving` });
      }
      if (!isFinite(amt) || amt <= 0) {
        return res
          .status(400)
          .json({ error: `Line ${i + 1}: enter an amount greater than zero` });
      }
      clean.push({
        stldDoc: doc,
        stldType: String(r.stldType || INVOICE_TYPE).trim(),
        stldAmt: amt,
        stldDate: r.stldDate || null,
        stldDbcr: String(r.stldDbcr || "D").trim().toUpperCase(),
        divCode: r.divCode ? String(r.divCode).slice(0, 2) : null,
        refNo: r.refNo || null,
      });
    }

    const keys = clean.map((r) => `${r.stldType}|${r.stldDoc}`);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) {
      return res
        .status(400)
        .json({ error: `Invoice ${dup.split("|")[1]} is on the grid twice` });
    }

    const total = clean.reduce((s, r) => s + r.stldAmt, 0);
    const recAmt = Number(receiptAmount || 0);
    if (recAmt && total - recAmt > 0.005) {
      return res.status(400).json({
        error: `Settled total ${total.toFixed(2)} is more than the receipt ${recAmt.toFixed(2)}`,
      });
    }

    let conn;
    try {
      conn = await connection.promise().getConnection();
      await conn.query("START TRANSACTION");

      // invoices touched before the rewrite, so their AMT_SETTLED is refreshed
      // even when a line is removed
      const [old] = await conn.execute(
        `SELECT DISTINCT STLD_TYPE, STLD_DOC FROM adj_dtl
          WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?`,
        [tranType, vchrNo]
      );

      await conn.execute(
        `DELETE FROM adj_dtl WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?`,
        [tranType, vchrNo]
      );

      const ins = `INSERT INTO adj_dtl
          (SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE, ACC_CODE,
           STLD_DOC, STLD_TYPE, STLD_AMT, STLD_DBCR, STLD_DATE,
           DIV_CODE, MAIN_SR_NO, REF_NO)
        VALUES (?, ?, STR_TO_DATE(?, '%d/%m/%Y'), ?,
                ?, ?, ?, ?, STR_TO_DATE(?, '%d/%m/%Y'),
                ?, ?, ?)`;

      for (let i = 0; i < clean.length; i++) {
        const r = clean[i];
        await conn.execute(ins, [
          vchrNo,
          tranType,
          vchrDate || null,
          acCode,
          r.stldDoc,
          r.stldType,
          r.stldAmt,
          r.stldDbcr,
          r.stldDate,
          r.divCode,
          i + 1, // MAIN_SR_NO — line serial within the voucher
          r.refNo,
        ]);
      }

      if (SYNC_AMT_SETTLED) {
        // receipt row
        await conn.execute(
          `UPDATE tran_acc SET AMT_SETTLED = (
              SELECT COALESCE(SUM(STLD_AMT), 0) FROM adj_dtl
               WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?)
            WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ?`,
          [tranType, vchrNo, tranType, vchrNo, acCode]
        );

        // every invoice touched, old and new
        const touched = new Map();
        old.forEach((o) => touched.set(`${o.STLD_TYPE}|${o.STLD_DOC}`, o));
        clean.forEach((r) =>
          touched.set(`${r.stldType}|${r.stldDoc}`, {
            STLD_TYPE: r.stldType,
            STLD_DOC: r.stldDoc,
          })
        );
        for (const t of touched.values()) {
          await conn.execute(
            `UPDATE tran_acc SET AMT_SETTLED = (
                SELECT COALESCE(SUM(STLD_AMT), 0) FROM adj_dtl
                 WHERE STLD_TYPE = ? AND STLD_DOC = ? AND ACC_CODE = ?)
              WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ?`,
            [t.STLD_TYPE, t.STLD_DOC, acCode, t.STLD_TYPE, t.STLD_DOC, acCode]
          );
        }
      }

      await conn.query("COMMIT");
      res.json({ ok: true, saved: clean.length, total });
    } catch (err) {
      if (conn) {
        try {
          await conn.query("ROLLBACK");
        } catch (e) {
          console.error("[invSettle] rollback:", e);
        }
      }
      fail(res, err, "settlement save");
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
