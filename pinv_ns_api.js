// ─────────────────────────────────────────────────────────────────────────────
//  pinv_ns_api.js — CRUD routes for the Purchase Entry (Non-Stock) screen,
//  purchase_hdr_ns / purchase_items_ns.
//  Mount in HayatDb.js:
//    const pinvNsRoutes = require('./pinv_ns_api')(connection);
//    app.use('/api', pinvNsRoutes);
//  → exposes GET /api/purchnsHdr/:id, GET /api/purchnsitems/:id,
//             GET /api/accmst/:code, POST /api/save-purchns
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');

function dbQuery(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

// ── Transaction helpers (used only by save-purchns) ────────────────────────
// If `connection` is a Pool, grab a dedicated connection so every statement in
// the transaction runs on the same session. If it's already a single shared
// Connection (as bank1_lov_api.js implies), just use it directly.
function getTxConnection(connection) {
  if (typeof connection.getConnection === 'function') {
    return new Promise((resolve, reject) => {
      connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn)));
    });
  }
  return Promise.resolve(connection);
}
function releaseTxConnection(conn) {
  if (typeof conn.release === 'function') conn.release();
}
function beginTransaction(conn) {
  return new Promise((resolve, reject) => {
    conn.beginTransaction((err) => (err ? reject(err) : resolve()));
  });
}
function commit(conn) {
  return new Promise((resolve, reject) => {
    conn.commit((err) => (err ? reject(err) : resolve()));
  });
}
function rollback(conn) {
  return new Promise((resolve) => {
    conn.rollback(() => resolve());
  });
}

