// ─────────────────────────────────────────────────────────────────────────────
// pinv_ns_api.js — CRUD routes for Purchase Entry (Non-Stock)
// Mount in HayatDb.js:
//   const pinvNsRoutes = require('./pinv_ns_api')(connection);
//   app.use('/api', pinvNsRoutes);
//
// Numbering (same pattern as save-fabinv / save-lpo / save-localpurch):
//   ADD  → the real PJV_NO is taken inside the save transaction, the same way
//          /api/nextPjvNo builds it: 'NS' + 8-digit running number, where the
//          running number is MAX(SUBSTR(PJV_NO,3,8))+1 across v_purchase_full
//          (purchase_hdr + purchase_hdr_ns + ngp_net — one shared series).
//          The header goes in with a plain INSERT; PJV_NO is the PK of
//          purchase_hdr_ns, so if two users save at the same instant the second
//          INSERT fails with ER_DUP_ENTRY and the whole save is retried in a
//          fresh transaction with a fresh MAX. Nothing is ever overwritten.
//   EDIT → the PJV must already exist (locked FOR UPDATE), then it is updated.
// The response returns the saved PJV_NO; if it differs from the number the
// screen was showing, `changed` is true and `message` says so.
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const PJV_PREFIX = "NS"; // Non-Stock purchase (same prefix the screen asks /api/nextPjvNo for)
  const MAX_ATTEMPTS = 5;

  // ── GET header — fetch single record by PJV_NO ────────────────────────────
  // ── POST save — header + items + GL entries (transactional) ───────────────
  router.post("/save-purchns", async (req, res) => {
    const { netData, itemsData } = req.body;
    if (!netData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "At least one item line is required." });
    }

    // Missing mode = EDIT. An old browser still doing an ADD then fails the
    // existence check instead of overwriting anything.
    const mode = String(req.body.mode || "").toUpperCase() === "ADD" ? "ADD" : "EDIT";
    const givenPjvNo = String(netData.PJV_NO ?? "").trim();
    if (mode === "EDIT" && !givenPjvNo) {
      return res.status(400).json({ message: "PJV_NO is required." });
    }

    if (!netData.DR_CODE || !netData.SUP_CODE) {
      return res.status(400).json({ message: "Both Dr.Code and Supplier Code are required to post to GL." });
    }
    const currentTime = new Date().toTimeString().slice(0, 8);

    // One complete save in its own transaction. Returns the PJV_NO it saved.
    const saveOnce = async () => {
      // Obtain a dedicated promise connection for transaction support
      const conn = await connection.promise().getConnection();
      try {
        await conn.beginTransaction(); // fresh transaction = fresh snapshot for MAX

        let pjvNo = givenPjvNo;
        if (mode === "ADD") {
          const [mx] = await conn.query(
            `SELECT COALESCE(MAX(CAST(SUBSTR(a.PJV_NO, 3, 8) AS UNSIGNED)), 0) AS mx
               FROM v_purchase_full a`
          );
          pjvNo = PJV_PREFIX + String(Number(mx[0].mx) + 1).padStart(8, "0");
        } else {
          const [ex] = await conn.query(
            "SELECT PJV_NO FROM purchase_hdr_ns WHERE PJV_NO = ? FOR UPDATE",
            [pjvNo]
          );
          if (!ex.length) {
            throw Object.assign(new Error(`Purchase voucher ${pjvNo} not found`), { status: 404 });
          }
        }

        // 1. Header row
        // ADD = plain INSERT, so a number clash throws ER_DUP_ENTRY instead of
        // overwriting another user's voucher. EDIT keeps the upsert (row is
        // confirmed to exist and locked above).
        const insertPart = `INSERT INTO purchase_hdr_ns
             (PJV_NO, PJV_DATE, SUP_CODE, INV_NO, INV_DATE, LPO_NO,  DR_CODE,
              NARRATION, INV_GRS_AMT, DISC_PER, DISCOUNT, RND_OFF, VAT_PERC, VAT_AMOUNT)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        const upsertPart = `
           ON DUPLICATE KEY UPDATE
             PJV_DATE=VALUES(PJV_DATE), SUP_CODE=VALUES(SUP_CODE), INV_NO=VALUES(INV_NO),
             INV_DATE=VALUES(INV_DATE), LPO_NO=VALUES(LPO_NO), DR_CODE=VALUES(DR_CODE),
             NARRATION=VALUES(NARRATION), INV_GRS_AMT=VALUES(INV_GRS_AMT),
             DISC_PER=VALUES(DISC_PER), DISCOUNT=VALUES(DISCOUNT), RND_OFF=VALUES(RND_OFF),
             VAT_PERC=VALUES(VAT_PERC), VAT_AMOUNT=VALUES(VAT_AMOUNT)`;
        await conn.query(mode === "ADD" ? insertPart : insertPart + upsertPart, [
          pjvNo, netData.PJV_DATE, netData.SUP_CODE, netData.INV_NO, netData.INV_DATE,
          netData.LPO_NO, netData.DR_CODE, netData.NARRATION, netData.INV_GRS_AMT,
          netData.DISC_PER, netData.DISCOUNT, netData.RND_OFF, netData.VAT_PERC, netData.VAT_AMOUNT,
        ]);
        console.log(`purchase_hdr_ns ${mode}:`, pjvNo);

        // 2. Clear old detail lines and G/L entries (EDIT only — a new voucher
        //    has none, and this way an ADD can never delete anything)
        if (mode === "EDIT") {
          await conn.query(`DELETE FROM purchase_items_ns WHERE PJV_NO = ?`, [pjvNo]);
          await conn.query(
            `DELETE FROM tran_acc WHERE vchr_no = ? AND TRAN_TYPE = '07'`,
            [pjvNo]
          );
        }

        // 3. Re-insert items grid array + debit lines.
        // Every line takes pjvNo — never it.PJV_NO, which carries the
        // provisional number the screen showed before the save.
        let i = 0;
        for (const it of itemsData) {
          i++;
          await conn.query(
            `INSERT INTO purchase_items_ns
               (PJV_NO, SR_NO, JOB_NO, PANEL_NO, LOC_CODE, PART_NO, SUP_ITEM_DESC,
                QTY, ITEM_UNIT, UNIT_COST, DR_CODE, DISCOUNT, VAT_PERC)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              pjvNo, it.SR_NO, it.JOB_NO, it.PANEL_NO, it.LOC_CODE, it.PART_NO, it.SUP_ITEM_DESC,
              it.QTY, it.ITEM_UNIT, it.UNIT_COST, it.DR_CODE, it.DISCOUNT, it.VAT_PERC,
            ]
          );

          // tran_acc Debit line — Taxable Amt
          await conn.query(
            `INSERT INTO tran_acc (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
               NARRATION1, NARRATION2, SR_NO, TRANS_DATE, TRANS_TIME, JOB_NO, PANEL_NO)
             VALUES ('07', ?, ?, ?, ?, 'D', ?, ?, ?, CURDATE(), ?, ?, ?)`,
            [pjvNo, netData.PJV_DATE, it.DR_CODE, it.taxableAmt,
              `Inv:${netData.INV_NO}:${netData.INV_DATE}`, netData.supName, i, currentTime, it.JOB_NO, it.PANEL_NO]
          );

          i++;
          // tran_acc Debit line — VAT Amt
          await conn.query(
            `INSERT INTO tran_acc (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
               NARRATION1, NARRATION2, SR_NO, TRANS_DATE, TRANS_TIME, JOB_NO, PANEL_NO)
             VALUES ('07', ?, ?, ?, ?, 'D', ?, ?, ?, CURDATE(), ?, ?, ?)`,
            [pjvNo, netData.PJV_DATE, '142-004-0-001', it.vatAmt,
              `Inv:${netData.INV_NO}:${netData.INV_DATE}`, netData.supName, i, currentTime, it.JOB_NO, it.PANEL_NO]
          );
        }

        // Credit line
        await conn.query(
          `INSERT INTO tran_acc (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1, NARRATION2, SR_NO, TRANS_DATE, TRANS_TIME)
           VALUES ('07', ?, ?, ?, ?, 'C', ?, ?, ?, CURDATE(), ?)`,
          [pjvNo, netData.PJV_DATE, netData.SUP_CODE, netData.netAmt,
            `Inv:${netData.INV_NO}:${netData.INV_DATE}`, netData.NARRATION, i + 1, currentTime]
        );

        await conn.commit();
        return pjvNo;
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release(); // always, on every path
      }
    };

    // ── Run it; on a PJV-number clash, retry with a new transaction ──
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const savedNo = await saveOnce();
        const changed = mode === "ADD" && givenPjvNo !== "" && savedNo !== givenPjvNo;
        return res.json({
          message: changed
            ? `PJV No ${givenPjvNo} was already taken. Saved as PJV No ${savedNo}.`
            : "Saved",
          PJV_NO: savedNo,
          changed,
        });
      } catch (err) {
        // Only a clash on purchase_hdr_ns's key is a number clash; a duplicate
        // on the items or tran_acc is a real bug and is reported.
        const numberClash =
          mode === "ADD" &&
          err.code === "ER_DUP_ENTRY" &&
          /'purchase_hdr_ns\./i.test(err.sqlMessage || "");
        if (numberClash && attempt < MAX_ATTEMPTS) {
          console.warn(`save-purchns: PJV number clash, retrying (attempt ${attempt})`);
          continue;
        }
        console.error("save-purchns POST error:", err);

        if (err.errno === 1452) {
          return res.status(400).json({
            message: "One of the item lines has an invalid Job No, Panel No, or Dr.Code that does not exist in its master table.",
          });
        }
        if (err.status) {
          return res.status(err.status).json({ message: err.message });
        }
        return res.status(500).json({ message: "Error saving voucher", error: err.message });
      }
    }
  });
  return router;
};
