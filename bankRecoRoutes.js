/**
 * bankRecoRoutes.js
 * Express routes for Bank Reconciliation save operations.
 * All 4 tables are linked by BANK_ST_NO (the statement header number).
 *
 * Mount in HayatDb.js:
 *   const bankRecoRoutes = require('./bankRecoRoutes');
 *   app.use('/api', bankRecoRoutes);
 *
 * ─── MySQL Table DDL ──────────────────────────────────────────────────────────
 *
 *  bank_st_hdr (NEW — header for one complete statement + reco run)
 *    ST_NO PK, RECO_DATE, BANK_CODE, BANK_NAME, FROM_DATE, TO_DATE,
 *    ST_OP_BAL, ST_CL_BAL, GL_DR_TOTAL, GL_CR_TOTAL,
 *    D_NIL_TOTAL, W_NIL_TOTAL, ARRIVED_BAL, VARIANCE,
 *    RECO_STATUS, GL_ROWS, MATCHED_ROWS, BANK_ROWS,
 *    CREATED_BY, REMARKS
 *
 *  bank_st (already exists — from bank_st_DDL.sql)
 *    ST_NO PK, BANK_ACCOUNT, TXN_DATE, CHQ_TXN_NO, DESCRIPTION,
 *    DEBIT, CREDIT, BALANCE
 *
 *  gl_bank_txn_link (already exists)
 *    TRAN_TYPE, VCHR_NO, CHQ_BANKTXN_NO, CHQ_BANKTXN_DATE,
 *    BANK_ST_NO PK
 *
 *  CREATE TABLE bank_nil_deposit (
 *    BANK_ST_NO   VARCHAR(15) NOT NULL,
 *    SR_NO        INT         NOT NULL,
 *    TXN_DATE     DATE        NOT NULL,
 *    CHQ_TXN_NO   VARCHAR(30),
 *    DESCRIPTION  VARCHAR(200),
 *    CREDIT       DECIMAL(15,2) NOT NULL DEFAULT 0,
 *    PRIMARY KEY (BANK_ST_NO, SR_NO),
 *    INDEX idx_bnd_stno (BANK_ST_NO)
 *  );
 *
 *  CREATE TABLE bank_nil_withdrawal (
 *    BANK_ST_NO   VARCHAR(15) NOT NULL,
 *    SR_NO        INT         NOT NULL,
 *    TXN_DATE     DATE        NOT NULL,
 *    CHQ_TXN_NO   VARCHAR(30),
 *    DESCRIPTION  VARCHAR(200),
 *    DEBIT        DECIMAL(15,2) NOT NULL DEFAULT 0,
 *    PRIMARY KEY (BANK_ST_NO, SR_NO),
 *    INDEX idx_bnw_stno (BANK_ST_NO)
 *  );
 */

const express    = require('express');
const router     = express.Router();
const connection = require('./db/connection'); // adjust path to your mysql2 pool

