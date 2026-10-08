// ─────────────────────────────────────────────────────────────────────────────
//  routes/save-jv.js
//
//  Journal Voucher save route  (TRAN_TYPE = "05")
//
//  Usage in HayatDb.js:
//
//      const saveJvRouter = require('./routes/save-jv')(connection);
//      app.use('/api', saveJvRouter);
//
//  Two modes, sent by JvEnt.tsx as vchrData.Mode:
//
//  ADD  — the voucher number is ALLOCATED HERE, not taken from the screen.
//         The screen's number is only a preview (MaxVchrNo + 1); two users
//         opening a new JV at the same time both see the same preview. The old
//         route deleted-then-inserted on that number, so the second save wiped
//         out the first user's voucher. Now:
//           • a MySQL named lock (GET_LOCK) per TRAN_TYPE serialises allocation
//           • MAX(VCHR_NO)+1 is read inside the lock, in the transaction
//           • nothing is ever deleted on ADD
//           • the PK on vouchers (TRAN_TYPE, VCHR_NO) is the last safety net —
//             a duplicate-key error retries with the next number
//         The number actually used is returned as { vchrNo }.
//
//  EDIT — the existing voucher is locked (SELECT … FOR UPDATE on its header),
//         then delete-then-insert as before, so two people saving the same JV
//         at once are applied one after the other, never interleaved.
//         Mode missing (an older cached screen) is treated as EDIT, which is
//         exactly the old behaviour.
//
//  Payload from JvEnt.tsx  →  POST /api/save-jv
//  {
//    vchrData    : { Mode, TranType, VchrNo, VchrDate, Particulars }
//    tranaccData : [{ TranType, VchrNo, SrNo, AccCode, RefNo,
//                     Narration1, Narration2, Amount, DbCr }]
//    InvStlData  : [{ TranType, SourceDoc, SourceDate, AccCode,
//                     StldType, StldDoc, StldDate, Amount }]
//  }
//
//  Tables touched:
//    vouchers  — 1 header row       (PK: TRAN_TYPE, VCHR_NO)
//    tran_acc  — N GL detail rows   (PK: TRAN_TYPE, VCHR_NO, SR_NO)
//    adj_dtl   — N settlement rows  (PK: SOURCE_TYPE, SOURCE_DOC, STLD_DOC)
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  // ── promise helpers ──────────────────────────────────────────────────────
  const query = (conn, sql, params) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result))));

  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));

  const begin    = (conn) => new Promise((res, rej) => conn.beginTransaction((e) => (e ? rej(e) : res())));
  const commit   = (conn) => new Promise((res, rej) => conn.commit((e) => (e ? rej(e) : res())));
  const rollback = (conn) => new Promise((res) => conn.rollback(() => res()));

  const VCHR_LEN = 10;                       // vouchers.VCHR_NO is 10, zero-padded
  const pad = (n) => String(n).padStart(VCHR_LEN, "0");
  const r2  = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // Highest number in use for this type. Both tables are checked so a
  // half-written voucher from the old route can't be reused.
  const maxVchrNo = async (conn, tranType) => {
    const rows = await query(
      conn,
      `SELECT GREATEST(
          COALESCE((SELECT MAX(CAST(VCHR_NO AS UNSIGNED)) FROM vouchers WHERE TRAN_TYPE = ?), 0),
          COALESCE((SELECT MAX(CAST(VCHR_NO AS UNSIGNED)) FROM tran_acc WHERE TRAN_TYPE = ?), 0)
        ) AS MX`,
      [tranType, tranType]
    );
    return Number(rows[0]?.MX) || 0;
  };

  // ── body writers (shared by ADD and EDIT) ────────────────────────────────
  const insertVoucher = async (conn, TRAN_TYPE, VCHR_NO, vchrData, tranaccData, InvStlData) => {
    await query(
      conn,
      `INSERT INTO vouchers (TRAN_TYPE, VCHR_NO, DATTE, NARRATION1) VALUES (?, ?, ?, ?)`,
      [TRAN_TYPE, VCHR_NO, vchrData.VchrDate, vchrData.Particulars || null]
    );

    // TRAN_TYPE / VCHR_NO / date always come from the header — on ADD the
    // number in each line is the screen preview and may be stale.
    let sr = 0;
    for (const trn of tranaccData) {
      sr += 1;
      await query(
        conn,
        `INSERT INTO tran_acc (
           TRAN_TYPE, VCHR_NO, DATTE, SR_NO, ACC_CODE,
           AMOUNT, DB_CR, NARRATION1, NARRATION2, REF_NO
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          TRAN_TYPE, VCHR_NO, vchrData.VchrDate,
          sr,                              // 1..n, no gaps
          trn.AccCode,
          r2(trn.Amount),
          trn.DbCr === "D" ? "D" : "C",
          trn.Narration1 || null,
          trn.Narration2 || null,
          trn.RefNo || null,
        ]
      );
    }

    if (Array.isArray(InvStlData)) {
      for (const stl of InvStlData) {
        if (!stl || !Number(stl.Amount)) continue;
        await query(
          conn,
          `INSERT INTO adj_dtl (
             SOURCE_TYPE, SOURCE_DOC, SOURCE_DATE, ACC_CODE,
             STLD_TYPE, STLD_DOC, STLD_DATE, STLD_AMT
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            TRAN_TYPE, VCHR_NO, vchrData.VchrDate,
            stl.AccCode || null,
            stl.StldType, stl.StldDoc, stl.StldDate || null,
            r2(stl.Amount),
          ]
        );
      }
    }
  };

  const deleteVoucher = async (conn, TRAN_TYPE, VCHR_NO) => {
    await query(conn, `DELETE FROM adj_dtl  WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?`, [TRAN_TYPE, VCHR_NO]);
    await query(conn, `DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,     [TRAN_TYPE, VCHR_NO]);
    await query(conn, `DELETE FROM vouchers WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,     [TRAN_TYPE, VCHR_NO]);
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  POST /api/save-jv
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/save-jv", async (req, res) => {
    const { vchrData, tranaccData, InvStlData } = req.body || {};

    // ── validation ─────────────────────────────────────────────────────────
    if (!vchrData?.TranType) {
      return res.status(400).json({ message: "TranType is required." });
    }
    if (!vchrData?.VchrDate) {
      return res.status(400).json({ message: "Voucher date is required." });
    }
    const lines = (Array.isArray(tranaccData) ? tranaccData : [])
      .filter((t) => String(t?.AccCode || "").trim() && Number(t?.Amount));
    if (lines.length === 0) {
      return res.status(400).json({ message: "No valid journal lines to save." });
    }
    const totDr = r2(lines.filter((t) => t.DbCr === "D").reduce((s, t) => s + Number(t.Amount), 0));
    const totCr = r2(lines.filter((t) => t.DbCr !== "D").reduce((s, t) => s + Number(t.Amount), 0));
    if (Math.abs(totDr - totCr) >= 0.005) {
      return res.status(400).json({
        message: `Journal does not balance: Debit ${totDr.toFixed(2)}, Credit ${totCr.toFixed(2)}.`,
      });
    }

    const TRAN_TYPE = String(vchrData.TranType);
    const isAdd = String(vchrData.Mode || "").toUpperCase() === "ADD";
    if (!isAdd && !vchrData.VchrNo) {
      return res.status(400).json({ message: "VchrNo is required to update a voucher." });
    }

    const lockName = `hayaterp_vchr_${TRAN_TYPE}`;
    let conn;
    let haveLock = false;

    try {
      conn = await getConn();

      if (isAdd) {
        // ── ADD: allocate under the named lock ─────────────────────────────
        const lk = await query(conn, `SELECT GET_LOCK(?, 15) AS L`, [lockName]);
        if (Number(lk[0]?.L) !== 1) {
          return res.status(503).json({
            message: "Another user is saving a voucher of this type — please press Save again.",
          });
        }
        haveLock = true;

        let VCHR_NO = null;
        for (let attempt = 1; attempt <= 3 && !VCHR_NO; attempt++) {
          await begin(conn);
          try {
            const candidate = pad((await maxVchrNo(conn, TRAN_TYPE)) + 1);   // re-read each attempt
            await insertVoucher(conn, TRAN_TYPE, candidate, vchrData, lines, InvStlData);
            await commit(conn);
            VCHR_NO = candidate;
          } catch (err) {
            await rollback(conn);
            // A screen still on the old build (no lock) may have grabbed the
            // number between our read and insert — try the next one.
            if (err && err.code === "ER_DUP_ENTRY" && attempt < 3) continue;
            throw err;
          }
        }

        const requested = vchrData.VchrNo ? pad(vchrData.VchrNo) : null;
        if (requested && requested !== VCHR_NO) {
          console.log(`JV ADD — screen showed ${requested}, allocated ${VCHR_NO}`);
        }
        return res.json({
          message: "Journal Voucher saved successfully!",
          vchrNo: VCHR_NO,
          renumbered: Boolean(requested && requested !== VCHR_NO),
        });
      }

      // ── EDIT: lock this voucher, then rewrite it ─────────────────────────
      const VCHR_NO = String(vchrData.VchrNo);
      await begin(conn);
      try {
        // Row lock on the header: a second save of the same JV waits here
        // until this one commits, instead of interleaving deletes/inserts.
        await query(
          conn,
          `SELECT VCHR_NO FROM vouchers WHERE TRAN_TYPE = ? AND VCHR_NO = ? FOR UPDATE`,
          [TRAN_TYPE, VCHR_NO]
        );
        await deleteVoucher(conn, TRAN_TYPE, VCHR_NO);
        await insertVoucher(conn, TRAN_TYPE, VCHR_NO, vchrData, lines, InvStlData);
        await commit(conn);
      } catch (err) {
        await rollback(conn);
        throw err;
      }
      return res.json({ message: "Journal Voucher saved successfully!", vchrNo: VCHR_NO });

    } catch (err) {
      console.error("JV save failed:", err);
      return res.status(500).json({
        message: "Journal Voucher save failed — nothing was written.",
        error: String(err?.sqlMessage || err),
      });
    } finally {
      if (conn) {
        // A named lock belongs to the connection, not the transaction — it
        // must be released before the connection goes back to the pool, or
        // the next user of that pooled connection would still hold it.
        if (haveLock) {
          try { await query(conn, `SELECT RELEASE_LOCK(?)`, [lockName]); } catch (_) { /* ignore */ }
        }
        conn.release();
      }
    }
  });

  return router;
};
