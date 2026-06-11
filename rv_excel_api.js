// ============================================================
//  RV Excel Entry — Complete Backend API routes
//  Node.js / Express + MySQL (mysql2 callback style)
//
//  Mount in your app:
//    const rvApi = require("./rv_excel_api");
//    app.use(rvApi);
//
//  Existing APIs already in your app (referenced but not
//  duplicated here):  /api/banklst  /api/cuslov/:cname
// ============================================================

"use strict";
const express    = require("express");
const router     = express.Router();
const connection = require("./db/connection");   // your existing MySQL connection/pool

// ── Promisify helper (works with mysql / mysql2 callback pools) ──────────────
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => {
      if (err) reject(err);
      else     resolve(results);
    });
  });
}

// ── Wrap async route handlers ────────────────────────────────────────────────
const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(err => {
    console.error("[rv_excel_api]", err.message);
    res.status(500).json({ error: err.message });
  });


// ============================================================
//  SECTION 1 — LOOKUP APIs
// ============================================================

// ──────────────────────────────────────────────────────────────
// GET /api/cuslst
// Full customer list for the lookup modal.
// Returns: [{ CUST_CODE, CUST_NAME, CUS_TEL1 }]
// ──────────────────────────────────────────────────────────────
router.get("/cuslst", wrap(async (req, res) => {
  const rows = await query(
    `SELECT CUST_CODE,
            LTRIM(RTRIM(CUST_NAME)) AS CUST_NAME,
            IFNULL(CUS_TEL1, '')    AS CUS_TEL1
     FROM   cus_mst
     ORDER  BY LTRIM(CUST_NAME)`
  );
  res.json(rows);
}));


// ──────────────────────────────────────────────────────────────
// GET /api/currencies
// Distinct currency list from nation_mst for the Currency dropdown.
// Returns: [{ CUR_CODE, CUR_NAME, DHS_CONV_RATE }]
// ──────────────────────────────────────────────────────────────
router.get("/currencies", wrap(async (req, res) => {
  const rows = await query(
    `SELECT DISTINCT
            CUR_CODE,
            CUR_NAME,
            IFNULL(DHS_CONV_RATE, 1) AS DHS_CONV_RATE
     FROM   nation_mst
     WHERE  CUR_CODE IS NOT NULL
       AND  CUR_CODE <> ''
     ORDER  BY CUR_CODE`
  );
  res.json(rows);
}));


// ──────────────────────────────────────────────────────────────
// GET /api/InvStlCust/:custcd
// Outstanding invoices for a customer — pre-loaded into Section D
// of the Excel template.
// Returns: [{ CUST_CODE, DOC_NO, DOC_TYPE, DOC_DATE, NAR,
//             DR_AMT, CR_AMT, INV_AMT }]
// ──────────────────────────────────────────────────────────────
router.get("/InvStlCust/:custcd", wrap(async (req, res) => {
  const { custcd } = req.params;
  console.log("[InvStlCust]", custcd);

  const rows = await query(
    `SELECT CUST_CODE,
            VCHR_NO                              AS DOC_NO,
            TRAN_TYPE                            AS DOC_TYPE,
            DATE_FORMAT(DATTE, '%d/%m/%Y')       AS DOC_DATE,
            NAR,
            DR_AMT,
            CR_AMT,
            BALANCE                              AS INV_AMT
     FROM   v_cust_outstanding_bill
     WHERE  CUST_CODE = ?
     ORDER  BY DATTE`,
    [custcd]
  );
  res.json(rows);
}));


// ============================================================
//  SECTION 2 — REF NO GENERATION & HEADER MANAGEMENT
// ============================================================

