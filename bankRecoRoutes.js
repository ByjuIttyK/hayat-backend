/**
 * bankRecoRoutes.js
 * Express routes for Bank Reconciliation save operations + InfoGrid list.
 * All child tables are linked by BANK_ST_NO (the statement header number).
 *
 * Mount in HayatDb.js:
 *   const bnkRecoRoutes = require('./bankRecoRoutes');
 *   app.use('/api', bnkRecoRoutes);
 *
 * ─── Numbering ────────────────────────────────────────────────────────────────
 *  The SERVER assigns ST_NO (BST-YYYY-NNN) in /bank-st-hdr/save when the screen
 *  sends a blank ST_NO. MAX+1 + plain INSERT; the PK on ST_NO catches a clash
 *  from another user and the save retries. The screen then uses the returned
 *  ST_NO for the four child saves. A non-blank ST_NO = re-save of that header.
 *
 * ─── MySQL Table DDL ──────────────────────────────────────────────────────────
 *
 *  bank_st_hdr  — header for one complete statement + reco run
 *    ST_NO PK, RECO_DATE, BANK_CODE, BANK_NAME, FROM_DATE, TO_DATE,
 *    ST_OP_BAL, ST_CL_BAL, GL_DR_TOTAL, GL_CR_TOTAL,
 *    D_NIL_TOTAL, W_NIL_TOTAL, ARRIVED_BAL, VARIANCE,
 *    RECO_STATUS, GL_ROWS, MATCHED_ROWS, BANK_ROWS,
 *    CREATED_BY, REMARKS
 *
 *  bank_st  — statement lines (needs BANK_ST_NO; see bank_st_alter.sql)
 *    ST_NO PK  (= <BANK_ST_NO>-<nnn>, e.g. BST-2026-002-001),
 *    BANK_ST_NO, BANK_ACCOUNT, TXN_DATE, CHQ_TXN_NO, DESCRIPTION,
 *    DEBIT, CREDIT, BALANCE
 *
 *  gl_bank_txn_link
 *    srno_row_id PK, TRAN_TYPE, VCHR_NO, GL_ROW_ID, GL_CHQ_NO,
 *    CHQ_BANKTXN_NO, CHQ_BANKTXN_DATE, BANK_ST_NO
 *    UNIQUE (BANK_ST_NO, GL_ROW_ID) — one row per G/L cheque line
 *
 *  bank_nil_deposit    (BANK_ST_NO, SR_NO) PK — D.NIL lines
 *  bank_nil_withdrawal (BANK_ST_NO, SR_NO) PK — W.NIL lines
 */

const express    = require('express');
const router     = express.Router();
const connection = require('./db/connection'); // mysql2 pool

// ── helper: run query returning a promise ─────────────────────────────────────
const query = (sql, params) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (err, result) =>
      err ? reject(err) : resolve(result)));

const pad3 = (n) => String(n).padStart(3, '0');

