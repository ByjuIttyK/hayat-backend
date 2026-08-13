// itemHistoryRoutes.js
// Read-only history endpoints for the Item Master screen's tabs
// (Purchase History, Sales History, All Transactions).
//
// Join chains below are confirmed from ItmBrow.fmb (the original Oracle
// Forms Item Browser), not guessed:
//
//   PURCHASE:  srv_items.SRV_NO  ->  purchase_hdr.PJV_NO  (get SUP_CODE)
//              purchase_hdr.SUP_CODE -> sup_mst.SUP_NAME
//              AMOUNT is computed as QTY * COST — confirmed via live
//              ER_BAD_FIELD_ERROR that srv_items has no stored AMT column
//              (it was a Forms-only formula-calculation field).
//
//   SALES:     invoice.CUST_CODE -> ac_list.AC_NAME, aliased CUST_NAME
//              AMOUNT is computed as INV_QTY * INV_RATE for the same
//              reason (invoice.AMT is not a stored column either).
//
//   ALL TRANS: stock_trans is an existing MySQL VIEW (UNION of purchase,
//              sales, purchase return, sales return, goods return branches)
//              confirmed earlier via SHOW CREATE VIEW. Queried as-is.
//
// Mount in hayatdb.js alongside your other route modules, e.g.:
//   app.use('/api', require('./routes/itemHistoryRoutes')(connection));

module.exports = function (connection) {
  const express = require('express');
  const router = express.Router();

  // ── Purchase History ──────────────────────────────────────────────
  router.get('/item-purchase-history/:itemCode', function (req, res) {
    const itemCode = req.params.itemCode;

    const sql = `
      SELECT
        s.SRV_NO,
        s.SRV_DATE,
        s.LOC_CODE,
        s.QTY,
        s.COST,
        (s.QTY * s.COST)  AS AMOUNT,
        ph.SUP_CODE,
        sm.SUP_NAME
      FROM srv_items s
      LEFT JOIN purchase_hdr ph ON ph.PJV_NO = s.SRV_NO
      LEFT JOIN sup_mst sm      ON sm.SUP_CODE = ph.SUP_CODE
      WHERE s.ITEM_CODE = ?
      ORDER BY s.SRV_DATE DESC
      LIMIT 500`;

    connection.query(sql, [itemCode], function (err, results) {
      if (err) {
        console.error('item-purchase-history error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // ── Sales History ─────────────────────────────────────────────────
  router.get('/item-sales-history/:itemCode', function (req, res) {
    const itemCode = req.params.itemCode;

    const sql = `
      SELECT
        i.INV_NO,
        i.INV_DATE,
        i.LOC_CODE,
        i.INV_QTY,
        i.INV_RATE,
        i.DISC_PER,
        (i.INV_QTY * i.INV_RATE) AS AMOUNT,
        i.CUST_CODE,
        al.AC_HEAD         AS CUST_NAME
      FROM invoice i
      LEFT JOIN ac_list al ON al.AC_CODE = i.CUST_CODE
      WHERE i.ITEM_CODE = ?
      ORDER BY i.INV_DATE DESC
      LIMIT 500`;

    connection.query(sql, [itemCode], function (err, results) {
      if (err) {
        console.error('item-sales-history error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // ── SIV (Store Issue Voucher) History ────────────────────────────────
  // siv_items — confirmed via DESCRIBE this session. AMOUNT is computed
  // as QTY * STD_COST for the same reason as Purchase/Sales (no stored
  // AMT column). No header table join needed — JOB_NO / PANEL_NO /
  // XL_ITEM_DESC all live directly on siv_items.
  router.get('/item-siv-history/:itemCode', function (req, res) {
    const itemCode = req.params.itemCode;

    const sql = `
      SELECT
        SIV_NO,
        SIV_DATE,
        SR_NO,
        LOC_CODE,
        QTY,
        STD_COST,
        (QTY * STD_COST) AS AMOUNT,
        JOB_NO,
        PANEL_NO,
        XL_ITEM_DESC
      FROM siv_items
      WHERE ITEM_CODE = ?
      ORDER BY SIV_DATE DESC
      LIMIT 500`;

    connection.query(sql, [itemCode], function (err, results) {
      if (err) {
        console.error('item-siv-history error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // ── All Transactions (stock_trans view) ─────────────────────────────
  router.get('/item-all-transactions/:itemCode', function (req, res) {
    const itemCode = req.params.itemCode;

    const sql = `
      SELECT
        Doc_no,
        Doc_date,
        Loc_code,
        Item_code,
        Qty,
        Std_cost,
        SUP_CODE,
        NARRATION,
        Stock_tran_type,
        Job_no
      FROM stock_trans
      WHERE Item_code = ?
      ORDER BY Doc_date DESC
      LIMIT 500`;

    connection.query(sql, [itemCode], function (err, results) {
      if (err) {
        console.error('item-all-transactions error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // ── Purchase Return ─────────────────────────────────────────────────
  // pret_items — ACC_CODE lives directly on the item row (no header join
  // needed for this listing).
  router.get('/item-purchase-return/:itemCode', function (req, res) {
    const itemCode = req.params.itemCode;

    const sql = `
      SELECT
        VCHR_NO,
        VCHR_DATE,
        LOC_CODE,
        QTY,
        COST,
        ACC_CODE
      FROM pret_items
      WHERE ITEM_CODE = ?
      ORDER BY VCHR_DATE DESC
      LIMIT 500`;

    connection.query(sql, [itemCode], function (err, results) {
      if (err) {
        console.error('item-purchase-return error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // ── Sales Return ─────────────────────────────────────────────────────
  // sret_items joined to sret_hdr on SRET_NO for CUST_CODE / NARRATION1.
  router.get('/item-sales-return/:itemCode', function (req, res) {
    const itemCode = req.params.itemCode;

    const sql = `
      SELECT
        a.SRET_NO,
        a.SRET_DATE,
        a.LOC_CODE,
        a.QTY,
        a.COST,
        b.CUST_CODE,
        b.NARRATION1
      FROM sret_items a
      LEFT JOIN sret_hdr b ON b.SRET_NO = a.SRET_NO
      WHERE a.ITEM_CODE = ?
      ORDER BY a.SRET_DATE DESC
      LIMIT 500`;

    connection.query(sql, [itemCode], function (err, results) {
      if (err) {
        console.error('item-sales-return error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // ── Goods Return (Job) ───────────────────────────────────────────────
  // goods_rtn_items joined to goods_rtn_hdr on SRV_NO for JOB_NO / DO_NO /
  // CUST_CODE. Filtered on PROD_CODE, which is this table's actual
  // item-code column (not ITEM_CODE).
  router.get('/item-goods-return/:itemCode', function (req, res) {
    const itemCode = req.params.itemCode;

    const sql = `
      SELECT
        a.SRV_NO,
        a.SRV_DATE,
        a.LOC_CODE,
        a.QTY,
        a.UNIT_COST,
        b.JOB_NO,
        b.DO_NO,
        b.CUST_CODE
      FROM goods_rtn_items a
      LEFT JOIN goods_rtn_hdr b ON b.SRV_NO = a.SRV_NO
      WHERE a.PROD_CODE = ?
      ORDER BY a.SRV_DATE DESC
      LIMIT 500`;

    connection.query(sql, [itemCode], function (err, results) {
      if (err) {
        console.error('item-goods-return error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  return router;
};