module.exports = function (connection) {
  const router = express.Router();

  // ── GET header (single row, dates formatted dd/MM/yyyy, Dr.Account head joined) ──
  router.get('/purchnsHdr/:id', async (req, res) => {
    try {
      const rows = await dbQuery(
        connection,
        `SELECT h.PJV_NO,
                DATE_FORMAT(h.PJV_DATE, '%d/%m/%Y')  AS PJV_DATE,
                h.SUP_CODE,
                s.SUP_NAME,
                h.INV_NO,
                DATE_FORMAT(h.INV_DATE, '%d/%m/%Y')  AS INV_DATE,
                h.LPO_NO,
                h.DR_CODE,
                a.ACC_HEAD                            AS DR_NAME,
                h.NARRATION,
                h.INV_GRS_AMT,
                h.DISC_PER,
                h.DISCOUNT,
                h.RND_OFF,
                h.VAT_PERC,
                h.VAT_AMOUNT,
                h.INV_NET_AMT,
                h.CAN_CEL
         FROM purchase_hdr_ns h
         LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
         LEFT JOIN acc_mst a ON a.ACC_CODE = h.DR_CODE
         WHERE h.PJV_NO = ?`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ message: 'Voucher not found' });
      res.json(rows);
    } catch (err) {
      console.error('purchnsHdr error:', err);
      res.status(500).json({ message: 'Error fetching header', error: err.message });
    }
  });

  // ── GET items for a given PJV_NO ──
  router.get('/purchnsitems/:id', async (req, res) => {
    try {
      const rows = await dbQuery(
        connection,
        `SELECT i.PJV_NO, i.SR_NO, i.JOB_NO, i.PANEL_NO, i.LOC_CODE, i.PART_NO, i.SUP_ITEM_DESC,
                i.QTY, i.ITEM_UNIT, i.UNIT_COST, i.DR_CODE, a.ACC_HEAD AS DR_HEAD, i.DISCOUNT, i.VAT_PERC
         FROM purchase_items_ns i
         LEFT JOIN acc_mst a ON a.ACC_CODE = i.DR_CODE
         WHERE i.PJV_NO = ?
         ORDER BY LPAD(i.SR_NO, 4, '0')`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) {
      console.error('purchnsitems error:', err);
      res.status(500).json({ message: 'Error fetching items', error: err.message });
    }
  });

  // ── GET single account (for the header Default Dr.A/c lookup-on-blur) ──
  router.get('/accmst/:code', async (req, res) => {
    try {
      const rows = await dbQuery(
        connection,
        `SELECT ACC_CODE, ACC_HEAD AS ACC_NAME FROM acc_mst WHERE ACC_CODE = ?`,
        [req.params.code]
      );
      res.json(rows);
    } catch (err) {
      console.error('accmst lookup error:', err);
      res.status(500).json({ message: 'Error fetching account', error: err.message });
    }
  });

  // ── POST save (header + items, transactional) ──
  // NOTE: INV_NET_AMT is never written — it's a STORED GENERATED column on
  // purchase_hdr_ns (INV_GRS_AMT - DISCOUNT + RND_OFF + VAT_AMOUNT) and MySQL
  // computes it automatically.
  router.post('/save-purchns', async (req, res) => {
    const { netData, itemsData } = req.body;
    if (!netData?.PJV_NO || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: 'PJV_NO and at least one item line are required.' });
    }

    let conn;
    try {
      conn = await getTxConnection(connection);
      await beginTransaction(conn);

      await dbQuery(
        conn,
        `INSERT INTO purchase_hdr_ns
           (PJV_NO, PJV_DATE, SUP_CODE, INV_NO, INV_DATE, LPO_NO, DR_CODE,
            NARRATION, INV_GRS_AMT, DISC_PER, DISCOUNT, RND_OFF, VAT_PERC, VAT_AMOUNT)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           PJV_DATE=VALUES(PJV_DATE), SUP_CODE=VALUES(SUP_CODE), INV_NO=VALUES(INV_NO),
           INV_DATE=VALUES(INV_DATE), LPO_NO=VALUES(LPO_NO), DR_CODE=VALUES(DR_CODE),
           NARRATION=VALUES(NARRATION), INV_GRS_AMT=VALUES(INV_GRS_AMT),
           DISC_PER=VALUES(DISC_PER), DISCOUNT=VALUES(DISCOUNT), RND_OFF=VALUES(RND_OFF),
           VAT_PERC=VALUES(VAT_PERC), VAT_AMOUNT=VALUES(VAT_AMOUNT)`,
        [
          netData.PJV_NO, netData.PJV_DATE, netData.SUP_CODE, netData.INV_NO, netData.INV_DATE,
          netData.LPO_NO, netData.DR_CODE, netData.NARRATION, netData.INV_GRS_AMT,
          netData.DISC_PER, netData.DISCOUNT, netData.RND_OFF, netData.VAT_PERC, netData.VAT_AMOUNT,
        ]
      );

      // Simplest reliable pattern for a detail grid: clear and re-insert this voucher's lines.
      await dbQuery(conn, `DELETE FROM purchase_items_ns WHERE PJV_NO = ?`, [netData.PJV_NO]);

      for (const it of itemsData) {
        await dbQuery(
          conn,
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

      // ── Post to GL (tran_acc): debit DR_CODE, credit SUP_CODE, both at
      //    the Net Amount. INV_NET_AMT is a STORED GENERATED column, so it
      //    only exists once the header row above has actually been written —
      //    re-read it now rather than trusting any client-sent value.
      if (!netData.DR_CODE || !netData.SUP_CODE) {
        throw new Error('Both Dr.Code and Supplier Code are required to post to the General Ledger.');
      }
      const hdrRows = await dbQuery(conn, `SELECT INV_NET_AMT FROM purchase_hdr_ns WHERE PJV_NO = ?`, [netData.PJV_NO]);
      const netAmt = hdrRows[0]?.INV_NET_AMT ?? 0;
      const narration = (netData.NARRATION || '').slice(0, 80);

      // Re-saving an edited voucher must not pile up duplicate GL lines.
      await dbQuery(conn, `DELETE FROM tran_acc WHERE vchr_no = ? AND TRAN_TYPE = '07'`, [netData.PJV_NO]);

      await dbQuery(
        conn,
        `INSERT INTO tran_acc (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1, SR_NO, TRANS_DATE, TRANS_TIME)
         VALUES ('07', ?, ?, ?, ?, 'D', ?, '0001', CURDATE(), ?)`,
        [netData.PJV_NO, netData.PJV_DATE, netData.DR_CODE, netAmt, narration, new Date().toTimeString().slice(0, 8)]
      );
      await dbQuery(
        conn,
        `INSERT INTO tran_acc (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1, SR_NO, TRANS_DATE, TRANS_TIME)
         VALUES ('07', ?, ?, ?, ?, 'C', ?, '0002', CURDATE(), ?)`,
        [netData.PJV_NO, netData.PJV_DATE, netData.SUP_CODE, netAmt, narration, new Date().toTimeString().slice(0, 8)]
      );

      await commit(conn);
      res.json({ message: 'Saved', PJV_NO: netData.PJV_NO });
    } catch (err) {
      if (conn) await rollback(conn);
      console.error('save-purchns error:', err);
      // Foreign-key violations on JOB_NO / PANEL_NO / DR_CODE surface here with errno 1452.
      if (err.errno === 1452) {
        return res.status(400).json({ message: 'One of the item lines has an invalid Job No, Panel No, or Dr.Code that does not exist in its master table.' });
      }
      res.status(500).json({ message: 'Error saving voucher', error: err.message });
    } finally {
      if (conn) releaseTxConnection(conn);
    }
  });

  return router;
};
