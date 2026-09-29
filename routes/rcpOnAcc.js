// routes/rcpOnAcc.js
// ─────────────────────────────────────────────────────────────────────────────
// On A/c Credit for Receipt Vouchers → rcp_on_acc
//
// Called from the /api/save-rcp route INSIDE its transaction, after the
// voucher number is final (allocated on ADD), so the RV and its on-account
// balance are committed or rolled back together.
//
//   DOC_NO     = RV number            DOC_TYPE  = RV tran type ('03' bank)
//   DOC_DATE   = RV date              CUST_CODE = Received From (customer)
//   AMOUNT     = On A/c Credit        DB_CR     = 'C'
//   STLD_AMT   = 0 (settled later)    STLD_TYPE = NULL
//   MAIN_SR_NO = Sr of the customer's credit line in the RV
//
// Rules
//  • amount > 0                → row written (replaces any earlier one)
//  • amount = 0                → row removed
//  • already partly settled    → amount may change but never below STLD_AMT,
//                                and the row is updated in place (keeps STLD_*)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {(sql: string, params: any[]) => Promise<any>} run  runs one statement
 *        on the save route's transaction connection and resolves with the
 *        result (rows for a SELECT). In saveRcpRoutes.js: (sql, p) => q(conn, sql, p)
 * @param {object} p
 * @param {string} p.vchrNo    RV number actually saved
 * @param {string} p.tranType  '03'
 * @param {string} p.vchrDate  'YYYY-MM-DD' (same value written to tran_acc)
 * @param {string} p.custCode
 * @param {number} p.amount    On A/c Credit from the screen
 * @param {number|null} p.mainSrNo
 */
async function saveRcpOnAcc(run, { vchrNo, tranType, vchrDate, custCode, amount, mainSrNo }) {
  const amt = Math.round((Number(amount) || 0) * 100) / 100;
  if (amt < 0) throw new Error('On A/c Credit cannot be negative — invoices settled exceed the amount received.');

  const rows = await run(
    `SELECT IFNULL(SUM(stld_amt),0) AS stld, COUNT(*) AS cnt
       FROM rcp_on_acc WHERE doc_no = ? AND doc_type = ?`,
    [vchrNo, tranType]
  );
  const stld = Number(rows[0]?.stld) || 0;

  if (stld > 0) {
    // Part of this on-account balance has already been used — keep the row
    // (and its STLD_* history), only let the amount move down to what is used.
    if (amt < stld) {
      throw new Error(
        `On A/c credit of RV ${vchrNo} is already settled for ${stld.toFixed(2)}; ` +
        `it cannot be reduced to ${amt.toFixed(2)}.`
      );
    }
    await run(
      `UPDATE rcp_on_acc
          SET amount = ?, doc_date = ?, cust_code = ?, main_sr_no = ?
        WHERE doc_no = ? AND doc_type = ?`,
      [amt, vchrDate, custCode, mainSrNo ?? null, vchrNo, tranType]
    );
    return;
  }

  await run(
    `DELETE FROM rcp_on_acc WHERE doc_no = ? AND doc_type = ?`,
    [vchrNo, tranType]
  );

  if (amt > 0) {
    await run(
      `INSERT INTO rcp_on_acc
         (doc_no, doc_type, doc_date, cust_code, amount, db_cr, stld_amt, stld_type, main_sr_no)
       VALUES (?, ?, ?, ?, ?, 'C', 0, NULL, ?)`,
      [vchrNo, tranType, vchrDate, custCode, amt, mainSrNo ?? null]
    );
  }
}

/** For RV delete/cancel: refuse if its on-account credit has been used. */
async function deleteRcpOnAcc(run, { vchrNo, tranType }) {
  const rows = await run(
    `SELECT IFNULL(SUM(stld_amt),0) AS stld FROM rcp_on_acc WHERE doc_no = ? AND doc_type = ?`,
    [vchrNo, tranType]
  );
  if (Number(rows[0]?.stld) > 0) {
    throw new Error(`RV ${vchrNo}: its On A/c credit is already settled — cancel those settlements first.`);
  }
  await run(`DELETE FROM rcp_on_acc WHERE doc_no = ? AND doc_type = ?`, [vchrNo, tranType]);
}

module.exports = { saveRcpOnAcc, deleteRcpOnAcc };
