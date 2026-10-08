// routes/ngpSaveApi.js
// Non-Goods Purchase save + G/L posting — moved out of HayatDb.js.
// Register in HayatDb.js:
//   const ngpSaveApi = require("./routes/ngpSaveApi");
//   app.use("/api", ngpSaveApi(connection));
//
// Numbering (same pattern as save-fabinv / save-lpo / save-localpurch / save-purchns):
//   ADD  → the real voucher no (PRCH_NO) is taken inside the save transaction,
//          the same way /api/nextPjvNo builds it: 'NG' + 8-digit running number,
//          where the running number is MAX(SUBSTR(PJV_NO,3,8))+1 across
//          v_purchase_full (purchase_hdr + purchase_hdr_ns + ngp_net — one shared
//          series). The header goes in with a plain INSERT; PRCH_NO is the key of
//          ngp_net, so if two users save at the same instant the second INSERT
//          fails with ER_DUP_ENTRY and the whole save is retried in a fresh
//          transaction with a fresh MAX. Nothing is ever overwritten.
//          (Replaces the earlier GET_LOCK / PJV_TAKEN_SQL / NEXT_PJV_SQL logic.)
//   EDIT → the voucher must already exist (locked FOR UPDATE), then it is updated.
// The response returns the saved vchrNo; if it differs from the number the
// screen was showing, `changed` is true and `message` says so.
//
// G/L voucher (tran_acc, TRAN_TYPE '07', VCHR_NO = PRCH_NO, DATTE = PRCH_DATE):
//   Cr  Supplier                     Net amount   (Gross − Discount + VAT)
//   Dr  Each grid line A/c Code      Line amount
//   Dr  142-004-0-001  Input VAT     VAT amount
//   Cr  502-001-0-002  Discount      Discount amount
//   NARRATION1 on every line = "Inv.No <no> Dt <dd/mm/yyyy>"

const express = require("express");

// Same values as the NGP_GL block in HayatDb.js — check them against yours.
const NGP_GL = {
  TRAN_TYPE: "07",
  VAT_ACC: "142-004-0-001",
  DISC_ACC: "502-001-0-002",
  NARR1_MAX: 60, // width of tran_acc.NARRATION1
};