// ── helper: run query returning a promise ─────────────────────────────────────
const query = (sql, params) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (err, result) =>
      err ? reject(err) : resolve(result)));

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bank-st-hdr/save
// Body: { hdr: BankStHdr }
// Saves the reconciliation header record.
// REPLACE INTO — safe to call again if user re-runs and re-saves.
// ════════════════════════════════════════════════════════════════════════════
router.post('/bank-st-hdr/save', async (req, res) => {
  const { hdr } = req.body;
  if (!hdr || !hdr.ST_NO)
    return res.status(400).json({ error: 'hdr.ST_NO is required' });

  try {
    const sql = `
      REPLACE INTO bank_st_hdr (
        ST_NO, RECO_DATE, BANK_CODE, BANK_NAME,
        FROM_DATE, TO_DATE,
        ST_OP_BAL, ST_CL_BAL,
        GL_DR_TOTAL, GL_CR_TOTAL,
        D_NIL_TOTAL, W_NIL_TOTAL,
        ARRIVED_BAL, VARIANCE, RECO_STATUS,
        GL_ROWS, MATCHED_ROWS, BANK_ROWS,
        CREATED_BY, REMARKS
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

    await query(sql, [
      hdr.ST_NO,       hdr.RECO_DATE,    hdr.BANK_CODE,    hdr.BANK_NAME,
      hdr.FROM_DATE,   hdr.TO_DATE,
      hdr.ST_OP_BAL,   hdr.ST_CL_BAL,
      hdr.GL_DR_TOTAL, hdr.GL_CR_TOTAL,
      hdr.D_NIL_TOTAL, hdr.W_NIL_TOTAL,
      hdr.ARRIVED_BAL, hdr.VARIANCE,     hdr.RECO_STATUS,
      hdr.GL_ROWS,     hdr.MATCHED_ROWS, hdr.BANK_ROWS,
      hdr.CREATED_BY,  hdr.REMARKS,
    ]);

    res.json({ saved: true, ST_NO: hdr.ST_NO, RECO_STATUS: hdr.RECO_STATUS });
  } catch (err) {
    console.error('bank-st-hdr/save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bank-statement/save
// Body: { rows: BankStRow[] }
// Inserts all PDF statement lines into bank_st.
// Uses INSERT IGNORE so re-saves are safe (ST_NO is PK).
// ════════════════════════════════════════════════════════════════════════════
router.post('/bank-statement/save', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  try {
    const sql = `
      INSERT IGNORE INTO bank_st
        (ST_NO, BANK_ACCOUNT, TXN_DATE, CHQ_TXN_NO, DESCRIPTION,
         DEBIT, CREDIT, BALANCE)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const r of rows) {
      await query(sql, [
        r.ST_NO, r.BANK_ACCOUNT, r.TXN_DATE,
        r.CHQ_TXN_NO,r.DESCRIPTION.substring(0, 300),
        r.DEBIT, r.CREDIT, r.BALANCE,
      ]);
    }
    res.json({ saved: rows.length, stNos: rows.map(r => r.ST_NO) });
  } catch (err) {
    console.error('bank-statement/save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/gl-bank-txn-link/save
// Body: { links: GlBankTxnLink[] }
// REPLACE INTO so re-running Auto Populate + Save refreshes the links.
// BANK_ST_NO is PK — one link row per matched bank transaction line.
// ════════════════════════════════════════════════════════════════════════════
router.post('/gl-bank-txn-link/save', async (req, res) => {
  const { links } = req.body;
  if (!Array.isArray(links) || links.length === 0)
    return res.status(400).json({ error: 'No links provided' });

  try {
    // Delete old links for this statement first (clean re-save)
    const bankStNo = links[0].BANK_ST_NO;
    await query(
      'DELETE FROM gl_bank_txn_link WHERE BANK_ST_NO = ?',
      [bankStNo]);

    const sql = `
      INSERT INTO gl_bank_txn_link
        (TRAN_TYPE, VCHR_NO, CHQ_BANKTXN_NO, CHQ_BANKTXN_DATE, BANK_ST_NO)
      VALUES (?, ?, ?, ?, ?)`;

    for (const lnk of links) {
      await query(sql, [
        lnk.TRAN_TYPE,
        lnk.VCHR_NO,
        lnk.CHQ_BANKTXN_NO,
        lnk.CHQ_BANKTXN_DATE,
        lnk.BANK_ST_NO,
      ]);
    }
    res.json({ saved: links.length });
  } catch (err) {
    console.error('gl-bank-txn-link/save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bank-nil-deposit/save
// Body: { rows: BankNilDepositRow[] }
// D.NIL — bank credit entries with no matching GL debit.
// Linked to statement by BANK_ST_NO.
// ════════════════════════════════════════════════════════════════════════════
router.post('/bank-nil-deposit/save', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  try {
    const bankStNo = rows[0].BANK_ST_NO;
    // Clean re-save
    await query(
      'DELETE FROM bank_nil_deposit WHERE BANK_ST_NO = ?',
      [bankStNo]);

    const sql = `
      INSERT INTO bank_nil_deposit
        (BANK_ST_NO, SR_NO, TXN_DATE, CHQ_TXN_NO, DESCRIPTION, CREDIT)
      VALUES (?, ?, ?, ?, ?, ?)`;

    for (const r of rows) {
      await query(sql, [
        r.BANK_ST_NO, r.SR_NO, r.TXN_DATE,
        r.CHQ_TXN_NO, r.DESCRIPTION.substring(0, 300), r.CREDIT,
      ]);
    }
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('bank-nil-deposit/save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bank-nil-withdrawal/save
// Body: { rows: BankNilWithdrawalRow[] }
// W.NIL — bank debit entries with no matching GL credit.
// Linked to statement by BANK_ST_NO.
// ════════════════════════════════════════════════════════════════════════════
router.post('/bank-nil-withdrawal/save', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  try {
    const bankStNo = rows[0].BANK_ST_NO;
    await query(
      'DELETE FROM bank_nil_withdrawal WHERE BANK_ST_NO = ?',
      [bankStNo]);

    const sql = `
      INSERT INTO bank_nil_withdrawal
        (BANK_ST_NO, SR_NO, TXN_DATE, CHQ_TXN_NO, DESCRIPTION, DEBIT)
      VALUES (?, ?, ?, ?, ?, ?)`;

    for (const r of rows) {
      await query(sql, [
        r.BANK_ST_NO, r.SR_NO, r.TXN_DATE,
        r.CHQ_TXN_NO, r.DESCRIPTION.substring(0, 300), r.DEBIT,
      ]);
    }
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('bank-nil-withdrawal/save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/bank-statement/next-prefix
// Returns the next BST-YYYY prefix and next sequence number.
// ════════════════════════════════════════════════════════════════════════════
router.get('/bank-statement/next-prefix', async (req, res) => {
  try {
    const year   = new Date().getFullYear();
    const prefix = `BST-${year}`;
    const rows   = await query(
      'SELECT COUNT(*) AS cnt FROM bank_st WHERE ST_NO LIKE ?',
      [`${prefix}-%`]);
    res.json({ prefix, nextSeq: (rows[0]?.cnt ?? 0) + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
