// services/glPostingService.js

async function postToTranAcc(payload, conn) {
  console.log('postToTranAcc payload:', JSON.stringify(payload, null, 2));
  const {
    ModuleName,
    InvNo,
    Narr1 = null,
    Narr2 = null,
    Date: invDate,
    JobNo = null,
    PanelNo = null,
    PartyName = null
  } = payload;

  if (!ModuleName) {
    throw new Error("Missing 'ModuleName' in request payload.");
  }

  // Helper function to wrap conn.query in a Promise for smooth await execution
  const queryAsync = (sql, params) => {
    return new Promise((resolve, reject) => {
      conn.query(sql, params, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });
  };

  // 1. Fetch posting rules for the active module
  const rules = await queryAsync(
    `SELECT * FROM acc_posting_setup WHERE MODULE_NAME = ?`,
    [ModuleName]
  );

  if (!rules || rules.length === 0) {
    throw new Error(`No GL posting setup found for Module: ${ModuleName}`);
  }

  // Optional line order: the caller may pass FieldOrder, a list of FIELD_NAMEs
  // in the order the lines should get SR_NO 1, 2, 3 … Rules not in the list
  // keep their table order and come after the listed ones. Modules that don't
  // pass FieldOrder post exactly as before (acc_posting_setup order).
  const order = Array.isArray(payload.FieldOrder) ? payload.FieldOrder : null;
  if (order && order.length) {
    const pos = (f) => {
      const i = order.indexOf(f);
      return i === -1 ? order.length : i;
    };
    rules.sort((a, b) => pos(a.FIELD_NAME) - pos(b.FIELD_NAME)); // stable sort
  }

  const tranType = rules[0].TRAN_TYPE;

  // 2. Clear old GL records for this voucher to support updates safely
  await queryAsync(
    `DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,
    [tranType, InvNo]
  );

  let srNo = 1;
  // Totals kept in fils (integers): adding floating-point amounts drifts in the
  // last digits (2091.35 + 104.57 ≠ 2195.92 exactly), which tripped the
  // balance check on vouchers whose Dr and Cr were in fact equal.
  let totalDebitFils = 0;
  let totalCreditFils = 0;
  const toFils = (v) => Math.round((Number(v) || 0) * 100);

  // 3. Process rules and insert ledger entries
  for (const rule of rules) {
    console.log("Field name=>", rule.FIELD_NAME)
    // Each line rounded to 2 decimals — the precision tran_acc.AMOUNT stores —
    // so the lines written are exactly the lines checked for balance.
    const fils = toFils(payload[rule.FIELD_NAME]);
    const amount = fils / 100;
    console.log("Field value", payload[rule.FIELD_NAME], "→", amount);
    if (fils === 0) continue; // Skip zero-amount lines

    // Resolve dynamic vs static GL account code
    const accCode = rule.ACC_CODE_FIELD ? payload[rule.ACC_CODE_FIELD] : rule.ACC_CODE;

    if (!accCode) {
      throw new Error(`Missing Account Code for Entry Type: ${rule.ENTRY_TYPE}`);
    }
    const nar1 = rule.ACC_CODE_FIELD ? Narr1 : PartyName;

    if (rule.DB_CR === 'D') totalDebitFils += fils;
    if (rule.DB_CR === 'C') totalCreditFils += fils;

    await queryAsync(
      `INSERT INTO tran_acc 
       (TRAN_TYPE, VCHR_NO, DATTE, SR_NO, ACC_CODE, NARRATION1, NARRATION2, AMOUNT, DB_CR, JOB_NO, PANEL_NO) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule.TRAN_TYPE,
        InvNo,
        invDate,
        srNo++,
        accCode,
        nar1,
        Narr2,
        amount,
        rule.DB_CR,
        JobNo,
        PanelNo
      ]
    );
  }

  // 4. Double-Entry Balance Check
  if (totalDebitFils !== totalCreditFils) {
    const dr = (totalDebitFils / 100).toFixed(2);
    const cr = (totalCreditFils / 100).toFixed(2);
    const diff = ((totalDebitFils - totalCreditFils) / 100).toFixed(2);
    console.log('not tally', dr, cr, diff);
    throw new Error(`Accounting Imbalance Error: Total Debits (${dr}) != Total Credits (${cr}), difference ${diff}`);
  }
}

// ✅ Crucial Fix: Export the function so HayatDb.js can import it
module.exports = {
  postToTranAcc
};