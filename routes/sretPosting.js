// routes/sretPosting.js
// Sales Return (TRAN_TYPE '08') — G/L posting to tran_acc + invoice settlement in adj_dtl.
// Call postSret() INSIDE the save-sret transaction, after sret_hdr / sret items are written,
// so the posting commits or rolls back together with the return.
//
//   Dr  Sales A/c   (header Debit A/c, e.g. 4100-2533)   Gross Amount
//   Dr  VAT on Sales (300-001-0-001)                    VAT Amount
//   Cr  Customer    (Cust.Code)                         Net Amount
//   adj_dtl: return 08/<SretNo> settles invoice 06/<InvNo> for Net Amount
//
// `conn` must be a PROMISE connection that holds the open transaction.
// If save-sret uses a callback connection from connection.getConnection(),
// pass conn.promise() — it wraps the same connection, so the transaction is shared.

const TRAN_TYPE = "08";      // Sales Return
const INV_TYPE  = "06";      // Sales Invoice (STLD_TYPE of invoice settlements)
const VAT_ACC   = "300-001-0-001";   // VAT on Sales A/c

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const t  = (v) => String(v ?? "").trim();

/** Remove the previous posting of this return (EDIT) and give the invoice back its settled amount. */
async function unpostSret(conn, sretNo) {
  // 1. Reverse what the old settlement put on the invoice's customer line
  const [old] = await conn.query(
    `SELECT ACC_CODE, STLD_DOC, STLD_AMT
       FROM adj_dtl
      WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?`,
    [TRAN_TYPE, sretNo]
  );
  for (const o of old) {
    await conn.query(
      `UPDATE tran_acc
          SET AMT_SETTLED = GREATEST(IFNULL(AMT_SETTLED,0) - ?, 0)
        WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ? AND DB_CR = 'D'`,
      [r2(o.STLD_AMT), INV_TYPE, o.STLD_DOC, o.ACC_CODE]
    );
  }
  // 2. Delete the old settlement and the old voucher lines
  await conn.query(`DELETE FROM adj_dtl  WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?`, [TRAN_TYPE, sretNo]);
  await conn.query(`DELETE FROM tran_acc WHERE TRAN_TYPE  = ? AND vchr_no   = ?`, [TRAN_TYPE, sretNo]);
}

/**
 * @param conn  promise connection inside the save transaction
 * @param p     { sretNo, sretDate (yyyy-MM-dd), custCode, salesAcc, invNo, jobNo,
 *                grossAmt, vatAmt, roundOff, netAmt, narration, divCode }
 */
async function postSret(conn, p) {
  const sretNo   = t(p.sretNo);
  const custCode = t(p.custCode);
  const salesAcc = t(p.salesAcc);
  const invNo    = t(p.invNo);
  const net      = r2(p.netAmt);

  if (!sretNo)   throw new Error("Sales Return No missing for posting.");
  if (!custCode) throw new Error("Customer is required for posting.");
  if (!salesAcc) throw new Error("Debit A/c (Sales A/c) is required for posting.");
  if (!(net > 0)) throw new Error("Net Amount must be greater than zero.");

  // Current accounting period (single-row table)
  const [[per]] = await conn.query(`SELECT Main_sr_no FROM ac_period LIMIT 1`);
  const mainSrNo = per?.Main_sr_no ?? null;
  const divCode  = p.divCode ?? null;

  await unpostSret(conn, sretNo);

  const narr1 = t(p.narration) || `Sales Return ${sretNo}${invNo ? " against Inv " + invNo : ""}`;
  const narr2 = invNo ? `Inv No ${invNo}` : null;

  // ── tran_acc ──
  //   Dr Sales A/c (4100-…)            Gross Amount (+ Round Off, so the voucher balances)
  //   Dr VAT on Sales (300-001-0-001)  VAT Amount
  //   Cr Customer                      Net Amount
  const vat   = r2(p.vatAmt);
  const round = r2(p.roundOff);
  const gross = r2(p.grossAmt);
  if (Math.abs(r2(gross + vat + round) - net) > 0.01) {
    throw new Error(`Amounts don't agree: Gross ${gross} + VAT ${vat} + Round Off ${round} ≠ Net ${net}.`);
  }
  const salesDr = r2(net - vat);                 // = Gross + Round Off

  const ins = `INSERT INTO tran_acc
      (TRAN_TYPE, vchr_no, DATTE, SR_NO, ACC_CODE, AMOUNT, DB_CR,
       NARRATION1, NARRATION2, AMT_SETTLED, JOB_NO, REF_NO, DIV_CODE, MAIN_SR_NO)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const jobNo = t(p.jobNo) || null;
  let srNo = 0;
  const line = (acc, amt, dbcr, settled = 0) =>
    conn.query(ins, [
      TRAN_TYPE, sretNo, p.sretDate, ++srNo, acc, amt, dbcr,
      narr1, narr2, settled, jobNo, invNo || null, divCode, mainSrNo,
    ]);

  if (salesDr !== 0) await line(salesAcc, salesDr, "D");
  if (vat !== 0)     await line(VAT_ACC, vat, "D");
  await line(custCode, net, "C", invNo ? net : 0);

  // ── adj_dtl: settle the invoice with the Net Amount ──
  if (invNo) {
    // STLD_DATE = the settled invoice's own date (fab_inv_hdr.INV_DATE)
    const [invRows] = await conn.query(
      `SELECT INV_DATE FROM fab_inv_hdr WHERE INV_NO = ? LIMIT 1`,
      [invNo]
    );
    if (!invRows.length || !invRows[0].INV_DATE) {
      throw new Error(`Invoice ${invNo} not found in fab_inv_hdr — cannot settle it.`);
    }
    const invDate = invRows[0].INV_DATE;

    await conn.query(
      `INSERT INTO adj_dtl
         (SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE, ACC_CODE,
          STLD_DOC, STLD_TYPE, STLD_AMT, STLD_DBCR, STLD_DATE,
          DIV_CODE, MAIN_SR_NO, REF_NO)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sretNo, TRAN_TYPE, p.sretDate, custCode,
       invNo, INV_TYPE, net, "C", invDate,
       divCode, mainSrNo, invNo]
    );
    // Invoice's customer (Dr) line now carries this settlement too
    await conn.query(
      `UPDATE tran_acc
          SET AMT_SETTLED = IFNULL(AMT_SETTLED,0) + ?
        WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ? AND DB_CR = 'D'`,
      [net, INV_TYPE, invNo, custCode]
    );
  }
}

/** Outstanding on an invoice for this customer, excluding this return's own settlement (for EDIT). */
async function invoiceOutstanding(conn, invNo, custCode, sretNo) {
  const [[inv]] = await conn.query(
    `SELECT IFNULL(SUM(AMOUNT),0) AS AMT FROM tran_acc
      WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ? AND DB_CR = 'D'`,
    [INV_TYPE, invNo, custCode]
  );
  const [[st]] = await conn.query(
    `SELECT IFNULL(SUM(STLD_AMT),0) AS AMT FROM adj_dtl
      WHERE STLD_TYPE = ? AND STLD_DOC = ? AND ACC_CODE = ?
        AND NOT (SOURCE_TYPE = ? AND SOURCE_DOC = ?)`,
    [INV_TYPE, invNo, custCode, TRAN_TYPE, t(sretNo)]
  );
  return r2(Number(inv.AMT) - Number(st.AMT));
}

module.exports = { postSret, unpostSret, invoiceOutstanding };
