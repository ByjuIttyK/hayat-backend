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
// Numbering
//   SL_NO (Doc.No)  -> LPAD(srno_row_id, 5, '0')                 e.g. 02548
//   DRAWING_NO      -> AHS / MMYY(DRAW_DATE) / running serial     e.g. AHS/1026/2939
//
//   The serial runs on across months: next = highest serial already used in
//   drawing_register + 1 (older numbers carrying a "-N" suffix count by their
//   numeric part).
//
//   DRAWING_NO is NOT unique: older records legitimately share one number
//   (one drawing covering several panels), so srno_row_id stays the only key.
//   Two users saving at the same moment are kept apart by a MySQL named lock
//   (GET_LOCK 'drawreg_no') held around MAX+1 -> INSERT -> COMMIT, so saves
//   queue one behind the other and each reads the number the previous one used.
//   Update and delete are keyed on srno_row_id for the same reason.
//
// Quotation / job / customer
//   quot_hdr (QUOT_NO, QUOT_DATE, CUST_CODE, PROJECT_NAME) + cus_mst (CUST_NAME)
//   job_card (JOB_NO, PROJ_NAME, CUST_CODE, QUOT_REF)
//   drawing_register.CUST_CODE added:
//     ALTER TABLE drawing_register ADD COLUMN CUST_CODE VARCHAR(10) NULL AFTER CLIENT_NAME;

const express = require('express');

