// ============================================================
// nlDispatchRoutes_v2.js
// Al Hayat ERP  |  Replace nlDispatchRoutes.js in HayatDb.js
//   const nlDispatch = require('./routes/nlDispatchRoutes_v2')(connection);
//   app.use('/api/nl-dispatch', nlDispatch);
// ============================================================
'use strict';
const express = require('express');

module.exports = function (connection) {
  const router = express.Router();
  const db     = connection.promise();

  // ── helpers ──────────────────────────────────────────────
  const user = (req) =>
    req.user?.username || req.body?.user || req.query?.user || 'UNKNOWN';

  // ──────────────────────────────────────────────────────────
  // GET /api/nl-dispatch/tran-types
  // ──────────────────────────────────────────────────────────
  router.get('/tran-types', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT TRAN_TYPE, TYPE_DES, TYPE_ABBR, ENTRY_FORM
         FROM   tran_type
         WHERE  NL_ENABLED = 'Y'
         ORDER  BY TYPE_DES`
      );
      res.json(rows);
    } catch (err) {
      console.error('nl-dispatch/tran-types:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/nl-dispatch/next-batch
  // Returns next batch number without consuming it
  // ──────────────────────────────────────────────────────────
  router.get('/next-batch', async (req, res) => {
    try {
      const [[seq]] = await db.query(
        `SELECT CONCAT('NLD-', LPAD(LAST_NO + 1, 4, '0')) AS NEXT_BATCH
         FROM   nl_dispatch_seq LIMIT 1`
      );
      res.json({ batchNo: seq.NEXT_BATCH });
    } catch (err) {
      console.error('nl-dispatch/next-batch:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/nl-dispatch/list
  // Header list for InfoGrid  (all batches for user)
  // ──────────────────────────────────────────────────────────
  router.get('/list', async (req, res) => {
    try {
      const u = user(req);
      const [rows] = await db.query(
        `SELECT h.BATCH_NO, h.BATCH_DATE, h.NARRATION, h.STATUS,
                h.CREATED_BY, h.CREATED_DT,
                COUNT(d.ID)                              AS TOTAL_LINES,
                SUM(d.GEN_FLAG = 'Y')                   AS DONE_LINES,
                SUM(d.GEN_FLAG = 'P')                   AS PENDING_LINES
         FROM   nl_dispatch_hdr h
         LEFT JOIN nl_dispatch_dtl d ON d.BATCH_NO = h.BATCH_NO
         WHERE  h.CREATED_BY = ?
         GROUP  BY h.BATCH_NO
         ORDER  BY h.CREATED_DT DESC
         LIMIT  500`,
        [u]
      );
      res.json(rows);
    } catch (err) {
      console.error('nl-dispatch/list:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/nl-dispatch/batch/:batchNo
  // Load one batch (header + all detail lines)
  // ──────────────────────────────────────────────────────────
  router.get('/batch/:batchNo', async (req, res) => {
    try {
      const { batchNo } = req.params;
      const [[hdr]] = await db.query(
        `SELECT * FROM nl_dispatch_hdr WHERE BATCH_NO = ?`,
        [batchNo]
      );
      if (!hdr) return res.status(404).json({ error: 'Batch not found' });

      const [dtl] = await db.query(
        `SELECT d.*, t.TYPE_DES, t.TYPE_ABBR, t.ENTRY_FORM
         FROM   nl_dispatch_dtl d
         JOIN   tran_type       t ON t.TRAN_TYPE = d.TRAN_TYPE
         WHERE  d.BATCH_NO = ?
         ORDER  BY d.SR_NO`,
        [batchNo]
      );
      res.json({ hdr, dtl });
    } catch (err) {
      console.error('nl-dispatch/batch:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/nl-dispatch/save-batch
  // Creates or updates a full batch (header + lines)
  // Body: { batchNo?, batchDate, narration, lines: [...] }
  // If batchNo is omitted → new batch (calls sp_next_nl_batch)
  // ──────────────────────────────────────────────────────────
  router.post('/save-batch', async (req, res) => {
    const conn = await connection.promise().getConnection?.()
      .catch(() => null);
    // Fall back to non-transactional if getConnection unavailable
    const useConn = conn || db;

    try {
      if (conn) await conn.beginTransaction();

      const u = user(req);
      const { batchDate, narration, lines } = req.body;
      let { batchNo } = req.body;

      if (!Array.isArray(lines) || lines.length === 0)
        throw new Error('lines array is required');

      // ── New batch ──
      if (!batchNo) {
        await useConn.query('UPDATE nl_dispatch_seq SET LAST_NO = LAST_NO + 1');
        const [[seq]] = await useConn.query(
          `SELECT CONCAT('NLD-', LPAD(LAST_NO, 4, '0')) AS B FROM nl_dispatch_seq LIMIT 1`
        );
        batchNo = seq.B;
        await useConn.query(
          `INSERT INTO nl_dispatch_hdr
             (BATCH_NO, BATCH_DATE, NARRATION, STATUS, CREATED_BY, CREATED_DT)
           VALUES (?, ?, ?, 'O', ?, NOW())`,
          [batchNo, batchDate || new Date().toISOString().slice(0, 10),
           narration?.trim() || null, u]
        );
      } else {
        // ── Update existing header ──
        await useConn.query(
          `UPDATE nl_dispatch_hdr
           SET NARRATION = ?, BATCH_DATE = ?, UPDATED_DT = NOW()
           WHERE BATCH_NO = ?`,
          [narration?.trim() || null, batchDate, batchNo]
        );
      }

      // ── Upsert detail lines ──
      for (const [idx, ln] of lines.entries()) {
        if (!ln.TRAN_TYPE || !ln.AI_TEXT?.trim()) continue;
        const srNo = idx + 1;
        await useConn.query(
          `INSERT INTO nl_dispatch_dtl
             (BATCH_NO, SR_NO, TRAN_TYPE, AI_TEXT, REMARKS, GEN_FLAG)
           VALUES (?, ?, ?, ?, ?, 'P')
           ON DUPLICATE KEY UPDATE
             TRAN_TYPE = VALUES(TRAN_TYPE),
             AI_TEXT   = VALUES(AI_TEXT),
             REMARKS   = VALUES(REMARKS)`,
          [batchNo, srNo,
           ln.TRAN_TYPE, ln.AI_TEXT.trim(), ln.REMARKS?.trim() || null]
        );
      }

      if (conn) await conn.commit();
      res.json({ success: true, batchNo });

    } catch (err) {
      if (conn) await conn.rollback();
      console.error('nl-dispatch/save-batch:', err);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/nl-dispatch/generate
  // Called before navigating — returns navUrl for one line
  // Body: { batchNo, srNo }
  // ──────────────────────────────────────────────────────────
  router.post('/generate', async (req, res) => {
    try {
      const { batchNo, srNo } = req.body;
      const [[row]] = await db.query(
        `SELECT d.ID, d.TRAN_TYPE, d.AI_TEXT, t.ENTRY_FORM
         FROM   nl_dispatch_dtl d
         JOIN   tran_type       t ON t.TRAN_TYPE = d.TRAN_TYPE
         WHERE  d.BATCH_NO = ? AND d.SR_NO = ? AND d.GEN_FLAG = 'P'`,
        [batchNo, srNo]
      );
      if (!row)
        return res.status(404).json({ error: 'Line not found or already done' });

      const navUrl =
        `${row.ENTRY_FORM}?nlBatch=${batchNo}&nlSr=${srNo}&nlId=${row.ID}`;
      res.json({ success: true, navUrl, aiText: row.AI_TEXT });
    } catch (err) {
      console.error('nl-dispatch/generate:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/nl-dispatch/mark-done
  // Called by entry screen after successful save
  // Body: { batchNo, srNo, vchrNo, vchrTranType }
  // ──────────────────────────────────────────────────────────
  router.post('/mark-done', async (req, res) => {
    try {
      const { batchNo, srNo, id, vchrNo, vchrTranType } = req.body;

      // Support both old (id) and new (batchNo+srNo) callers
      if (batchNo && srNo) {
        await db.query(
          `UPDATE nl_dispatch_dtl
           SET GEN_FLAG = 'Y', VCHR_NO = ?, VCHR_TRAN_TYPE = ?, DONE_DT = NOW()
           WHERE BATCH_NO = ? AND SR_NO = ?`,
          [vchrNo || null, vchrTranType || null, batchNo, srNo]
        );
      } else if (id) {
        await db.query(
          `UPDATE nl_dispatch_dtl
           SET GEN_FLAG = 'Y', VCHR_NO = ?, DONE_DT = NOW()
           WHERE ID = ?`,
          [vchrNo || null, id]
        );
      }
      res.json({ success: true });
    } catch (err) {
      console.error('nl-dispatch/mark-done:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/nl-dispatch/mark-error
  // Body: { batchNo, srNo, errorMsg }
  // ──────────────────────────────────────────────────────────
  router.post('/mark-error', async (req, res) => {
    try {
      const { batchNo, srNo, id, errorMsg } = req.body;
      if (batchNo && srNo) {
        await db.query(
          `UPDATE nl_dispatch_dtl
           SET GEN_FLAG = 'E', ERROR_MSG = ?
           WHERE BATCH_NO = ? AND SR_NO = ?`,
          [errorMsg?.substring(0, 300) || 'Unknown error', batchNo, srNo]
        );
      } else if (id) {
        await db.query(
          `UPDATE nl_dispatch_dtl SET GEN_FLAG = 'E', ERROR_MSG = ? WHERE ID = ?`,
          [errorMsg?.substring(0, 300) || 'Unknown error', id]
        );
      }
      res.json({ success: true });
    } catch (err) {
      console.error('nl-dispatch/mark-error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // DELETE /api/nl-dispatch/line
  // Delete a pending detail line
  // Body: { batchNo, srNo }
  // ──────────────────────────────────────────────────────────
  router.delete('/line', async (req, res) => {
    try {
      const { batchNo, srNo } = req.body;
      await db.query(
        `DELETE FROM nl_dispatch_dtl
         WHERE BATCH_NO = ? AND SR_NO = ? AND GEN_FLAG = 'P'`,
        [batchNo, srNo]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('nl-dispatch/line delete:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // DELETE /api/nl-dispatch/batch/:batchNo
  // Delete entire batch (only if all lines are Pending)
  // ──────────────────────────────────────────────────────────
  router.delete('/batch/:batchNo', async (req, res) => {
    try {
      const { batchNo } = req.params;
      const [[check]] = await db.query(
        `SELECT COUNT(*) AS done FROM nl_dispatch_dtl
         WHERE BATCH_NO = ? AND GEN_FLAG != 'P'`,
        [batchNo]
      );
      if (check.done > 0)
        return res.status(400).json({
          error: 'Cannot delete — batch has processed lines',
        });
      await db.query(`DELETE FROM nl_dispatch_dtl WHERE BATCH_NO = ?`, [batchNo]);
      await db.query(`DELETE FROM nl_dispatch_hdr WHERE BATCH_NO = ?`, [batchNo]);
      res.json({ success: true });
    } catch (err) {
      console.error('nl-dispatch/batch delete:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
