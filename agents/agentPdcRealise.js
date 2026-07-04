// ============================================================
// agents/agentPdcRealise.js  V4
// AI Agent: PDC Receivable Realisation
//
// Table:    pdc_rcd
// JV type:  tran_type = '13'
// Dr:       Bank A/c — CHQ_BANK default, USER EDITABLE in preview
// Cr:       116-024-0-001  — P.D.C. RECEIVABLE A/C (fixed control account)
// Update:   REALISED='Y', JV_NO_RLZ=vchr_no(13), JV_DATE_RLZ=asOnDate
// ============================================================
'use strict';
const dayjs = require('dayjs');

const TRAN_TYPE          = '13';
const DEFAULT_BANK       = '111-011-0-001';   // RAK Bank AED — CHQ_BANK default
const PDC_RECEIVABLE_ACC = '116-024-0-001';   // P.D.C. RECEIVABLE A/C — always Cr

// ── Next voucher number from tran_acc ─────────────────────────
async function getNextVchrNo(db, tranType) {
  const [[row]] = await db.query(
    `SELECT MAX(vchr_no) AS MX FROM tran_acc
     WHERE TRAN_TYPE = ?
     AND   SUBSTR(vchr_no, 1, 1) < 'A'`,
    [tranType]
  );
  return String(parseInt(row?.MX || '0', 10) + 1).padStart(10, '0');
}

// ── PREVIEW ───────────────────────────────────────────────────
async function previewPdcRealise(db, params) {
  const { asOnDate } = params;

  const [cheques] = await db.query(
    `SELECT
       p.TRAN_TYPE, p.VCHR_NO, p.CHQ_NO,
       p.CHQ_DATE, p.CHQ_BANK,
       p.CUST_CODE, c.CUST_NAME,
       p.AMOUNT, p.NARRATION
     FROM   pdc_rcd p
     LEFT JOIN CUS_MST c ON c.CUST_CODE = p.CUST_CODE
     WHERE  (p.REALISED IS NULL OR p.REALISED != 'Y')
     AND    DATE(p.CHQ_DATE) <= ?
     ORDER  BY p.CHQ_DATE, p.CUST_CODE`,
    [asOnDate]
  );

  if (!cheques.length) {
    return {
      found: 0, totalAmount: 0, cheques: [],
      message: `No unrealised PDC receivable cheques found up to ${asOnDate}.`,
    };
  }

  const totalAmount = cheques.reduce((s, r) => s + Number(r.AMOUNT || 0), 0);

  // ── Provisional JV numbers for display only ──────────────────
  // NOTE: these are NOT reserved. If another user posts a tran_type 13
  // JV between preview and confirm, the actual number assigned at
  // confirm time may differ. UI must show this as "Proposed", not final.
  const startingJvNo = parseInt(await getNextVchrNo(db, TRAN_TYPE), 10);

  return {
    found:       cheques.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    asOnDate,
    defaultBank: DEFAULT_BANK,
    pdcAcc:      PDC_RECEIVABLE_ACC,
    cheques: cheques.map((r, idx) => ({
      tranType:  r.TRAN_TYPE,
      vchrNo:    r.VCHR_NO,
      chqNo:     r.CHQ_NO,
      chqDate:   r.CHQ_DATE ? dayjs(r.CHQ_DATE).format('DD/MM/YYYY') : '',
      // Dr Bank — editable by user, defaults to CHQ_BANK or RAK Bank
      bankAcc:   (r.CHQ_BANK && r.CHQ_BANK.trim()) ? r.CHQ_BANK.trim() : DEFAULT_BANK,
      // Cr P.D.C. Receivable A/c — fixed, not editable
      pdcAcc:    PDC_RECEIVABLE_ACC,
      crAcc:     PDC_RECEIVABLE_ACC,   // alias for clearer UI column naming
      crAccHead: 'P.D.C. RECEIVABLE A/C',
      // Provisional only — actual number assigned at confirm time
      proposedJvNo: String(startingJvNo + idx).padStart(10, '0'),
      custCode:  r.CUST_CODE,
      custName:  r.CUST_NAME || r.CUST_CODE || '—',
      amount:    Number(r.AMOUNT || 0),
      narration: r.NARRATION || '',
    })),
    message: `Found ${cheques.length} unrealised PDC receivable cheque(s) totalling `
      + `AED ${totalAmount.toLocaleString('en-AE', { minimumFractionDigits: 2 })}. `
      + `Review the bank account for each cheque, then post ${cheques.length} Realisation JV(s) (Tran Type 13).`,
  };
}

