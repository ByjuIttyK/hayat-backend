// ─────────────────────────────────────────────────────────────────────────────
// pinv_ns_api.js — CRUD routes for Purchase Entry (Non-Stock)
// Mount in HayatDb.js:
//   const pinvNsRoutes = require('./pinv_ns_api')(connection);
//   app.use('/api', pinvNsRoutes);
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();


  // ── GET header — fetch single record by PJV_NO ────────────────────────────
  // ── POST save — header + items + GL entries (transactional) ───────────────
  router.post("/save-purchns", async (req, res) => {
    const { netData, itemsData } = req.body;
    if (!netData?.PJV_NO || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "PJV_NO and at least one item line are required." });
    }

    if (!netData.DR_CODE || !netData.SUP_CODE) {
      return res.status(400).json({ message: "Both Dr.Code and Supplier Code are required to post to GL." });
    }

    let conn;
    try {
      // Obtain a dedicated promise connection for transaction support
      conn = await connection.promise().getConnection();
      await conn.beginTransaction();

      // 1. Insert or update header row
      await conn.query(
        `INSERT INTO purchase_hdr_ns
           (PJV_NO, PJV_DATE, SUP_CODE, INV_NO, INV_DATE, LPO_NO, SRV_NO, DR_CODE,
            NARRATION, INV_GRS_AMT, DISC_PER, DISCOUNT, RND_OFF, VAT_PERC, VAT_AMOUNT)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           PJV_DATE=VALUES(PJV_DATE), SUP_CODE=VALUES(SUP_CODE), INV_NO=VALUES(INV_NO),
           INV_DATE=VALUES(INV_DATE), LPO_NO=VALUES(LPO_NO), SRV_NO=VALUES(SRV_NO), DR_CODE=VALUES(DR_CODE),
           NARRATION=VALUES(NARRATION), INV_GRS_AMT=VALUES(INV_GRS_AMT),
           DISC_PER=VALUES(DISC_PER), DISCOUNT=VALUES(DISCOUNT), RND_OFF=VALUES(RND_OFF),
           VAT_PERC=VALUES(VAT_PERC), VAT_AMOUNT=VALUES(VAT_AMOUNT)`,
        [
          netData.PJV_NO, netData.PJV_DATE, netData.SUP_CODE, netData.INV_NO, netData.INV_DATE,
          netData.LPO_NO, netData.SRV_NO, netData.DR_CODE, netData.NARRATION, netData.INV_GRS_AMT,
          netData.DISC_PER, netData.DISCOUNT, netData.RND_OFF, netData.VAT_PERC, netData.VAT_AMOUNT,
        ]
      );

      // 2. Clear old detail lines for this voucher
      await conn.query(`DELETE FROM purchase_items_ns WHERE PJV_NO = ?`, [netData.PJV_NO]);

      // 3. Re-insert items grid array
      for (const it of itemsData) {
        await conn.query(
          `INSERT INTO purchase_items_ns
             (PJV_NO, SR_NO, JOB_NO, PANEL_NO, LOC_CODE, PART_NO, SUP_ITEM_DESC,
              QTY, ITEM_UNIT, UNIT_COST, DR_CODE, DISCOUNT, VAT_PERC)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            it.PJV_NO, it.SR_NO, it.JOB_NO, it.PANEL_NO, it.LOC_CODE, it.PART_NO, it.SUP_ITEM_DESC,
            it.QTY, it.ITEM_UNIT, it.UNIT_COST, it.DR_CODE, it.DISCOUNT, it.VAT_PERC,
          ]
        );
      }

      // 4. Read back computed INV_NET_AMT generated column
      const [hdrRows] = await conn.query(
        `SELECT INV_NET_AMT FROM purchase_hdr_ns WHERE PJV_NO = ?`,
        [netData.PJV_NO]
      );
      const netAmt = hdrRows[0]?.INV_NET_AMT ?? 0;
      const narration = (netData.NARRATION || "").slice(0, 80);
      const currentTime = new Date().toTimeString().slice(0, 8);

      // 5. Post GL transactions (tran_acc)
      await conn.query(
        `DELETE FROM tran_acc WHERE vchr_no = ? AND TRAN_TYPE = '07'`,
        [netData.PJV_NO]
      );

      // Debit line
      await conn.query(
        `INSERT INTO tran_acc (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1, SR_NO, TRANS_DATE, TRANS_TIME)
         VALUES ('07', ?, ?, ?, ?, 'D', ?, '0001', CURDATE(), ?)`,
        [netData.PJV_NO, netData.PJV_DATE, netData.DR_CODE, netAmt, narration, currentTime]
      );

      // Credit line
      await conn.query(
        `INSERT INTO tran_acc (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1, SR_NO, TRANS_DATE, TRANS_TIME)
         VALUES ('07', ?, ?, ?, ?, 'C', ?, '0002', CURDATE(), ?)`,
        [netData.PJV_NO, netData.PJV_DATE, netData.SUP_CODE, netAmt, narration, currentTime]
      );

      await conn.commit();
      res.json({ message: "Saved", PJV_NO: netData.PJV_NO });
    } catch (err) {
      if (conn) await conn.rollback();
      console.error("save-purchns POST error:", err);

      if (err.errno === 1452) {
        return res.status(400).json({
          message: "One of the item lines has an invalid Job No, Panel No, or Dr.Code that does not exist in its master table.",
        });
      }

      res.status(500).json({ message: "Error saving voucher", error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });
  return router;
};