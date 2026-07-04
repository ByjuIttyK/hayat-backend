// ============================================================
// agents/agentPdcPayable.js  V3
// AI Agent: PDC Payable Realisation (Issued cheques)
//
// Table:    pdc_isu
// JV type:  tran_type = '14'
// Dr:       PDC_CODE = 201-002-0-001  — PDC Issued control
// Cr:       CHQ_BANK (or default 111-011-0-001) — Bank A/c
// Update:   REALISED='Y', JV_NO_RLZ=vchr_no(14), JV_DATE_RLZ=asOnDate
// ============================================================
'use strict';
const dayjs = require('dayjs');

const TRAN_TYPE        = '14';
const DEFAULT_BANK     = '111-011-0-001';   // RAK Bank AED — CHQ_BANK default
const DEFAULT_PDC_ISU  = '201-002-0-001';   // PDC Issued control account

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
async function previewPdcPayable(db, params) {
  const { asOnDate } = params;

  const [cheques] = await db.query(
    `SELECT
       p.TRAN_TYPE, p.VCHR_NO, p.CHQ_NO,
       p.CHQ_DATE, p.CHQ_BANK, p.PDC_CODE,
       p.SUP_CODE, s.SUP_NAME,
       p.AMOUNT, p.NARRATION
     FROM   pdc_isu p
     LEFT JOIN SUP_MST s ON s.SUP_CODE = p.SUP_CODE
     WHERE  (p.REALISED IS NULL OR p.REALISED != 'Y')
     AND    DATE(p.CHQ_DATE) <= ?
     ORDER  BY p.CHQ_DATE, p.SUP_CODE`,
    [asOnDate]
  );

  if (!cheques.length) {
    return {
      found: 0, totalAmount: 0, cheques: [],
      message: `No unrealised PDC issued cheques found up to ${asOnDate}.`,
    };
  }

  const totalAmount = cheques.reduce((s, r) => s + Number(r.AMOUNT || 0), 0);

  // ── Provisional JV numbers for display only ──────────────────
  // NOTE: not reserved — actual number assigned at confirm time.
  const startingJvNo = parseInt(await getNextVchrNo(db, TRAN_TYPE), 10);

  return {
    found:       cheques.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    asOnDate,
    cheques: cheques.map((r, idx) => ({
      tranType:  r.TRAN_TYPE,
      vchrNo:    r.VCHR_NO,
      chqNo:     r.CHQ_NO,
      chqDate:   r.CHQ_DATE ? dayjs(r.CHQ_DATE).format('DD/MM/YYYY') : '',
      // Dr P.D.C. Payable A/c — fixed control account, always this
      pdcAcc:    DEFAULT_PDC_ISU,
      drAcc:     DEFAULT_PDC_ISU,        // alias for clearer UI column naming
      drAccHead: 'P.D.C. PAYABLE A/C',
      // Cr Bank: CHQ_BANK or default RAK Bank
      bankAcc:   (r.CHQ_BANK && r.CHQ_BANK.trim()) ? r.CHQ_BANK.trim() : DEFAULT_BANK,
      // Provisional only — actual number assigned at confirm time
      proposedJvNo: String(startingJvNo + idx).padStart(10, '0'),
      supCode:   r.SUP_CODE,
      supName:   r.SUP_NAME || r.SUP_CODE || '—',
      amount:    Number(r.AMOUNT || 0),
      narration: r.NARRATION || '',
    })),
    message: `Found ${cheques.length} unrealised PDC issued cheque(s) totalling `
      + `AED ${totalAmount.toLocaleString('en-AE', { minimumFractionDigits: 2 })}. `
      + `Ready to post ${cheques.length} Realisation JV(s) (Tran Type 14).`,
  };
}

// ── CONFIRM ───────────────────────────────────────────────────
async function confirmPdcPayable(db, params, preview, runId, confirmedBy) {
  const { asOnDate } = params;
  // Realisation date from screen (passed via params)
  const jvDate = dayjs(asOnDate).format('YYYY-MM-DD');
  const posted = [], errors = [];

  for (const chq of preview.cheques) {
    try {
      // JV_NO_RLZ = next vchr_no under tran_type 14
      const jvNo = await getNextVchrNo(db, TRAN_TYPE);

      const narr = `PDC Isu Realised Chq ${chq.chqNo} ${chq.supName}`.substring(0, 80);

      // Dr PDC_CODE (201-002-0-001), Cr CHQ_BANK (111-011-0-001)
      await db.query(
        `INSERT INTO tran_acc
           (TRAN_TYPE, vchr_no, DATTE, SR_NO,
            ACC_CODE, AMOUNT, DB_CR, NARRATION1, USERNAME)
         VALUES
           (?, ?, ?, '1', ?, ?, 'D', ?, ?),
           (?, ?, ?, '2', ?, ?, 'C', ?, ?)`,
        [
          TRAN_TYPE, jvNo, jvDate,
          chq.pdcAcc,  chq.amount, narr, confirmedBy,   // Dr PDC Issued control
          TRAN_TYPE, jvNo, jvDate,
          chq.bankAcc, chq.amount, narr, confirmedBy,   // Cr Bank
        ]
      );

      // Mark realised — JV_NO_RLZ = jvNo (tran_type 14), JV_DATE_RLZ = realisation date
      await db.query(
        `UPDATE pdc_isu
         SET    REALISED    = 'Y',
                JV_NO_RLZ   = ?,
                JV_DATE_RLZ = ?
         WHERE  TRAN_TYPE = ?
         AND    VCHR_NO   = ?
         AND    CHQ_NO    = ?`,
        [jvNo, jvDate, chq.tranType, chq.vchrNo, chq.chqNo]
      );

      posted.push({ chqNo: chq.chqNo, supName: chq.supName,
        amount: chq.amount, jvNo, pdcAcc: chq.pdcAcc, bankAcc: chq.bankAcc });

    } catch (err) {
      console.error(`agentPdcPayable: chq ${chq.chqNo}:`, err.message);
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
      : `✓ Realised ${posted.length} PDC issued cheque(s) totalling `
        + `AED ${totalPosted.toLocaleString('en-AE', { minimumFractionDigits: 2 })} `
        + `via Tran Type 14 JVs.`,
  };
}

module.exports = { previewPdcPayable, confirmPdcPayable };