// CLIENT_NAME is varchar(40); a full customer name from the list can be longer.
const cut40 = (v) => (v == null ? v : String(v).trim().slice(0, 40));

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

  // ── Helper: next running serial for DRAWING_NO (AHS/MMYY/<serial>) ──
  // Numeric part after the last '/'; CAST stops at the first non-digit, so
  // "2939-1" counts as 2939. Only well-formed AHS/MMYY/nnnn[-n] numbers count.
  //
  // Taken from the last 12 months of drawings: a few old numbers were keyed
  // with typing slips (AHS/1023/11751-3, AHS/0323/08589-1, AHS/0522/04755-4)
  // and are already on issued drawings, so they stay as they are — the window
  // simply keeps them out of the count. If no drawing falls in the window,
  // the whole table is used.
  const SERIAL_SQL = (windowed) => `
    SELECT MAX(CAST(SUBSTRING_INDEX(DRAWING_NO, '/', -1) AS UNSIGNED)) AS mx
      FROM drawing_register
     WHERE DRAWING_NO REGEXP '^AHS/[0-9]{4}/[0-9]{1,6}(-[0-9]+)?$'
       ${windowed ? 'AND DRAW_DATE >= CURDATE() - INTERVAL 12 MONTH' : ''}`;

  async function nextDrawSerial(conn) {
    const [recent] = await conn.query(SERIAL_SQL(true));
    let mx = Number(recent[0] && recent[0].mx) || 0;
    if (!mx) {
      const [all] = await conn.query(SERIAL_SQL(false));
      mx = Number(all[0] && all[0].mx) || 0;
    }
    return mx + 1;
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
  // Doc.No and a PROVISIONAL Drawing No (MMYY from ?date=). Nothing is
  // reserved: the real numbers are taken under the lock at save, and the
  // screen tells the user if either moved in the meantime.
  //
  // This is a PREVIEW. It takes no locks and reserves nothing, so if another
  // user saves first the real number will differ — the client compares what
  // it displayed against what the save returns and tells the user if it moved.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getNextDrawRegNo', async (req, res) => {
    // ?date=yyyy-mm-dd → MMYY of the provisional Drawing No (default: today)
    const date = String(req.query.date || '').trim();
    try {
      const rowId = await peekNextRowId();
      const serial = await nextDrawSerial(db);

      res.json({
        srno_row_id: rowId,
        SL_NO: String(rowId).padStart(5, '0'),
        DRAWING_NO: `AHS/${getMMYY(date || new Date())}/${serial}`,
        preview: true,
      });
    } catch (err) {
      console.error('getNextDrawRegNo error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getJobInfo/:jobNo — quotation + customer for a job.
  //   QUOTE_NO    <- job_card.QUOT_REF, else MAX(job_quot_no.QUOTE_NO)
  //   CUST_CODE   <- job_card.CUST_CODE
  //   CLIENT_NAME <- cus_mst.CUST_NAME (trimmed to fit the 40-char column)
  // The screen only fills Quote Ref from here when it is still blank — once a
  // quotation has been picked, it leads and the job follows it.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getJobInfo/:jobNo', async (req, res) => {
    const { jobNo } = req.params;
    const out = { JOB_NO: jobNo, QUOTE_NO: null, CUST_CODE: null, CLIENT_NAME: null, PROJECT_NAME: null };

    try {
      const [cRows] = await db.query(
        `SELECT j.QUOT_REF, j.CUST_CODE, j.PROJ_NAME,
                SUBSTR(c.CUST_NAME, 1, 38) AS CLIENT_NAME
           FROM job_card j
           LEFT JOIN cus_mst c ON c.CUST_CODE = j.CUST_CODE
          WHERE j.JOB_NO = ?
          LIMIT 1`,
        [jobNo]
      );
      const r = cRows[0] || {};
      out.QUOTE_NO = r.QUOT_REF ? String(r.QUOT_REF).trim() : null;
      out.CUST_CODE = r.CUST_CODE || null;
      out.CLIENT_NAME = r.CLIENT_NAME || null;
      out.PROJECT_NAME = r.PROJ_NAME || null;
    } catch (err) {
      console.error('getJobInfo (job card) error:', err);
    }

    if (!out.QUOTE_NO) {
      try {
        const [qRows] = await db.query(
          `SELECT MAX(QUOTE_NO) AS QUOTE_NO FROM job_quot_no WHERE JOB_NO = ?`,
          [jobNo]
        );
        out.QUOTE_NO = (qRows[0] && qRows[0].QUOTE_NO) || null;
      } catch (err) {
        console.error('getJobInfo (job_quot_no) error:', err);
      }
    }

    res.json(out);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/drawRegQuotes[?cust=] — quotation picker (F9 on Quote Ref)
  //   QUOT_NO, QUOT_DATE (dd/mm/yyyy), CUST_CODE, CUST_NAME, PROJECT_NAME
  // Newest first; the screen filters as the user types.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/drawRegQuotes', async (req, res) => {
    // ?cust=<CUST_CODE> limits the list to that customer; omitted = everyone
    const cust = String(req.query.cust || '').trim();
    try {
      const [rows] = await db.query(
        `SELECT a.QUOT_NO,
                DATE_FORMAT(a.QUOT_DATE, '%d/%m/%Y') AS QUOT_DATE,
                a.CUST_CODE,
                SUBSTR(b.CUST_NAME, 1, 38) AS CUST_NAME,
                a.PROJECT_NAME
           FROM quot_hdr a
           LEFT JOIN cus_mst b ON b.CUST_CODE = a.CUST_CODE
          ${cust ? 'WHERE a.CUST_CODE = ?' : ''}
          ORDER BY a.QUOT_DATE DESC, a.QUOT_NO DESC
          LIMIT 5000`,
        cust ? [cust] : []
      );
      res.json(rows);
    } catch (err) {
      console.error('drawRegQuotes error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/drawRegQuote?quot=<QUOT_NO> — one quotation (Quote Ref typed by
  // hand) plus the jobs raised against it (job_card.QUOT_REF).
  // Query string, not a path segment: revision numbers carry a '/'.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/drawRegQuote', async (req, res) => {
    const quot = String(req.query.quot || '').trim();
    if (!quot) return res.status(400).json({ message: 'Quotation number is required' });
    try {
      const [[qRows], [jRows]] = await Promise.all([
        db.query(
          `SELECT a.QUOT_NO,
                  DATE_FORMAT(a.QUOT_DATE, '%d/%m/%Y') AS QUOT_DATE,
                  a.CUST_CODE,
                  SUBSTR(b.CUST_NAME, 1, 38) AS CUST_NAME,
                  a.PROJECT_NAME
             FROM quot_hdr a
             LEFT JOIN cus_mst b ON b.CUST_CODE = a.CUST_CODE
            WHERE a.QUOT_NO = ?
            LIMIT 1`,
          [quot]
        ),
        db.query(
          `SELECT JOB_NO, PROJ_NAME, CUST_CODE
             FROM job_card
            WHERE TRIM(QUOT_REF) = ?
            ORDER BY JOB_NO DESC`,
          [quot]
        ),
      ]);
      res.json({ quote: qRows[0] || null, jobs: jRows });
    } catch (err) {
      console.error('drawRegQuote error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getDrawReg/:drawingNo — single record
  // (the EDIT page routes as /DrawingRegister/EDIT/<DRAWING_NO>/DRAWREG)
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getDrawReg/:drawingNo', async (req, res) => {
    try {
      const { drawingNo } = req.params;
      // ?id=<srno_row_id> opens one particular record when several share the
      // drawing number; without it the oldest record is returned.
      const rowId = Number(req.query.id) || 0;
      // DATE columns are formatted in SQL rather than returned as JS Date
      // objects: res.json() would serialise those to UTC, shifting the day
      // back for a +04:00 server (31/12 arriving at the browser as 30/12).
      const [rows] = await db.query(
        `SELECT srno_row_id, SL_NO, DRAWING_NO, JOB_NO, PROJECT_NAME,
                CLIENT_NAME, CUST_CODE, PANEL_REF, QUOTE_REF, DRAWN_NAME,
                EXT_REV, COMPUTER_LOCATION,
                DATE_FORMAT(DRAW_DATE,     '%Y-%m-%d') AS DRAW_DATE,
                DATE_FORMAT(DATE_OF_SUBM,  '%Y-%m-%d') AS DATE_OF_SUBM,
                DATE_FORMAT(APPROVAL_DATE, '%Y-%m-%d') AS APPROVAL_DATE
         FROM drawing_register
         WHERE DRAWING_NO = ? ${rowId ? 'AND srno_row_id = ?' : ''}
         ORDER BY srno_row_id`,
        rowId ? [drawingNo, rowId] : [drawingNo]
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
  // GET /api/getDrawRegById/:id — single record by srno_row_id.
  // The Drawing List (InfoGrid, key_field = srno_row_id) opens records this
  // way, so a drawing number shared by several records opens the right one.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getDrawRegById/:id', async (req, res) => {
    const rowId = Number(req.params.id) || 0;
    if (!rowId) return res.status(400).json({ message: 'Record id is required' });
    try {
      const [rows] = await db.query(
        `SELECT srno_row_id, SL_NO, DRAWING_NO, JOB_NO, PROJECT_NAME,
                CLIENT_NAME, CUST_CODE, PANEL_REF, QUOTE_REF, DRAWN_NAME,
                EXT_REV, COMPUTER_LOCATION,
                DATE_FORMAT(DRAW_DATE,     '%Y-%m-%d') AS DRAW_DATE,
                DATE_FORMAT(DATE_OF_SUBM,  '%Y-%m-%d') AS DATE_OF_SUBM,
                DATE_FORMAT(APPROVAL_DATE, '%Y-%m-%d') AS APPROVAL_DATE
           FROM drawing_register
          WHERE srno_row_id = ?`,
        [rowId]
      );
      if (!rows.length) return res.status(404).json({ message: 'Drawing not found' });
      res.json(rows);
    } catch (err) {
      console.error('getDrawRegById error:', err);
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
  // SL_NO and DRAWING_NO are always generated here; the client never sends them.
  //
  // Multi-user safety (named lock, no unique key needed):
  //   GET_LOCK('drawreg_no')            — waits up to 15 s for any other save
  //   BEGIN
  //     serial = MAX(serial)+1          — sees every number committed before us
  //     INSERT ... DRAWING_NO
  //     UPDATE SL_NO from srno_row_id
  //   COMMIT
  //   RELEASE_LOCK('drawreg_no')
  // The lock is taken BEFORE the transaction starts, so the MAX read is not
  // served from an older snapshot. Lock, transaction and release all run on
  // one dedicated connection; MySQL also frees the lock if that connection drops.
  // ─────────────────────────────────────────────────────────────────────────
  const DRAWREG_LOCK = 'drawreg_no';

  router.post('/saveDrawReg', async (req, res) => {
    const {
      DRAW_DATE, JOB_NO, PROJECT_NAME, CLIENT_NAME, CUST_CODE, PANEL_REF,
      QUOTE_REF, DATE_OF_SUBM, DRAWN_NAME, EXT_REV,
      COMPUTER_LOCATION, APPROVAL_DATE,
    } = req.body;

    if (!DRAW_DATE) {
      return res.status(400).json({ message: 'Draw Date is required to generate Drawing No' });
    }

    const conn = isPool ? await db.getConnection() : db;
    let locked = false;
    try {
      const [[lk]] = await conn.query(`SELECT GET_LOCK(?, 15) AS got`, [DRAWREG_LOCK]);
      if (Number(lk && lk.got) !== 1) {
        return res.status(503).json({ message: 'Another drawing is being saved - please try again.' });
      }
      locked = true;

      await conn.beginTransaction();
      try {
        const serial = await nextDrawSerial(conn);
        const drawingNo = `AHS/${getMMYY(DRAW_DATE)}/${serial}`;

        const [ins] = await conn.query(
          `INSERT INTO drawing_register
             (DRAWING_NO, DRAW_DATE, CLIENT_NAME, CUST_CODE, PROJECT_NAME, QUOTE_REF,
              COMPUTER_LOCATION, DRAWN_NAME, PANEL_REF, DATE_OF_SUBM, EXT_REV,
              JOB_NO, APPROVAL_DATE)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            drawingNo, DRAW_DATE, cut40(CLIENT_NAME), CUST_CODE || null, PROJECT_NAME, QUOTE_REF,
            COMPUTER_LOCATION, DRAWN_NAME, PANEL_REF, DATE_OF_SUBM || null, EXT_REV,
            JOB_NO, APPROVAL_DATE || null,
          ]
        );

        const rowId = ins.insertId;
        const slNo = String(rowId).padStart(5, '0');
        await conn.query(
          `UPDATE drawing_register SET SL_NO = ? WHERE srno_row_id = ?`,
          [slNo, rowId]
        );
        await conn.commit();

        res.json({ message: 'Saved', srno_row_id: rowId, SL_NO: slNo, DRAWING_NO: drawingNo });
      } catch (err) {
        try { await conn.rollback(); } catch (_) { /* best-effort */ }
        throw err;
      }
    } catch (err) {
      console.error('saveDrawReg error:', err);
      if (!res.headersSent) res.status(500).json({ message: 'Server error', error: err.message });
    } finally {
      if (locked) {
        try { await conn.query(`SELECT RELEASE_LOCK(?)`, [DRAWREG_LOCK]); } catch (_) { /* freed on disconnect */ }
      }
      if (isPool) conn.release();
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
      DRAW_DATE, JOB_NO, PROJECT_NAME, CLIENT_NAME, CUST_CODE, PANEL_REF,
      QUOTE_REF, DATE_OF_SUBM, DRAWN_NAME, EXT_REV,
      COMPUTER_LOCATION, APPROVAL_DATE,
    } = req.body;

    // Older drawing numbers are shared by several records, so the row id
    // decides which one is updated; DRAWING_NO is the fallback.
    const rowId = Number(req.body.srno_row_id) || 0;

    try {
      const [result] = await db.query(
        `UPDATE drawing_register SET
           DRAW_DATE = ?, JOB_NO = ?, PROJECT_NAME = ?, CLIENT_NAME = ?, CUST_CODE = ?, PANEL_REF = ?,
           QUOTE_REF = ?, DATE_OF_SUBM = ?, DRAWN_NAME = ?, EXT_REV = ?,
           COMPUTER_LOCATION = ?, APPROVAL_DATE = ?
         WHERE ${rowId ? 'srno_row_id = ?' : 'DRAWING_NO = ?'}`,
        [
          DRAW_DATE, JOB_NO, PROJECT_NAME, cut40(CLIENT_NAME), CUST_CODE || null, PANEL_REF,
          QUOTE_REF, DATE_OF_SUBM || null, DRAWN_NAME, EXT_REV, COMPUTER_LOCATION,
          APPROVAL_DATE || null, rowId || drawingNo,
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
      // ?id=<srno_row_id> deletes just that record; a shared number would
      // otherwise take every record carrying it.
      const rowId = Number(req.query.id) || 0;
      const [result] = await db.query(
        rowId
          ? `DELETE FROM drawing_register WHERE DRAWING_NO = ? AND srno_row_id = ?`
          : `DELETE FROM drawing_register WHERE DRAWING_NO = ?`,
        rowId ? [drawingNo, rowId] : [drawingNo]
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