// "1,234.50" / "" / null → 1234.5 / 0 / 0   (Discount arrives comma-formatted from the screen)
const ngpNum = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round(n * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status, userMessage: message });

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

  const PJV_PREFIX = "NG"; // Non-Goods purchase (same prefix the screen asks /api/nextPjvNo for)
  const MAX_ATTEMPTS = 5;

  router.post("/save-ngp", async (req, res) => {
    try {
      const { netData, itemsData } = req.body;

      if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
        return res.status(400).json({ message: "Invalid data format" });
      }

      // Ngpent sends the mode inside netData (Mode); a top-level mode is accepted too.
      // Missing mode = EDIT, so an old browser fails the existence check instead
      // of overwriting anything.
      const rawMode = netData.Mode ?? req.body.mode ?? "";
      const mode = String(rawMode).toUpperCase() === "ADD" ? "ADD" : "EDIT";
      const givenNo = String(netData.LpoNo ?? "").trim();
      const vchrDt = String(netData.LpoDt ?? "").trim();
      const supCd = String(netData.SupCd ?? "").trim();
      if (!givenNo && mode === "EDIT") return res.status(400).json({ message: "Voucher No is required" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vchrDt)) return res.status(400).json({ message: "Pjv Date is required" });
      if (!supCd) return res.status(400).json({ message: "Supplier Code is required" });

      // Supplier invoice reference (both optional)
      const invNo = String(netData.InvNo ?? "").trim().slice(0, 30) || null;
      const invDt = netData.InvDt ? String(netData.InvDt).trim() : null;
      if (invDt && !/^\d{4}-\d{2}-\d{2}$/.test(invDt)) {
        return res.status(400).json({ message: "Inv. Date must be yyyy-MM-dd" });
      }
      const narration1 =
        [invNo && `Inv.No ${invNo}`, invDt && `Dt ${invDt.split("-").reverse().join("/")}`]
          .filter(Boolean).join(" ").slice(0, NGP_GL.NARR1_MAX) || null;

      // ── Amounts: recomputed here from the lines so the voucher always balances ──
      const lines = itemsData
        .map((r) => ({ acc: String(r.ACC_CODE ?? "").trim(), amt: r2(ngpNum(r.AMOUNT)) }))
        .filter((l) => l.acc);
      const gross = r2(lines.reduce((s, l) => s + l.amt, 0));
      const disc = r2(ngpNum(netData.discAmt));
      const vat = r2(ngpNum(netData.VatAmt));
      const net = r2(gross - disc + vat);
      if (Math.abs(net - ngpNum(netData.AMOUNT)) > 0.01) {
        console.warn(`NGP ${givenNo}: screen net ${netData.AMOUNT} ≠ computed net ${net}; using computed`);
      }

      // Signed legs: + = Debit, − = Credit
      const legs = [
        { acc: supCd, amt: -net },
        ...lines.map((l) => ({ acc: l.acc, amt: l.amt })),
        { acc: NGP_GL.VAT_ACC, amt: vat },
        { acc: NGP_GL.DISC_ACC, amt: -disc },
      ].filter((l) => l.amt !== 0);

      const imbalanceCents = legs.reduce((s, l) => s + Math.round(l.amt * 100), 0);
      if (imbalanceCents !== 0) {
        return res.status(400).json({ message: `G/L voucher does not balance (difference ${imbalanceCents / 100})` });
      }

      const srNos = itemsData
        .map((r) => r.SR_NO)
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "");

      console.log("NGP HDR   =>", netData);
      console.log("NGP ITEMS =>", itemsData);

      const saveOnce = async () => {
        const conn = await getConn();
        try {
          await begin(conn); // fresh transaction = fresh snapshot for MAX

          // ✅ Step 0: voucher number
          let vchrNo = givenNo;
          if (mode === "ADD") {
            const [r] = await q(
              conn,
              `SELECT COALESCE(MAX(CAST(SUBSTR(a.PJV_NO, 3, 8) AS UNSIGNED)), 0) AS mx
                 FROM v_purchase_full a`,
              []
            );
            vchrNo = PJV_PREFIX + String(Number(r.mx) + 1).padStart(8, "0");
          } else {
            const ex = await q(conn, "SELECT PRCH_NO FROM ngp_net WHERE PRCH_NO = ? FOR UPDATE", [vchrNo]);
            if (!ex.length) throw httpError(404, `Voucher ${vchrNo} not found`);

            // The number is fixed. Refuse if a Purchase Invoice owns it too (old
            // all-numeric migrated numbers), otherwise Step 4 would delete that
            // invoice's G/L lines (same tran type 07).
            const clash = await q(
              conn,
              `SELECT PJV_NO FROM purchase_hdr    WHERE TRIM(PJV_NO) = ?
               UNION ALL
               SELECT PJV_NO FROM purchase_hdr_ns WHERE TRIM(PJV_NO) = ?
               LIMIT 1`,
              [vchrNo, vchrNo]
            );
            if (clash.length) {
              throw httpError(409, `Voucher No ${vchrNo} is already used by a Purchase Invoice (tran type 07).`);
            }
          }

          // ✅ Step 1: ngp_net (header)
          // ADD = plain INSERT, so a number clash throws ER_DUP_ENTRY instead of
          // overwriting another user's voucher. EDIT keeps the upsert (row is
          // confirmed to exist and locked above).
          const insertPart = `
            INSERT INTO ngp_net (PRCH_NO, PRCH_DATE, SUP_CODE, INV_NO, INV_DATE, NARRATION, DISCOUNT, AMOUNT)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
          const upsertPart = `
            ON DUPLICATE KEY UPDATE
              PRCH_DATE = VALUES(PRCH_DATE),
              SUP_CODE  = VALUES(SUP_CODE),
              INV_NO    = VALUES(INV_NO),
              INV_DATE  = VALUES(INV_DATE),
              NARRATION = VALUES(NARRATION),
              DISCOUNT  = VALUES(DISCOUNT),
              AMOUNT    = VALUES(AMOUNT)`;
          const netResult = await q(
            conn,
            mode === "ADD" ? insertPart : insertPart + upsertPart,
            [vchrNo, vchrDt, supCd, invNo, invDt, netData.Narration, disc, net]
          );
          console.log(`NGP_NET ${mode}:`, vchrNo, netResult.affectedRows);

          // ✅ Step 2: ngp_items (lines)
          // PRCH_NO comes from the server-side number, never the row: rows carry
          // the provisional number (or "" on blank filler rows).
          const values = itemsData.map((row) => [
            vchrNo, row.SR_NO, row.ACC_CODE,
            row.NARRATION, row.JOB_NO, row.AMOUNT,
          ]);
          const itemsResult = await q(
            conn,
            `INSERT INTO ngp_items (PRCH_NO, SR_NO, ACC_CODE, NARRATION, JOB_NO, AMOUNT)
             VALUES ?
             ON DUPLICATE KEY UPDATE
               ACC_CODE  = COALESCE(VALUES(ACC_CODE), ACC_CODE),
               NARRATION = COALESCE(VALUES(NARRATION), NARRATION),
               JOB_NO    = COALESCE(VALUES(JOB_NO), JOB_NO),
               AMOUNT    = COALESCE(VALUES(AMOUNT), AMOUNT)`,
            [values]
          );
          console.log("NGP_ITEMS Insert/Update:", itemsResult.affectedRows);

          // ✅ Steps 3–4 delete old lines / G/L — EDIT only. A new voucher has
          // none, and this way an ADD can never delete anything.
          if (mode === "EDIT") {
            // Step 3: lines the user removed in the grid
            const delItems = srNos.length
              ? await q(conn, `DELETE FROM ngp_items WHERE PRCH_NO = ? AND SR_NO NOT IN (?)`, [vchrNo, srNos])
              : await q(conn, `DELETE FROM ngp_items WHERE PRCH_NO = ?`, [vchrNo]);
            console.log("NGP_ITEMS deleted rows:", delItems.affectedRows);

            // Step 4a: this voucher's existing tran_acc lines
            const delGl = await q(
              conn,
              `DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,
              [NGP_GL.TRAN_TYPE, vchrNo]
            );
            console.log("TRAN_ACC deleted rows:", delGl.affectedRows);
          }

          // ✅ Step 4b: G/L posting
          if (legs.length) {
            const glRows = legs.map((l, i) => [
              NGP_GL.TRAN_TYPE,
              vchrNo,
              String(i + 1).padStart(4, "0"), // SR_NO, same pattern as Non-Stock Purchase
              vchrDt,                          // DATTE
              l.acc,
              Math.abs(l.amt),
              l.amt > 0 ? "D" : "C",
              narration1,
            ]);
            const glResult = await q(
              conn,
              `INSERT INTO tran_acc (TRAN_TYPE, VCHR_NO, SR_NO, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1)
               VALUES ?`,
              [glRows]
            );
            console.log("TRAN_ACC inserted rows:", glResult.affectedRows);
          }

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
              : "Data saved successfully!",
            vchrNo: savedNo,
            changed,
            net,
            glLines: legs.length,
          });
        } catch (error) {
          // Only a clash on ngp_net's key is a number clash; a duplicate on
          // ngp_items or tran_acc is a real bug and is reported.
          const numberClash =
            mode === "ADD" &&
            error.code === "ER_DUP_ENTRY" &&
            /'ngp_net\./i.test(error.sqlMessage || "");
          if (numberClash && attempt < MAX_ATTEMPTS) {
            console.warn(`save-ngp: voucher number clash, retrying (attempt ${attempt})`);
            continue;
          }
          console.error("NGP Transaction Failed:", error);
          return res.status(error.status || 500).json({
            // sqlMessage surfaces tran_acc trigger errors (e.g. closed period) to the screen
            message: error.userMessage || error.sqlMessage || "Transaction failed, rolled back",
            error,
          });
        }
      }
    } catch (error) {
      console.error("Server Error:", error);
      res.status(500).json({ message: "Internal Server Error", error });
    }
  });

  return router;
};