// Next BST-<year>-nnn from bank_st_hdr (MAX+1). Used by the save and by the ADD-screen preview.
const nextStNo = async (year) => {
  const prefix = `BST-${year}-`;
  const r = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(ST_NO, ?) AS UNSIGNED)), 0) + 1 AS nxt
       FROM bank_st_hdr WHERE ST_NO LIKE ?`,
    [prefix.length + 1, `${prefix}%`]);
  return `${prefix}${pad3(r[0].nxt)}`;
};
const cut  = (s, n) => (s === null || s === undefined ? null : String(s).substring(0, n));

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bank-st-hdr/save
// Body: { hdr: BankStHdr }   hdr.ST_NO blank → new number assigned here
// Returns { saved, ST_NO, RECO_STATUS }
// ════════════════════════════════════════════════════════════════════════════
router.post('/bank-st-hdr/save', async (req, res) => {
  const { hdr } = req.body || {};
  if (!hdr || !hdr.BANK_CODE)
    return res.status(400).json({ error: 'hdr.BANK_CODE is required' });

  const cols = `
        ST_NO, RECO_DATE, BANK_CODE, BANK_NAME,
        FROM_DATE, TO_DATE,
        ST_OP_BAL, ST_CL_BAL,
        GL_DR_TOTAL, GL_CR_TOTAL,
        D_NIL_TOTAL, W_NIL_TOTAL,
        ARRIVED_BAL, VARIANCE, RECO_STATUS,
        GL_ROWS, MATCHED_ROWS, BANK_ROWS,
        CREATED_BY, REMARKS`;
  const vals = (stNo) => [
    stNo,            hdr.RECO_DATE,    hdr.BANK_CODE,    hdr.BANK_NAME,
    hdr.FROM_DATE,   hdr.TO_DATE,
    hdr.ST_OP_BAL,   hdr.ST_CL_BAL,
    hdr.GL_DR_TOTAL, hdr.GL_CR_TOTAL,
    hdr.D_NIL_TOTAL, hdr.W_NIL_TOTAL,
    hdr.ARRIVED_BAL, hdr.VARIANCE,     hdr.RECO_STATUS,
    hdr.GL_ROWS,     hdr.MATCHED_ROWS, hdr.BANK_ROWS,
    hdr.CREATED_BY,  hdr.REMARKS,
  ];
  const ph = '?,'.repeat(20).slice(0, -1);

  try {
    // ── Re-save of an existing reconciliation ──
    if (hdr.ST_NO) {
      await query(`REPLACE INTO bank_st_hdr (${cols}) VALUES (${ph})`, vals(hdr.ST_NO));
      return res.json({ saved: true, ST_NO: hdr.ST_NO, RECO_STATUS: hdr.RECO_STATUS });
    }

    // ── New reconciliation: MAX+1 within the year, retry on PK clash ──
    const year = String(hdr.RECO_DATE || '').slice(0, 4) || String(new Date().getFullYear());
    for (let attempt = 1; attempt <= 3; attempt++) {
      const stNo = await nextStNo(year);
      try {
        await query(`INSERT INTO bank_st_hdr (${cols}) VALUES (${ph})`, vals(stNo));
        return res.json({ saved: true, ST_NO: stNo, RECO_STATUS: hdr.RECO_STATUS });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY' && attempt < 3) continue;   // another user took it
        throw e;
      }
    }
  } catch (err) {
    console.error('bank-st-hdr/save error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bank-statement/save
// Body: { bankStNo, rows: BankStRow[] }
// Line key = <bankStNo>-<nnn>; delete-then-insert so a re-save is clean.
// (Previously every statement used BST-YYYY-001… and INSERT IGNORE silently
//  dropped all lines after the first statement.)
// ════════════════════════════════════════════════════════════════════════════
router.post('/bank-statement/save', async (req, res) => {
  const { bankStNo, rows } = req.body || {};
  if (!bankStNo)
    return res.status(400).json({ error: 'bankStNo is required' });
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  const data = rows.map((r, i) => [
    `${bankStNo}-${pad3(i + 1)}`,
    bankStNo,
    r.BANK_ACCOUNT, r.TXN_DATE,
    r.CHQ_TXN_NO, cut(r.DESCRIPTION || '', 300),
    r.DEBIT, r.CREDIT, r.BALANCE,
  ]);

  try {
    await query('DELETE FROM bank_st WHERE BANK_ST_NO = ?', [bankStNo]);
    await query(
      `INSERT INTO bank_st
         (ST_NO, BANK_ST_NO, BANK_ACCOUNT, TXN_DATE, CHQ_TXN_NO, DESCRIPTION,
          DEBIT, CREDIT, BALANCE)
       VALUES ?`,
      [data]);
    res.json({ saved: data.length });
  } catch (err) {
    console.error('bank-statement/save error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/gl-bank-txn-link/save
// Body: { links: GlBankTxnLink[] }
// One link row per matched G/L CHEQUE line (GL_ROW_ID from v_bank_reco_lines).
// Delete-then-insert (one multi-row INSERT — all rows or none).
// ════════════════════════════════════════════════════════════════════════════
router.post('/gl-bank-txn-link/save', async (req, res) => {
  const { links } = req.body || {};
  if (!Array.isArray(links) || links.length === 0)
    return res.status(400).json({ error: 'No links provided' });

  const bankStNo = links[0].BANK_ST_NO;
  const rows = links.map(l => [
    l.TRAN_TYPE,
    l.VCHR_NO,
    l.GL_ROW_ID || `${l.TRAN_TYPE}-${l.VCHR_NO}-${l.CHQ_BANKTXN_NO}`,
    l.GL_CHQ_NO || null,
    l.CHQ_BANKTXN_NO,
    l.CHQ_BANKTXN_DATE,
    bankStNo,
  ]);

  try {
    await query('DELETE FROM gl_bank_txn_link WHERE BANK_ST_NO = ?', [bankStNo]);
    await query(
      `INSERT INTO gl_bank_txn_link
         (TRAN_TYPE, VCHR_NO, GL_ROW_ID, GL_CHQ_NO, CHQ_BANKTXN_NO, CHQ_BANKTXN_DATE, BANK_ST_NO)
       VALUES ?`,
      [rows]);
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('gl-bank-txn-link/save error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bank-nil-deposit/save      Body: { rows: BankNilDepositRow[] }
// POST /api/bank-nil-withdrawal/save   Body: { rows: BankNilWithdrawalRow[] }
// ════════════════════════════════════════════════════════════════════════════
router.post('/bank-nil-deposit/save', async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  try {
    const bankStNo = rows[0].BANK_ST_NO;
    await query('DELETE FROM bank_nil_deposit WHERE BANK_ST_NO = ?', [bankStNo]);
    await query(
      `INSERT INTO bank_nil_deposit
         (BANK_ST_NO, SR_NO, TXN_DATE, CHQ_TXN_NO, DESCRIPTION, CREDIT)
       VALUES ?`,
      [rows.map(r => [r.BANK_ST_NO, r.SR_NO, r.TXN_DATE, r.CHQ_TXN_NO, cut(r.DESCRIPTION || '', 200), r.CREDIT])]);
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('bank-nil-deposit/save error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

router.post('/bank-nil-withdrawal/save', async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  try {
    const bankStNo = rows[0].BANK_ST_NO;
    await query('DELETE FROM bank_nil_withdrawal WHERE BANK_ST_NO = ?', [bankStNo]);
    await query(
      `INSERT INTO bank_nil_withdrawal
         (BANK_ST_NO, SR_NO, TXN_DATE, CHQ_TXN_NO, DESCRIPTION, DEBIT)
       VALUES ?`,
      [rows.map(r => [r.BANK_ST_NO, r.SR_NO, r.TXN_DATE, r.CHQ_TXN_NO, cut(r.DESCRIPTION || '', 200), r.DEBIT])]);
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('bank-nil-withdrawal/save error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /bankreco-next-no   → { ST_NO }  preview of the number the next ADD save will get.
// Display only — the real number is still assigned in /bank-st-hdr/save, so two
// users opening ADD together both see the same preview; the second save gets +1.
// ════════════════════════════════════════════════════════════════════════════
router.get('/bankreco-next-no', async (req, res) => {
  try {
    res.json({ ST_NO: await nextStNo(String(new Date().getFullYear())) });
  } catch (err) {
    console.error('bankreco-next-no error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/bankreco-list?from=yyyy-mm-dd&to=yyyy-mm-dd   (both optional)
// InfoGrid list of saved reconciliations — newest first.
// Dates as dd/mm/yyyy for display; *_ISO copies kept for sorting/filtering.
// ════════════════════════════════════════════════════════════════════════════
router.get('/bankreco-list', async (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('TO_DATE >= ?');   params.push(from); }
  if (to)   { where.push('FROM_DATE <= ?'); params.push(to); }

  try {
    const rows = await query(
      `SELECT ST_NO,
              DATE_FORMAT(RECO_DATE,'%d/%m/%Y') AS RECO_DATE,
              BANK_CODE, BANK_NAME,
              DATE_FORMAT(FROM_DATE,'%d/%m/%Y') AS FROM_DATE,
              DATE_FORMAT(TO_DATE,'%d/%m/%Y')   AS TO_DATE,
              DATE_FORMAT(TO_DATE,'%Y-%m-%d')   AS TO_DATE_ISO,
              ST_OP_BAL, ST_CL_BAL, ARRIVED_BAL, VARIANCE, RECO_STATUS,
              GL_ROWS, MATCHED_ROWS, BANK_ROWS, CREATED_BY, REMARKS
         FROM bank_st_hdr
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY bank_st_hdr.TO_DATE DESC, ST_NO DESC`,
      params);
    res.json(rows);
  } catch (err) {
    console.error('bankreco-list error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /bankreco/:stNo   — open a saved reconciliation (EDIT / VIEW)
// Returns { hdr, lines, links }. The G/L side is reloaded live by the screen.
// ════════════════════════════════════════════════════════════════════════════
router.get('/bankreco/:stNo', async (req, res) => {
  const stNo = req.params.stNo;
  try {
    const hdr = await query(
      `SELECT ST_NO,
              DATE_FORMAT(RECO_DATE,'%Y-%m-%d') AS RECO_DATE,
              BANK_CODE, BANK_NAME,
              DATE_FORMAT(FROM_DATE,'%Y-%m-%d') AS FROM_DATE,
              DATE_FORMAT(TO_DATE,'%Y-%m-%d')   AS TO_DATE,
              ST_OP_BAL, ST_CL_BAL, RECO_STATUS, REMARKS
         FROM bank_st_hdr
        WHERE ST_NO = ?`,
      [stNo]);
    if (!hdr.length) return res.status(404).json({ error: `${stNo} not found` });

    const lines = await query(
      `SELECT ST_NO,
              DATE_FORMAT(TXN_DATE,'%Y-%m-%d') AS TXN_DATE,
              CHQ_TXN_NO, DESCRIPTION, DEBIT, CREDIT, BALANCE
         FROM bank_st
        WHERE BANK_ST_NO = ?
        ORDER BY ST_NO`,
      [stNo]);

    const links = await query(
      `SELECT GL_ROW_ID, CHQ_BANKTXN_NO,
              DATE_FORMAT(CHQ_BANKTXN_DATE,'%Y-%m-%d') AS CHQ_BANKTXN_DATE
         FROM gl_bank_txn_link
        WHERE BANK_ST_NO = ?`,
      [stNo]);

    res.json({ hdr: hdr[0], lines, links });
  } catch (err) {
    console.error('bankreco load error:', err);
    res.status(500).json({ error: err.sqlMessage || err.message });
  }
});

module.exports = router;
