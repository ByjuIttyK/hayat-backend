// =====================================================================
// salaryJvApi.js — Salary JV (tran type 15) — 30-Oct-2026
//
//   Header : salary_jv_hdr (TRAN_TYPE, VCHR_NO) — category, salary month, particulars, totals
//   Lines  : tran_acc  TRAN_TYPE = '15' AND VCHR_NO = salary_jv_hdr.VCHR_NO
//            per time sheet one Dr (emp_catg_mst.Salary_debit_ac, gross), one Cr per tsht_ded line
//            (tsht_ded.ACC_CODE) and one Cr (payroll_mst.ACCRUED_SAL_AC, TOTAL_SALARY) — see 14-Nov-2026
//            NARRATION1 = "EMP NAME - MM/YYYY" (deduction: "DED_DESC - EMP NAME - MM/YYYY"), NARRATION2 = TSHT_NO
//
//   GET  /api/salary-jv-list                    every tran type 15 voucher (header from salary_jv_hdr,
//                                               or derived from its first time sheet when the header is missing)
//   GET  /api/salary-jv/catgs                   employee categories + salary debit A/c
//   GET  /api/salary-jv/vchr/:vchrNo            one voucher's header (for EDIT)
//   GET  /api/salary-jv/lines?catg=&month=&vchr= time sheets of the category + month
//        → { sheets, drafts, posted, zero, removed }   (vchr = the voucher being edited: its own sheets count as open)
//   POST /api/salary-jv/save    { mode: ADD|EDIT, vchrNo, vchrDate, catg, month, particulars, expect:[{TSHT_NO, AMOUNT}] }
//        One transaction: header + tran_acc lines. The lines are rebuilt here from the time sheets, never taken
//        from the browser; `expect` is what the user saw — if the time sheets changed meanwhile the save is refused.
//        ADD numbers the voucher MAX+1 inside the transaction (PK on the header catches a clash → retry).
//   POST /api/salary-jv/delete  { vchrNo }      header + tran_acc lines, one transaction
//   GET  /api/salary-jv/print/:vchrNo           { data: { hdr, items } } for ErpPdfTemplates docType SALJV
//
// 08-Nov-2026: payroll month close (payrollPeriod.js) — the Salary JV of a month whose payroll is closed
//   cannot be added, changed or deleted.
// 13-Nov-2026: Vchr Date is chosen on the screen in ADD and EDIT. The voucher is posted on it —
//   salary_jv_hdr.VCHR_DATE and every tran_acc.DATTE line. It must fall inside ac_period
//   (START_DATE … END_DATE). EDIT without a date (older screen) keeps the saved date.
// 14-Nov-2026: time-sheet deductions credited to their own account.
//   Per time sheet:  Dr Salary Debit A/c          = TOTAL_SALARY + deductions (gross)
//                    Cr tsht_ded.ACC_CODE          = each deduction line (AMOUNT > 0), in DED_CODE order
//                       NARRATION1 "DED_DESC - EMP NAME - MM/YYYY", NARRATION2 TSHT_NO
//                    Cr payroll_mst.ACCRUED_SAL_AC = TOTAL_SALARY (net)
//   sheetsFor returns per sheet DEDS [{DED_CODE, DED_DESC, AMOUNT, ACC_CODE, ACC_HEAD}], DED_TOTAL, GROSS,
//   DED_SIG (deductions per account, "acc:amt,…") and, for the voucher being edited, SAVED_DED_SIG
//   (the same, from its saved Cr lines other than the accrual) so a changed deduction shows as amended.
//   Save: expect carries {TSHT_NO, AMOUNT = GROSS, DED_SIG}; a deduction without ACC_CODE, or with an
//   ACC_CODE not in acc_mst, refuses the save. salary_jv_hdr.TOTAL_AMT = the Dr total (gross).
//
// Register in HayatDb.js:
//   const salaryJvApi = require('./routes/salaryJvApi');
//   app.use('/api', salaryJvApi(connection));
// =====================================================================
const express = require('express');

const { assertPayrollOpen } = require('./payrollPeriod');

const SALARY_JV_TYPE = '15';

