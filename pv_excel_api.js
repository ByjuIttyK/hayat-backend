// ═════════════════════════════════════════════════════════════════════════════
//   PV (Payment Voucher) Excel Entry — Backend APIs
//   Mirrors rv_excel_api.js but for outgoing payments (Tran Type = '04')
//
//   Mount in HayatDb.js:
//     const pvXlRoutes = require('./pv_excel_api');
//     app.use(pvXlRoutes);   // routes already include /api/
// ═════════════════════════════════════════════════════════════════════════════
"use strict";
const express = require("express");
const router = express.Router();
const connection = require("./db/connection");   // adjust path to your db module

const TRAN_TYPE = "04";

// ─── Promise wrapper around connection.query ────────────────────────────────
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

// ─── Error-handling wrapper for async routes ────────────────────────────────
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error("[pv-excel-api] Error:", err.message, err.stack);
    res.status(500).json({ error: err.message || "Server error" });
  });
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/InvStlSup/:supcd  — Supplier outstanding bills for PV settlement
// (provided as starting point; included here so PV is self-contained)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/api/InvStlSup/:supcd", (req, res) => {
  const sql =
    "SELECT ACC_CODE SUP_CODE, VCHR_NO DOC_NO, TRAN_TYPE DOC_TYPE, " +
    "DATE_FORMAT(DATTE,'%d/%m/%Y') DOC_DATE, '' AS NAR, " +
    "DR_AMT, CR_AMT, BALANCE INV_AMT " +
    "FROM v_sup_outstanding_bill WHERE BALANCE > 0 AND ACC_CODE = ?";
  connection.query(sql, [req.params.supcd], (err, results) => {
    if (err) {
      console.error("[InvStlSup]", err);
      return res.status(500).send("Error executing query.");
    }
    res.json(results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/gen-pv-refno?tran_type=04&date=YYYY-MM-DD
// Returns: { REF_NO, VCHR_NO }
// ═════════════════════════════════════════════════════════════════════════════
router.get("/api/gen-pv-refno", wrap(async (req, res) => {
  const tranType = req.query.tran_type || TRAN_TYPE;
  const pvDate = req.query.date || new Date().toISOString().slice(0, 10);
  const userName = req.query.user || req.session?.user || "SYSTEM";

  await query("CALL sp_gen_pv_refno(?, ?, @ref_no, @vchr_no)", [tranType, pvDate]);
  const [[row]] = [await query("SELECT @ref_no AS REF_NO, @vchr_no AS VCHR_NO")];
  const { REF_NO: refNo, VCHR_NO: vchrNo } = row;

  await query(
    `INSERT INTO pv_excel_header
       (REF_NO, VCHR_NO, TRAN_TYPE, PV_DATE, SUP_CODE, BANK_CODE,
        STATUS, GENERATED_BY, USER_NAME)
     VALUES (?, ?, ?, ?, '', '', 'GENERATED', ?, ?)
     ON DUPLICATE KEY UPDATE STATUS = STATUS`,
    [refNo, vchrNo, tranType, pvDate, userName, userName]
  );

  console.log(`[gen-pv-refno] REF_NO=${refNo}  VCHR_NO=${vchrNo}`);
  res.json({ REF_NO: refNo, VCHR_NO: vchrNo });
}));

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/update-pv-header — write all fields after Section A filled
// ═════════════════════════════════════════════════════════════════════════════
router.post("/api/update-pv-header", wrap(async (req, res) => {
  const {
    refNo, vchrNo, rvDate, supCode, supName, bankCode, bankName,
    particulars, currCode, convRate, amountFc, amountLocal,
  } = req.body;

  if (!refNo) return res.status(400).json({ error: "refNo is required" });

  await query(
    `UPDATE pv_excel_header SET
       VCHR_NO=?, PV_DATE=?, SUP_CODE=?, SUP_NAME=?,
       BANK_CODE=?, BANK_NAME=?, PARTICULARS=?, CURR_CODE=?,
       CONV_RATE=?, AMOUNT_FC=?, AMOUNT_LOCAL=?
     WHERE REF_NO = ?`,
    [vchrNo, rvDate, supCode || "", supName || "", bankCode || "", bankName || "",
      particulars || "", currCode || "AED", Number(convRate) || 1,
      Number(amountFc) || 0, Number(amountLocal) || 0, refNo]
  );

  res.json({ success: true, refNo });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/pv-header-status/:refNo — fetch full header for edit mode
// ═════════════════════════════════════════════════════════════════════════════
router.get("/api/pv-header-status/:refNo", wrap(async (req, res) => {
  const rows = await query(
    `SELECT REF_NO, VCHR_NO, TRAN_TYPE,
       DATE_FORMAT(PV_DATE,'%Y-%m-%d') AS PV_DATE,
       SUP_CODE, SUP_NAME, BANK_CODE, BANK_NAME,
       PARTICULARS, CURR_CODE, CONV_RATE,
       AMOUNT_FC, AMOUNT_LOCAL, STATUS,
       GENERATED_DT, UPLOADED_DT, POSTED_DT, ERR_MSG
     FROM pv_excel_header
     WHERE REF_NO = ?`,
    [req.params.refNo]
  );
  if (!rows.length)
    return res.status(404).json({ error: `REF_NO '${req.params.refNo}' not found` });
  res.json(rows[0]);
}));

// ═════════════════════════════════════════════════════════════════════════════
// PATCH /api/pv-header-status/:refNo — update STATUS / VCHR_NO / ERR_MSG
// ═════════════════════════════════════════════════════════════════════════════
router.patch("/api/pv-header-status/:refNo", wrap(async (req, res) => {
  const { refNo } = req.params;
  const { status, errMsg, vchrNo } = req.body;

  const VALID = ["GENERATED", "UPLOADED", "VALIDATED", "POSTED", "ERROR"];
  if (!VALID.includes(status))
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID.join(", ")}` });

  let sql = "UPDATE pv_excel_header SET STATUS = ?";
  const p = [status];

  if (status === "UPLOADED") sql += ", UPLOADED_DT = NOW()";
  if (status === "POSTED") sql += ", POSTED_DT   = NOW()";
  if (errMsg !== undefined) { sql += ", ERR_MSG = ?"; p.push(errMsg); }
  if (vchrNo) { sql += ", VCHR_NO = ?"; p.push(vchrNo); }

  sql += " WHERE REF_NO = ?";
  p.push(refNo);

  console.log(`[pv-header-status] ${refNo} → status=${status}${vchrNo ? ` vchrNo=${vchrNo}` : ""}`);

  const result = await query(sql, p);
  if (!result.affectedRows)
    return res.status(404).json({ error: `REF_NO '${refNo}' not found` });

  res.json({ success: true, refNo, status, vchrNo: vchrNo || null });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/pv-excel-register — paginated list for the Register grid
// Query params: status, from, to, supCode, limit
// ═════════════════════════════════════════════════════════════════════════════
router.get("/api/pv-excel-register", wrap(async (req, res) => {
  const { status, from, to, supCode, limit = 500 } = req.query;
  const where = [];
  const params = [];

  if (status) { where.push("STATUS = ?"); params.push(status); }
  if (from) { where.push("PV_DATE >= ?"); params.push(from); }
  if (to) { where.push("PV_DATE <= ?"); params.push(to); }
  if (supCode) { where.push("SUP_CODE = ?"); params.push(supCode); }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const rows = await query(
    `SELECT * FROM v_pv_excel_summary
     ${whereSql}
     ORDER BY GENERATED_DT DESC
     LIMIT ?`,
    [...params, Number(limit)]
  );

  const [{ cnt }] = await query(
    `SELECT COUNT(*) AS cnt FROM pv_excel_header ${whereSql}`,
    params
  );

  res.json({ rows, total: cnt });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/pv-excel-register/:refNo — detail for one record
// ═════════════════════════════════════════════════════════════════════════════
router.get("/api/pv-excel-register/:refNo", wrap(async (req, res) => {
  const rows = await query(
    `SELECT * FROM v_pv_excel_summary WHERE REF_NO = ?`,
    [req.params.refNo]
  );
  if (!rows.length)
    return res.status(404).json({ error: `REF_NO '${req.params.refNo}' not found` });
  res.json(rows[0]);
}));

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
//   vchrData:    { TranType, VchrNo, VchrDate, SupCd, DrAc, CurCd,
//                  ConvRt, Particulars, PaidTo, FrgnAmt, Amount },
//   chqData:     [{ TranType, VchrNo, ChqNo, ChqDt, PdcCode,
//                   SupCd, ChqBank, Amount, Narration }],
//   tranaccData: [{ TranType, VchrNo, VchrDate, SrNo, AccCode,
//                   RefNo, Narration1, Narration2, Amount, DbCr }],
//   InvStlData:  [{ TranType, SourceDoc, SourceDate, AccCode,
//                   StldDoc, StldType, StldDate, Amount }]
// }
// Returns: { success: true, refNo, vchrNo, postedAt }
// ──────────────────────────────────────────────────────────────
const parseDate = (val) => {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  // Returns 'YYYY-MM-DD' format which MySQL accepts
  return d.toISOString().slice(0, 10);
};

router.post("/api/save-pv-xl", wrap(async (req, res) => {
  const { vchrData, chqData = [], tranaccData = [], InvStlData = [] } = req.body;

  if (!vchrData || !vchrData.VchrNo)
    return res.status(400).json({ error: "vchrData.VchrNo is required" });

  const vchrNo = vchrData.VchrNo;
  const refNo = vchrData.VchrNo;          // RefNo = VchrNo for RV Excel entries
  const tranType = vchrData.TranType || "04";

  console.log(`[save-pv] START  VchrNo=${vchrNo}  tranType=${tranType}  chqs=${chqData.length}  stl=${InvStlData.length}`);

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
        parseDate(vchrData.VchrDate),
        vchrData.SupCd || null,
        vchrData.CrAc || null,
        chqData.length > 0 ? chqData[0].ChqNo : null,  // first cheque no in header
        vchrData.Amount || 0,
        vchrData.Particulars || vchrData.Narration1 || null,
        refNo,
        vchrData.FrgnAmt || 0,
        vchrData.CurCd || "AED",
        vchrData.ConvRt || 1,
      ]
    );
    console.log(`[save-pv] vouchers OK`);


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
      console.log('****tran_acc.vchr_no ==>', vchrNo);
      await query(
        `INSERT INTO tran_acc
           (TRAN_TYPE, VCHR_NO, DATTE, SR_NO, ACC_CODE, REF_NO,
            NARRATION1, NARRATION2, AMOUNT, DB_CR)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.TranType || tranType,
          vchrNo,
          //  row.VchrDate  || vchrData.VchrDate,
          parseDate(vchrData.VchrDate),
          row.SrNo || 0,
          row.AccCode,
          row.RefNo || refNo,
          vchrData.Particulars || vchrData.Narration1 || null,
          row.Narration2 || null,
          row.Amount || 0,
          row.DbCr || "D",
        ]
      );
    }
    console.log(`[save-pv] tran_acc OK  (${tranaccData.length} lines)`);


    // ── 3. PDC_RCD / CURRENT_CHQ table (cheques) ─────────────
    // Delete existing cheque rows for this voucher
    await query(
      "DELETE FROM pdc_isu WHERE TRAN_TYPE = ? AND VCHR_NO = ?",
      [tranType, vchrNo]
    );

    for (const chq of chqData) {
      if (!chq.Amount) continue;
      await query(
        `INSERT INTO pdc_isu
           (TRAN_TYPE, VCHR_NO, CHQ_NO, CHQ_DATE, CHQ_BANK,
            PDC_CODE, SUP_CODE, AMOUNT, NARRATION)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chq.TranType || tranType,
          chq.VchrNo || vchrNo,
          chq.ChqNo || null,
          chq.ChqDt || null,
          chq.ChqBank || null,
          vchrData.CrAc || null,   // PDC_CODE = Bank a/c = '111-011-0-001' ✅
          vchrData.SupCd || null,
          chq.Amount || 0,
          chq.Narration || vchrData.Particulars || null,
        ]
      );
    }
    // chq.PdcCode || vchrData.CrAc || null,   // PDC_CODE = Bank a/c = '111-011-0-001' ✅
    //    chq.SupCd || vchrData.DrAc || null,
    console.log(`[save-pv] pdc_isu OK  (${chqData.length} cheques)`);


    // ── 4. ADJ_DTL table (invoice settlements) ───────────────
    // Delete existing settlement rows for this source doc
    await query(
      "DELETE FROM adj_dtl WHERE SOURCE_TYPE = '04' AND REF_NO = ?",
      [refNo]
    );

    for (const stl of InvStlData) {
      if (!stl.Amount || Number(stl.Amount) <= 0) continue;
      await query(
        `INSERT INTO adj_dtl
           (SOURCE_TYPE, REF_NO, SOURCE_DOC, SOURCE_DATE, ACC_CODE,
            STLD_TYPE, STLD_DOC, STLD_DATE, STLD_AMT)
         VALUES ('04', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          refNo,
          stl.SourceDoc || vchrNo,
          stl.SourceDate || vchrData.VchrDate,
          stl.AccCode,
          stl.StldType || "06",
          stl.StldDoc || null,
          stl.StldDate || null,
          stl.Amount || 0,
        ]
      );
      console.log("InvStl =>", refNo, stl.SourceDoc, stl.SourceDate, stl.AccCode, stl.Amount);
    }
    console.log(`[save-pv] adj_dtl OK  (${InvStlData.length} settlements)`);


    // ── 5. Mark rv_excel_header as POSTED ─────────────────────
    await query(
      `UPDATE pv_excel_header
       SET STATUS = 'POSTED', POSTED_DT = NOW(), ERR_MSG = NULL
       WHERE REF_NO = ?`,
      [refNo]
    ).catch(() => { });  // non-fatal if header row doesn't exist


    // ── COMMIT ────────────────────────────────────────────────
    await query("COMMIT");

    const postedAt = new Date().toISOString();
    console.log(`[save-pv] COMMITTED  VchrNo=${vchrNo}  at ${postedAt}`);
    res.json({ success: true, refNo, vchrNo, postedAt });

  } catch (err) {
    // ── ROLLBACK ──────────────────────────────────────────────
    await query("ROLLBACK").catch(() => { });

    // Mark header as ERROR
    await query(
      `UPDATE pv_excel_header
       SET STATUS = 'ERROR', ERR_MSG = ?
       WHERE REF_NO = ?`,
      [err.message?.slice(0, 499), refNo]
    ).catch(() => { });

    console.error(`[save-pv] ROLLED BACK  VchrNo=${vchrNo}  error=${err.message}`);
    throw err;   // re-throw → wrap() sends 500
  }
}));


module.exports = router;