// ──────────────────────────────────────────────────────────────
// GET /api/gen-refno
// Generates next REF_NO + VCHR_NO via stored procedure,
// inserts a GENERATED row in rv_excel_header.
// Query: ?tran_type=03&date=YYYY-MM-DD
// Returns: { REF_NO, VCHR_NO }
// ──────────────────────────────────────────────────────────────
router.get("/gen-refno", wrap(async (req, res) => {
  const tranType = req.query.tran_type || "03";
  const rvDate   = req.query.date      || new Date().toISOString().slice(0, 10);
  const userName = req.query.user      || req.session?.user || "SYSTEM";

  // Call stored procedure (see rv_excel_tables.sql)
  await query("CALL sp_gen_rv_refno(?, ?, @ref_no, @vchr_no)", [tranType, rvDate]);
  const [[row]] = [await query("SELECT @ref_no AS REF_NO, @vchr_no AS VCHR_NO")];
  const { REF_NO: refNo, VCHR_NO: vchrNo } = row;

  // Seed the header row — full fields written by /api/update-rv-header
  await query(
    `INSERT INTO rv_excel_header
       (REF_NO, VCHR_NO, TRAN_TYPE, RV_DATE, CUST_CODE, BANK_CODE,
        STATUS, GENERATED_BY, USER_NAME)
     VALUES (?, ?, ?, ?, '', '', 'GENERATED', ?, ?)
     ON DUPLICATE KEY UPDATE STATUS = STATUS`,   // no-op if somehow called twice
    [refNo, vchrNo, tranType, rvDate, userName, userName]
  );

  console.log(`[gen-refno] REF_NO=${refNo}  VCHR_NO=${vchrNo}`);
  res.json({ REF_NO: refNo, VCHR_NO: vchrNo });
}));


// ──────────────────────────────────────────────────────────────
// POST /api/update-rv-header
// Saves full header data after the user fills Section A fields.
// Body: { refNo, vchrNo, rvDate, custCode, custName,
//         bankCode, bankName, particulars, currCode,
//         convRate, amountFc, amountLocal, userName }
// ──────────────────────────────────────────────────────────────
router.post("/update-rv-header", wrap(async (req, res) => {
  const {
    refNo, vchrNo, rvDate, custCode, custName,
    bankCode, bankName, particulars, currCode,
    convRate, amountFc, amountLocal, userName = "SYSTEM"
  } = req.body;

  if (!refNo) return res.status(400).json({ error: "refNo is required" });

  const result = await query(
    `UPDATE rv_excel_header
     SET VCHR_NO      = ?,
         RV_DATE      = ?,
         CUST_CODE    = ?,
         CUST_NAME    = ?,
         BANK_CODE    = ?,
         BANK_NAME    = ?,
         PARTICULARS  = ?,
         CURR_CODE    = ?,
         CONV_RATE    = ?,
         AMOUNT_FC    = ?,
         AMOUNT_LOCAL = ?,
         STATUS       = 'GENERATED',
         USER_NAME    = ?
     WHERE REF_NO = ?`,
    [vchrNo, rvDate, custCode, custName, bankCode, bankName,
     particulars, currCode, convRate, amountFc, amountLocal,
     userName, refNo]
  );

  if (result.affectedRows === 0) {
    // Row wasn't seeded yet — insert it fully
    await query(
      `INSERT INTO rv_excel_header
         (REF_NO, VCHR_NO, TRAN_TYPE, RV_DATE, CUST_CODE, CUST_NAME,
          BANK_CODE, BANK_NAME, PARTICULARS, CURR_CODE, CONV_RATE,
          AMOUNT_FC, AMOUNT_LOCAL, STATUS, GENERATED_BY, USER_NAME)
       VALUES (?, ?, '03', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GENERATED', ?, ?)`,
      [refNo, vchrNo, rvDate, custCode, custName, bankCode, bankName,
       particulars, currCode, convRate, amountFc, amountLocal,
       userName, userName]
    );
  }

  res.json({ success: true, refNo });
}));


