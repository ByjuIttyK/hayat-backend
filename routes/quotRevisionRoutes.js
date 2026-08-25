/**
 * Quotation Revision Route
 * File: E:\hayatApi\routes\quotRevisionRoutes.js
 *
 * Endpoints:
 *   GET  /api/quot-revision/next-rev/:quotNo   → next revision suffix (01,02…)
 *   POST /api/quot-revision/copy               → copy all 3 tables to new QUOT_NO
 *
 * New QUOT_NO format:  0000006440/01  (original + "/" + zero-padded rev)
 *
 * Registration in HayatDb.js:
 *   const quotRevision = require('./routes/quotRevisionRoutes');
 *   app.use('/api', quotRevision(connection));
 */

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  // ── helper: promisify a query on a given conn ───────────────────────────────
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  // ── helper: get a connection from the pool ──────────────────────────────────
  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn)))
    );

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/quot-revision/next-rev/:quotNo
  //
  // Returns the next available revision suffix for a given base QUOT_NO.
  // Strips any existing /XX suffix first so you can call it on either the
  // base number or an existing revision.
  //
  // Example:
  //   quotNo = "0000006440"   → looks for 0000006440/01, /02 … → returns "01"
  //   quotNo = "0000006440/01" → same logic, still returns "02" if /01 exists
  // ─────────────────────────────────────────────────────────────────────────────
  router.get('/quot-revision/next-rev/:quotNo', async (req, res) => {
    try {
      const base = req.params.quotNo.split('/')[0];   // strip existing suffix

      const conn  = await getConn();
      // Find all existing revisions of this base number
      const rows  = await q(conn,
        `SELECT QUOT_NO FROM quot_hdr
         WHERE QUOT_NO LIKE ?
         ORDER BY QUOT_NO DESC LIMIT 1`,
        [`${base}/%`]
      );
      conn.release();

      let nextRev = 1;
      if (rows.length > 0) {
        const lastNo  = rows[0].QUOT_NO;          // e.g. "0000006440/03"
        const lastRev = parseInt(lastNo.split('/')[1] || '0', 10);
        nextRev       = lastRev + 1;
      }

      const revStr   = String(nextRev).padStart(2, '0');
      const newQuotNo = `${base}/${revStr}`;

      res.json({ base, revNo: revStr, newQuotNo });
    } catch (err) {
      console.error('[quot-revision/next-rev]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/quot-revision/copy
  // Body: { sourceQuotNo: "0000006440", newQuotNo: "0000006440/01" }
  //
  // Copies quot_hdr + quot_item + quot_terms_cond to the new QUOT_NO.
  // All inside one transaction — rolls back if anything fails.
  // ─────────────────────────────────────────────────────────────────────────────
  router.post('/quot-revision/copy', async (req, res) => {
    const { sourceQuotNo, newQuotNo } = req.body;

    if (!sourceQuotNo || !newQuotNo) {
      return res.status(400).json({ error: 'sourceQuotNo and newQuotNo are required.' });
    }
    if (sourceQuotNo === newQuotNo) {
      return res.status(400).json({ error: 'Source and destination QUOT_NO cannot be the same.' });
    }

    let conn;
    try {
      conn = await getConn();

      // ── Check source exists ────────────────────────────────────────────────
      const srcRows = await q(conn,
        'SELECT QUOT_NO, REV_NO FROM quot_hdr WHERE QUOT_NO = ?',
        [sourceQuotNo]
      );
      if (!srcRows.length) {
        conn.release();
        return res.status(404).json({ error: `Quotation ${sourceQuotNo} not found.` });
      }

      // ── Check destination doesn't already exist ────────────────────────────
      const destRows = await q(conn,
        'SELECT QUOT_NO FROM quot_hdr WHERE QUOT_NO = ?',
        [newQuotNo]
      );
      if (destRows.length) {
        conn.release();
        return res.status(409).json({ error: `${newQuotNo} already exists. Choose a different revision.` });
      }

      // ── Work out the revision number from the new QUOT_NO ─────────────────
      const revNo = newQuotNo.includes('/') ? newQuotNo.split('/')[1] : '01';

      // ── Begin transaction ─────────────────────────────────────────────────
      await new Promise((resolve, reject) =>
        conn.beginTransaction(err => (err ? reject(err) : resolve()))
      );

      try {
        // 1. Copy quot_hdr — replace QUOT_NO, bump REV_NO
        await q(conn, `
          INSERT INTO quot_hdr
            (QUOT_NO, QUOT_DATE, CUST_CODE, PAYMENT_TERMS, ENGG_CODE, ATTN,
             YOUR_REF, SUBJECT, PROJECT_NAME, CURR_CODE, REV_NO, INQ_NO,
             TEL_NO, FAX_NO, AMOUNT, DISCOUNT, ROUND_OFF, VAT_PERC, VAT_AMOUNT,
             NARRATION, DETAILS)
          SELECT
            ?, QUOT_DATE, CUST_CODE, PAYMENT_TERMS, ENGG_CODE, ATTN,
            YOUR_REF, SUBJECT, PROJECT_NAME, CURR_CODE, ?, INQ_NO,
            TEL_NO, FAX_NO, AMOUNT, DISCOUNT, ROUND_OFF, VAT_PERC, VAT_AMOUNT,
            NARRATION, DETAILS
          FROM quot_hdr
          WHERE QUOT_NO = ?
        `, [newQuotNo, revNo, sourceQuotNo]);

        // 2. Copy quot_item
        const itemRows = await q(conn,
          'SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
          ['quot_item']
        );
        if (itemRows[0].cnt > 0) {
          await q(conn, `
            INSERT INTO quot_item
              (QUOT_NO, SR_NO, LOC_CODE, ITEM_CODE, ITEM_NAME, QTY, RATE)
            SELECT ?, SR_NO, LOC_CODE, ITEM_CODE, ITEM_NAME, QTY, RATE
            FROM quot_item
            WHERE QUOT_NO = ?
          `, [newQuotNo, sourceQuotNo]);
        }

        // 3. Copy quot_terms_cond
        const tcRows = await q(conn,
          'SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
          ['quot_terms_cond']
        );
        if (tcRows[0].cnt > 0) {
          await q(conn, `
            INSERT INTO quot_terms_cond
              (QUOT_NO, SR_NO, TERMS_HDR, TERMS_DETAILS)
            SELECT ?, SR_NO, TERMS_HDR, TERMS_DETAILS
            FROM quot_terms_cond
            WHERE QUOT_NO = ?
          `, [newQuotNo, sourceQuotNo]);
        }

        // ── Commit ──────────────────────────────────────────────────────────
        await new Promise((resolve, reject) =>
          conn.commit(err => (err ? reject(err) : resolve()))
        );

        conn.release();
        res.json({
          message : `Quotation ${sourceQuotNo} copied to ${newQuotNo} successfully.`,
          newQuotNo,
          revNo,
        });

      } catch (txErr) {
        await new Promise(resolve => conn.rollback(resolve));
        conn.release();
        throw txErr;
      }

    } catch (err) {
      if (conn) conn.release();
      console.error('[quot-revision/copy]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
