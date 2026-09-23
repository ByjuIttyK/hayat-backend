/**
 * Trading Delivery Order — do_hdr / do_items
 * Mount in HayatDb.js (file name is all lowercase — keep the require the same):
 *   const trdDo = require('./routes/trddo')(connection);
 *   app.use('/api', trdDo);
 *
 *   GET  /api/trddo/next-no        → { DO_NO }  next number (preview only)
 *   GET  /api/trddo/cust/:code     → { CUST_CODE, CUST_NAME }
 *   GET  /api/trddo/:doNo          → { hdr, items }
 *   POST /api/save-trddo           → { DO_NO, message }
 *
 * Table names are lowercase for the VPS (lower_case_table_names=0).
 */
const express = require('express');

const DO_NO_LEN = 10; // do_items.DO_NO is varchar(10)

module.exports = function (connection) {
  const router = express.Router();

  // ── promise helpers over the callback pool ──────────────────────────────
  const getConn = () =>
    new Promise((res, rej) => connection.getConnection((e, c) => (e ? rej(e) : res(c))));
  const q = (conn, sql, params = []) =>
    new Promise((res, rej) => conn.query(sql, params, (e, r) => (e ? rej(e) : res(r))));

  const pad = (n) => String(n).padStart(DO_NO_LEN, '0');
  const NEXT_SQL = `SELECT IFNULL(MAX(CAST(DO_NO AS UNSIGNED)), 0) + 1 AS nxt FROM do_hdr`;

  // ── next number (display only; the real number is taken inside the save) ─
  router.get('/trddo/next-no', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const [r] = await q(conn, NEXT_SQL);
      res.json({ DO_NO: pad(r.nxt) });
    } catch (err) {
      console.error('[trddo/next-no]', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  // ── customer name for a typed code (Enter / blur on Cust.Code) ─────────
  router.get('/trddo/cust/:code', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const r = await q(conn, `SELECT CUST_CODE, CUST_NAME FROM cus_mst WHERE CUST_CODE = ?`, [req.params.code]);
      if (!r.length) return res.status(404).json({ error: 'Customer not found' });
      res.json(r[0]);
    } catch (err) {
      console.error('[trddo/cust]', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  
router.get("/trddolist", function (req, res) {
 // const cust = req.params;
  connection.query(
    "select a.DO_NO, DATE_FORMAT(a.DO_DATE,'%d/%m/%Y') DO_DATE ,a.LPO_NO ,a.CUST_CODE ,b.CUST_NAME "+
    " from do_hdr a LEFT OUTER JOIN cus_mst b  ON (a.CUST_CODE = b.CUST_CODE) " +
    "  ORDER BY a.DO_NO DESC",
    [req.params.cust],

    function (err, results, fields) {
      if (err) {
        throw err;
      } else {
        //    console.log("Oracle DO LST", result.rows);
        res.json(results);

      }
    }
  );
});

  // ── load one D/O ─────────────────────────────────────────────────────────
  router.get('/trddo/:doNo', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const hdr = await q(
        conn,
        `SELECT h.DO_NO, DATE_FORMAT(h.DO_DATE, '%Y-%m-%d') AS DO_DATE,
                h.SLSORD_NO, h.CUST_CODE, c.CUST_NAME, h.LPO_NO
           FROM do_hdr h
           LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
          WHERE h.DO_NO = ?`,
        [req.params.doNo]
      );
      if (!hdr.length) return res.status(404).json({ error: 'D/O not found' });

      const items = await q(
        conn,
        `SELECT SR_NO, ITEM_CODE, ITEM_DES1, ITEM_DES2, UNIT,
                IFNULL(QTY, 0) AS QTY, IFNULL(QTY_INVOICED, 0) AS QTY_INVOICED
           FROM do_items
          WHERE DO_NO = ?
          ORDER BY CAST(SR_NO AS UNSIGNED), srno_row_id`,
        [req.params.doNo]
      );
      res.json({ hdr: hdr[0], items });
    } catch (err) {
      console.error('[trddo/:doNo]', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  // ── save (header upsert + lines replace, one transaction) ───────────────
  router.post('/save-trddo', async (req, res) => {
    const { mode, hdr = {}, items = [] } = req.body || {};
    if (!hdr.DO_DATE) return res.status(400).json({ error: 'D/O date is required' });
    if (!hdr.CUST_CODE) return res.status(400).json({ error: 'Customer code is required' });

    const lines = items
      .filter((r) => (r.ITEM_CODE || '').trim() && Number(r.QTY) > 0)
      .map((r, i) => ({
        SR_NO: String(i + 1),
        ITEM_CODE: r.ITEM_CODE.trim(),
        ITEM_DES1: r.ITEM_DES1 || null,
        ITEM_DES2: r.ITEM_DES2 || null,
        UNIT: r.UNIT || null,
        QTY: Number(r.QTY),
        QTY_INVOICED: Number(r.QTY_INVOICED) || 0,
      }));
    if (!lines.length) return res.status(400).json({ error: 'Enter at least one item with quantity' });

    const over = lines.find((l) => l.QTY < l.QTY_INVOICED);
    if (over)
      return res.status(400).json({
        error: `Line ${over.SR_NO} (${over.ITEM_CODE}): qty cannot be less than already invoiced ${over.QTY_INVOICED}`,
      });

    let conn;
    try {
      conn = await getConn();
      await q(conn, 'START TRANSACTION');

      let doNo = (hdr.DO_NO || '').trim();
      if (mode === 'ADD' || !doNo) {
        // lock the table's max so two users saving together don't collide
        const [r] = await q(conn, `${NEXT_SQL} FOR UPDATE`);
        doNo = pad(r.nxt);
      }

      await q(
        conn,
        `INSERT INTO do_hdr (DO_NO, DO_DATE, SLSORD_NO, CUST_CODE, LPO_NO)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE DO_DATE = VALUES(DO_DATE), SLSORD_NO = VALUES(SLSORD_NO),
                                 CUST_CODE = VALUES(CUST_CODE), LPO_NO = VALUES(LPO_NO)`,
        [doNo, hdr.DO_DATE, hdr.SLSORD_NO || null, hdr.CUST_CODE, hdr.LPO_NO || null]
      );

      await q(conn, `DELETE FROM do_items WHERE DO_NO = ?`, [doNo]);
      await q(
        conn,
        `INSERT INTO do_items (DO_NO, SR_NO, ITEM_CODE, ITEM_DES1, ITEM_DES2, UNIT, QTY, QTY_INVOICED)
         VALUES ?`,
        [lines.map((l) => [doNo, l.SR_NO, l.ITEM_CODE, l.ITEM_DES1, l.ITEM_DES2, l.UNIT, l.QTY, l.QTY_INVOICED])]
      );

      await q(conn, 'COMMIT');
      res.json({ DO_NO: doNo, message: `D/O ${doNo} saved` });
    } catch (err) {
      if (conn) await q(conn, 'ROLLBACK').catch(() => {});
      console.error('[save-trddo]', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
