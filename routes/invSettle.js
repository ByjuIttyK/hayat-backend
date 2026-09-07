// routes/invSettle.js
// Settlement editor — adj_dtl lines against a party's vouchers.
//
//   mode = "customer"  ->  cus_mst, Cr side of tran_acc, settles sales    (06)
//   mode = "supplier"  ->  sup_mst, Dr side of tran_acc, settles purchase (07)
//
// Register in HayatDb.js:
//   const invSettleRoutes = require("./routes/invSettle");
//   app.use("/api", authMiddleware, invSettleRoutes(connection));

const express = require("express");

const MODES = {
  customer: {
    master: "cus_mst",
    codeCol: "CUST_CODE",
    nameCol: "CUST_NAME",
    voucherSide: "C", // the receipt sits on the Cr side of the customer
    docType: "06",    // sales invoice
    docSide: "D",     // the invoice sits on the Dr side
    stldDbcr: "D",
    lovView: "v_cust_outstanding_bill",
    lovCodeCol: "CUST_CODE",
    lovAmtCol: "Dr_amt",   // the bill itself
    lovAdjCol: "Cr_amt",   // what has been knocked off it
  },
  supplier: {
    master: "sup_mst",
    codeCol: "SUP_CODE",
    nameCol: "SUP_NAME",
    voucherSide: "D", // the payment sits on the Dr side of the supplier
    docType: "07",    // purchase invoice
    docSide: "C",     // the invoice sits on the Cr side
    stldDbcr: "C",
    lovView: "v_sup_outstanding_bill",
    lovCodeCol: "ACC_CODE",
    lovAmtCol: "CR_AMT",
    lovAdjCol: "DR_AMT",
  },
};