// ── CONFIRM ───────────────────────────────────────────────────
// preview.cheques may have been EDITED by the user on the frontend
// (bankAcc changed per row) before being sent back here.
async function confirmPdcRealise(db, params, preview, runId, confirmedBy) {
  const { asOnDate } = params;
  const jvDate = dayjs(asOnDate).format('YYYY-MM-DD');
  const posted = [], errors = [];

  for (const chq of preview.cheques) {
    try {
      const jvNo = await getNextVchrNo(db, TRAN_TYPE);

      // Use the (possibly user-edited) bank account for this cheque
      const bankAcc = (chq.bankAcc && chq.bankAcc.trim()) ? chq.bankAcc.trim() : DEFAULT_BANK;
      const pdcAcc  = PDC_RECEIVABLE_ACC;  // always fixed, never editable

      const narr = `PDC Recd Realised Chq ${chq.chqNo} ${chq.custName}`.substring(0, 80);

      // Dr Bank (user-selected), Cr P.D.C. Receivable A/c (fixed)
      await db.query(
        `INSERT INTO tran_acc
           (TRAN_TYPE, vchr_no, DATTE, SR_NO,
            ACC_CODE, AMOUNT, DB_CR, NARRATION1, USERNAME)
         VALUES
           (?, ?, ?, '1', ?, ?, 'D', ?, ?),
           (?, ?, ?, '2', ?, ?, 'C', ?, ?)`,
        [
          TRAN_TYPE, jvNo, jvDate,
          bankAcc, chq.amount, narr, confirmedBy,   // Dr Bank
          TRAN_TYPE, jvNo, jvDate,
          pdcAcc,  chq.amount, narr, confirmedBy,   // Cr P.D.C. Receivable
        ]
      );

      // Mark realised — JV_NO_RLZ = jvNo (tran_type 13), JV_DATE_RLZ = realisation date
      await db.query(
        `UPDATE pdc_rcd
         SET    REALISED    = 'Y',
                JV_NO_RLZ   = ?,
                JV_DATE_RLZ = ?
         WHERE  TRAN_TYPE = ?
         AND    VCHR_NO   = ?
         AND    CHQ_NO    = ?`,
        [jvNo, jvDate, chq.tranType, chq.vchrNo, chq.chqNo]
      );

      posted.push({ chqNo: chq.chqNo, custName: chq.custName,
        amount: chq.amount, jvNo, bankAcc });

    } catch (err) {
      console.error(`agentPdcRealise: chq ${chq.chqNo}:`, err.message);
      errors.push({ chqNo: chq.chqNo, error: err.message });
    }
  }

  const totalPosted = posted.reduce((s, r) => s + r.amount, 0);
  await db.query(
    `UPDATE agent_run_log
     SET STATUS=?, RESULT_JSON=?, CONFIRMED_BY=?, CONFIRMED_DT=NOW()
     WHERE ID=?`,
    [errors.length && !posted.length ? 'E' : 'C',
     JSON.stringify({ posted, errors, totalPosted }), confirmedBy, runId]
  );

  return {
    posted: posted.length, errors: errors.length,
    totalPosted: Math.round(totalPosted * 100) / 100,
    details: posted, errorDetails: errors,
    message: errors.length
      ? `Posted ${posted.length} JV(s). ${errors.length} error(s).`
      : `✓ Realised ${posted.length} PDC receivable cheque(s) totalling `
        + `AED ${totalPosted.toLocaleString('en-AE', { minimumFractionDigits: 2 })} `
        + `via Tran Type 13 JVs.`,
  };
}

module.exports = { previewPdcRealise, confirmPdcRealise };
