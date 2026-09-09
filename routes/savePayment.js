// routes/savePayment.js  (or paste over the handler in HayatDb.js)
//
// Payment voucher save. Rewritten on the promise API so the connection has
// exactly ONE release path — a try/finally — instead of five hand-written
// ones. The old version returned from the commit-error branch without
// rolling back and without releasing, which left the connection checked out
// of the pool still holding its row locks and, under REPEATABLE READ, still
// carrying a read view that hid later commits from anything that reused it.
//
//   const savePayment = require("./routes/savePayment");
//   app.use("/api", savePayment(connection));

const express = require("express");

const MAX_ALLOC_RETRIES = 3;

module.exports = function (connection) {
  const router = express.Router();
  const dbp = connection.promise();

  /**
   * Next voucher number for a type. Named apart from HayatDb.js's own
   * allocateVchrNo so the two can coexist while the old handler is retired —
   * this one lives inside the module closure and is not exported.
   *
   * MAX+1 cannot be made safe by locking — SELECT MAX(...) FOR UPDATE locks
   * the rows it scanned, not the number it returned, so two sessions can and
   * do come away with the same one. The INSERT below is therefore a plain
   * INSERT, and a duplicate-key error sends us round the retry loop to take
   * the next number. The collision is caught by the primary key rather than
   * papered over by ON DUPLICATE KEY UPDATE, which used to overwrite the
   * other user's voucher in silence.
   *
   * CAST(...AS UNSIGNED) means this cannot use the index on VCHR_NO and scans
   * the type's rows every time. Fine at a few thousand vouchers a year; if it
   * starts to drag, move to a one-row-per-type sequence table:
   *
   *   UPDATE vchr_seq SET last_no = LAST_INSERT_ID(last_no + 1)
   *    WHERE tran_type = ?;
   *   SELECT LAST_INSERT_ID();
   */
  const nextVchrNo = async (conn, tranType) => {
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(CAST(VCHR_NO AS UNSIGNED)), 0) + 1 AS nextNo
         FROM vouchers
        WHERE TRAN_TYPE = ?`,
      [tranType]
    );
    const next = Number(rows && rows[0] && rows[0].nextNo);
    if (!Number.isFinite(next) || next < 1) {
      throw new Error(`nextVchrNo: bad sequence for ${tranType}`);
    }
    return String(next).padStart(10, "0");
  };

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /* ---- GET /api/lpo-settlements/:tranType/:vchrNo -------------------------
   * The LPO panel's rows on EDIT. Ordered by MAIN_SR_NO so they come back in
   * the order they were keyed — that is what the save assigns it for.
   * ---------------------------------------------------------------------- */
  router.get("/lpo-settlements/:tranType/:vchrNo", async (req, res) => {
    try {
      const [rows] = await dbp.query(
        `SELECT PV_TYPE, PV_NO, LPO_NO, DETAILS, AMOUNT_STL, SUP_CODE, MAIN_SR_NO
           FROM lpo_pv_settlements
          WHERE PV_TYPE = ? AND PV_NO = ?
          ORDER BY MAIN_SR_NO`,
        [req.params.tranType, req.params.vchrNo]
      );
      res.json(
        rows.map((r) => ({
          LPO_NO: r.LPO_NO || "",
          DETAILS: r.DETAILS || "",
          // DECIMAL comes back as a string from mysql2; the grid sums it
          AMOUNT_STL: Number(r.AMOUNT_STL) || 0,
          SUP_CODE: r.SUP_CODE || "",
          MAIN_SR_NO: Number(r.MAIN_SR_NO) || null,
        }))
      );
    } catch (err) {
      console.error("[lpo-settlements] read failed:", err);
      res.status(500).json({ message: "Could not read the LPO settlements." });
    }
  });

  /* ---- GET /api/lpos-by-supplier/:supCode --------------------------------
   * The F9 lookup on the LPO panel: this supplier's LPOs with what is still
   * open on each.
   *
   * Optional ?pvType=04&pvNo=0000004326 — when editing a voucher, its own
   * settlements are added back to the balance. Without that an LPO already
   * settled by the voucher being edited would show as closed, and the line
   * could not be re-picked or corrected.
   *
   * The LPO's value is AMOUNT less DISCOUNT plus ROUND_OFF and VAT_AMOUNT.
   * Check that against how LpoPrn prints a total — if the printed figure is
   * built differently, this is the one line to change.
   * ---------------------------------------------------------------------- */
  router.get("/lpos-by-supplier/:supCode", async (req, res) => {
    const supCode = String(req.params.supCode || "").trim();
    if (!supCode) return res.status(400).json({ message: "No supplier code." });

    const { pvType = null, pvNo = null } = req.query;

    try {
      const [rows] = await dbp.query(
        `
        SELECT n.LPO_NO,
               DATE_FORMAT(n.lpo_date, '%d/%m/%Y')                      AS LPO_DATE,
               COALESCE(NULLIF(TRIM(n.NARRATION), ''), LEFT(n.PAY_TERMS, 100)) AS DETAILS,
               n.JOB_NO,
               ROUND(COALESCE(n.AMOUNT,0) - COALESCE(n.DISCOUNT,0)
                   + COALESCE(n.ROUND_OFF,0) + COALESCE(n.VAT_AMOUNT,0), 2) AS LPO_AMOUNT,
               ROUND(COALESCE(s.settled, 0), 2)                          AS SETTLED,
               ROUND(COALESCE(n.AMOUNT,0) - COALESCE(n.DISCOUNT,0)
                   + COALESCE(n.ROUND_OFF,0) + COALESCE(n.VAT_AMOUNT,0)
                   - COALESCE(s.settled, 0), 2)                          AS BALANCE
          FROM lpo_net n
          LEFT JOIN (
                SELECT LPO_NO, SUM(AMOUNT_STL) AS settled
                  FROM lpo_pv_settlements
                 WHERE (? IS NULL OR NOT (PV_TYPE = ? AND PV_NO = ?))
                 GROUP BY LPO_NO
               ) s ON s.LPO_NO = n.LPO_NO
         WHERE n.SUP_CODE = ?
           AND COALESCE(n.CANCELLED, 'N') <> 'Y'
        HAVING BALANCE > 0.005
         ORDER BY n.lpo_date DESC, n.LPO_NO DESC
         LIMIT 300
        `,
        [pvNo || null, pvType || null, pvNo || null, supCode]
      );

      // mysql2 returns DECIMAL as a string and the picker does arithmetic on it
      res.json(
        rows.map((r) => ({
          LPO_NO: r.LPO_NO,
          LPO_DATE: r.LPO_DATE || "",
          DETAILS: r.DETAILS || "",
          JOB_NO: r.JOB_NO || "",
          LPO_AMOUNT: Number(r.LPO_AMOUNT) || 0,
          SETTLED: Number(r.SETTLED) || 0,
          BALANCE: Number(r.BALANCE) || 0,
        }))
      );
    } catch (err) {
      console.error("[lpos-by-supplier] failed:", err);
      res.status(500).json({ message: "Could not read the supplier's LPOs." });
    }
  });

  router.post("/save-payment", async (req, res) => {
    const {
      vchrData,
      chqData = [],
      tranaccData = [],
      InvStlData = [],
      lpoData = [],
    } = req.body || {};

    /* ---- validate before opening a transaction ---------------------------- */

    if (!vchrData || !vchrData.TranType) {
      return res.status(400).json({ message: "No voucher data in the request." });
    }
    if (!Array.isArray(tranaccData) || tranaccData.length === 0) {
      return res.status(400).json({ message: "The voucher has no account lines." });
    }

    const isAdd = String(vchrData.Mode || "").toUpperCase() === "ADD";
    if (!isAdd && !vchrData.VchrNo) {
      return res.status(400).json({ message: "EDIT needs the voucher number." });
    }

    // A voucher that does not balance has no business reaching the ledger.
    // The screen checks this too, but the screen is not the last word.
    const dr = round2(
      tranaccData.filter((t) => t.DbCr === "D").reduce((s, t) => s + Number(t.Amount || 0), 0)
    );
    const cr = round2(
      tranaccData.filter((t) => t.DbCr === "C").reduce((s, t) => s + Number(t.Amount || 0), 0)
    );
    if (Math.abs(dr - cr) > 0.009) {
      return res.status(400).json({
        message: `Voucher does not balance — debit ${dr.toFixed(2)}, credit ${cr.toFixed(2)}.`,
      });
    }

    const conn = await dbp.getConnection();

    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const vchrNo = await saveOnce(conn, {
            vchrData,
            chqData,
            tranaccData,
            InvStlData,
            lpoData,
            isAdd,
          });
          return res.json({ message: "Data saved successfully!", vchrNo });
        } catch (err) {
          // Roll back before deciding what to do — never leave the
          // transaction open across a retry or a response.
          await conn.rollback().catch(() => {});

          const collided = isAdd && err && err.code === "ER_DUP_ENTRY";
          if (collided && attempt < MAX_ALLOC_RETRIES) {
            console.warn(
              `[save-payment] voucher number taken, retry ${attempt}/${MAX_ALLOC_RETRIES}`
            );
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      console.error("[save-payment] failed:", err);
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          message: "Another user took that voucher number. Please save again.",
        });
      }
      return res
        .status(500)
        .json({ message: "The voucher was not saved.", detail: err.message });
    } finally {
      // The one and only release. Whatever happened above — success, a
      // rolled-back failure, a thrown validation error — the connection goes
      // back to the pool clean.
      conn.release();
    }
  });

  /* ---- one attempt, inside one transaction -------------------------------- */

  async function saveOnce(conn, { vchrData, chqData, tranaccData, InvStlData, lpoData, isAdd }) {
    await conn.beginTransaction();

    const vchrNo = isAdd
      ? await nextVchrNo(conn, vchrData.TranType)
      : vchrData.VchrNo;

    // On ADD the number is brand new, so these would match nothing — five
    // pointless statements and five sets of locks per save. Only EDIT needs
    // to clear the record being replaced.
    if (!isAdd) {
      const deletes = [
        ["DELETE FROM vouchers    WHERE TRAN_TYPE=?  AND VCHR_NO=?", vchrNo],
        ["DELETE FROM tran_acc    WHERE TRAN_TYPE=?  AND VCHR_NO=?", vchrNo],
        ["DELETE FROM pdc_isu     WHERE TRAN_TYPE=?  AND VCHR_NO=?", vchrNo],
        ["DELETE FROM current_chq WHERE TRAN_TYPE=?  AND VCHR_NO=?", vchrNo],
        ["DELETE FROM adj_dtl     WHERE SOURCE_TYPE=? AND SOURCE_DOC=?", vchrNo],
        ["DELETE FROM lpo_pv_settlements WHERE PV_TYPE=? AND PV_NO=?", vchrNo],
      ];
      for (const [sql, no] of deletes) {
        await conn.query(sql, [vchrData.TranType, no]);
      }
    }

    /* ---- header ---- */
    // Plain INSERT on ADD: a duplicate must raise, not overwrite. EDIT has
    // just deleted the row, so it inserts cleanly too — no upsert needed
    // either way, which is what let a collision pass unnoticed before.
    await conn.query(
      // CUST_CODE is the first credit account (the bank), ACC_CODE the party
      // being paid. ACC_CODE2 / AMOUNT2 carry the second credit line when the
      // payment comes out of two accounts — the columns were already on the
      // table and the voucher list already selects them.
      `INSERT INTO vouchers
         (TRAN_TYPE, VCHR_NO, DATTE, CUST_CODE, ACC_CODE,
          ACC_CODE2, AMOUNT2,
          CUR_CODE, CONV_RATE, NARRATION1, PAID_TO, AMOUNT_FRGN,
          AMOUNT, VCHR_TYPE)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vchrData.TranType,
        vchrNo,
        vchrData.VchrDate,
        vchrData.CustCd,
        vchrData.DrAc,
        vchrData.CrAc2 || null,
        vchrData.Amount2 || null,
        vchrData.CurCd,
        vchrData.ConvRt,
        vchrData.Particulars,
        vchrData.PaidTo,
        vchrData.FrgnAmt,
        vchrData.Amount,
        vchrData.VchrType,
      ]
    );

    /* ---- post-dated cheques ---- */
    if (vchrData.TranType !== "05") {
      for (const chq of chqData.filter((c) => c && c.ChqNo && String(c.ChqNo).trim())) {
        await conn.query(
          `INSERT INTO pdc_isu
             (TRAN_TYPE, VCHR_NO, VCHR_DATE, CHQ_NO, CHQ_DATE,
              PDC_CODE, SUP_CODE, CHQ_BANK, AMOUNT, NARRATION)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            vchrData.TranType,
            vchrNo,
            vchrData.VchrDate,
            chq.ChqNo,
            chq.ChqDt,
            chq.PdcCode,
            chq.SupCode,
            chq.ChqBank,
            chq.Amount,
            chq.Narration,
          ]
        );
      }
    }

    /* ---- account lines ---- */
    for (const trn of tranaccData) {
      await conn.query(
        `INSERT INTO tran_acc
           (TRAN_TYPE, VCHR_NO, DATTE, SR_NO, ACC_CODE,
            AMOUNT, DB_CR, NARRATION1, NARRATION2, JOB_NO)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          vchrData.TranType,
          vchrNo,
          vchrData.VchrDate,
          trn.SrNo,
          trn.AccCode,
          trn.Amount,
          trn.DbCr,
          trn.Narration1,
          trn.Narration2,
          trn.JobNo,
        ]
      );
    }

    /* ---- settlements ---- */
    for (const trn of InvStlData) {
      await conn.query(
        `INSERT INTO adj_dtl
           (SOURCE_TYPE, SOURCE_DOC, SOURCE_DATE, ACC_CODE,
            STLD_TYPE, STLD_DOC, STLD_DATE, STLD_AMT, MAIN_SR_NO)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          vchrData.TranType,
          vchrNo,
          trn.SourceDate,
          trn.AccCode,
          trn.StldType,
          trn.StldDoc,
          trn.StldDate,
          trn.Amount,
          trn.MainSrNo ?? null,
        ]
      );
    }

    /* ---- LPOs this payment is against ---- */
    // lpo_pv_settlements has no unique key, so a re-save can only be made
    // idempotent by the DELETE above — which is why the delete list has to
    // include it. If a key is added later, make it
    // (PV_TYPE, PV_NO, MAIN_SR_NO) to match how MAIN_SR_NO is assigned.
    for (const lpo of lpoData.filter((l) => l && String(l.LpoNo || "").trim())) {
      await conn.query(
        `INSERT INTO lpo_pv_settlements
           (PV_TYPE, PV_NO, LPO_NO, DETAILS, AMOUNT_STL, SUP_CODE, MAIN_SR_NO)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          vchrData.TranType,
          vchrNo,
          String(lpo.LpoNo).trim(),
          lpo.Details ?? null,
          lpo.Amount,
          lpo.SupCode,
          lpo.MainSrNo ?? null,
        ]
      );
    }

    await conn.commit();
    return vchrNo;
  }

  return router;
};
