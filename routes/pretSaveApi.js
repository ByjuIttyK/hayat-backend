// routes/pretSaveApi.js
// Purchase Return save route — moved out of HayatDb.js.
// Register in HayatDb.js:
//   const pretSaveApi = require("./routes/pretSaveApi");
//   app.use("/api", pretSaveApi(connection));
//
// Numbering (same pattern as save-fabinv / save-lpo / save-localpurch / save-ngp):
//   ADD  → the real VCHR_NO (format 000106RLV1 — see nextPretNo) is MAX+1 from
//          pret_hdr, taken inside the save
//          transaction, and the header goes in with a plain INSERT. VCHR_NO is
//          the key of pret_hdr, so if two users save at the same instant the
//          second INSERT fails with ER_DUP_ENTRY and the whole save is retried in
//          a fresh transaction with a fresh MAX. Nothing is ever overwritten.
//   EDIT → the return must already exist (locked FOR UPDATE), then it is updated.
// The response returns the saved VchrNo; if it differs from the number the
// screen was showing, `changed` is true and `message` says so.
//
// Header columns written: VCHR_NO, VCHR_DATE, SUP_CODE, INV_NO, INV_DATE,
// NARRATION, DISCOUNT, VAT_PERC, VAT_AMOUNT, INV_AMOUNT — check them with
// `desc pret_hdr;` (the screen already reads all of these back via /api/prethdr).

