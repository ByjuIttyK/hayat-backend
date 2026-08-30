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
//  Strategy: full delete-then-insert inside a single transaction.
//  All existing rows for the voucher (TRAN_TYPE + VCHR_NO) are deleted first,
//  then the fresh data from JvEnt.tsx is inserted.  This prevents stale SR_NO
//  ghost rows that an ON-DUPLICATE-KEY approach leaves behind when lines are
//  removed on the UI side.
//
//  Payload from JvEnt.tsx  →  POST /api/save-jv
//  {
//    vchrData    : { TranType, VchrNo, VchrDate, Particulars }
//    tranaccData : [{ TranType, VchrNo, SrNo, AccCode, RefNo,
//                     Narration1, Narration2, Amount, DbCr }]
//    InvStlData  : [{ TranType, SourceDoc, SourceDate,
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

/**
 * Factory function — receives the shared mysql connection pool and returns
 * a configured Express Router.  This keeps the route completely self-contained
 * while sharing the single pool created in HayatDb.js.
 *
 * @param {import("mysql").Pool} connection  — the pool from HayatDb.js
 * @returns {express.Router}
 */
module.exports = function (connection) {
  const router = express.Router();

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Thin Promise wrapper around conn.query so we can use async/await
   * without nesting callbacks.
   */
  const query = (conn, sql, params) =>
    new Promise((resolve, reject) => {
      conn.query(sql, params, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

  // ─────────────────────────────────────────────────────────────────────────
  //  POST /api/save-jv
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/save-jv", async (req, res) => {
    console.log("── SAVE JOURNAL VOUCHER ──");

    try {
      const { vchrData, tranaccData, InvStlData } = req.body;

      console.log("JV vchrData    =>", vchrData);
      console.log("JV tranaccData =>", tranaccData);
      console.log("JV InvStlData  =>", InvStlData);

      // ── input validation ────────────────────────────────────────────────
      if (!vchrData?.TranType || !vchrData?.VchrNo) {
        return res
          .status(400)
          .json({ message: "TranType and VchrNo are required." });
      }
      if (!Array.isArray(tranaccData) || tranaccData.length === 0) {
        return res
          .status(400)
          .json({ message: "No valid journal lines to save." });
      }

      const TRAN_TYPE = vchrData.TranType;   // "05" for JV
      const VCHR_NO   = vchrData.VchrNo;

      // ── acquire connection from pool ─────────────────────────────────────
      connection.getConnection((connErr, conn) => {
        if (connErr) {
          console.error("JV save — pool error:", connErr);
          return res
            .status(500)
            .json({ message: "Error getting DB connection", error: connErr });
        }

        conn.beginTransaction(async (txErr) => {
          if (txErr) {
            console.error("JV save — BEGIN TRANSACTION error:", txErr);
            conn.release();
            return res
              .status(500)
              .json({ message: "Transaction start error", error: txErr });
          }

          try {

            // ════════════════════════════════════════════════════════════════
            //  STEP 1 — DELETE existing voucher rows (reverse FK order)
            // ════════════════════════════════════════════════════════════════

            // 1a. Settlement detail
            const del1 = await query(
              conn,
              `DELETE FROM adj_dtl
               WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?`,
              [TRAN_TYPE, VCHR_NO]
            );
            console.log(`adj_dtl  deleted: ${del1.affectedRows} row(s)`);

            // 1b. GL detail lines
            const del2 = await query(
              conn,
              `DELETE FROM tran_acc
               WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,
              [TRAN_TYPE, VCHR_NO]
            );
            console.log(`tran_acc deleted: ${del2.affectedRows} row(s)`);

            // 1c. Voucher header (last — in case FK references it)
            const del3 = await query(
              conn,
              `DELETE FROM vouchers
               WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,
              [TRAN_TYPE, VCHR_NO]
            );
            console.log(`vouchers deleted: ${del3.affectedRows} row(s)`);

            // ════════════════════════════════════════════════════════════════
            //  STEP 2 — INSERT voucher header
            //
            //  JV has no bank a/c, no customer code, no cheque, no foreign
            //  currency — those vouchers columns are left at their DB defaults.
            // ════════════════════════════════════════════════════════════════
            await query(
              conn,
              `INSERT INTO vouchers (
                 TRAN_TYPE, VCHR_NO, DATTE,
                 NARRATION1
               ) VALUES (?, ?, ?, ?)`,
              [
                TRAN_TYPE,
                VCHR_NO,
                vchrData.VchrDate,
                vchrData.Particulars || null,
              ]
            );
            console.log("vouchers INSERT: 1 row");

            // ════════════════════════════════════════════════════════════════
            //  STEP 3 — INSERT GL detail lines (tran_acc)
            //
            //  Component fields → DB columns:
            //    SrNo       → SR_NO
            //    AccCode    → ACC_CODE
            //    Amount     → AMOUNT      (always positive)
            //    DbCr       → DB_CR       "D" debit | "C" credit
            //    Narration1 → NARRATION1  row-level narration from the grid
            //    Narration2 → NARRATION2  voucher-level Particulars echoed
            //    RefNo      → REF_NO
            // ════════════════════════════════════════════════════════════════
            console.log(`tran_acc INSERT start — ${tranaccData.length} row(s)`);

            for (const trn of tranaccData) {
              await query(
                conn,
                `INSERT INTO tran_acc (
                   TRAN_TYPE,  VCHR_NO,    DATTE,
                   SR_NO,      ACC_CODE,
                   AMOUNT,     DB_CR,
                   NARRATION1, NARRATION2,
                   REF_NO
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  trn.TranType,
                  trn.VchrNo,
                  vchrData.VchrDate,       // always use the header date
                  trn.SrNo,
                  trn.AccCode,
                  trn.Amount,
                  trn.DbCr,                // "D" or "C"
                  trn.Narration1 || null,
                  trn.Narration2 || null,
                  trn.RefNo      || null,
                ]
              );
            }
            console.log("tran_acc INSERT end");

            // ════════════════════════════════════════════════════════════════
            //  STEP 4 — INSERT settlement rows (adj_dtl)
            //
            //  Only rows with Amount > 0 are passed by JvEnt's StlPayload.
            //  ACC_CODE = the customer/supplier GL account that owns the
            //  settlement (stlAccCode ref in JvEnt, sent as stl.AccCode).
            // ════════════════════════════════════════════════════════════════
            if (Array.isArray(InvStlData) && InvStlData.length > 0) {
              console.log(`adj_dtl INSERT start — ${InvStlData.length} row(s)`);

              for (const stl of InvStlData) {
                await query(
                  conn,
                  `INSERT INTO adj_dtl (
                     SOURCE_TYPE, SOURCE_DOC,  SOURCE_DATE,
                     ACC_CODE,
                     STLD_TYPE,   STLD_DOC,    STLD_DATE,
                     STLD_AMT
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    stl.TranType,       // SOURCE_TYPE  "05"
                    stl.SourceDoc,      // SOURCE_DOC   JV voucher no.
                    stl.SourceDate,     // SOURCE_DATE  YYYY-MM-DD
                    stl.AccCode || null, // ACC_CODE — customer/supplier GL account code
                    stl.StldType,       // STLD_TYPE    type of settled document
                    stl.StldDoc,        // STLD_DOC     settled document no.
                    stl.StldDate,       // STLD_DATE    YYYY-MM-DD or null
                    stl.Amount,         // STLD_AMT
                  ]
                );
              }
              console.log("adj_dtl INSERT end");
            } else {
              console.log("adj_dtl: no settlement rows — skipping");
            }

            // ════════════════════════════════════════════════════════════════
            //  STEP 5 — COMMIT
            // ════════════════════════════════════════════════════════════════
            conn.commit((commitErr) => {
              if (commitErr) {
                console.error("JV save — COMMIT error:", commitErr);
                conn.release();
                return res
                  .status(500)
                  .json({ message: "Commit error", error: commitErr });
              }
              console.log(`JV saved OK — VCHR_NO: ${VCHR_NO}`);
              conn.release();
              res.json({
                message: "Journal Voucher saved successfully!",
                vchrNo: VCHR_NO,
              });
            });

          } catch (stepError) {
            // ── rollback on any step failure ─────────────────────────────
            console.error("JV save — rolling back:", stepError);
            conn.rollback(() => {
              conn.release();
              res.status(500).json({
                message: "Journal Voucher save failed — transaction rolled back",
                error: String(stepError),
              });
            });
          }
        }); // beginTransaction
      }); // getConnection

    } catch (outerError) {
      console.error("JV save — outer catch:", outerError);
      res.status(500).json({
        message: "Internal Server Error: Journal Voucher save",
        error: String(outerError),
      });
    }
  }); // router.post

  return router;
}; // module.exports