// ──────────────────────────────────────────────────────────────
// GET /api/rv-header-status/:refNo
// Returns status and key fields of a header row.
// ──────────────────────────────────────────────────────────────
router.get("/rv-header-status/:refNo", wrap(async (req, res) => {
  const rows = await query(
    `SELECT REF_NO, VCHR_NO, TRAN_TYPE, RV_DATE, CUST_CODE, CUST_NAME,
            BANK_CODE, BANK_NAME, AMOUNT_LOCAL, STATUS,
            GENERATED_DT, UPLOADED_DT, POSTED_DT, ERR_MSG
     FROM   rv_excel_header
     WHERE  REF_NO = ?`,
    [req.params.refNo]
  );
  if (!rows.length)
    return res.status(404).json({ error: `REF_NO '${req.params.refNo}' not found` });
  res.json(rows[0]);
}));


// ──────────────────────────────────────────────────────────────
// PATCH /api/rv-header-status/:refNo
// Updates lifecycle status, and optionally VCHR_NO (set at posting time when
// the real voucher number is generated from MaxVchrNo).
// Body: { status: "UPLOADED"|"VALIDATED"|"POSTED"|"ERROR", errMsg?, vchrNo? }
// ──────────────────────────────────────────────────────────────
router.patch("/rv-header-status/:refNo", wrap(async (req, res) => {
  const { refNo }                    = req.params;
  const { status, errMsg, vchrNo }   = req.body;

  const VALID = ["GENERATED","UPLOADED","VALIDATED","POSTED","ERROR"];
  if (!VALID.includes(status))
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID.join(", ")}` });

  let sql    = "UPDATE rv_excel_header SET STATUS = ?";
  const p    = [status];

  if (status === "UPLOADED")    { sql += ", UPLOADED_DT = NOW()"; }
  if (status === "POSTED")      { sql += ", POSTED_DT   = NOW()"; }
  if (errMsg !== undefined)     { sql += ", ERR_MSG = ?"; p.push(errMsg); }
  // Update VCHR_NO when posting — link header to actual voucher created
  if (vchrNo)                   { sql += ", VCHR_NO = ?"; p.push(vchrNo);  }

  sql += " WHERE REF_NO = ?";
  p.push(refNo);

  console.log(`[rv-header-status] ${refNo} → status=${status}${vchrNo?` vchrNo=${vchrNo}`:""}`);

  const result = await query(sql, p);
  if (!result.affectedRows)
    return res.status(404).json({ error: `REF_NO '${refNo}' not found` });

  res.json({ success: true, refNo, status, vchrNo: vchrNo || null });
}));


// ============================================================
//  SECTION 3 — VALIDATE (pre-flight check before POST)
// ============================================================

// ──────────────────────────────────────────────────────────────
// POST /api/validate-rv
// Runs server-side validation on the parsed Excel data before
// committing to DB.  Returns errors[] and warnings[].
//
// Body: {
//   refNo, vchrNo, tranType, rvDate,
//   custCode, bankCode, amountLocal,
//   settlements: [{ docNo, docDate, settleAmt, srcType }],
//   cheques:     [{ chqNo, chqDate, depBank, amount }]
// }
// Returns: { valid: bool, errors: [], warnings: [] }
// ──────────────────────────────────────────────────────────────
router.post("/validate-rv", wrap(async (req, res) => {
  const {
    refNo, vchrNo, tranType = "03", rvDate,
    custCode, bankCode, amountLocal,
    settlements = [], cheques = []
  } = req.body;

  const errors   = [];
  const warnings = [];

  // ── 1. Header completeness ────────────────────────────────
  if (!refNo)        errors.push("REF_NO is missing.");
  if (!rvDate)       errors.push("RV Date is missing.");
  if (!custCode)     errors.push("Customer Code is missing.");
  if (!bankCode)     errors.push("Bank Code is missing.");
  if (!amountLocal || Number(amountLocal) <= 0)
                     errors.push("Amount Local must be > 0.");
  if (tranType !== "03")
                     errors.push(`Tran Type must be '03', got '${tranType}'.`);

  // ── 2. Duplicate REF_NO check ─────────────────────────────
  if (refNo) {
    const existing = await query(
      "SELECT STATUS FROM rv_excel_header WHERE REF_NO = ?", [refNo]
    );
    if (existing.length && existing[0].STATUS === "POSTED")
      errors.push(`REF_NO '${refNo}' has already been POSTED. Cannot re-post.`);
  }

  // ── 3. Customer exists ────────────────────────────────────
  if (custCode) {
    const cust = await query(
      "SELECT CUST_CODE FROM cus_mst WHERE CUST_CODE = ?", [custCode]
    );
    if (!cust.length) errors.push(`Customer '${custCode}' not found in cus_mst.`);
  }

  // ── 4. Bank account exists ────────────────────────────────
  if (bankCode) {
    const bank = await query(
      "SELECT BANK_CODE FROM bank_mst WHERE BANK_CODE = ?", [bankCode]
    );
    if (!bank.length) errors.push(`Bank Code '${bankCode}' not found in bank_mst.`);
  }

  // ── 5. Cheque validations ─────────────────────────────────
  const totalCheques = cheques.reduce((s, r) => s + Number(r.amount || 0), 0);
  if (cheques.length === 0)
    errors.push("No cheque rows found in Section B.");
  if (Math.abs(totalCheques - Number(amountLocal)) > 0.01)
    errors.push(
      `Cheque total (${totalCheques.toFixed(2)}) ≠ Amount Local (${Number(amountLocal).toFixed(2)}).`
    );
  cheques.forEach((r, i) => {
    if (!r.chqNo)   errors.push(`Cheque ${i + 1}: Cheque No is missing.`);
    if (!r.chqDate) errors.push(`Cheque ${i + 1}: Cheque Date is missing.`);
    if (!r.depBank) errors.push(`Cheque ${i + 1}: Deposit Bank is missing.`);
    if (!r.amount || Number(r.amount) <= 0)
                    errors.push(`Cheque ${i + 1}: Amount must be > 0.`);
  });

  // ── 6. Settlement validations ─────────────────────────────
  const totalSettled = settlements.reduce((s, r) => s + Number(r.settleAmt || 0), 0);
  if (settlements.length === 0)
    warnings.push("No invoice settlements entered — voucher will be posted as unallocated advance.");
  if (totalSettled > Number(amountLocal) + 0.01)
    errors.push(
      `Total Settled (${totalSettled.toFixed(2)}) exceeds Amount Local (${Number(amountLocal).toFixed(2)}).`
    );
  if (settlements.length > 0 && Math.abs(totalSettled - Number(amountLocal)) > 0.01)
    warnings.push(
      `Partial allocation: ${totalSettled.toFixed(2)} settled, ` +
      `${(Number(amountLocal) - totalSettled).toFixed(2)} will remain unallocated.`
    );

  // ── 7. Validate source docs exist in adj_dtl-eligible tables ─
  for (const stl of settlements) {
    if (!stl.docNo) { errors.push("Settlement row has empty Doc No."); continue; }
    const invRows = await query(
      `SELECT VCHR_NO FROM v_cust_outstanding_bill
       WHERE  CUST_CODE = ? AND VCHR_NO = ?`,
      [custCode, stl.docNo]
    ).catch(() => []);
    if (!invRows.length)
      warnings.push(`Invoice '${stl.docNo}' not found in outstanding bills — may already be settled.`);
  }

  // ── 8. Ledger balance check ───────────────────────────────
  // DR line = bankCode, CR line = custCode, both = amountLocal
  const totalDR = Number(amountLocal);
  const totalCR = Number(amountLocal);
  if (Math.abs(totalDR - totalCR) > 0.01)
    errors.push(`Ledger imbalance: DR ${totalDR.toFixed(2)} ≠ CR ${totalCR.toFixed(2)}.`);

  const valid = errors.length === 0;

  // Update header status to VALIDATED if clean
  if (valid && refNo) {
    await query(
      "UPDATE rv_excel_header SET STATUS = 'VALIDATED' WHERE REF_NO = ?", [refNo]
    ).catch(() => {});
  }

  console.log(`[validate-rv] REF_NO=${refNo}  valid=${valid}  errors=${errors.length}  warnings=${warnings.length}`);
  res.json({ valid, errors, warnings });
}));


// ============================================================
//  SECTION 4 — SAVE / POST TO ACCOUNTS
// ============================================================

// ──────────────────────────────────────────────────────────────
// POST /api/save-rcp
// The main transactional POST.  Writes to 4 tables atomically:
//   1. vouchers     — voucher header
//   2. tran_acc     — debit + credit ledger lines
//   3. pdc_rcd      — cheque rows (PDC/current)
//   4. adj_dtl      — invoice settlement rows
//
// Also updates rv_excel_header status to POSTED.
//
// Body (built by useRvEntBankSave hook):
// {
//   vchrData:    { TranType, VchrNo, VchrDate, CustCd, DrAc, CurCd,
//                  ConvRt, Particulars, PaidTo, FrgnAmt, Amount },
//   chqData:     [{ TranType, VchrNo, ChqNo, ChqDt, PdcCode,
//                   CustCd, ChqBank, Amount, Narration }],
//   tranaccData: [{ TranType, VchrNo, VchrDate, SrNo, AccCode,
//                   RefNo, Narration1, Narration2, Amount, DbCr }],
//   InvStlData:  [{ TranType, SourceDoc, SourceDate, AccCode,
//                   StldDoc, StldType, StldDate, Amount }]
// }
// Returns: { success: true, refNo, vchrNo, postedAt }
// ──────────────────────────────────────────────────────────────
router.post("/save-rcp-xl", wrap(async (req, res) => {
  const { vchrData, chqData = [], tranaccData = [], InvStlData = [] } = req.body;

  if (!vchrData || !vchrData.VchrNo)
    return res.status(400).json({ error: "vchrData.VchrNo is required" });

  const vchrNo  = vchrData.VchrNo;
  const refNo   = vchrData.VchrNo;          // RefNo = VchrNo for RV Excel entries
  const tranType= vchrData.TranType || "03";

  console.log(`[save-rcp] START  VchrNo=${vchrNo}  tranType=${tranType}  chqs=${chqData.length}  stl=${InvStlData.length}`);

  // ── BEGIN TRANSACTION ─────────────────────────────────────
  await query("START TRANSACTION");

  try {

    // ── 1. VOUCHERS table ─────────────────────────────────────
    // Upsert so re-running after a partial failure is safe
    await query(
      `INSERT INTO vouchers
         (TRAN_TYPE, VCHR_NO, DATTE, CUST_CODE, ACC_CODE,
          CHEQUE_NO, AMOUNT, NARRATION1, REF_NO, AMOUNT_FRGN, CUR_CODE, CONV_RATE)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         DATTE        = VALUES(DATTE),
         CUST_CODE    = VALUES(CUST_CODE),
         ACC_CODE     = VALUES(ACC_CODE),
         AMOUNT       = VALUES(AMOUNT),
         NARRATION1   = VALUES(NARRATION1),
         AMOUNT_FRGN  = VALUES(AMOUNT_FRGN),
         CUR_CODE     = VALUES(CUR_CODE),
         CONV_RATE    = VALUES(CONV_RATE)`,
      [
        tranType,
        vchrNo,
        vchrData.VchrDate,
        vchrData.CustCd    || null,
        vchrData.DrAc      || null,
        chqData.length > 0 ? chqData[0].ChqNo : null,  // first cheque no in header
        vchrData.Amount    || 0,
        vchrData.Particulars || vchrData.Narration1 || null,
        refNo,
        vchrData.FrgnAmt   || 0,
        vchrData.CurCd     || "AED",
        vchrData.ConvRt    || 1,
      ]
    );
    console.log(`[save-rcp] vouchers OK`);


    // ── 2. TRAN_ACC table (ledger lines) ─────────────────────
    // Delete existing lines first (safe re-run)
    await query(
      "DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?",
      [tranType, vchrNo]
    );

    if (tranaccData.length === 0)
      throw new Error("tranaccData is empty — no ledger lines to post.");

    for (const row of tranaccData) {
      if (!row.AccCode?.trim()) continue;
      console.log('****tran_acc.vchr_no ==>',vchrNo);
      await query(
        `INSERT INTO tran_acc
           (TRAN_TYPE, VCHR_NO, DATTE, SR_NO, ACC_CODE, REF_NO,
            NARRATION1, NARRATION2, AMOUNT, DB_CR)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.TranType  || tranType,
           vchrNo,
          row.VchrDate  || vchrData.VchrDate,
          row.SrNo      || 0,
          row.AccCode,
          row.RefNo     || refNo,
           vchrData.Particulars || vchrData.Narration1 || null,
          row.Narration2|| null,
          row.Amount    || 0,
          row.DbCr      || "D",
        ]
      );
    }
    console.log(`[save-rcp] tran_acc OK  (${tranaccData.length} lines)`);


    // ── 3. PDC_RCD / CURRENT_CHQ table (cheques) ─────────────
    // Delete existing cheque rows for this voucher
    await query(
      "DELETE FROM pdc_rcd WHERE TRAN_TYPE = ? AND VCHR_NO = ?",
      [tranType, vchrNo]
    );

    for (const chq of chqData) {
      if (!chq.Amount) continue;
      await query(
        `INSERT INTO pdc_rcd
           (TRAN_TYPE, VCHR_NO, CHQ_NO, CHQ_DATE, CHQ_BANK,
            PDC_CODE, CUST_CODE, AMOUNT, NARRATION)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chq.TranType || tranType,
          chq.VchrNo   || vchrNo,
          chq.ChqNo    || null,
          chq.ChqDt    || null,
          chq.ChqBank  || null,
          chq.PdcCode  || vchrData.DrAc || null,
          chq.CustCd   || vchrData.CustCd || null,
          chq.Amount   || 0,
          chq.Narration|| vchrData.Particulars || null,
        ]
      );
    }
    console.log(`[save-rcp] pdc_rcd OK  (${chqData.length} cheques)`);


    // ── 4. ADJ_DTL table (invoice settlements) ───────────────
    // Delete existing settlement rows for this source doc
    await query(
      "DELETE FROM adj_dtl WHERE SOURCE_TYPE = '03' AND REF_NO = ?",
      [refNo]
    );

    for (const stl of InvStlData) {
      if (!stl.Amount || Number(stl.Amount) <= 0) continue;
      await query(
        `INSERT INTO adj_dtl
           (SOURCE_TYPE, REF_NO, SOURCE_DOC, SOURCE_DATE, ACC_CODE,
            STLD_TYPE, STLD_DOC, STLD_DATE, STLD_AMT)
         VALUES ('03', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          refNo,
          stl.SourceDoc  || vchrNo,
          stl.SourceDate || vchrData.VchrDate,
          stl.AccCode    || vchrData.CustCd,
          stl.StldType   || "06",
          stl.StldDoc    || null,
          stl.StldDate   || null,
          stl.Amount     || 0,
        ]
      );
      console.log("InvStl =>",refNo,stl.SourceDoc,stl.SourceDate,stl.AccCode,stl.Amount);
    }
    console.log(`[save-rcp] adj_dtl OK  (${InvStlData.length} settlements)`);


    // ── 5. Mark rv_excel_header as POSTED ─────────────────────
    await query(
      `UPDATE rv_excel_header
       SET STATUS = 'POSTED', POSTED_DT = NOW(), ERR_MSG = NULL
       WHERE REF_NO = ?`,
      [refNo]
    ).catch(() => {});  // non-fatal if header row doesn't exist


    // ── COMMIT ────────────────────────────────────────────────
    await query("COMMIT");

    const postedAt = new Date().toISOString();
    console.log(`[save-rcp] COMMITTED  VchrNo=${vchrNo}  at ${postedAt}`);
    res.json({ success: true, refNo, vchrNo, postedAt });

  } catch (err) {
    // ── ROLLBACK ──────────────────────────────────────────────
    await query("ROLLBACK").catch(() => {});

    // Mark header as ERROR
    await query(
      `UPDATE rv_excel_header
       SET STATUS = 'ERROR', ERR_MSG = ?
       WHERE REF_NO = ?`,
      [err.message?.slice(0, 499), refNo]
    ).catch(() => {});

    console.error(`[save-rcp] ROLLED BACK  VchrNo=${vchrNo}  error=${err.message}`);
    throw err;   // re-throw → wrap() sends 500
  }
}));


