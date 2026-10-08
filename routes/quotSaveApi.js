// routes/quotSaveApi.js
// Quotation save route — moved out of HayatDb.js.
// Register in HayatDb.js:
//   const quotSaveApi = require("./routes/quotSaveApi");
//   app.use("/api", quotSaveApi(connection));
//
// Numbering (same pattern as save-fabinv / save-lpo / save-do — no counter table):
//   ADD  → the real QUOT_NO is MAX(QUOT_NO)+1 from quot_hdr, taken inside the
//          save transaction, and the header goes in with a plain INSERT. QUOT_NO
//          is the PK, so if two users save at the same instant the second INSERT
//          fails with ER_DUP_ENTRY, its transaction rolls back, and the save is
//          retried with a fresh MAX (up to 5 times). Nothing is ever overwritten.
//   EDIT → the quotation must already exist (locked FOR UPDATE), then it is
//          updated and its lines replaced.
// The body carries `mode` ("ADD" | "EDIT"); a missing mode is treated as EDIT.
// The response returns the saved QtNo; `changed` is true when it differs from
// the number the screen was showing.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  // ── Promise helpers over the callback-style pool ──
  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const begin = (conn) =>
    new Promise((resolve, reject) => conn.beginTransaction((err) => (err ? reject(err) : resolve())));
  const commit = (conn) =>
    new Promise((resolve, reject) => conn.commit((err) => (err ? reject(err) : resolve())));
  const rollback = (conn) => new Promise((resolve) => conn.rollback(() => resolve()));
  const q = (conn, sql, params) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result))));

  // ── Next quotation number: MAX(QUOT_NO)+1 ──
  // Numeric max (CAST), so '10000' sorts above '9999' on the varchar key. The
  // new number keeps the width of the current highest one ('0000000165' →
  // '0000000166'); with no numeric quotation yet it starts at 10 digits.
  const QUOT_NO_WIDTH = 10;
  const nextQuotNo = async (conn) => {
    const rows = await q(
      conn,
      `SELECT QUOT_NO
         FROM quot_hdr
        WHERE QUOT_NO REGEXP '^[0-9]+$'
        ORDER BY CAST(QUOT_NO AS UNSIGNED) DESC
        LIMIT 1`,
      []
    );
    if (!rows.length) return "1".padStart(QUOT_NO_WIDTH, "0");
    const last = String(rows[0].QUOT_NO);
    return String(Number(last) + 1).padStart(last.length, "0");
  };

  const MAX_ATTEMPTS = 5;

  router.post("/save-quotation", async (req, res) => {
    try {
      const { qtHdr, lpoItems } = req.body || {};
      if (!qtHdr) return res.status(400).json({ message: "Quotation header missing" });
      console.log("Qt Hdr. ==>", qtHdr);
      console.log("Qt Items. ==>", (lpoItems || []).length, "rows");

      const mode = String(req.body.mode || "").toUpperCase() === "ADD" ? "ADD" : "EDIT";
      const givenNo = String(qtHdr.QtNo ?? "").trim();
      if (mode === "EDIT" && !givenNo) {
        return res.status(400).json({ message: "Quotation No is required" });
      }

      // skip blank grid lines (no code and no description)
      const rows = (Array.isArray(lpoItems) ? lpoItems : []).filter(
        (r) =>
          (r.ITEM_CODE && String(r.ITEM_CODE).trim()) ||
          (r.ITEM_NAME && String(r.ITEM_NAME).trim())
      );

      const saveOnce = async () => {
        const conn = await getConn();
        try {
          await begin(conn); // fresh transaction = fresh snapshot for MAX

          let qtNo = givenNo;
          if (mode === "ADD") {
            qtNo = await nextQuotNo(conn);
          } else {
            const ex = await q(conn, "SELECT QUOT_NO FROM quot_hdr WHERE QUOT_NO = ? FOR UPDATE", [qtNo]);
            if (!ex.length) {
              throw Object.assign(new Error(`Quotation ${qtNo} not found`), { status: 404 });
            }
          }

          /* ── 1) header. ADD = plain INSERT, so a number clash throws
                 ER_DUP_ENTRY instead of overwriting another user's quotation.
                 EDIT keeps the upsert (row is confirmed to exist and locked). */
          const insertPart = `
            INSERT INTO quot_hdr
              (QUOT_NO, QUOT_DATE, CUST_CODE, PAYMENT_TERMS, ENGG_CODE, ATTN,
               YOUR_REF, SUBJECT, PROJECT_NAME, CURR_CODE, REV_NO, INQ_NO, TEL_NO,
               AMOUNT, DISCOUNT, ROUND_OFF, VAT_PERC, VAT_AMOUNT)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          const upsertPart = `
            ON DUPLICATE KEY UPDATE
              QUOT_DATE     = COALESCE(VALUES(QUOT_DATE), QUOT_DATE),
              CUST_CODE     = VALUES(CUST_CODE),
              PAYMENT_TERMS = VALUES(PAYMENT_TERMS),
              ENGG_CODE     = VALUES(ENGG_CODE),
              ATTN          = VALUES(ATTN),
              YOUR_REF      = VALUES(YOUR_REF),
              SUBJECT       = VALUES(SUBJECT),
              PROJECT_NAME  = VALUES(PROJECT_NAME),
              CURR_CODE     = VALUES(CURR_CODE),
              REV_NO        = VALUES(REV_NO),
              INQ_NO        = VALUES(INQ_NO),
              TEL_NO        = VALUES(TEL_NO),
              AMOUNT        = VALUES(AMOUNT),
              DISCOUNT      = VALUES(DISCOUNT),
              ROUND_OFF     = VALUES(ROUND_OFF),
              VAT_PERC      = VALUES(VAT_PERC),
              VAT_AMOUNT    = VALUES(VAT_AMOUNT)`;
          await q(conn, mode === "ADD" ? insertPart : insertPart + upsertPart, [
            qtNo, qtHdr.QtDt || null, qtHdr.CustCd, qtHdr.PayTrm, qtHdr.EngCd,
            qtHdr.Attn, qtHdr.YourRef, qtHdr.Subject, qtHdr.ProjName,
            qtHdr.CurrCd, qtHdr.RevNo, qtHdr.inqNo, qtHdr.TelNo,
            qtHdr.Amount || 0, qtHdr.Discount || 0, qtHdr.RoundOff || 0,
            qtHdr.VatPerc || 0, qtHdr.VatAmount || 0,
          ]);

          /* ── 2) items: wipe this quotation's rows (EDIT only — a new
                 quotation has none), then insert the grid as it stands.
                 Every line takes qtNo, never the row's QUOT_NO, which carries
                 the provisional number the screen showed before the save. */
          if (mode === "EDIT") {
            await q(conn, `DELETE FROM quot_item WHERE QUOT_NO = ?`, [qtNo]);
          }
          if (rows.length > 0) {
            const values = rows.map((row) => [
              qtNo, row.SR_NO, row.LOC_CODE, row.ITEM_CODE,
              row.ITEM_NAME, row.QTY, row.RATE,
            ]);
            const result = await q(
              conn,
              `INSERT INTO quot_item
                 (QUOT_NO, SR_NO, LOC_CODE, ITEM_CODE, ITEM_NAME, QTY, RATE)
               VALUES ?`,
              [values]
            );
            console.log("quot_item inserted:", result.affectedRows, "rows");
          }

          await commit(conn);
          return qtNo;
        } catch (e) {
          await rollback(conn);
          throw e;
        } finally {
          conn.release(); // always, on every path
        }
      };

      // ── Run it; on a quotation-number clash, retry with a new transaction ──
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const savedNo = await saveOnce();
          const changed = mode === "ADD" && givenNo !== "" && savedNo !== givenNo;
          return res.json({
            message: changed
              ? `Quotation No ${givenNo} was already taken. Saved as ${savedNo}.`
              : "Quot saved successfully!",
            QtNo: savedNo,
            changed,
          });
        } catch (e) {
          // Only a clash on quot_hdr's key is a number clash; a duplicate on
          // quot_item is a real bug and is reported.
          const numberClash =
            mode === "ADD" &&
            e.code === "ER_DUP_ENTRY" &&
            /'quot_hdr\./i.test(e.sqlMessage || "");
          if (numberClash && attempt < MAX_ATTEMPTS) {
            console.warn(`save-quotation: number clash, retrying (attempt ${attempt})`);
            continue;
          }
          console.error("Quot.Transaction Failed:", e);
          return res
            .status(e.status || 500)
            .json({ message: e.status ? e.message : (e.sqlMessage || "Transaction failed, rolled back") });
        }
      }
    } catch (error) {
      console.log("QT save - internal error :", error);
      res.status(500).json({ message: "Qt.Doc. save Internal Server Error", error });
    }
  });

  return router;
};
