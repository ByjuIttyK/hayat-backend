// routes/fabDoSaveApi.js
// Fabrication Delivery Order save route — moved out of HayatDb.js.
// Register in HayatDb.js:
//   const fabDoSaveApi = require("./routes/fabDoSaveApi");
//   app.use("/api", fabDoSaveApi(connection));
//
// fab_do_hdr.INV_NO holds the actual D.O number (DO_NO holds the invoice ref).
//
// Numbering (same pattern as save-fabinv / save-lpo / save-pret):
//   ADD  → the real D.O no is MAX(INV_NO)+1 from fab_do_hdr, taken inside the
//          save transaction, and the header goes in with a plain INSERT. INV_NO
//          is the PK, so if two users save at the same instant the second INSERT
//          fails with ER_DUP_ENTRY and the whole save is retried in a fresh
//          transaction with a fresh MAX. Nothing is ever overwritten.
//   EDIT → the D.O must already exist (locked FOR UPDATE), then it is updated.
// The response returns the saved DoNo; if it differs from the number the
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

  // ── Next D.O number: MAX(INV_NO)+1 ──
  // Numeric max (CAST), so '10000' sorts above '9999' on the varchar column.
  // The new number keeps the width of the current highest one, so a
  // zero-padded series ('0000004512' → '0000004513') stays zero-padded.
  const nextDoNo = async (conn) => {
    const rows = await q(
      conn,
      `SELECT INV_NO
         FROM fab_do_hdr
        WHERE INV_NO REGEXP '^[0-9]+$'
        ORDER BY CAST(INV_NO AS UNSIGNED) DESC
        LIMIT 1`,
      []
    );
    if (!rows.length) return "1";
    const last = String(rows[0].INV_NO);
    return String(Number(last) + 1).padStart(last.length, "0");
  };

  const MAX_ATTEMPTS = 5;

  router.post("/save-do", async (req, res) => {
    console.log("save-do, start ===>");
    try {
      const { DoHdr, itemsData } = req.body; // form data & grid rows

      if (!DoHdr || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
        return res.status(400).json({ message: "Invalid data format" });
      }
      console.log("FAB DO HDR**", DoHdr);

      // Missing mode = EDIT. An old browser still doing an ADD then fails the
      // existence check instead of overwriting anything.
      const mode = String(req.body.mode || "").toUpperCase() === "ADD" ? "ADD" : "EDIT";
      const givenNo = String(DoHdr.DoNo ?? "").trim();
      if (mode === "EDIT" && !givenNo) {
        return res.status(400).json({ message: "D.O No is required" });
      }

      // SR_NOs still on screen — used in EDIT to remove lines deleted in the grid.
      // TRIM() guards against space-padded CHAR values from the Oracle migration.
      const srNos = itemsData
        .map((r) => r.SR_NO)
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
        .map((v) => String(v).trim());

      const saveOnce = async () => {
        const conn = await getConn();
        try {
          await begin(conn); // fresh transaction = fresh snapshot for MAX

          let doNo = givenNo;
          if (mode === "ADD") {
            doNo = await nextDoNo(conn);
          } else {
            const ex = await q(conn, "SELECT INV_NO FROM fab_do_hdr WHERE INV_NO = ? FOR UPDATE", [doNo]);
            if (!ex.length) {
              throw Object.assign(new Error(`D.O ${doNo} not found`), { status: 404 });
            }
          }

          // ── Step 1: fab_do_hdr ──
          // ADD = plain INSERT, so a number clash throws ER_DUP_ENTRY instead of
          // overwriting another user's D.O. EDIT keeps the upsert (row is
          // confirmed to exist and locked above).
          const insertPart = `
            INSERT INTO fab_do_hdr (INV_NO, INV_DATE, CUST_CODE, JOB_NO,
                                    LPO_NO, LPO_DATE, DO_NO, CONTACT_PERSON, DO_APPROVED,
                                    PROJECT_DETAIL)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          const upsertPart = `
            ON DUPLICATE KEY UPDATE
              INV_DATE       = VALUES(INV_DATE),
              CUST_CODE      = VALUES(CUST_CODE),
              JOB_NO         = VALUES(JOB_NO),
              LPO_NO         = VALUES(LPO_NO),
              LPO_DATE       = VALUES(LPO_DATE),
              DO_NO          = VALUES(DO_NO),
              CONTACT_PERSON = VALUES(CONTACT_PERSON),
              DO_APPROVED    = VALUES(DO_APPROVED),
              PROJECT_DETAIL = VALUES(PROJECT_DETAIL)`;
          const hdrResult = await q(conn, mode === "ADD" ? insertPart : insertPart + upsertPart, [
            doNo, DoHdr.DoDt, DoHdr.CustCd,
            DoHdr.JobNo, DoHdr.LpoNo, DoHdr.LpoDt, DoHdr.InvNo, DoHdr.Attn, DoHdr.DoAprv,
            DoHdr.ClientPrjRef,
          ]);
          console.log(`fab_do_hdr ${mode}:`, doNo, hdrResult.affectedRows);

          // ── Step 2: fab_do_dtl ──
          // Every line takes doNo — never the row's DO_NO, which carries the
          // provisional number the screen showed before the save.
          const itemsQuery = `
            INSERT INTO fab_do_dtl (INV_NO, SR_NO, INV_DATE, ITEM_CODE, INV_ITEM_DESC, INV_QTY, INV_UNIT)
            VALUES ?
            ON DUPLICATE KEY UPDATE
              INV_DATE      = VALUES(INV_DATE),
              ITEM_CODE     = COALESCE(VALUES(ITEM_CODE), ITEM_CODE),
              INV_ITEM_DESC = VALUES(INV_ITEM_DESC),
              INV_QTY       = COALESCE(VALUES(INV_QTY), INV_QTY),
              INV_UNIT      = COALESCE(VALUES(INV_UNIT), INV_UNIT)`;
          const values = itemsData.map((row) => [
            doNo, row.SR_NO, DoHdr.DoDt, row.ITEM_CODE, row.ITEM_NAME, row.QTY, row.UNIT,
          ]);
          const itemsResult = await q(conn, itemsQuery, [values]);
          console.log("DO_ITEMS Insert/Update:", itemsResult.affectedRows);

          // ── Step 3: delete detail rows the user removed in the grid (EDIT
          // only — a new D.O has no old lines, so an ADD never deletes anything).
          if (mode === "EDIT") {
            const delResult = srNos.length
              ? await q(conn, "DELETE FROM fab_do_dtl WHERE INV_NO = ? AND TRIM(SR_NO) NOT IN (?)", [doNo, srNos])
              : await q(conn, "DELETE FROM fab_do_dtl WHERE INV_NO = ?", [doNo]);
            console.log("DO_ITEMS deleted rows:", delResult.affectedRows);
          }

          await commit(conn);
          return doNo;
        } catch (e) {
          await rollback(conn);
          throw e;
        } finally {
          conn.release(); // always, on every path
        }
      };

      // ── Run it; on a D.O-number clash, retry with a new transaction ──
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const savedNo = await saveOnce();
          const changed = mode === "ADD" && givenNo !== "" && savedNo !== givenNo;
          return res.json({
            message: changed
              ? `D.O No ${givenNo} was already taken. Saved as D.O No ${savedNo}.`
              : `D.O ${savedNo} saved successfully!`,
            DoNo: savedNo,
            changed,
          });
        } catch (e) {
          // Only a clash on fab_do_hdr's key is a number clash; a duplicate on
          // fab_do_dtl is a real bug and is reported.
          const numberClash =
            mode === "ADD" &&
            e.code === "ER_DUP_ENTRY" &&
            /'fab_do_hdr\./i.test(e.sqlMessage || "");
          if (numberClash && attempt < MAX_ATTEMPTS) {
            console.warn(`save-do: D.O number clash, retrying (attempt ${attempt})`);
            continue;
          }
          console.error("D.O save failed:", e);
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