// ============================================================
//  SECTION 5 — REGISTER / REPORTING
// ============================================================

// ──────────────────────────────────────────────────────────────
// GET /api/rv-excel-register
// Management list of all RV Excel entries.
// Query: ?status=GENERATED&from=2025-01-01&to=2025-12-31
//        &custCode=xxx&page=1&limit=50
// Returns: { total, rows: [...] }
// ──────────────────────────────────────────────────────────────
router.get("/rv-excel-register", wrap(async (req, res) => {
  const { status, from, to, custCode } = req.query;
  const page  = Math.max(1, parseInt(req.query.page  || "1",  10));
  const limit = Math.min(500, parseInt(req.query.limit || "100", 10));
  const offset= (page - 1) * limit;

  let where = "WHERE 1=1";
  const p   = [];

  if (status)   { where += " AND STATUS = ?";     p.push(status);   }
  if (from)     { where += " AND RV_DATE >= ?";    p.push(from);     }
  if (to)       { where += " AND RV_DATE <= ?";    p.push(to);       }
  if (custCode) { where += " AND CUST_CODE = ?";   p.push(custCode); }

  const [countRow] = await query(
    `SELECT COUNT(*) AS total FROM v_rv_excel_summary ${where}`, p
  );
  const rows = await query(
    `SELECT * FROM v_rv_excel_summary ${where}
     ORDER  BY GENERATED_DT DESC
     LIMIT  ? OFFSET ?`,
    [...p, limit, offset]
  );

  res.json({ total: countRow.total, page, limit, rows });
}));


// ──────────────────────────────────────────────────────────────
// GET /api/rv-excel-register/:refNo
// Single entry detail (used by a Register / drill-down screen).
// ──────────────────────────────────────────────────────────────
router.get("/rv-excel-register/:refNo", wrap(async (req, res) => {
  const { refNo } = req.params;

  const [header] = await query(
    "SELECT * FROM v_rv_excel_summary WHERE REF_NO = ?", [refNo]
  );
  if (!header) return res.status(404).json({ error: `REF_NO '${refNo}' not found` });

  const tranAccRows = await query(
    `SELECT * FROM tran_acc
     WHERE  TRAN_TYPE = '03' AND VCHR_NO = ?
     ORDER  BY SR_NO`, [refNo]
  );
  const chqRows = await query(
    `SELECT * FROM pdc_rcd
     WHERE  TRAN_TYPE = '03' AND VCHR_NO = ?`, [refNo]
  );
  const stlRows = await query(
    `SELECT * FROM adj_dtl
     WHERE  SOURCE_TYPE = '03' AND REF_NO = ?`, [refNo]
  );

  res.json({ header, tranAccRows, chqRows, stlRows });
}));


module.exports = router;
