// routes/drawingRegisterRoutes.js — Drawing Register (header + panels)
//
// Factory-pattern route module. Mounts under both / and /api:
//   const drawingRegisterRoutes = require('./routes/drawingRegisterRoutes');
//   app.use("/api", drawingRegisterRoutes(connection));
//
// Tables
//   drawing_register     header — one row per drawing set (customer + quotation)
//   drawing_reg_panel    detail — one row per panel, its own DRAWING_NO and REV_NO,
//                        PANEL_DETAILS MEDIUMTEXT (from quot_item.ITEM_NAME)
//   quot_hdr / quot_item / cus_mst / job_card   read only
//
// Numbering
//   SL_NO (Doc.No)      LPAD(header srno_row_id, 5, '0')
//   Header DRAWING_NO   AHS / MMYY(DRAW_DATE) / serial            e.g. AHS/1026/2940
//   Panel DRAWING_NO    only for panels ticked "Dwg" (ASSIGN). The first panel
//                       to get a number takes the header number itself, the
//                       next ones <header no>-1, -2 …          e.g. AHS/1026/2940, AHS/1026/2940-1
//                       Unticked panels are saved without a number and can be
//                       given one on a later edit. An issued number never changes.
//   serial = highest well-formed serial of the last 12 months + 1 (header and
//   panel numbers both counted; old typo numbers fall outside the window).
//
// Multi-user safety: every save/update that assigns numbers runs under the
// MySQL named lock 'drawreg_no' (GET_LOCK), so numbers are never handed out
// twice. DRAWING_NO is not unique — older records share numbers — so records
// are always addressed by srno_row_id.

const express = require('express');

// Suffix of the SECOND numbered panel (the first takes the header number):
// 1 → AHS/1026/2940, AHS/1026/2940-1, -2 …
const SUFFIX_START = 1;

const DRAWREG_LOCK = 'drawreg_no';

// Header text columns and their sizes (see drawreg_vps.sql)
const cut = (v, n) => (v == null ? v : String(v).trim().slice(0, n));