const SYNC_AMT_SETTLED = true; // also refresh tran_acc.AMT_SETTLED on save

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const fail = (res, err, where) => {
    console.error(`[invSettle] ${where}:`, err);
    res.status(500).json({ error: `${where} failed`, detail: err.message });
  };

  const cfg = (mode) => MODES[String(mode || "").toLowerCase()] || null;
  const badMode = (res) =>
    res.status(400).json({ error: "mode must be customer or supplier" });

  // --- 1. party type-ahead ---------------------------------------------------
  router.get("/inv-settle/parties/:mode", async (req, res) => {
    const m = cfg(req.params.mode);
    if (!m) return badMode(res);
    const q = `%${(req.query.q || "").trim()}%`;
    try {
      const [rows] = await db.execute(
        `SELECT ${m.codeCol} AS acCode, ${m.nameCol} AS acName
           FROM ${m.master}
          WHERE ${m.codeCol} LIKE ? OR ${m.nameCol} LIKE ?
       ORDER BY (${m.nameCol} IS NULL OR ${m.nameCol} = ''),
                ${m.nameCol}, ${m.codeCol}
          LIMIT 100`,
        [q, q]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "party lookup");
    }
  });

  // --- 2. vouchers of the party (display only) -------------------------------
  router.get("/inv-settle/vouchers/:mode/:acCode", async (req, res) => {
    const m = cfg(req.params.mode);
    if (!m) return badMode(res);
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
                p.${m.nameCol}                     AS acName,
                COALESCE(a.settled, 0)             AS settled
           FROM tran_acc t
      LEFT JOIN ${m.master} p ON p.${m.codeCol} = t.ACC_CODE
      LEFT JOIN (SELECT SOURCE_TYPE st, SOURCE_DOC sd, SUM(STLD_AMT) settled
                   FROM adj_dtl
                  WHERE ACC_CODE = ?
               GROUP BY SOURCE_TYPE, SOURCE_DOC) a
             ON a.st = t.TRAN_TYPE AND a.sd = t.vchr_no
          WHERE t.ACC_CODE = ?
            AND t.DB_CR = ?
       ORDER BY t.DATTE DESC, t.vchr_no DESC`,
        [acCode, acCode, m.voucherSide]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "voucher list");
    }
  });

  // --- 3. adj_dtl lines of one voucher (same for both modes) -----------------
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

  // --- 4. outstanding bill LOV ----------------------------------------------
  // Reads the outstanding-bill view, so a bill drops off the list once it is
  // fully adjusted. DIV_CODE / JOB_NO are not on the view, so they come from
  // the underlying tran_acc row.
  const billSelect = (m) => `
     SELECT v.VCHR_NO                          AS stldDoc,
            v.TRAN_TYPE                        AS stldType,
            DATE_FORMAT(v.DATTE, '%d/%m/%Y')   AS stldDate,
            v.${m.lovAmtCol}                   AS invAmount,
            v.${m.lovAdjCol}                   AS adjusted,
            v.BALANCE                          AS balance,
            v.NAR                              AS narration,
            t.DIV_CODE                         AS divCode,
            t.JOB_NO                           AS jobNo
       FROM ${m.lovView} v
  LEFT JOIN tran_acc t
         ON t.TRAN_TYPE = v.TRAN_TYPE
        AND t.vchr_no   = v.VCHR_NO
        AND t.ACC_CODE  = v.${m.lovCodeCol}
      WHERE v.${m.lovCodeCol} = ?`;

  router.get("/inv-settle/invoices/:mode/:acCode", async (req, res) => {
    const m = cfg(req.params.mode);
    if (!m) return badMode(res);
    try {
      const [rows] = await db.execute(
        `${billSelect(m)} ORDER BY v.DATTE DESC, v.VCHR_NO DESC`,
        [req.params.acCode]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "invoice lov");
    }
  });

  // --- 4b. one bill, for a manually typed invoice number ---------------------
  router.get("/inv-settle/bill/:mode/:acCode/:vchrNo", async (req, res) => {
    const m = cfg(req.params.mode);
    if (!m) return badMode(res);
    const { acCode, vchrNo } = req.params;
    const doc = String(vchrNo).trim().padStart(10, "0");
    try {
      const [rows] = await db.execute(
        `${billSelect(m)} AND v.VCHR_NO = ? LIMIT 1`,
        [acCode, doc]
      );
      if (!rows.length) {
        return res
          .status(404)
          .json({ error: `${doc} is not an outstanding bill for this account` });
      }
      res.json(rows[0]);
    } catch (err) {
      fail(res, err, "bill lookup");
    }
  });

  // --- 5. save ---------------------------------------------------------------
  // Replaces every adj_dtl line of the voucher inside one transaction.
  router.post("/inv-settle/save", async (req, res) => {
    const {
      mode,
      tranType,
      vchrNo,
      vchrDate, // dd/mm/yyyy
      acCode,
      voucherAmount,
      rows = [],
    } = req.body || {};

    const m = cfg(mode);
    if (!m) return badMode(res);
    if (!tranType || !vchrNo || !acCode) {
      return res
        .status(400)
        .json({ error: "tranType, vchrNo and acCode are required" });
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
        stldType: String(r.stldType || m.docType).trim(),
        stldAmt: amt,
        stldDate: r.stldDate || null,
        stldDbcr: String(r.stldDbcr || m.stldDbcr).trim().toUpperCase(),
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
    const vchAmt = Number(voucherAmount || 0);
    if (vchAmt && total - vchAmt > 0.005) {
      return res.status(400).json({
        error: `Settled total ${total.toFixed(2)} is more than the voucher ${vchAmt.toFixed(2)}`,
      });
    }

    let conn;
    try {
      conn = await connection.promise().getConnection();
      await conn.query("START TRANSACTION");

      // the voucher must exist on the side this mode settles
      const [head] = await conn.execute(
        `SELECT DB_CR FROM tran_acc
          WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ? LIMIT 1`,
        [tranType, vchrNo, acCode]
      );
      if (!head.length) {
        await conn.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: `Voucher ${vchrNo} is not on this account` });
      }
      if (head[0].DB_CR !== m.voucherSide) {
        await conn.query("ROLLBACK");
        return res.status(400).json({
          error: `Voucher ${vchrNo} is a ${head[0].DB_CR} entry — not settleable in ${mode} mode`,
        });
      }

      // invoices touched before the rewrite, so AMT_SETTLED is refreshed even
      // for lines that were removed
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
        await conn.execute(
          `UPDATE tran_acc SET AMT_SETTLED = (
              SELECT COALESCE(SUM(STLD_AMT), 0) FROM adj_dtl
               WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?)
            WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ?`,
          [tranType, vchrNo, tranType, vchrNo, acCode]
        );

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
