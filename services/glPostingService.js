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

  const tranType = rules[0].TRAN_TYPE;

  // 2. Clear old GL records for this voucher to support updates safely
  await queryAsync(
    `DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,
    [tranType, InvNo]
  );

  let srNo = 1;
  let totalDebit = 0;
  let totalCredit = 0;

  // 3. Process rules and insert ledger entries
  for (const rule of rules) {
    console.log("Field name=>", rule.FIELD_NAME)
    const amount = Number(payload[rule.FIELD_NAME]) || 0;
    console.log("Field value", Number(payload[rule.FIELD_NAME]));
    if (amount === 0) continue; // Skip zero-amount lines

    // Resolve dynamic vs static GL account code
    const accCode = rule.ACC_CODE_FIELD ? payload[rule.ACC_CODE_FIELD] : rule.ACC_CODE;

    if (!accCode) {
      throw new Error(`Missing Account Code for Entry Type: ${rule.ENTRY_TYPE}`);
    }
    const nar1 = rule.ACC_CODE_FIELD ? Narr1 : PartyName;

    if (rule.DB_CR === 'D') totalDebit += amount;
    if (rule.DB_CR === 'C') totalCredit += amount;

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
  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    console.log('not tally');
    throw new Error(`Accounting Imbalance Error: Total Debits (${totalDebit.toFixed(2)}) != Total Credits (${totalCredit.toFixed(2)})`);
  }
}

// ✅ Crucial Fix: Export the function so HayatDb.js can import it
module.exports = {
  postToTranAcc
};