module.exports = function (connection) {
  const router = express.Router();
  const db = typeof connection.promise === 'function' ? connection.promise() : connection;
  const isPool = typeof db.getConnection === 'function';

  // ── MMYY from 'YYYY-MM-DD' (string parse, no UTC shift) or a Date ──
  function getMMYY(dateVal) {
    if (typeof dateVal === 'string') {
      const m = dateVal.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[2]}${m[1].slice(-2)}`;
    }
    const d = dateVal ? new Date(dateVal) : new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getFullYear()).slice(-2)}`;
  }

  // ── Next running serial ──
  // Well-formed AHS/MMYY/nnnn[-n] numbers only; CAST stops at the '-'.
  // Last 12 months of drawings first — old typo numbers (AHS/1023/11751-3,
  // AHS/0323/08589-1, AHS/0522/04755-4) stay untouched but don't count.
  const SERIAL_SQL = (windowed) => `
    SELECT MAX(CAST(SUBSTRING_INDEX(n, '/', -1) AS UNSIGNED)) AS mx
      FROM (
            SELECT DRAWING_NO AS n FROM drawing_register
             WHERE DRAWING_NO REGEXP '^AHS/[0-9]{4}/[0-9]{1,6}(-[0-9]+)?$'
               ${windowed ? 'AND DRAW_DATE >= CURDATE() - INTERVAL 12 MONTH' : ''}
            UNION ALL
            SELECT p.DRAWING_NO FROM drawing_reg_panel p
              JOIN drawing_register h ON h.srno_row_id = p.HDR_ROW_ID
             WHERE p.DRAWING_NO REGEXP '^AHS/[0-9]{4}/[0-9]{1,6}(-[0-9]+)?$'
               ${windowed ? 'AND h.DRAW_DATE >= CURDATE() - INTERVAL 12 MONTH' : ''}
           ) x`;

  async function nextDrawSerial(conn) {
    const [recent] = await conn.query(SERIAL_SQL(true));
    let mx = Number(recent[0] && recent[0].mx) || 0;
    if (!mx) {
      const [all] = await conn.query(SERIAL_SQL(false));
      mx = Number(all[0] && all[0].mx) || 0;
    }
    return mx + 1;
  }

  // ── Probable next header srno_row_id (Doc.No preview only) ──
  async function peekNextRowId() {
    try { await db.query(`SET SESSION information_schema_stats_expiry = 0`); } catch (_) { /* optional */ }
    const [aiRows] = await db.query(
      `SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'drawing_register'`
    );
    const [maxRows] = await db.query(`SELECT COALESCE(MAX(srno_row_id), 0) + 1 AS mx FROM drawing_register`);
    return Math.max(Number(aiRows[0] && aiRows[0].ai) || 0, Number(maxRows[0] && maxRows[0].mx) || 1);
  }

  // ── Run fn holding the numbering lock, inside a transaction, on one connection ──
  async function withNumberLock(fn) {
    const conn = isPool ? await db.getConnection() : db;
    let locked = false;
    try {
      const [[lk]] = await conn.query(`SELECT GET_LOCK(?, 15) AS got`, [DRAWREG_LOCK]);
      if (Number(lk && lk.got) !== 1) {
        const e = new Error('Another drawing is being saved — please try again.');
        e.status = 503;
        throw e;
      }
      locked = true;
      await conn.beginTransaction();       // after the lock: the MAX read sees every committed number
      try {
        const out = await fn(conn);
        await conn.commit();
        return out;
      } catch (err) {
        try { await conn.rollback(); } catch (_) { /* best-effort */ }
        throw err;
      }
    } finally {
      if (locked) { try { await conn.query(`SELECT RELEASE_LOCK(?)`, [DRAWREG_LOCK]); } catch (_) { /* freed on disconnect */ } }
      if (isPool) conn.release();
    }
  }

  // ── Header SELECT (dates as strings: res.json would shift a Date to UTC) ──
  const HDR_COLS = `
    srno_row_id, SL_NO, DRAWING_NO, JOB_NO, PROJECT_NAME, CLIENT_NAME, CUST_CODE,
    PANEL_REF, QUOTE_REF, DRAWN_NAME, EXT_REV, COMPUTER_LOCATION,
    DATE_FORMAT(DRAW_DATE,     '%Y-%m-%d') AS DRAW_DATE,
    DATE_FORMAT(DATE_OF_SUBM,  '%Y-%m-%d') AS DATE_OF_SUBM,
    DATE_FORMAT(APPROVAL_DATE, '%Y-%m-%d') AS APPROVAL_DATE`;

  // Header rows + their panels. A record saved before the panel table existed
  // has no panel rows: its single panel is shown from the header itself, and
  // is written to drawing_reg_panel the next time the record is saved.
  async function withPanels(rows) {
    for (const r of rows) {
      const [p] = await db.query(
        `SELECT srno_row_id, SR_NO, QUOT_SR_NO, ITEM_CODE, QTY, PANEL_DETAILS, DRAWING_NO, REV_NO
           FROM drawing_reg_panel
          WHERE HDR_ROW_ID = ?
          ORDER BY SR_NO, srno_row_id`,
        [r.srno_row_id]
      );
      r.panels = p.length
        ? p.map((x) => ({ ...x, QTY: x.QTY == null ? null : Number(x.QTY) }))
        : [{
          srno_row_id: null, SR_NO: 1, QUOT_SR_NO: null, ITEM_CODE: null, QTY: null,
          PANEL_DETAILS: r.PANEL_REF || '', DRAWING_NO: r.DRAWING_NO || '', REV_NO: r.EXT_REV || '',
          legacy: true,
        }];
    }
    return rows;
  }

  // Panels from the request: real lines only, numbered 1..n in grid order
  const cleanPanels = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((p) => p && String(p.PANEL_DETAILS ?? '').trim())
      .map((p, i) => ({
        SR_NO: i + 1,
        QUOT_SR_NO: p.QUOT_SR_NO ? cut(p.QUOT_SR_NO, 4) : null,
        ITEM_CODE: p.ITEM_CODE ? cut(p.ITEM_CODE, 20) : null,
        QTY: p.QTY === '' || p.QTY == null || isNaN(Number(p.QTY)) ? null : Number(p.QTY),
        PANEL_DETAILS: String(p.PANEL_DETAILS).trim(),
        DRAWING_NO: p.DRAWING_NO ? cut(p.DRAWING_NO, 30) : '',
        REV_NO: p.REV_NO ? cut(p.REV_NO, 10) : null,
        // a panel that already has a number keeps it; otherwise only if ticked
        ASSIGN: Boolean(p.DRAWING_NO) || p.ASSIGN === true || p.ASSIGN === 1 || p.ASSIGN === '1',
      }));

  // Is a drawing number already used anywhere — as another set's number or
  // by any panel? (Older records share numbers, so the header number of
  // THIS set is only free for its own first panel.)
  async function numberTaken(conn, no, hdrRowId) {
    const [rows] = await conn.query(
      `SELECT 1 FROM drawing_register WHERE DRAWING_NO = ? AND srno_row_id <> ?
       UNION ALL
       SELECT 1 FROM drawing_reg_panel WHERE DRAWING_NO = ? AND HDR_ROW_ID <> ?
       LIMIT 1`,
      [no, hdrRowId, no, hdrRowId]
    );
    return rows.length > 0;
  }

  // Give numbers to ticked panels that don't have one yet, in grid order.
  //   first number of the set → the header number (if no panel holds it yet
  //   and no other record uses it), then <base>-<next free suffix>.
  async function assignNumbers(conn, hdrRowId, headerNo, panels) {
    const base = String(headerNo || '').replace(/-\d+$/, '');
    const pending = panels.filter((p) => p.ASSIGN && !p.DRAWING_NO);
    if (!pending.length || !base) return;

    let baseFree = !panels.some((p) => p.DRAWING_NO === base) && !(await numberTaken(conn, base, hdrRowId));
    let next = Math.max(await maxSuffix(conn, base), SUFFIX_START - 1) + 1;
    for (const p of pending) {
      if (baseFree) { p.DRAWING_NO = base; baseFree = false; continue; }
      p.DRAWING_NO = `${base}-${next++}`;
    }
  }

  // Highest suffix already used under a base number, across header + panels
  async function maxSuffix(conn, base) {
    const [rows] = await conn.query(
      `SELECT MAX(CAST(SUBSTRING_INDEX(n, '-', -1) AS UNSIGNED)) AS mx
         FROM (SELECT DRAWING_NO AS n FROM drawing_register WHERE DRAWING_NO LIKE CONCAT(?, '-%')
               UNION ALL
               SELECT DRAWING_NO FROM drawing_reg_panel WHERE DRAWING_NO LIKE CONCAT(?, '-%')) x`,
      [base, base]
    );
    const mx = rows[0] && rows[0].mx;
    return mx == null ? 0 : Number(mx);
  }

  async function writePanels(conn, hdrRowId, panels) {
    await conn.query(`DELETE FROM drawing_reg_panel WHERE HDR_ROW_ID = ?`, [hdrRowId]);
    for (const p of panels) {
      await conn.query(
        `INSERT INTO drawing_reg_panel
           (HDR_ROW_ID, SR_NO, QUOT_SR_NO, ITEM_CODE, QTY, PANEL_DETAILS, DRAWING_NO, REV_NO)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [hdrRowId, p.SR_NO, p.QUOT_SR_NO, p.ITEM_CODE, p.QTY, p.PANEL_DETAILS, p.DRAWING_NO || null, p.REV_NO]
      );
    }
  }

  const hdrValues = (b) => ({
    DRAW_DATE: b.DRAW_DATE || null,
    JOB_NO: cut(b.JOB_NO, 10) || null,
    PROJECT_NAME: cut(b.PROJECT_NAME, 200) || null,
    CLIENT_NAME: cut(b.CLIENT_NAME, 100) || null,
    CUST_CODE: cut(b.CUST_CODE, 10) || null,
    QUOTE_REF: cut(b.QUOTE_REF, 15) || null,
    DRAWN_NAME: cut(b.DRAWN_NAME, 50) || null,
    COMPUTER_LOCATION: cut(b.COMPUTER_LOCATION, 40) || null,
    DATE_OF_SUBM: b.DATE_OF_SUBM || null,
    APPROVAL_DATE: b.APPROVAL_DATE || null,
  });

  const sendErr = (res, where, err) => {
    console.error(`${where} error:`, err);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ message: err.status ? err.message : 'Server error', error: err.message });
  };

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getNextDrawRegNo[?date=yyyy-mm-dd] — provisional numbers for ADD.
  // Reserves nothing; the save takes the real ones under the lock and the
  // screen reports any change.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getNextDrawRegNo', async (req, res) => {
    const date = String(req.query.date || '').trim();
    try {
      const rowId = await peekNextRowId();
      const serial = await nextDrawSerial(db);
      res.json({
        srno_row_id: rowId,
        SL_NO: String(rowId).padStart(5, '0'),
        DRAWING_NO: `AHS/${getMMYY(date || new Date())}/${serial}`,
        SUFFIX_START,
        preview: true,
      });
    } catch (err) { sendErr(res, 'getNextDrawRegNo', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getJobInfo/:jobNo — quotation / customer / project of a job
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getJobInfo/:jobNo', async (req, res) => {
    const { jobNo } = req.params;
    const out = { JOB_NO: jobNo, QUOTE_NO: null, CUST_CODE: null, CLIENT_NAME: null, PROJECT_NAME: null };
    try {
      const [cRows] = await db.query(
        `SELECT j.QUOT_REF, j.CUST_CODE, j.PROJ_NAME, c.CUST_NAME AS CLIENT_NAME
           FROM job_card j
           LEFT JOIN cus_mst c ON c.CUST_CODE = j.CUST_CODE
          WHERE j.JOB_NO = ? LIMIT 1`,
        [jobNo]
      );
      const r = cRows[0] || {};
      out.QUOTE_NO = r.QUOT_REF ? String(r.QUOT_REF).trim() : null;
      out.CUST_CODE = r.CUST_CODE || null;
      out.CLIENT_NAME = r.CLIENT_NAME || null;
      out.PROJECT_NAME = r.PROJ_NAME || null;
    } catch (err) { console.error('getJobInfo (job card) error:', err); }

    if (!out.QUOTE_NO) {
      try {
        const [qRows] = await db.query(`SELECT MAX(QUOTE_NO) AS QUOTE_NO FROM job_quot_no WHERE JOB_NO = ?`, [jobNo]);
        out.QUOTE_NO = (qRows[0] && qRows[0].QUOTE_NO) || null;
      } catch (err) { console.error('getJobInfo (job_quot_no) error:', err); }
    }
    res.json(out);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/drawRegQuotes[?cust=] — quotation list (F9 at Quote Ref)
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/drawRegQuotes', async (req, res) => {
    const cust = String(req.query.cust || '').trim();
    try {
      const [rows] = await db.query(
        `SELECT a.QUOT_NO, DATE_FORMAT(a.QUOT_DATE, '%d/%m/%Y') AS QUOT_DATE,
                a.CUST_CODE, b.CUST_NAME, a.PROJECT_NAME
           FROM quot_hdr a
           LEFT JOIN cus_mst b ON b.CUST_CODE = a.CUST_CODE
          ${cust ? 'WHERE a.CUST_CODE = ?' : ''}
          ORDER BY a.QUOT_DATE DESC, a.QUOT_NO DESC
          LIMIT 5000`,
        cust ? [cust] : []
      );
      res.json(rows);
    } catch (err) { sendErr(res, 'drawRegQuotes', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/drawRegQuote?quot= — one quotation, its jobs and its line items
  //   quote  quot_hdr + customer name
  //   jobs   job_card rows whose QUOT_REF is this quotation
  //   items  quot_item lines → the panel grid
  // Query string, not a path segment: revision numbers carry a '/'.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/drawRegQuote', async (req, res) => {
    const quot = String(req.query.quot || '').trim();
    if (!quot) return res.status(400).json({ message: 'Quotation number is required' });
    try {
      const [[qRows], [jRows], [iRows]] = await Promise.all([
        db.query(
          `SELECT a.QUOT_NO, DATE_FORMAT(a.QUOT_DATE, '%d/%m/%Y') AS QUOT_DATE,
                  a.CUST_CODE, b.CUST_NAME, a.PROJECT_NAME
             FROM quot_hdr a
             LEFT JOIN cus_mst b ON b.CUST_CODE = a.CUST_CODE
            WHERE a.QUOT_NO = ? LIMIT 1`,
          [quot]
        ),
        db.query(
          `SELECT JOB_NO, PROJ_NAME, CUST_CODE FROM job_card
            WHERE TRIM(QUOT_REF) = ? ORDER BY JOB_NO DESC`,
          [quot]
        ),
        db.query(
          `SELECT SR_NO, ITEM_CODE, ITEM_NAME, QTY, UNIT
             FROM quot_item
            WHERE QUOT_NO = ?
            ORDER BY COALESCE(MAIN_SR_NO, 0), CAST(SR_NO AS UNSIGNED), SR_NO, temp_sr`,
          [quot]
        ),
      ]);
      res.json({
        quote: qRows[0] || null,
        jobs: jRows,
        items: iRows.map((r) => ({
          QUOT_SR_NO: r.SR_NO ? String(r.SR_NO).trim() : null,
          ITEM_CODE: r.ITEM_CODE || null,
          QTY: r.QTY == null ? null : Number(r.QTY),
          UNIT: r.UNIT || null,
          PANEL_DETAILS: r.ITEM_NAME ? String(r.ITEM_NAME).trim() : '',
        })),
      });
    } catch (err) { sendErr(res, 'drawRegQuote', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getDrawRegById/:id — header + panels by srno_row_id
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getDrawRegById/:id', async (req, res) => {
    const rowId = Number(req.params.id) || 0;
    if (!rowId) return res.status(400).json({ message: 'Record id is required' });
    try {
      const [rows] = await db.query(`SELECT ${HDR_COLS} FROM drawing_register WHERE srno_row_id = ?`, [rowId]);
      if (!rows.length) return res.status(404).json({ message: 'Drawing not found' });
      res.json(await withPanels(rows));
    } catch (err) { sendErr(res, 'getDrawRegById', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getDrawReg/:drawingNo[?id=] — old links by drawing number.
  // Finds the header by its own number or by any of its panels' numbers.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getDrawReg/:drawingNo', async (req, res) => {
    const { drawingNo } = req.params;
    const rowId = Number(req.query.id) || 0;
    try {
      const [rows] = await db.query(
        `SELECT ${HDR_COLS} FROM drawing_register
          WHERE ${rowId ? 'srno_row_id = ?' : `DRAWING_NO = ?
             OR srno_row_id IN (SELECT HDR_ROW_ID FROM drawing_reg_panel WHERE DRAWING_NO = ?)`}
          ORDER BY srno_row_id`,
        rowId ? [rowId] : [drawingNo, drawingNo]
      );
      if (!rows.length) return res.status(404).json({ message: 'Drawing not found' });
      res.json(await withPanels(rows));
    } catch (err) { sendErr(res, 'getDrawReg', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/getDrawRegList — recent headers
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getDrawRegList', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT srno_row_id, SL_NO, DRAWING_NO, DRAW_DATE, JOB_NO, PROJECT_NAME, CLIENT_NAME, CUST_CODE, QUOTE_REF
           FROM drawing_register ORDER BY srno_row_id DESC LIMIT 200`
      );
      res.json(rows);
    } catch (err) { sendErr(res, 'getDrawRegList', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/saveDrawReg — new drawing set.
  //   body: header fields + panels: [{ PANEL_DETAILS, QTY, REV_NO, ASSIGN, QUOT_SR_NO, ITEM_CODE }]
  //   Under the lock: serial → header DRAWING_NO (AHS/MMYY/serial) → INSERT
  //   header → SL_NO → ticked panels numbered (header no, then -1, -2 …).
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/saveDrawReg', async (req, res) => {
    const b = req.body || {};
    if (!b.DRAW_DATE) return res.status(400).json({ message: 'Draw Date is required to generate Drawing No' });
    const panels = cleanPanels(b.panels);
    if (!panels.length) return res.status(400).json({ message: 'At least one panel is required' });

    try {
      const out = await withNumberLock(async (conn) => {
        const serial = await nextDrawSerial(conn);
        const base = `AHS/${getMMYY(b.DRAW_DATE)}/${serial}`;
        const h = hdrValues(b);

        const [ins] = await conn.query(
          `INSERT INTO drawing_register
             (DRAWING_NO, DRAW_DATE, CLIENT_NAME, CUST_CODE, PROJECT_NAME, QUOTE_REF,
              COMPUTER_LOCATION, DRAWN_NAME, PANEL_REF, DATE_OF_SUBM, EXT_REV, JOB_NO, APPROVAL_DATE)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [base, h.DRAW_DATE, h.CLIENT_NAME, h.CUST_CODE, h.PROJECT_NAME, h.QUOTE_REF,
            h.COMPUTER_LOCATION, h.DRAWN_NAME, cut(panels[0].PANEL_DETAILS, 60), h.DATE_OF_SUBM,
            panels[0].REV_NO, h.JOB_NO, h.APPROVAL_DATE]
        );
        const rowId = ins.insertId;
        const slNo = String(rowId).padStart(5, '0');
        await conn.query(`UPDATE drawing_register SET SL_NO = ? WHERE srno_row_id = ?`, [slNo, rowId]);

        panels.forEach((p) => { p.DRAWING_NO = ''; });   // new set: numbers come only from here
        await assignNumbers(conn, rowId, base, panels);
        await writePanels(conn, rowId, panels);

        return { srno_row_id: rowId, SL_NO: slNo, DRAWING_NO: base, panels };
      });
      res.json({ message: 'Saved', ...out });
    } catch (err) { sendErr(res, 'saveDrawReg', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /api/updateDrawReg/:drawingNo — update a drawing set (by srno_row_id).
  //   Header DRAWING_NO never changes. Panels keep the numbers they have; a
  //   panel ticked now gets the next number (header no if still free, else
  //   the next free suffix).
  //   Removed panels are deleted. An old single-panel record gets its panel
  //   row written here for the first time, keeping its existing number.
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/updateDrawReg/:drawingNo', async (req, res) => {
    const b = req.body || {};
    const rowId = Number(b.srno_row_id) || 0;
    if (!rowId) return res.status(400).json({ message: 'Record id (srno_row_id) is required' });
    const panels = cleanPanels(b.panels);
    if (!panels.length) return res.status(400).json({ message: 'At least one panel is required' });

    try {
      const out = await withNumberLock(async (conn) => {
        const [[hdr]] = await conn.query(`SELECT DRAWING_NO FROM drawing_register WHERE srno_row_id = ?`, [rowId]);
        if (!hdr) { const e = new Error('Drawing not found'); e.status = 404; throw e; }

        // numbers already issued stay; newly ticked panels get the next ones
        await assignNumbers(conn, rowId, hdr.DRAWING_NO, panels);

        const h = hdrValues(b);
        await conn.query(
          `UPDATE drawing_register SET
             DRAW_DATE = ?, JOB_NO = ?, PROJECT_NAME = ?, CLIENT_NAME = ?, CUST_CODE = ?,
             QUOTE_REF = ?, DATE_OF_SUBM = ?, DRAWN_NAME = ?, COMPUTER_LOCATION = ?, APPROVAL_DATE = ?,
             PANEL_REF = ?, EXT_REV = ?
           WHERE srno_row_id = ?`,
          [h.DRAW_DATE, h.JOB_NO, h.PROJECT_NAME, h.CLIENT_NAME, h.CUST_CODE,
            h.QUOTE_REF, h.DATE_OF_SUBM, h.DRAWN_NAME, h.COMPUTER_LOCATION, h.APPROVAL_DATE,
            cut(panels[0].PANEL_DETAILS, 60), panels[0].REV_NO, rowId]
        );
        await writePanels(conn, rowId, panels);
        return { srno_row_id: rowId, DRAWING_NO: hdr.DRAWING_NO, panels };
      });
      res.json({ message: 'Updated', ...out });
    } catch (err) { sendErr(res, 'updateDrawReg', err); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/deleteDrawReg/:drawingNo?id=<srno_row_id>
  // Panels go with the header (FK ON DELETE CASCADE).
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/deleteDrawReg/:drawingNo', async (req, res) => {
    const { drawingNo } = req.params;
    const rowId = Number(req.query.id) || 0;
    try {
      const [result] = await db.query(
        rowId
          ? `DELETE FROM drawing_register WHERE srno_row_id = ?`
          : `DELETE FROM drawing_register WHERE DRAWING_NO = ?`,
        [rowId || drawingNo]
      );
      if (result.affectedRows === 0) return res.status(404).json({ message: 'Drawing not found' });
      res.json({ message: 'Deleted', DRAWING_NO: drawingNo });
    } catch (err) { sendErr(res, 'deleteDrawReg', err); }
  });

  // Expose under both / and /api, whichever way HayatDb.js mounts it
  const mount = express.Router();
  mount.use('/api', router);
  mount.use('/', router);
  return mount;
};
