// routes/drawingRegisterRoutes.js
//
// Factory-pattern route module (matches HayatDb.js convention). Either mount
// style works — the module exposes its routes under both / and /api:
//
//   const drawingRegisterRoutes = require('./routes/drawingRegisterRoutes');
//   app.use(drawingRegisterRoutes(connection));            // root mount
//   // ── or ──
//   app.use("/api", drawingRegisterRoutes(connection));    // prefixed mount
//
// Either way the endpoints land on /api/getDrawReg, /api/saveDrawReg, etc.,
// which is what DbUrl-based calls in DrawingRegister.tsx expect.
//
// Numbering is driven by drawing_register.srno_row_id (BIGINT AUTO_INCREMENT PK
// — see drawing_register_ddl.sql). No separate sequence table.
//
//   SL_NO (Doc.No)  -> LPAD(srno_row_id, 5, '0')          e.g. 02548
//   DRAWING_NO      -> AHS / MMYY(DRAW_DATE) / srno_row_id - Suffix
//                                                         e.g. AHS/1225/2548-1
//
//   Suffix -> 1 for the first drawing raised against a QUOTE_REF, 2 for the
//             next drawing against the SAME QUOTE_REF, and so on.

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  // ── Accept either a callback-style mysql2 handle or a promise one. ──
  // mysql2's callback connection/pool exposes .promise(); the promise variants
  // don't. This keeps the module working whichever HayatDb.js creates.
  const db = typeof connection.promise === 'function' ? connection.promise() : connection;

  // True when `db` is a pool (has getConnection) rather than a single
  // connection — decides how transactions are opened below.
  const isPool = typeof db.getConnection === 'function';

  // ── Run fn inside a transaction, on a dedicated connection if pooled. ──
  async function withTxn(fn) {
    const conn = isPool ? await db.getConnection() : db;
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (err) {
      try { await conn.rollback(); } catch (_) { /* rollback is best-effort */ }
      throw err;
    } finally {
      if (isPool) conn.release();
    }
  }

  // ── Helper: MMYY from a date value (e.g. 2025-12-31 -> "1225") ──
  // Parses 'YYYY-MM-DD' as a plain string rather than via `new Date()`, which
  // would treat it as UTC midnight and shift the month on a UTC-or-behind
  // server for dates on the 1st of a month.
  function getMMYY(dateVal) {
    if (typeof dateVal === 'string') {
      const m = dateVal.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[2]}${m[1].slice(-2)}`;
    }
    const d = dateVal ? new Date(dateVal) : new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${mm}${yy}`;
  }

  // ── Helper: what srno_row_id will the next INSERT most likely get? ──
  // Reads the live AUTO_INCREMENT counter, and also takes MAX(srno_row_id)+1
  // as a floor in case the counter has been reset low. PREVIEW ONLY — the
  // authoritative value comes from insertId at save time.
  async function peekNextRowId() {
    // MySQL 8 caches information_schema stats for 24h by default; without this
    // the preview would freeze at its first value after the first save.
    // Needs SESSION_VARIABLES_ADMIN on some setups, so failure is tolerated —
    // MAX(srno_row_id)+1 below still gives a usable answer.
    try {
      await db.query(`SET SESSION information_schema_stats_expiry = 0`);
    } catch (e) {
      console.warn('information_schema_stats_expiry not settable:', e.code || e.message);
    }

    const [aiRows] = await db.query(
      `SELECT AUTO_INCREMENT AS ai
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'drawing_register'`
    );
    const [maxRows] = await db.query(
      `SELECT COALESCE(MAX(srno_row_id), 0) + 1 AS mx FROM drawing_register`
    );

    const ai = Number(aiRows[0] && aiRows[0].ai) || 0;
    const mx = Number(maxRows[0] && maxRows[0].mx) || 1;
    return Math.max(ai, mx);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getNextDrawRegNo — next Doc.No for the ADD screen.
  //
  // Doc.No ONLY. The Drawing No is deliberately not previewed: it depends on
  // DRAW_DATE (MMYY) and QUOTE_REF (the -N suffix), so it would keep changing
  // under the user as they fill the form. It's generated once, at save.
  //
  // This is a PREVIEW. It takes no locks and reserves nothing, so if another
  // user saves first the real number will differ — the client compares what
  // it displayed against what the save returns and tells the user if it moved.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getNextDrawRegNo', async (req, res) => {
    try {
      const rowId = await peekNextRowId();

      res.json({
        srno_row_id: rowId,
        SL_NO: String(rowId).padStart(5, '0'),
        preview: true,
      });
    } catch (err) {
      console.error('getNextDrawRegNo error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getJobInfo/:jobNo — quotation + customer for a job.
  //
  // Replaces the old QUOTE_REF LOV: the user picks a Job No, and both the
  // quotation and the client name follow from it.
  //   QUOTE_NO    <- job_quot_no  (MAX, since a job can have several rows)
  //   CLIENT_NAME <- job card's customer code, resolved through cus_mst
  //
  // ⚠ CHECK THESE NAMES against your schema — I don't have DESC output for
  //   the job card or cus_mst. Adjust the table/column names in the second
  //   query if they differ (job_card / CUST_CODE / cus_mst / CUS_CODE / CUS_NAME).
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getJobInfo/:jobNo', async (req, res) => {
    const { jobNo } = req.params;
    const out = { JOB_NO: jobNo, QUOTE_NO: null, CLIENT_NAME: null };

    try {
      const [qRows] = await db.query(
        `SELECT MAX(QUOTE_NO) AS QUOTE_NO FROM job_quot_no WHERE JOB_NO = ?`,
        [jobNo]
      );
      out.QUOTE_NO = (qRows[0] && qRows[0].QUOTE_NO) || null;
    } catch (err) {
      console.error('getJobInfo (quote) error:', err);
    }

    try {
      const [cRows] = await db.query(
        `SELECT SubstR(c.CUST_NAME,1,38) AS CLIENT_NAME
           FROM job_card j
           JOIN cus_mst  c ON c.CUST_CODE = j.CUST_CODE
          WHERE j.JOB_NO = ?
          LIMIT 1`,
        [jobNo]
      );
      out.CLIENT_NAME = (cRows[0] && cRows[0].CLIENT_NAME) || null;
    } catch (err) {
      // Logged, not fatal — a missing customer shouldn't block the quotation.
      console.error('getJobInfo (customer) error:', err);
    }

    // A job with no quotation or no customer is a normal outcome, not an
    // error — the form just leaves those boxes blank.
    res.json(out);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getDrawReg/:drawingNo — single record
  // (the EDIT page routes as /DrawingRegister/EDIT/<DRAWING_NO>/DRAWREG)
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getDrawReg/:drawingNo', async (req, res) => {
    try {
      const { drawingNo } = req.params;
      // DATE columns are formatted in SQL rather than returned as JS Date
      // objects: res.json() would serialise those to UTC, shifting the day
      // back for a +04:00 server (31/12 arriving at the browser as 30/12).
      const [rows] = await db.query(
        `SELECT srno_row_id, SL_NO, DRAWING_NO, JOB_NO, PROJECT_NAME,
                CLIENT_NAME, PANEL_REF, QUOTE_REF, DRAWN_NAME,
                EXT_REV, COMPUTER_LOCATION,
                DATE_FORMAT(DRAW_DATE,     '%Y-%m-%d') AS DRAW_DATE,
                DATE_FORMAT(DATE_OF_SUBM,  '%Y-%m-%d') AS DATE_OF_SUBM,
                DATE_FORMAT(APPROVAL_DATE, '%Y-%m-%d') AS APPROVAL_DATE
         FROM drawing_register
         WHERE DRAWING_NO = ?`,
        [drawingNo]
      );

      if (!rows.length) {
        return res.status(404).json({ message: 'Drawing not found' });
      }
      res.json(rows);
    } catch (err) {
      console.error('getDrawReg error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getDrawRegList — recent records for the browser / LOV
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getDrawRegList', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT srno_row_id, SL_NO, DRAWING_NO, DRAW_DATE, JOB_NO, PROJECT_NAME,
                CLIENT_NAME, QUOTE_REF
         FROM drawing_register
         ORDER BY srno_row_id DESC
         LIMIT 200`
      );
      res.json(rows);
    } catch (err) {
      console.error('getDrawRegList error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/saveDrawReg — create.
  // SL_NO and DRAWING_NO are generated server-side from the AUTO_INCREMENT
  // srno_row_id; the client never sends them. AUTO_INCREMENT only yields its
  // value AFTER the INSERT, so this is INSERT-then-UPDATE in one transaction.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/saveDrawReg', async (req, res) => {
    const {
      DRAW_DATE, JOB_NO, PROJECT_NAME, CLIENT_NAME, PANEL_REF,
      QUOTE_REF, DATE_OF_SUBM, DRAWN_NAME, EXT_REV,
      COMPUTER_LOCATION, APPROVAL_DATE,
    } = req.body;

    // Blank = auto-generate; anything typed by the user wins.
    const manualNo = (req.body.DRAWING_NO || '').trim();

    if (!DRAW_DATE) {
      return res.status(400).json({ message: 'Draw Date is required to generate Drawing No' });
    }

    try {
      // Reject a manual number that's already taken, before touching the
      // table — otherwise the row inserts and only the number silently clashes.
      if (manualNo) {
        const [dup] = await db.query(
          `SELECT 1 FROM drawing_register WHERE DRAWING_NO = ? LIMIT 1`,
          [manualNo]
        );
        if (dup.length) {
          return res.status(409).json({
            message: `Drawing No ${manualNo} already exists`,
            DRAWING_NO: manualNo,
          });
        }
      }

      const out = await withTxn(async (conn) => {
        // 1) Suffix = how many drawings already exist for this QUOTE_REF, + 1.
        //    FOR UPDATE locks those rows so two concurrent saves against the
        //    same quote can't both land on the same suffix.
        let suffix = 1;
        if (QUOTE_REF) {
          const [cntRows] = await conn.query(
            `SELECT COUNT(*) AS cnt FROM drawing_register WHERE QUOTE_REF = ? FOR UPDATE`,
            [QUOTE_REF]
          );
          suffix = (cntRows[0].cnt || 0) + 1;
        }

        // 2) INSERT first — srno_row_id is assigned by MySQL here.
        const [ins] = await conn.query(
          `INSERT INTO drawing_register
             (DRAW_DATE, CLIENT_NAME, PROJECT_NAME, QUOTE_REF, COMPUTER_LOCATION,
              DRAWN_NAME, PANEL_REF, DATE_OF_SUBM, EXT_REV, JOB_NO, APPROVAL_DATE)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            DRAW_DATE, CLIENT_NAME, PROJECT_NAME, QUOTE_REF, COMPUTER_LOCATION,
            DRAWN_NAME, PANEL_REF, DATE_OF_SUBM || null, EXT_REV, JOB_NO,
            APPROVAL_DATE || null,
          ]
        );

        const rowId = ins.insertId;                       // e.g. 2548
        const slNo = String(rowId).padStart(5, '0');      // e.g. 02548
        const drawingNo = manualNo || `AHS/${getMMYY(DRAW_DATE)}/${rowId}-${suffix}`;

        // 3) Stamp the numbers onto the row just created.
        await conn.query(
          `UPDATE drawing_register SET SL_NO = ?, DRAWING_NO = ? WHERE srno_row_id = ?`,
          [slNo, drawingNo, rowId]
        );

        return { srno_row_id: rowId, SL_NO: slNo, DRAWING_NO: drawingNo, manual: Boolean(manualNo) };
      });

      res.json({ message: 'Saved', ...out });
    } catch (err) {
      console.error('saveDrawReg error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /api/updateDrawReg/:drawingNo — update.
  // DRAWING_NO is immutable once generated — it's the lookup key, never a
  // column that gets rewritten.
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/updateDrawReg/:drawingNo', async (req, res) => {
    const { drawingNo } = req.params;
    const {
      DRAW_DATE, JOB_NO, PROJECT_NAME, CLIENT_NAME, PANEL_REF,
      QUOTE_REF, DATE_OF_SUBM, DRAWN_NAME, EXT_REV,
      COMPUTER_LOCATION, APPROVAL_DATE,
    } = req.body;

    try {
      const [result] = await db.query(
        `UPDATE drawing_register SET
           DRAW_DATE = ?, JOB_NO = ?, PROJECT_NAME = ?, CLIENT_NAME = ?, PANEL_REF = ?,
           QUOTE_REF = ?, DATE_OF_SUBM = ?, DRAWN_NAME = ?, EXT_REV = ?,
           COMPUTER_LOCATION = ?, APPROVAL_DATE = ?
         WHERE DRAWING_NO = ?`,
        [
          DRAW_DATE, JOB_NO, PROJECT_NAME, CLIENT_NAME, PANEL_REF,
          QUOTE_REF, DATE_OF_SUBM || null, DRAWN_NAME, EXT_REV, COMPUTER_LOCATION,
          APPROVAL_DATE || null, drawingNo,
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Drawing not found' });
      }
      res.json({ message: 'Updated', DRAWING_NO: drawingNo });
    } catch (err) {
      console.error('updateDrawReg error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/deleteDrawReg/:drawingNo
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/deleteDrawReg/:drawingNo', async (req, res) => {
    try {
      const { drawingNo } = req.params;
      const [result] = await db.query(
        `DELETE FROM drawing_register WHERE DRAWING_NO = ?`,
        [drawingNo]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Drawing not found' });
      }
      res.json({ message: 'Deleted', DRAWING_NO: drawingNo });
    } catch (err) {
      console.error('deleteDrawReg error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ── Mount-style shim ──
  // Routes above are declared without the /api prefix. This wrapper exposes
  // them under BOTH / and /api, so HayatDb.js works either way:
  //     app.use(drawingRegisterRoutes(connection));          -> /api/getDrawReg
  //     app.use("/api", drawingRegisterRoutes(connection));  -> /api/getDrawReg
  // (the second also answers on /api/api/..., which is harmless and unused)
  const mount = express.Router();
  mount.use('/api', router);
  mount.use('/', router);
  return mount;
};
