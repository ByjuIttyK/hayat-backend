// routes/hrReportsApi.js — H.R Reports (Payroll › H.R Reports)
// Register in HayatDb.js:
//   const hrReportsApi = require("./routes/hrReportsApi");
//   app.use("/api", hrReportsApi(connection));
//
// GET /api/hr-rpt/lookups
//       -> { catgs: [{ code, name }], docTypes: [{ code, name, remindDays }] }
// GET /api/hr-rpt/doc-expiry?catg=M,S,W&status=A,L&docs=VISA,PASSPORT&mode=DUE&days=60&asOn=yyyy-mm-dd
//       mode: EXPIRED (expiry before asOn) | DUE (asOn .. asOn+days) | BOTH (up to asOn+days) | ALL
//       -> { asOn, rows: [{ EMP_CODE, EMP_NAME, EMP_CATG, DEPT_NAME, TRADE_NAME, NATION_CODE,
//                           DOC_TYPE, DOC_NAME, DOC_NO, ISSUE_DT, EXPIRY_DT, ISSUE_PLACE, DAYS_LEFT }] }
// GET /api/hr-rpt/emp-list?catg=M,S,W&status=A,L[&withSal=1]
//       withSal=1 adds BASIC_SAL (payroll_mst), ALLOW_AMT (sum of emp_allow_mst) and TOTAL_SAL
//       -> { rows: [{ EMP_CODE, EMP_NAME, EMP_CATG, CATG_NAME, EMP_STATUS, CARD_NO, GENDER, NATION_CODE,
//                     DEPT_CODE, DEPT_NAME, TRADE_CODE, TRADE_NAME, BIRTH_DT, APPT_DT, BLOOD_GROUP,
//                     MOBILE_NO, PAY_MODE, BANK_NAME, IBAN }] }
// Grouping (department / trade / nation / blood group / bank) is done on the screen.
const express = require("express");