module.exports = function (connection) {
  const router = express.Router();
  const getConn = () =>
    new Promise((resolve, reject) => connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) => conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  const userOf = (req) => (req.user && (req.user.username || req.user.USER_NAME || req.user.userId)) || null;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const monthOf = (s) => {
    const m = /^(\d{4})-(\d{2})/.exec(String(s || ''));
    return m ? `${m[1]}-${m[2]}-01` : null;
  };
  const mmyyyy = (iso) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  /** Deductions summed per account, sorted — "12-1208-0-016:500.00,…" ('' when none). Same rule on both sides of a compare. */
  const dedSig = (list) => {
    const byAcc = new Map();
    for (const d of list) byAcc.set(String(d.ACC_CODE || ''), r2((byAcc.get(String(d.ACC_CODE || '')) || 0) + r2(d.AMOUNT)));
    return Array.from(byAcc.entries())
      .filter(([, amt]) => amt)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([acc, amt]) => `${acc}:${amt.toFixed(2)}`)
      .join(',');
  };

  const withConn = (fn) => async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      await fn(conn, req, res);
    } catch (e) {
      if (conn) await q(conn, 'ROLLBACK').catch(() => {});
      console.error('[salary-jv]', e);
      res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : e.sqlMessage || e.message, code: e.code });
    } finally {
      if (conn) conn.release();
    }
  };

  // ---------------------------------------------------------------------
  // time sheets of a category + month, split into what goes in the JV and what is left out
  // ---------------------------------------------------------------------
  async function sheetsFor(conn, catg, month, vchr) {
    const own = vchr || '';
    const [c] = await q(
      conn,
      `SELECT c.catg_code AS CATG_CODE, c.catg_name AS CATG_NAME, c.Salary_debit_ac AS DEBIT_AC, a.ACC_HEAD AS DEBIT_HEAD
         FROM emp_catg_mst c LEFT JOIN acc_mst a ON a.ACC_CODE = c.Salary_debit_ac
        WHERE c.catg_code = ?`,
      [catg],
    );
    if (!c) throw fail(404, `Category ${catg} not found`);

    const all = await q(
      conn,
      `SELECT h.TSHT_NO, h.EMP_CODE, e.EMP_NAME, h.STATUS, IFNULL(h.TOTAL_SALARY, 0) AS TOTAL_SALARY,
              p.ACCRUED_SAL_AC, a.ACC_HEAD AS ACCRUED_HEAD,
              (SELECT MIN(t.VCHR_NO) FROM tran_acc t
                WHERE t.TRAN_TYPE = ? AND t.NARRATION2 = h.TSHT_NO AND t.VCHR_NO <> ?) AS POSTED_VCHR,
              (SELECT SUM(t.AMOUNT) FROM tran_acc t
                WHERE t.TRAN_TYPE = ? AND t.VCHR_NO = ? AND t.NARRATION2 = h.TSHT_NO AND t.DB_CR = 'D') AS SAVED_AMT
         FROM time_sheet_hdr h
         JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
         LEFT JOIN payroll_mst p ON p.EMP_CODE = h.EMP_CODE
         LEFT JOIN acc_mst a ON a.ACC_CODE = p.ACCRUED_SAL_AC
        WHERE e.EMP_CATG = ? AND h.TSHT_DATE = ?
        ORDER BY h.EMP_CODE`,
      [SALARY_JV_TYPE, own, SALARY_JV_TYPE, own, catg, month],
    );

    // deduction lines of these time sheets (tsht_ded) — each is credited to its AcCode (Cr)
    const tshtNos = all.map((r) => r.TSHT_NO);
    const dedRows = tshtNos.length
      ? await q(
          conn,
          `SELECT d.TSHT_NO, d.DED_CODE, m.DED_DESC, d.AMOUNT, d.ACC_CODE, a.ACC_HEAD
             FROM tsht_ded d
             LEFT JOIN ded_mst m ON m.DED_CODE = d.DED_CODE
             LEFT JOIN acc_mst a ON a.ACC_CODE = d.ACC_CODE
            WHERE d.TSHT_NO IN (?) AND d.AMOUNT > 0
            ORDER BY d.TSHT_NO, d.DED_CODE`,
          [tshtNos],
        )
      : [];
    // EDIT: the voucher's saved Cr lines, to tell a changed deduction (amount or account)
    const savedCr = own
      ? await q(conn, `SELECT NARRATION2 AS TSHT_NO, ACC_CODE, AMOUNT FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ? AND DB_CR = 'C'`, [SALARY_JV_TYPE, own])
      : [];
    const dedBySheet = new Map();
    for (const d of dedRows) {
      if (!dedBySheet.has(d.TSHT_NO)) dedBySheet.set(d.TSHT_NO, []);
      dedBySheet.get(d.TSHT_NO).push({
        DED_CODE: d.DED_CODE, DED_DESC: d.DED_DESC || '', AMOUNT: r2(d.AMOUNT),
        ACC_CODE: d.ACC_CODE ? String(d.ACC_CODE).trim() : '', ACC_HEAD: d.ACC_HEAD || '',
      });
    }
    for (const r of all) {
      const deds = dedBySheet.get(r.TSHT_NO) || [];
      r.DEDS = deds;
      r.DED_TOTAL = r2(deds.reduce((t, d) => t + d.AMOUNT, 0));
      r.GROSS = r2(r2(r.TOTAL_SALARY) + r.DED_TOTAL);
      r.DED_SIG = dedSig(deds);
      r.SAVED_DED_SIG =
        r.SAVED_AMT === null || r.SAVED_AMT === undefined
          ? null
          : dedSig(savedCr.filter((t) => t.TSHT_NO === r.TSHT_NO && t.ACC_CODE !== r.ACCRUED_SAL_AC));
    }

    const posted = all.filter((r) => r.POSTED_VCHR);
    const drafts = all.filter((r) => !r.POSTED_VCHR && r.STATUS === 'D');
    const zero = all.filter((r) => !r.POSTED_VCHR && r.STATUS !== 'D' && !(Number(r.TOTAL_SALARY) > 0));
    const sheets = all.filter((r) => !r.POSTED_VCHR && r.STATUS !== 'D' && Number(r.TOTAL_SALARY) > 0);

    // EDIT: sheets saved in this voucher that no longer qualify (sent back to draft, salary now 0, ...)
    let removed = [];
    if (own) {
      const inVchr = await q(
        conn,
        `SELECT NARRATION2 AS TSHT_NO, MAX(NARRATION1) AS NARRATION1, SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE 0 END) AS SAVED_AMT
           FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ? GROUP BY NARRATION2`,
        [SALARY_JV_TYPE, own],
      );
      const keep = new Set(sheets.map((s) => s.TSHT_NO));
      removed = inVchr.filter((r) => !keep.has(r.TSHT_NO));
    }
    return { catgRow: c, sheets, drafts, posted, zero, removed };
  }

  // ---------------------------------------------------------------------
  router.get('/salary-jv-list', withConn(async (conn, req, res) => {
    const rows = await q(
      conn,
      `SELECT a.VCHR_NO,
              DATE_FORMAT(IFNULL(h.VCHR_DATE, a.VCHR_DATE), '%Y-%m-%d') AS VCHR_DATE,
              IFNULL(h.CATG_CODE, e.EMP_CATG) AS CATG_CODE,
              c.catg_name AS CATG_NAME,
              DATE_FORMAT(IFNULL(h.SAL_MONTH, ts.TSHT_DATE), '%Y-%m-%d') AS SAL_MONTH,
              h.PARTICULARS, a.EMP_COUNT, a.DR_TOTAL, a.CR_TOTAL, a.LINE_CNT,
              IFNULL(h.UPDATED_BY, h.CREATED_BY) AS USER_NAME,
              (h.VCHR_NO IS NOT NULL) AS HAS_HDR
         FROM (SELECT VCHR_NO, MIN(DATTE) AS VCHR_DATE, MIN(NARRATION2) AS FIRST_TSHT,
                      COUNT(DISTINCT NARRATION2) AS EMP_COUNT, COUNT(*) AS LINE_CNT,
                      SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE 0 END) AS DR_TOTAL,
                      SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE 0 END) AS CR_TOTAL
                 FROM tran_acc WHERE TRAN_TYPE = ? GROUP BY VCHR_NO) a
         LEFT JOIN salary_jv_hdr h  ON h.TRAN_TYPE = ? AND h.VCHR_NO = a.VCHR_NO
         LEFT JOIN time_sheet_hdr ts ON ts.TSHT_NO = a.FIRST_TSHT
         LEFT JOIN emp_mst e        ON e.EMP_CODE = ts.EMP_CODE
         LEFT JOIN emp_catg_mst c   ON c.catg_code = IFNULL(h.CATG_CODE, e.EMP_CATG)
        ORDER BY a.VCHR_NO DESC`,
      [SALARY_JV_TYPE, SALARY_JV_TYPE],
    );
    res.json({ ok: true, rows: rows.map((r) => ({ ...r, HAS_HDR: !!Number(r.HAS_HDR) })) });
  }));

  router.get('/salary-jv/catgs', withConn(async (conn, req, res) => {
    const rows = await q(
      conn,
      `SELECT c.catg_code AS CATG_CODE, c.catg_name AS CATG_NAME, c.Salary_debit_ac AS DEBIT_AC, a.ACC_HEAD AS DEBIT_HEAD
         FROM emp_catg_mst c LEFT JOIN acc_mst a ON a.ACC_CODE = c.Salary_debit_ac
        ORDER BY c.catg_code`,
    );
    res.json({ ok: true, rows });
  }));

  router.get('/salary-jv/vchr/:vchrNo', withConn(async (conn, req, res) => {
    const vchrNo = String(req.params.vchrNo || '').trim();
    const [r] = await q(
      conn,
      `SELECT a.VCHR_NO,
              DATE_FORMAT(IFNULL(h.VCHR_DATE, a.VCHR_DATE), '%Y-%m-%d') AS VCHR_DATE,
              IFNULL(h.CATG_CODE, e.EMP_CATG) AS CATG_CODE,
              DATE_FORMAT(IFNULL(h.SAL_MONTH, ts.TSHT_DATE), '%Y-%m-%d') AS SAL_MONTH,
              h.PARTICULARS, (h.VCHR_NO IS NOT NULL) AS HAS_HDR
         FROM (SELECT VCHR_NO, MIN(DATTE) AS VCHR_DATE, MIN(NARRATION2) AS FIRST_TSHT
                 FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ? GROUP BY VCHR_NO) a
         LEFT JOIN salary_jv_hdr h  ON h.TRAN_TYPE = ? AND h.VCHR_NO = a.VCHR_NO
         LEFT JOIN time_sheet_hdr ts ON ts.TSHT_NO = a.FIRST_TSHT
         LEFT JOIN emp_mst e        ON e.EMP_CODE = ts.EMP_CODE`,
      [SALARY_JV_TYPE, vchrNo, SALARY_JV_TYPE],
    );
    if (!r) throw fail(404, `Salary JV ${vchrNo} not found`);
    res.json({ ok: true, hdr: { ...r, HAS_HDR: !!Number(r.HAS_HDR) } });
  }));

  // print data for ErpPdfTemplates SALJV — the saved voucher, never the screen
  router.get('/salary-jv/print/:vchrNo', withConn(async (conn, req, res) => {
    const vchrNo = String(req.params.vchrNo || '').trim();
    const items = await q(
      conn,
      `SELECT t.SR_NO, t.ACC_CODE, a.ACC_HEAD, t.NARRATION1, t.NARRATION2, t.DB_CR,
              CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE 0 END AS AMOUNT_DR,
              CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE 0 END AS AMOUNT_CR
         FROM tran_acc t LEFT JOIN acc_mst a ON a.ACC_CODE = t.ACC_CODE
        WHERE t.TRAN_TYPE = ? AND t.VCHR_NO = ?
        ORDER BY t.SR_NO`,
      [SALARY_JV_TYPE, vchrNo],
    );
    if (!items.length) throw fail(404, `Salary JV ${vchrNo} not found`);
    const [h] = await q(
      conn,
      `SELECT DATE_FORMAT(h.VCHR_DATE, '%d/%m/%Y') AS VCHR_DATE,
              IFNULL(h.CATG_CODE, e.EMP_CATG) AS CATG_CODE, c.catg_name AS CATG_NAME,
              DATE_FORMAT(IFNULL(h.SAL_MONTH, ts.TSHT_DATE), '%Y-%m-%d') AS SAL_MONTH, h.PARTICULARS
         FROM (SELECT 1) x
         LEFT JOIN salary_jv_hdr h  ON h.TRAN_TYPE = ? AND h.VCHR_NO = ?
         LEFT JOIN time_sheet_hdr ts ON ts.TSHT_NO = ?
         LEFT JOIN emp_mst e        ON e.EMP_CODE = ts.EMP_CODE
         LEFT JOIN emp_catg_mst c   ON c.catg_code = IFNULL(h.CATG_CODE, e.EMP_CATG)`,
      [SALARY_JV_TYPE, vchrNo, items[0].NARRATION2],
    );
    const [d] = await q(conn, `SELECT DATE_FORMAT(MIN(DATTE), '%d/%m/%Y') AS D FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?`, [SALARY_JV_TYPE, vchrNo]);
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const m = h.SAL_MONTH;
    res.json({
      ok: true,
      data: {
        hdr: {
          VCHR_NO: vchrNo,
          VCHR_DATE: h.VCHR_DATE || d.D,
          CATG_CODE: h.CATG_CODE, CATG_NAME: h.CATG_NAME,
          SAL_MONTH: m ? `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : '',
          PARTICULARS: h.PARTICULARS,
          EMP_COUNT: new Set(items.map((r) => r.NARRATION2)).size,
          PRINTED_BY: userOf(req),
        },
        items: items.map((r) => ({ ...r, AMOUNT_DR: Number(r.AMOUNT_DR) || 0, AMOUNT_CR: Number(r.AMOUNT_CR) || 0 })),
      },
    });
  }));

  router.get('/salary-jv/lines', withConn(async (conn, req, res) => {
    const catg = String(req.query.catg || '').trim().toUpperCase();
    const month = monthOf(req.query.month);
    if (!catg) throw fail(400, 'Select the employee category');
    if (!month) throw fail(400, 'Select the month');
    const r = await sheetsFor(conn, catg, month, String(req.query.vchr || '').trim());
    res.json({
      ok: true, month,
      debitAc: r.catgRow.DEBIT_AC || '', debitHead: r.catgRow.DEBIT_HEAD || '',
      sheets: r.sheets, drafts: r.drafts, posted: r.posted, zero: r.zero, removed: r.removed,
    });
  }));

  // ---------------------------------------------------------------------
  router.post('/salary-jv/save', withConn(async (conn, req, res) => {
    const b = req.body || {};
    const mode = String(b.mode || 'ADD').toUpperCase() === 'EDIT' ? 'EDIT' : 'ADD';
    const catg = String(b.catg || '').trim().toUpperCase();
    const month = monthOf(b.month);
    const particulars = b.particulars ? String(b.particulars).slice(0, 200) : null;
    const who = userOf(req);
    if (!catg) throw fail(400, 'Select the employee category');
    if (!month) throw fail(400, 'Select the month');
    if (mode === 'EDIT' && !b.vchrNo) throw fail(400, 'Voucher number missing');
    if (mode === 'ADD' && !isIso(b.vchrDate)) throw fail(400, 'Voucher date missing');
    if (b.vchrDate && !isIso(b.vchrDate)) throw fail(400, 'Voucher date is not valid');

    for (let attempt = 0; ; attempt += 1) {
      try {
        await q(conn, 'START TRANSACTION');
        await assertPayrollOpen((sql, p) => q(conn, sql, p), month, mode === 'ADD' ? 'Posting a Salary JV' : 'Changing this Salary JV');
        let vchrNo = mode === 'EDIT' ? String(b.vchrNo).trim() : '';
        let vchrDate = b.vchrDate;

        if (mode === 'EDIT') {
          // lock the voucher: header row if it has one, else its lines
          const [h] = await q(conn, `SELECT DATE_FORMAT(VCHR_DATE, '%Y-%m-%d') AS VCHR_DATE FROM salary_jv_hdr WHERE TRAN_TYPE = ? AND VCHR_NO = ? FOR UPDATE`, [SALARY_JV_TYPE, vchrNo]);
          const [t] = await q(conn, `SELECT DATE_FORMAT(MIN(DATTE), '%Y-%m-%d') AS VCHR_DATE, COUNT(*) AS N FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ? FOR UPDATE`, [SALARY_JV_TYPE, vchrNo]);
          if (!h && !Number(t.N)) throw fail(404, `Salary JV ${vchrNo} no longer exists`);
          // the date chosen on the screen; without one the voucher keeps its saved date
          vchrDate = isIso(b.vchrDate) ? b.vchrDate : (h && h.VCHR_DATE) || t.VCHR_DATE;
        }

        // the posting date must be inside the current accounting period (ac_period: one row)
        const [per] = await q(
          conn,
          `SELECT DATE_FORMAT(START_DATE, '%Y-%m-%d') AS F, DATE_FORMAT(END_DATE, '%Y-%m-%d') AS T FROM ac_period LIMIT 1`,
        );
        if (per && per.F && per.T && (vchrDate < per.F || vchrDate > per.T)) {
          const d = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
          throw fail(400, `Vchr. Date ${d(vchrDate)} is outside the accounting period ${d(per.F)} – ${d(per.T)}`);
        }

        const s = await sheetsFor(conn, catg, month, mode === 'EDIT' ? vchrNo : '');
        if (!s.sheets.length) {
          throw fail(400, mode === 'EDIT'
            ? 'No processed time sheets are left for this JV — delete the voucher from the list instead'
            : 'There are no processed time sheets to post');
        }
        // the lines the user saw must still be the lines we are about to write
        //   (gross amount + the deductions per account, so a changed deduction or AcCode (Cr) is caught too)
        const expect = new Map(
          (Array.isArray(b.expect) ? b.expect : []).map((x) => [String(x.TSHT_NO), { amt: r2(x.AMOUNT), sig: String(x.DED_SIG ?? '') }]),
        );
        const changed =
          s.sheets.length !== expect.size ||
          s.sheets.some((x) => {
            const e = expect.get(x.TSHT_NO);
            return !e || e.amt !== x.GROSS || e.sig !== x.DED_SIG;
          });
        if (changed) throw fail(409, 'The time sheets changed while you were on this screen (posted by another user, re-processed or amended). The lines have been refreshed — check and save again.');

        const debitAc = s.catgRow.DEBIT_AC;
        if (!debitAc) throw fail(400, `No Salary Debit A/c for category ${catg} (emp_catg_mst)`);
        const noAccrual = s.sheets.filter((x) => !x.ACCRUED_SAL_AC);
        if (noAccrual.length) throw fail(400, `No Accrued Sal A/c (Employee Master → Payroll) for ${noAccrual.map((x) => x.EMP_CODE).join(', ')}`);
        // every deduction must name a valid account to credit (Time Sheet → Deductions → AcCode (Cr))
        const badDed = [];
        for (const x of s.sheets) {
          for (const d of x.DEDS) {
            if (!d.ACC_CODE) badDed.push(`${x.TSHT_NO} ded ${d.DED_CODE}: AcCode (Cr) not set`);
            else if (!d.ACC_HEAD) badDed.push(`${x.TSHT_NO} ded ${d.DED_CODE}: ${d.ACC_CODE} not in acc_mst`);
          }
        }
        if (badDed.length) throw fail(400, `Correct the deductions on the Time Sheet first — ${badDed.join('; ')}`);

        const total = r2(s.sheets.reduce((t, x) => t + x.GROSS, 0)); // Dr total = Cr total

        if (mode === 'ADD') {
          const [m] = await q(
            conn,
            `SELECT GREATEST(
                      IFNULL((SELECT MAX(CAST(VCHR_NO AS UNSIGNED)) FROM tran_acc WHERE TRAN_TYPE = ?), 0),
                      IFNULL((SELECT MAX(CAST(VCHR_NO AS UNSIGNED)) FROM salary_jv_hdr WHERE TRAN_TYPE = ?), 0)) AS MX`,
            [SALARY_JV_TYPE, SALARY_JV_TYPE],
          );
          vchrNo = String(Number(m.MX || 0) + 1).padStart(10, '0');
          await q(
            conn,
            `INSERT INTO salary_jv_hdr (TRAN_TYPE, VCHR_NO, VCHR_DATE, CATG_CODE, SAL_MONTH, PARTICULARS, DEBIT_AC, EMP_COUNT, TOTAL_AMT, CREATED_BY, CREATED_DT)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [SALARY_JV_TYPE, vchrNo, vchrDate, catg, month, particulars, debitAc, s.sheets.length, total, who],
          );
        } else {
          await q(
            conn,
            `INSERT INTO salary_jv_hdr (TRAN_TYPE, VCHR_NO, VCHR_DATE, CATG_CODE, SAL_MONTH, PARTICULARS, DEBIT_AC, EMP_COUNT, TOTAL_AMT, CREATED_BY, CREATED_DT)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE VCHR_DATE = VALUES(VCHR_DATE),
                                     PARTICULARS = VALUES(PARTICULARS), DEBIT_AC = VALUES(DEBIT_AC), EMP_COUNT = VALUES(EMP_COUNT),
                                     TOTAL_AMT = VALUES(TOTAL_AMT), UPDATED_BY = ?, UPDATED_DT = NOW()`,
            [SALARY_JV_TYPE, vchrNo, vchrDate, catg, month, particulars, debitAc, s.sheets.length, total, who, who],
          );
          await q(conn, 'DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?', [SALARY_JV_TYPE, vchrNo]);
        }

        // tran_acc lines per time sheet, Emp Code order:
        //   Dr Salary (gross) · Cr each deduction to its AcCode (Cr) · Cr Accrued Salary (net)
        const values = [];
        let sr = 0;
        for (const x of s.sheets) {
          const net = r2(x.TOTAL_SALARY);
          const n1 = `${x.EMP_NAME} - ${mmyyyy(month)}`.slice(0, 200);
          values.push([SALARY_JV_TYPE, vchrNo, vchrDate, ++sr, debitAc, null, n1, x.TSHT_NO, x.GROSS, 'D']);
          for (const d of x.DEDS) {
            const n1d = `${d.DED_DESC || `Deduction ${d.DED_CODE}`} - ${x.EMP_NAME} - ${mmyyyy(month)}`.slice(0, 200);
            values.push([SALARY_JV_TYPE, vchrNo, vchrDate, ++sr, d.ACC_CODE, null, n1d, x.TSHT_NO, d.AMOUNT, 'C']);
          }
          values.push([SALARY_JV_TYPE, vchrNo, vchrDate, ++sr, x.ACCRUED_SAL_AC, null, n1, x.TSHT_NO, net, 'C']);
        }
        await q(
          conn,
          'INSERT INTO tran_acc (TRAN_TYPE, VCHR_NO, DATTE, SR_NO, ACC_CODE, REF_NO, NARRATION1, NARRATION2, AMOUNT, DB_CR) VALUES ?',
          [values],
        );
        await q(conn, 'COMMIT');
        console.log(`[salary-jv] ${who} ${mode === 'ADD' ? 'added' : 'updated'} ${vchrNo} — ${catg} ${mmyyyy(month)}, ${s.sheets.length} employee(s), ${total}`);
        return res.json({ ok: true, vchrNo, employees: s.sheets.length, total, message: `Salary JV ${vchrNo} ${mode === 'ADD' ? 'saved' : 'updated'} — ${s.sheets.length} employee(s), ${total.toFixed(2)}` });
      } catch (e) {
        await q(conn, 'ROLLBACK').catch(() => {});
        // another user took this number a moment ago — take the next one
        if (mode === 'ADD' && e.code === 'ER_DUP_ENTRY' && attempt < 3) continue;
        throw e;
      }
    }
  }));

  router.post('/salary-jv/delete', withConn(async (conn, req, res) => {
    const vchrNo = String((req.body || {}).vchrNo || '').trim();
    if (!vchrNo) throw fail(400, 'Voucher number missing');
    await q(conn, 'START TRANSACTION');
    // salary month of the voucher: its header, else its first time sheet
    const [m] = await q(
      conn,
      `SELECT DATE_FORMAT(IFNULL(h.SAL_MONTH, ts.TSHT_DATE), '%Y-%m-%d') AS SAL_MONTH
         FROM (SELECT MIN(NARRATION2) AS FIRST_TSHT FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?) a
         LEFT JOIN salary_jv_hdr h  ON h.TRAN_TYPE = ? AND h.VCHR_NO = ?
         LEFT JOIN time_sheet_hdr ts ON ts.TSHT_NO = a.FIRST_TSHT`,
      [SALARY_JV_TYPE, vchrNo, SALARY_JV_TYPE, vchrNo],
    );
    if (m && m.SAL_MONTH) await assertPayrollOpen((sql, p) => q(conn, sql, p), m.SAL_MONTH, `Deleting Salary JV ${vchrNo}`);
    const del = await q(conn, 'DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?', [SALARY_JV_TYPE, vchrNo]);
    const delH = await q(conn, 'DELETE FROM salary_jv_hdr WHERE TRAN_TYPE = ? AND VCHR_NO = ?', [SALARY_JV_TYPE, vchrNo]);
    if (!del.affectedRows && !delH.affectedRows) throw fail(404, `Salary JV ${vchrNo} not found`);
    await q(conn, 'COMMIT');
    console.log(`[salary-jv] ${userOf(req)} deleted ${vchrNo} (${del.affectedRows} line(s))`);
    res.json({ ok: true, message: `Salary JV ${vchrNo} deleted — its time sheets can be posted again` });
  }));

  return router;
};
