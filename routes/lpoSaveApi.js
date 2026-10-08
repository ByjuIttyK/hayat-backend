// routes/lpoSaveApi.js
// LPO save route — moved out of HayatDb.js.
// Register in HayatDb.js:
//   const lpoSaveApi = require("./routes/lpoSaveApi");
//   app.use("/api", lpoSaveApi(connection));
//
// Numbering (same pattern as save-fabinv):
//   ADD  → the real LPO_NO is MAX(LPO_NO)+1 from lpo_net, taken inside the save
//          transaction, and the header goes in with a plain INSERT. LPO_NO is the
//          PK, so if two users save at the same instant the second INSERT fails
//          with ER_DUP_ENTRY and the whole save is retried in a fresh transaction
//          with a fresh MAX. Nothing is ever overwritten.
//   EDIT → the LPO must already exist (locked FOR UPDATE), then it is updated.
// The response returns the saved LpoNo; if it differs from the number the
// screen was showing, `changed` is true and `message` says so.

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

  const MAX_ATTEMPTS = 5;

  router.post("/save-lpo", async (req, res) => {
    try {
      console.log("save-lpo ==>", req.body);
      const { lpoNet, lpoItems } = req.body;
      if (!lpoNet || !lpoItems || !Array.isArray(lpoItems) || lpoItems.length === 0) {
        // Deliberately still rejecting an empty line list. With the delete step
        // below, an empty payload would wipe every line of the LPO — so a bug or
        // a half-loaded screen must not be able to reach that path. The frontend
        // blocks the empty case too, with its own message.
        return res.status(400).json({ message: "Invalid lpo data format" });
      }

      // Missing mode = EDIT. An old browser still doing an ADD then fails the
      // existence check instead of overwriting anything.
      const mode = String(req.body.mode || "").toUpperCase() === "ADD" ? "ADD" : "EDIT";
      const givenLpoNo = String(lpoNet.LpoNo ?? "").trim();
      if (mode === "EDIT" && !givenLpoNo) {
        return res.status(400).json({ message: "LPO No is required" });
      }

      const keptSrNos = lpoItems
        .map((row) => row.SR_NO)
        .filter((sr) => sr !== null && sr !== undefined && String(sr).trim() !== "");

      const saveOnce = async () => {
        const conn = await getConn();
        try {
          await begin(conn); // fresh transaction = fresh snapshot for MAX

          let lpoNo = givenLpoNo;
          if (mode === "ADD") {
            // CAST so '10000' sorts above '9999' (LPO_NO is varchar)
            const [r] = await q(
              conn,
              `SELECT COALESCE(MAX(CAST(LPO_NO AS UNSIGNED)), 0) AS mx
                 FROM lpo_net
                WHERE LPO_NO REGEXP '^[0-9]+$'`,
              []
            );
            lpoNo = String(Number(r.mx) + 1);
          } else {
            const ex = await q(conn, "SELECT LPO_NO FROM lpo_net WHERE LPO_NO = ? FOR UPDATE", [lpoNo]);
            if (!ex.length) {
              throw Object.assign(new Error(`LPO ${lpoNo} not found`), { status: 404 });
            }
          }

          // ── Step 1: lpo_net ──
          // ADD = plain INSERT, so a number clash throws ER_DUP_ENTRY instead of
          // overwriting another user's LPO. EDIT keeps the upsert (row is
          // confirmed to exist and locked above).
          const insertPart = `
            INSERT INTO lpo_net (
              LPO_NO, LPO_DATE, SUP_CODE, NARRATION, AMOUNT, ATTN, SMAN_CODE,
              DISCOUNT, VAT_PERC, VAT_AMOUNT,
              SUPP_REF_NO, PAY_TERMS, PLACE_DLV, DELIVERY_REQ,
              PREPARED_BY, ACCOUNTS_DEPT, APPROVED_BY, LPO_TYPE
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          const upsertPart = `
            ON DUPLICATE KEY UPDATE
              LPO_DATE      = VALUES(LPO_DATE),
              SUP_CODE      = VALUES(SUP_CODE),
              NARRATION     = VALUES(NARRATION),
              AMOUNT        = VALUES(AMOUNT),
              ATTN          = VALUES(ATTN),
              SMAN_CODE     = VALUES(SMAN_CODE),
              DISCOUNT      = VALUES(DISCOUNT),
              VAT_PERC      = VALUES(VAT_PERC),
              VAT_AMOUNT    = VALUES(VAT_AMOUNT),
              SUPP_REF_NO   = VALUES(SUPP_REF_NO),
              PAY_TERMS     = VALUES(PAY_TERMS),
              PLACE_DLV     = VALUES(PLACE_DLV),
              DELIVERY_REQ  = VALUES(DELIVERY_REQ),
              PREPARED_BY   = VALUES(PREPARED_BY),
              ACCOUNTS_DEPT = VALUES(ACCOUNTS_DEPT),
              APPROVED_BY   = VALUES(APPROVED_BY),
              LPO_TYPE      = VALUES(LPO_TYPE)`;
          const netQuery = mode === "ADD" ? insertPart : insertPart + upsertPart;

          const netResult = await q(conn, netQuery, [
            lpoNo, lpoNet.LpoDt, lpoNet.SupCd, lpoNet.Narration,
            lpoNet.Amount, lpoNet.Attn, lpoNet.SmanCd,
            lpoNet.Discount, lpoNet.VatPerc, lpoNet.VatAmount,
            lpoNet.SuppRefNo, lpoNet.PayTerms, lpoNet.PlaceDlv, lpoNet.DeliveryReq,
            lpoNet.PreparedBy, lpoNet.AccountsDept, lpoNet.ApprovedBy, lpoNet.LpoType,
          ]);
          console.log(`lpo_net ${mode}:`, lpoNo, netResult.affectedRows);

          // ── Step 2: lpo_items ──
          // Every line takes lpoNo — never row.LPO_NO, which carries the
          // provisional number the screen showed before the save.
          // Straight VALUES(...) assignment — no COALESCE — so a field the user
          // cleared on screen is actually cleared in the table.
          const itemsQuery = `
            INSERT INTO lpo_items (LPO_NO, SR_NO, MAIN_SR_NO, ITEM_CODE, ITEM_NAME, PART_NO, QTY, UNIT, RATE, CAT_CODE)
            VALUES ?
            ON DUPLICATE KEY UPDATE
              MAIN_SR_NO = VALUES(MAIN_SR_NO),
              ITEM_CODE  = VALUES(ITEM_CODE),
              ITEM_NAME  = VALUES(ITEM_NAME),
              PART_NO    = VALUES(PART_NO),
              QTY        = VALUES(QTY),
              UNIT       = VALUES(UNIT),
              RATE       = VALUES(RATE),
              CAT_CODE   = VALUES(CAT_CODE)`;
          const values = lpoItems.map((row) => [
            lpoNo, row.SR_NO, row.MAIN_SR_NO, row.ITEM_CODE, row.ITEM_NAME, row.PART_NO,
            row.QTY, row.UNIT, row.RATE, row.CAT_CODE,
          ]);
          const itemsResult = await q(conn, itemsQuery, [values]);
          console.log("lpo_items Insert/Update:", itemsResult.affectedRows);

          // ── Step 3: remove lines deleted on screen (EDIT only — a new LPO has
          // no old lines). Same transaction, so a failure rolls back everything.
          if (mode === "EDIT") {
            const delResult = await q(
              conn,
              "DELETE FROM lpo_items WHERE LPO_NO = ? AND SR_NO NOT IN (?)",
              [lpoNo, keptSrNos]
            );
            console.log(
              `lpo_items rows deleted for LPO ${lpoNo}:`,
              delResult.affectedRows,
              "(kept SR_NOs:", keptSrNos.join(","), ")"
            );
          }

          await commit(conn);
          return lpoNo;
        } catch (e) {
          await rollback(conn);
          throw e;
        } finally {
          conn.release(); // always, on every path
        }
      };

      // ── Run it; on an LPO-number clash, retry with a new transaction ──
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const savedNo = await saveOnce();
          const changed = mode === "ADD" && givenLpoNo !== "" && savedNo !== givenLpoNo;
          return res.json({
            message: changed
              ? `LPO No ${givenLpoNo} was already taken. Saved as LPO No ${savedNo}.`
              : `LPO ${savedNo} saved successfully!`,
            LpoNo: savedNo,
            changed,
          });
        } catch (e) {
          const numberClash =
            mode === "ADD" &&
            e.code === "ER_DUP_ENTRY" &&
            /lpo_net\.PRIMARY/i.test(e.sqlMessage || "");
          if (numberClash && attempt < MAX_ATTEMPTS) {
            console.warn(`save-lpo: LPO number clash, retrying (attempt ${attempt})`);
            continue;
          }
          console.error("LPO save failed:", e);
          return res
            .status(e.status || 500)
            .json({ message: e.message || "LPO Transaction failed, rolled back" });
        }
      }
    } catch (error) {
      console.log("Lpo save - internal error :", error);
      res.status(500).json({ message: "Internal Server Error", error });
    }
  });

  return router;
};