const STATUSES = ["A", "L", "R", "T", "X"];

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
    );
  const fail = (res, e) => res.status(e.status || 500).json({ message: e.sqlMessage || e.message });

  // comma list from the query string, upper-cased, only allowed characters
  const list = (v, re = /^[A-Z0-9_]{1,10}$/) =>
    String(v || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => re.test(s));

  // category filter is mandatory on every report
  const catgsOf = (req) => {
    const c = list(req.query.catg);
    if (!c.length) throw Object.assign(new Error("Select at least one employee category"), { status: 400 });
    return c;
  };
  const statusesOf = (req) => {
    const s = list(req.query.status).filter((x) => STATUSES.includes(x));
    return s.length ? s : ["A", "L"];
  };

  // ---------- lookups ----------
  router.get("/hr-rpt/lookups", async (req, res) => {
    try {
      const [catgs, docTypes] = await Promise.all([
        q(`SELECT catg_code AS code, catg_name AS name FROM emp_catg_mst ORDER BY catg_code`),
        q(`SELECT DOC_TYPE AS code, DOC_NAME AS name, REMIND_DAYS AS remindDays
             FROM doc_type_mst WHERE APPLIES_TO = 'E' ORDER BY DOC_NAME`),
      ]);
      res.json({ catgs, docTypes });
    } catch (e) { fail(res, e); }
  });

  // ---------- document expiry ----------
  router.get("/hr-rpt/doc-expiry", async (req, res) => {
    try {
      const catgs = catgsOf(req);
      const statuses = statusesOf(req);
      const docs = list(req.query.docs);
      const mode = ["EXPIRED", "DUE", "BOTH", "ALL"].includes(String(req.query.mode).toUpperCase())
        ? String(req.query.mode).toUpperCase() : "BOTH";
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 0), 3650);
      const asOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.asOn || "")) ? String(req.query.asOn) : null;

      const where = ["e.EMP_CATG IN (?)", "e.EMP_STATUS IN (?)", "d.EXPIRY_DT IS NOT NULL"];
      const params = [catgs, statuses];
      if (docs.length) { where.push("d.DOC_TYPE IN (?)"); params.push(docs); }
      const base = asOn ? "?" : "CURDATE()";
      const baseP = asOn ? [asOn] : [];
      if (mode === "EXPIRED") { where.push(`d.EXPIRY_DT < ${base}`); params.push(...baseP); }
      if (mode === "DUE") {
        where.push(`d.EXPIRY_DT >= ${base} AND d.EXPIRY_DT <= ${base} + INTERVAL ? DAY`);
        params.push(...baseP, ...baseP, days);
      }
      if (mode === "BOTH") { where.push(`d.EXPIRY_DT <= ${base} + INTERVAL ? DAY`); params.push(...baseP, days); }

      const rows = await q(
        `SELECT e.EMP_CODE, e.EMP_NAME, e.EMP_CATG, e.NATION_CODE,
                dp.DEPT_NAME, t.TRADE_NAME,
                d.DOC_TYPE, dt.DOC_NAME, d.DOC_NO, d.ISSUE_PLACE,
                DATE_FORMAT(d.ISSUE_DT,  '%d/%m/%Y') AS ISSUE_DT,
                DATE_FORMAT(d.EXPIRY_DT, '%d/%m/%Y') AS EXPIRY_DT,
                DATEDIFF(d.EXPIRY_DT, ${base}) AS DAYS_LEFT
           FROM emp_docs d
           JOIN emp_mst e       ON e.EMP_CODE = d.EMP_CODE
           JOIN doc_type_mst dt ON dt.DOC_TYPE = d.DOC_TYPE
           LEFT JOIN dept_mst dp  ON dp.DEPT_CODE = e.DEPT_CODE
           LEFT JOIN trade_mst t  ON t.TRADE_CODE = e.TRADE_CODE
          WHERE ${where.join(" AND ")}
          ORDER BY d.EXPIRY_DT, e.EMP_CODE`,
        [...baseP, ...params]
      );
      res.json({ asOn: asOn || null, rows });
    } catch (e) { fail(res, e); }
  });

  // ---------- employee list (grouped on the screen) ----------
  router.get("/hr-rpt/emp-list", async (req, res) => {
    try {
      const catgs = catgsOf(req);
      const statuses = statusesOf(req);
      // salary only when asked for: basic (payroll_mst) + fixed monthly allowances (emp_allow_mst)
      const withSal = String(req.query.withSal || "") === "1";
      const salCols = withSal
        ? `, COALESCE(p.BASIC_SAL, 0) AS BASIC_SAL, COALESCE(al.ALLOW_AMT, 0) AS ALLOW_AMT,
             COALESCE(p.BASIC_SAL, 0) + COALESCE(al.ALLOW_AMT, 0) AS TOTAL_SAL`
        : "";
      const salJoin = withSal
        ? `LEFT JOIN (SELECT emp_code, SUM(amount) AS ALLOW_AMT FROM emp_allow_mst GROUP BY emp_code) al
                  ON al.emp_code = e.EMP_CODE`
        : "";
      const rows = await q(
        `SELECT e.EMP_CODE, e.EMP_NAME, e.EMP_CATG, c.catg_name AS CATG_NAME, e.EMP_STATUS,
                e.CARD_NO, e.GENDER, e.NATION_CODE,
                e.DEPT_CODE, dp.DEPT_NAME, e.TRADE_CODE, t.TRADE_NAME,
                DATE_FORMAT(e.BIRTH_DT, '%d/%m/%Y') AS BIRTH_DT,
                DATE_FORMAT(e.APPT_DT,  '%d/%m/%Y') AS APPT_DT,
                h.BLOOD_GROUP, h.MOBILE_NO,
                p.PAY_MODE, p.BANK_NAME, p.IBAN
                ${salCols}
           FROM emp_mst e
           LEFT JOIN emp_catg_mst c ON c.catg_code = e.EMP_CATG
           LEFT JOIN dept_mst dp    ON dp.DEPT_CODE = e.DEPT_CODE
           LEFT JOIN trade_mst t    ON t.TRADE_CODE = e.TRADE_CODE
           LEFT JOIN hr_mst h       ON h.EMP_CODE = e.EMP_CODE
           LEFT JOIN payroll_mst p  ON p.EMP_CODE = e.EMP_CODE
           ${salJoin}
          WHERE e.EMP_CATG IN (?) AND e.EMP_STATUS IN (?)
          ORDER BY e.EMP_CODE`,
        [catgs, statuses]
      );
      res.json({ rows });
    } catch (e) { fail(res, e); }
  });

  return router;
};
