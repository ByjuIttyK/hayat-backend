// routes/purchaseLocalApi.js
// Local (stock) purchase save route — moved out of HayatDb.js.
// Register in HayatDb.js:
//   const purchaseLocalApi = require("./routes/purchaseLocalApi");
//   app.use("/api", purchaseLocalApi(connection));
//
// Numbering (same pattern as save-fabinv / save-lpo):
//   ADD  → the real PJV_NO is taken inside the save transaction, the same way
//          /api/nextPjvNo builds it: 'SP' + 8-digit running number, where the
//          running number is MAX(SUBSTR(PJV_NO,3,8))+1 across v_purchase_full
//          (purchase_hdr + purchase_hdr_ns + ngp_net — one shared series).
//          The header goes in with a plain INSERT; PJV_NO is the key, so if two
//          users save at the same instant the second INSERT fails with
//          ER_DUP_ENTRY and the whole save is retried in a fresh transaction.
//   EDIT → the PJV must already exist (locked FOR UPDATE), then it is updated.
// The response returns the saved PjvNo; if it differs from the number the
// screen was showing, `changed` is true and `message` says so.

const express = require("express");
const { postToTranAcc } = require("../services/glPostingService");

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

  const PJV_PREFIX = "SP"; // Stock - Local Purchase (same prefix the screen asks /api/nextPjvNo for)
  const MAX_ATTEMPTS = 5;

  router.post("/save-localpurch", async (req, res) => {
    try {
      const { netData, itemsData } = req.body; // form data & grid rows

      if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
        return res.status(400).json({ message: "Invalid data format" });
      }
      console.log("PURCHASE LOCAL HDR =>**", netData);
      console.log("PURCHASE LOCAL ITEMS =>** ", itemsData);

      // Missing mode = EDIT. An old browser still doing an ADD then fails the
      // existence check instead of overwriting anything.
      const mode = String(req.body.mode || "").toUpperCase() === "ADD" ? "ADD" : "EDIT";
      const givenPjvNo = String(netData.PjvNo ?? "").trim();
      if (mode === "EDIT" && !givenPjvNo) {
        return res.status(400).json({ message: "PJV No is required" });
      }

      // SR_NOs still on screen — used in EDIT to remove lines deleted in the grid.
      // SR_NO is never resequenced on the client, so these match what is stored.
      const srNos = itemsData
        .map((r) => r.SR_NO)
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "");

      const saveOnce = async () => {
        const conn = await getConn();
        try {
          await begin(conn); // fresh transaction = fresh snapshot for MAX

          let pjvNo = givenPjvNo;
          if (mode === "ADD") {
            const [r] = await q(
              conn,
              `SELECT COALESCE(MAX(CAST(SUBSTR(a.PJV_NO, 3, 8) AS UNSIGNED)), 0) AS mx
                 FROM v_purchase_full a`,
              []
            );
            pjvNo = PJV_PREFIX + String(Number(r.mx) + 1).padStart(8, "0");
          } else {
            const ex = await q(conn, "SELECT PJV_NO FROM purchase_hdr WHERE PJV_NO = ? FOR UPDATE", [pjvNo]);
            if (!ex.length) {
              throw Object.assign(new Error(`Purchase voucher ${pjvNo} not found`), { status: 404 });
            }
          }

          // ── Step 1: purchase_hdr ──
          // ADD = plain INSERT, so a number clash throws ER_DUP_ENTRY instead of
          // overwriting another user's voucher. EDIT keeps the upsert (row is
          // confirmed to exist and locked above).
          const insertPart = `
            INSERT INTO purchase_hdr (PJV_NO, PJV_DATE, SUP_CODE, NARRATION,
                                      INV_NO, INV_DATE, PO_NO, INV_AMOUNT, DISCOUNT, VAT_PERC, VAT_AMOUNT)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          const upsertPart = `
            ON DUPLICATE KEY UPDATE
              PJV_DATE   = VALUES(PJV_DATE),
              SUP_CODE   = VALUES(SUP_CODE),
              NARRATION  = VALUES(NARRATION),
              INV_NO     = VALUES(INV_NO),
              INV_DATE   = VALUES(INV_DATE),
              PO_NO      = VALUES(PO_NO),
              INV_AMOUNT = VALUES(INV_AMOUNT),
              DISCOUNT   = VALUES(DISCOUNT),
              VAT_PERC   = VALUES(VAT_PERC),
              VAT_AMOUNT = VALUES(VAT_AMOUNT)`;
          const netQuery = mode === "ADD" ? insertPart : insertPart + upsertPart;

          const hdrResult = await q(conn, netQuery, [
            pjvNo, netData.PjvDt, netData.SupCd,
            netData.Narration, netData.InvNo, netData.InvDt, netData.LpoNo,
            netData.AMOUNT, netData.discAmt, netData.VatPct,
            netData.VatAmt, // was netData.vatAmt — the screen sends VatAmt, so VAT_AMOUNT was saving NULL
          ]);
          console.log(`purchase_hdr ${mode}:`, pjvNo, hdrResult.affectedRows);

          // ── Step 2: purchase_items ──
          // Every line takes pjvNo — never row.PJV_NO, which carries the
          // provisional number the screen showed before the save.
          const itemsQuery = `
            INSERT INTO purchase_items (PJV_NO, SR_NO, SRV_NO, ITEM_CODE, QTY, COST)
            VALUES ?
            ON DUPLICATE KEY UPDATE
              SRV_NO    = COALESCE(VALUES(SRV_NO), SRV_NO),
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE),
              QTY       = COALESCE(VALUES(QTY), QTY),
              COST      = COALESCE(VALUES(COST), COST)`;
          const values = itemsData.map((row) => [
            pjvNo, row.SR_NO, row.SRV_NO, row.ITEM_CODE, row.QTY, row.COST,
          ]);
          const itemsResult = await q(conn, itemsQuery, [values]);
          console.log("PURCHASE_ITEMS Insert/Update:", itemsResult.affectedRows);

          // ── Step 3: delete item rows the user removed in the grid (EDIT only —
          // a new voucher has no old lines). Same transaction, so a failure here
          // rolls the whole save back.
          if (mode === "EDIT" && srNos.length) {
            const delResult = await q(
              conn,
              "DELETE FROM purchase_items WHERE PJV_NO = ? AND SR_NO NOT IN (?)",
              [pjvNo, srNos]
            );
            console.log("PURCHASE_ITEMS deleted rows:", delResult.affectedRows);
          }

          // ── Step 4: post GL entries to tran_acc (same connection/transaction) ──
          // Field names match acc_posting_setup FIELD_NAMEs.
          const glPayload = {
            ModuleName: "PURCHASE_HDR",
            InvNo: pjvNo,
            Date: netData.PjvDt,
            Narration: `Inv:${netData.InvNo}:${netData.InvDt}` || "",
            SupCode: netData.SupCd,
            GrossAmt: netData.GrossAmt, // PURCHASE rule
            VatAmt: netData.VatAmt,     // VAT rule
            DiscAmt: netData.discAmt,   // DISCOUNT rule
            NetAmt: netData.NetAmt,     // NET_PAYABLE rule
            JobNo: netData.JobNo || null,
            PanelNo: netData.PanelNo || null,
          };
          await postToTranAcc(glPayload, conn);

          await commit(conn);
          return pjvNo;
        } catch (e) {
          await rollback(conn);
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
              : `Purchase ${savedNo} saved successfully!`,
            PjvNo: savedNo,
            changed,
          });
        } catch (e) {
          // Only a clash on the purchase_hdr key is a number clash; a duplicate
          // on purchase_items or tran_acc is a real bug and is reported.
          const numberClash =
            mode === "ADD" &&
            e.code === "ER_DUP_ENTRY" &&
            /'purchase_hdr\./i.test(e.sqlMessage || "");
          if (numberClash && attempt < MAX_ATTEMPTS) {
            console.warn(`save-localpurch: PJV number clash, retrying (attempt ${attempt})`);
            continue;
          }
          console.error("Local purchase save failed:", e);
          return res
            .status(e.status || 500)
            .json({ message: e.message || "Purchase Transaction failed, rolled back" });
        }
      }
    } catch (error) {
      console.error("Server Error:", error);
      res.status(500).json({ message: "Internal Server Error", error });
    }
  });

  return router;
};