const express = require("express");
const { postToTranAcc } = require('../services/glPostingService');

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

  const num = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  };

  // ── Next Purchase Return number: 000105RLV1 → 000106RLV1 ──
  // Format: 6-digit running number + the fixed suffix "RLV1" (as migrated
  // from Oracle). The running number is the highest of:
  //   • the 6 leading digits of every number already in that format, and
  //   • any all-digit number saved by the old route (e.g. "0000000106" = 106),
  // so a stray old-style number never lets the same running number be issued
  // twice, whether or not it has been renamed yet.
  const PRET_SUFFIX = "RLV1";
  const PRET_DIGITS = 6;
  const nextPretNo = async (conn) => {
    const [r] = await q(
      conn,
      `SELECT GREATEST(
                COALESCE(MAX(CASE WHEN VCHR_NO REGEXP ?
                                  THEN CAST(LEFT(VCHR_NO, ?) AS UNSIGNED) END), 0),
                COALESCE(MAX(CASE WHEN VCHR_NO REGEXP '^[0-9]+$'
                                  THEN CAST(VCHR_NO AS UNSIGNED) END), 0)
              ) AS mx
         FROM pret_hdr`,
      [`^[0-9]{${PRET_DIGITS}}${PRET_SUFFIX}$`, PRET_DIGITS]
    );
    return String(Number(r.mx) + 1).padStart(PRET_DIGITS, "0") + PRET_SUFFIX;
  };

  const MAX_ATTEMPTS = 5;

  router.post("/save-pret", async (req, res) => {
    try {
      const { netData, itemsData } = req.body; // form data & grid rows

      if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
        return res.status(400).json({ message: "Invalid data format" });
      }
      console.log("PURCHASE RETURN HDR   =>", netData);
      console.log("PURCHASE RETURN ITEMS =>", itemsData);

      // Missing mode = EDIT. An old browser still doing an ADD then fails the
      // existence check instead of overwriting anything.
      const mode = String(req.body.mode || "").toUpperCase() === "ADD" ? "ADD" : "EDIT";
      const givenNo = String(netData.VchrNo ?? netData.PjvNo ?? "").trim();
      if (mode === "EDIT" && !givenNo) {
        return res.status(400).json({ message: "Voucher No is required" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(netData.PjvDt ?? ""))) {
        return res.status(400).json({ message: "Voucher Date is required" });
      }
      if (!String(netData.SupCd ?? "").trim()) {
        return res.status(400).json({ message: "Supplier Code is required" });
      }

      // SR_NOs still on screen — used in EDIT to remove lines deleted in the grid.
      const srNos = itemsData
        .map((r) => r.SR_NO)
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "");

      const saveOnce = async () => {
        const conn = await getConn();
        try {
          await begin(conn); // fresh transaction = fresh snapshot for MAX

          let vchrNo = givenNo;
          if (mode === "ADD") {
            vchrNo = await nextPretNo(conn);
          } else {
            const ex = await q(conn, "SELECT VCHR_NO FROM pret_hdr WHERE VCHR_NO = ? FOR UPDATE", [vchrNo]);
            if (!ex.length) {
              throw Object.assign(new Error(`Purchase Return ${vchrNo} not found`), { status: 404 });
            }
          }

          // ── Step 1: pret_hdr ──
          // ADD = plain INSERT, so a number clash throws ER_DUP_ENTRY instead of
          // overwriting another user's return. EDIT keeps the upsert (row is
          // confirmed to exist and locked above).
          // (The old route listed 6 columns but passed 7 values, so VAT_PERC was
          //  being written with the discount amount.)
          const insertPart = `
            INSERT INTO pret_hdr (VCHR_NO, VCHR_DATE, SUP_CODE,PJV_NO,INV_NO, INV_DATE, NARRATION,
                                  DISCOUNT, VAT_PERC, VAT_AMOUNT, INV_AMOUNT)
            VALUES (?, ?, ?, ?,?, ?, ?, ?, ?, ?, ?)`;
          const upsertPart = `
            ON DUPLICATE KEY UPDATE
              VCHR_DATE  = VALUES(VCHR_DATE),
              SUP_CODE   = VALUES(SUP_CODE),
              PJV_NO     =VALUES(PJV_NO),
              INV_NO     = VALUES(INV_NO),
              INV_DATE   = VALUES(INV_DATE),
              NARRATION  = VALUES(NARRATION),
              DISCOUNT   = VALUES(DISCOUNT),
              VAT_PERC   = VALUES(VAT_PERC),
              VAT_AMOUNT = VALUES(VAT_AMOUNT),
              INV_AMOUNT = VALUES(INV_AMOUNT)`;
          const hdrResult = await q(conn, mode === "ADD" ? insertPart : insertPart + upsertPart, [
            vchrNo,
            netData.PjvDt,
            String(netData.SupCd).trim(),
             netData.PjvNo,
            String(netData.InvNo ?? "").trim() || null,
            netData.InvDt || null,
            netData.Narration ?? null,
            num(netData.discAmt),
            num(netData.VatPerc),
            num(netData.VatAmt),
            num(netData.AMOUNT),
          ]);
          console.log(`pret_hdr ${mode}:`, vchrNo, hdrResult.affectedRows);

          // ── Step 2: pret_items ──
          // Every line takes vchrNo — never row.VCHR_NO, which carries the
          // provisional number (or "" on rows typed into blank filler lines).
          const itemsQuery = `
            INSERT INTO pret_items (VCHR_NO, SR_NO, ITEM_CODE, QTY, COST)
            VALUES ?
            ON DUPLICATE KEY UPDATE
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE),
              QTY       = COALESCE(VALUES(QTY), QTY),
              COST      = COALESCE(VALUES(COST), COST)`;
          const values = itemsData.map((row) => [vchrNo, row.SR_NO, row.ITEM_CODE, row.QTY, row.COST]);
          const itemsResult = await q(conn, itemsQuery, [values]);
          console.log("pret_items Insert/Update:", itemsResult.affectedRows);

          // ── Step 3: remove lines deleted on screen (EDIT only — a new return
          // has no old lines). Same transaction, so a failure rolls back.
          if (mode === "EDIT" && srNos.length) {
            const delResult = await q(
              conn,
              "DELETE FROM pret_items WHERE VCHR_NO = ? AND SR_NO NOT IN (?)",
              [vchrNo, srNos]
            );
            console.log("pret_items deleted rows:", delResult.affectedRows);
          }
          //GL
     await postToTranAcc({
        ModuleName: 'PRET',
        InvNo: vchrNo,
        Date: netData.PjvDt,
        Narration: netData.Narration|| '',
        SupCode: netData.SupCd,
        GrossAmt: netData.GrossAmt,
        VatAmt: netData.VatAmt,
        DiscAmt: netData.discAmt,
        NetAmt: netData.AMOUNT,
        JobNo: netData.PjvNo || null,
      }, conn);

          await commit(conn);
          return vchrNo;
        } catch (e) {
          await rollback(conn);
          throw e;
        } finally {
          conn.release(); // always, on every path
        }
      };

      // ── Run it; on a voucher-number clash, retry with a new transaction ──
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const savedNo = await saveOnce();
          const changed = mode === "ADD" && givenNo !== "" && savedNo !== givenNo;
          return res.json({
            message: changed
              ? `Voucher No ${givenNo} was already taken. Saved as ${savedNo}.`
              : `Purchase Return ${savedNo} saved successfully!`,
            VchrNo: savedNo,
            changed,
          });
        } catch (e) {
          // Only a clash on pret_hdr's key is a number clash; a duplicate on
          // pret_items is a real bug and is reported.
          const numberClash =
            mode === "ADD" &&
            e.code === "ER_DUP_ENTRY" &&
            /'pret_hdr\./i.test(e.sqlMessage || "");
          if (numberClash && attempt < MAX_ATTEMPTS) {
            console.warn(`save-pret: voucher number clash, retrying (attempt ${attempt})`);
            continue;
          }
          console.error("Purchase Return save failed:", e);
          return res
            .status(e.status || 500)
            .json({ message: e.status ? e.message : (e.sqlMessage || "Transaction failed, rolled back") });
        }
      }
    } catch (error) {
      console.error("Server Error:", error);
      res.status(500).json({ message: "Internal Server Error", error });
    }
  });

  return router;
};
