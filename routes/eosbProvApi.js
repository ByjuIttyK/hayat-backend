// routes/eosbProvApi.js
// Gratuity & Leave Salary year-end provision (EosbProv screen)
// Register in HayatDb.js:  app.use("/api", require("./routes/eosbProvApi")(connection));

const express = require("express");

/* ==================== ADJUST HERE if your names differ ==================== */
// How emp_catg_mst points at its salary scheme (checked against DESC – correct)
const SCHEME_JOIN = "LEFT JOIN sal_scheme_mst s ON s.SCHEME_CODE = c.SAL_SCHEME";
// New tran types for the provision JVs (Salary JV is 15)
const TRAN_TYPE = { G: "16", L: "17" };
// tran_acc insert – columns as per DESC tran_acc
const TA_INSERT =
  "INSERT INTO tran_acc (TRAN_TYPE, VCHR_NO, SR_NO, MAIN_SR_NO, DATTE, ACC_CODE, DB_CR, AMOUNT, AMOUNT_FC, AMT_SETTLED, " +
  "NARRATION1, NARRATION2, REF_NO, USERNAME, TRANS_DATE, TRANS_TIME) VALUES ?";
// Only this user may un-post (same rule as the time sheet approvals)
const ADMIN_USER = "admin";
/* ========================================================================== */

const TYPES = ["G", "L"];
const TYPE_NAME = { G: "Gratuity", L: "Leave salary" };
const isIso = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const userOf = (req) =>
  (req.user && (req.user.username || req.user.user_name || req.user.USER_ID)) ||
  (req.body && req.body.user) ||
  null;
const fail = (res, code, message) => res.status(code).json({ success: false, message });
const D = (col, alias) => `DATE_FORMAT(${col}, '%Y-%m-%d') AS ${alias || col.split(".").pop()}`;

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  /* ---------- screen start-up: period, company, categories ---------- */
  router.get("/eosb-prov/init", async (req, res) => {
    try {
      const [[period]] = await db.query(
        `SELECT ${D("START_DATE")}, ${D("END_DATE")} FROM ac_period LIMIT 1`
      );
      const [[comp]] = await db.query("SELECT NAME FROM company LIMIT 1");
      const [catgs] = await db.query(
        `SELECT c.catg_code AS CATG_CODE, c.catg_name AS CATG_NAME,
                COALESCE(s.GRAT_DAY_BASIS, '30') AS DAY_BASIS,
                c.GRAT_EXP_AC, c.GRAT_PROV_AC, c.LS_EXP_AC, c.LS_PROV_AC
           FROM emp_catg_mst c ${SCHEME_JOIN}
          ORDER BY c.catg_code`
      );
      res.json({ success: true, period: period || {}, company: (comp && comp.NAME) || "", catgs });
    } catch (e) {
      console.error("eosb-prov/init", e);
      fail(res, 500, e.message);
    }
  });

  /* ---------- saved runs for the "Open run" dropdown ---------- */
  router.get("/eosb-prov/runs", async (req, res) => {
    const { type } = req.query;
    if (!TYPES.includes(type)) return fail(res, 400, "Invalid type");
    try {
      const [rows] = await db.query(
        `SELECT PROV_TYPE, PROV_NO, EMP_CATG, ${D("FROM_DT")}, ${D("AS_ON_DT")},
                TOTAL_LIAB, TOTAL_PROV, STATUS, VCHR_NO
           FROM eosb_prov_hdr WHERE PROV_TYPE = ?
          ORDER BY AS_ON_DT DESC, PROV_NO DESC`,
        [type]
      );
      res.json({ success: true, rows });
    } catch (e) {
      console.error("eosb-prov/runs", e);
      fail(res, 500, e.message);
    }
  });

  /* ---------- source data for Calculate ---------- */
  // employees of the category in service at any time in [fromDt, asOn],
  // basic + fixed allowances, and the opening position per employee
  router.get("/eosb-prov/source", async (req, res) => {
    const { type, catg, fromDt, asOn } = req.query;
    if (!TYPES.includes(type) || !catg || !isIso(fromDt) || !isIso(asOn))
      return fail(res, 400, "Type, category, from date and as-on date are required");
    try {
      const [emps] = await db.query(
        `SELECT e.EMP_CODE, e.EMP_NAME, ${D("e.APPT_DT")}, ${D("e.EXIT_DT")},
                p.BASIC_SAL, COALESCE(a.ALLOW_AMT, 0) AS ALLOW_AMT
           FROM emp_mst e
           JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
           LEFT JOIN (SELECT emp_code, SUM(amount) AS ALLOW_AMT
                        FROM emp_allow_mst GROUP BY emp_code) a ON a.emp_code = e.EMP_CODE
          WHERE e.EMP_CATG = ?
            AND e.APPT_DT IS NOT NULL AND e.APPT_DT <= ?
            AND (e.EXIT_DT IS NULL OR e.EXIT_DT >= ?)
          ORDER BY e.EMP_CODE`,
        [catg, asOn, fromDt]
      );
      if (!emps.length) return res.json({ success: true, rows: [] });
      const codes = emps.map((e) => e.EMP_CODE);

      // latest earlier run per employee (draft or posted)
      const [prev] = await db.query(
        `SELECT * FROM (
           SELECT d.EMP_CODE, d.CLOSING, d.UNPAID_DAYS, ${D("d.LS_FROM_DT")}, d.BF_BAL,
                  ${D("h.AS_ON_DT", "PREV_AS_ON")}, h.STATUS AS PREV_STATUS,
                  ROW_NUMBER() OVER (PARTITION BY d.EMP_CODE ORDER BY h.AS_ON_DT DESC, h.PROV_NO DESC) AS rn
             FROM eosb_prov_dtl d
             JOIN eosb_prov_hdr h ON h.PROV_TYPE = d.PROV_TYPE AND h.PROV_NO = d.PROV_NO
            WHERE h.PROV_TYPE = ? AND h.AS_ON_DT < ? AND d.EMP_CODE IN (?)
         ) x WHERE x.rn = 1`,
        [type, asOn, codes]
      );
      const [ob] = await db.query(
        `SELECT EMP_CODE, OP_AMT, UNPAID_DAYS, ${D("LS_PAID_TILL")}, LS_BF_BAL, ${D("AS_ON_DT")}
           FROM emp_eosb_opbal WHERE PROV_TYPE = ? AND AS_ON_DT < ? AND EMP_CODE IN (?)`,
        [type, asOn, codes]
      );
      const prevMap = Object.fromEntries(prev.map((p) => [p.EMP_CODE, p]));
      const obMap = Object.fromEntries(ob.map((o) => [o.EMP_CODE, o]));

      const rows = emps.map((e) => {
        const p = prevMap[e.EMP_CODE];
        const o = obMap[e.EMP_CODE];
        return {
          ...e,
          BASIC_SAL: n(e.BASIC_SAL),
          ALLOW_AMT: n(e.ALLOW_AMT),
          OPENING: p ? n(p.CLOSING) : o ? n(o.OP_AMT) : 0,
          UNPAID_DAYS: p ? n(p.UNPAID_DAYS) : o ? n(o.UNPAID_DAYS) : 0,
          LS_FROM_DT: p ? p.LS_FROM_DT : o ? o.LS_PAID_TILL : null,
          BF_BAL: p ? n(p.BF_BAL) : o ? n(o.LS_BF_BAL) : 0,
          SETTLED: 0,
          OPEN_SRC: p ? `Run ${dmy(p.PREV_AS_ON)}${p.PREV_STATUS === "P" ? "" : " (draft)"}` : o ? `Op.bal ${dmy(o.AS_ON_DT)}` : "",
        };
      });
      res.json({ success: true, rows });
    } catch (e) {
      console.error("eosb-prov/source", e);
      fail(res, 500, e.message);
    }
  });

  /* ---------- load one saved run ---------- */
  router.get("/eosb-prov/run/:type/:provNo", async (req, res) => {
    const { type, provNo } = req.params;
    if (!TYPES.includes(type)) return fail(res, 400, "Invalid type");
    try {
      const [[hdr]] = await db.query(
        `SELECT h.*, ${D("h.FROM_DT")}, ${D("h.AS_ON_DT")}
           FROM eosb_prov_hdr h WHERE h.PROV_TYPE = ? AND h.PROV_NO = ?`,
        [type, provNo]
      );
      if (!hdr) return fail(res, 404, "Provision run not found");
      const [rows] = await db.query(
        `SELECT d.*, e.EMP_NAME, ${D("d.APPT_DT")}, ${D("d.EXIT_DT")}, ${D("d.END_DT")}, ${D("d.LS_FROM_DT")}
           FROM eosb_prov_dtl d LEFT JOIN emp_mst e ON e.EMP_CODE = d.EMP_CODE
          WHERE d.PROV_TYPE = ? AND d.PROV_NO = ? ORDER BY d.SR_NO`,
        [type, provNo]
      );
      const num = ["BASIC_SAL", "ALLOW_AMT", "SAL_BASIS", "YEARS", "ACCRUED", "BF_BAL", "LIABILITY", "OPENING", "SETTLED", "PROVISION", "CLOSING"];
      rows.forEach((r) => num.forEach((k) => (r[k] = n(r[k]))));
      res.json({ success: true, hdr, rows });
    } catch (e) {
      console.error("eosb-prov/run", e);
      fail(res, 500, e.message);
    }
  });

  /* ---------- save (ADD or re-save a draft) ---------- */
  router.post("/eosb-prov/save", async (req, res) => {
    const { type, provNo, hdr, rows } = req.body || {};
    if (!TYPES.includes(type)) return fail(res, 400, "Invalid type");
    if (!hdr || !hdr.EMP_CATG || !isIso(hdr.FROM_DT) || !isIso(hdr.AS_ON_DT))
      return fail(res, 400, "Category, from date and as-on date are required");
    if (hdr.FROM_DT > hdr.AS_ON_DT) return fail(res, 400, "From date is after the as-on date");
    if (!Array.isArray(rows) || !rows.length) return fail(res, 400, "Nothing to save – press Calculate first");

    const user = userOf(req);
    const totLiab = r2(rows.reduce((s, r) => s + n(r.LIABILITY), 0));
    const totProv = r2(rows.reduce((s, r) => s + n(r.PROVISION), 0));
    const hdrVals = [
      hdr.EMP_CATG, hdr.FROM_DT, hdr.AS_ON_DT, String(hdr.DAY_BASIS || "30"),
      n(hdr.LS_DAYS_PA) || 30, hdr.INCL_ALLOW === "N" ? "N" : "Y", hdr.ACCRUE_U1Y === "Y" ? "Y" : "N",
      totLiab, totProv, hdr.REMARKS || null,
    ];

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      let no = provNo ? Number(provNo) : null;

      const [dup] = await conn.query(
        "SELECT PROV_NO FROM eosb_prov_hdr WHERE PROV_TYPE = ? AND EMP_CATG = ? AND AS_ON_DT = ? AND PROV_NO <> ?",
        [type, hdr.EMP_CATG, hdr.AS_ON_DT, no || 0]
      );
      if (dup.length)
        throw new Error(`${TYPE_NAME[type]} run No. ${dup[0].PROV_NO} already exists for this category and as-on date`);

      if (no) {
        const [[h]] = await conn.query(
          "SELECT STATUS FROM eosb_prov_hdr WHERE PROV_TYPE = ? AND PROV_NO = ? FOR UPDATE",
          [type, no]
        );
        if (!h) throw new Error("Provision run not found");
        if (h.STATUS === "P") throw new Error("This run is posted – un-post it before changing");
        await conn.query(
          `UPDATE eosb_prov_hdr SET EMP_CATG=?, FROM_DT=?, AS_ON_DT=?, DAY_BASIS=?, LS_DAYS_PA=?,
                  INCL_ALLOW=?, ACCRUE_U1Y=?, TOTAL_LIAB=?, TOTAL_PROV=?, REMARKS=?, MODIFIED_BY=?
            WHERE PROV_TYPE=? AND PROV_NO=?`,
          [...hdrVals, user, type, no]
        );
        await conn.query("DELETE FROM eosb_prov_dtl WHERE PROV_TYPE = ? AND PROV_NO = ?", [type, no]);
      } else {
        // MAX+1 inside the transaction, PK catches a clash, retry (save-fabinv pattern)
        for (let attempt = 0; ; attempt++) {
          const [[m]] = await conn.query(
            "SELECT COALESCE(MAX(PROV_NO), 0) + 1 AS NX FROM eosb_prov_hdr WHERE PROV_TYPE = ?",
            [type]
          );
          no = m.NX;
          try {
            await conn.query(
              `INSERT INTO eosb_prov_hdr (PROV_TYPE, PROV_NO, EMP_CATG, FROM_DT, AS_ON_DT, DAY_BASIS, LS_DAYS_PA,
                      INCL_ALLOW, ACCRUE_U1Y, TOTAL_LIAB, TOTAL_PROV, REMARKS, STATUS, CREATED_BY)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'D', ?)`,
              [type, no, ...hdrVals, user]
            );
            break;
          } catch (err) {
            if (err.code === "ER_DUP_ENTRY" && attempt < 3 && /PRIMARY/.test(err.message)) continue;
            throw err;
          }
        }
      }

      const dtl = rows.map((r, i) => [
        type, no, i + 1, r.EMP_CODE,
        r.APPT_DT || null, r.EXIT_DT || null, r.END_DT || null,
        n(r.BASIC_SAL), n(r.ALLOW_AMT), n(r.SAL_BASIS), r.LS_FROM_DT || null,
        Math.round(n(r.SERVICE_DAYS)), Math.round(n(r.UNPAID_DAYS)), n(r.YEARS),
        r2(r.ACCRUED), r2(r.BF_BAL), r2(r.LIABILITY), r2(r.OPENING), r2(r.SETTLED),
        r2(r.PROVISION), r2(r.CLOSING), (r.NOTE || "").slice(0, 80) || null,
      ]);
      await conn.query(
        `INSERT INTO eosb_prov_dtl (PROV_TYPE, PROV_NO, SR_NO, EMP_CODE, APPT_DT, EXIT_DT, END_DT,
                BASIC_SAL, ALLOW_AMT, SAL_BASIS, LS_FROM_DT, SERVICE_DAYS, UNPAID_DAYS, YEARS,
                ACCRUED, BF_BAL, LIABILITY, OPENING, SETTLED, PROVISION, CLOSING, NOTE) VALUES ?`,
        [dtl]
      );

      await conn.commit();
      res.json({ success: true, provNo: no, message: `${TYPE_NAME[type]} run No. ${no} saved` });
    } catch (e) {
      await conn.rollback();
      console.error("eosb-prov/save", e);
      fail(res, 400, e.message);
    } finally {
      conn.release();
    }
  });

  /* ---------- post JV: Dr expense / Cr provision per employee ---------- */
  router.post("/eosb-prov/post/:type/:provNo", async (req, res) => {
    const { type, provNo } = req.params;
    if (!TYPES.includes(type)) return fail(res, 400, "Invalid type");
    const user = userOf(req);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[h]] = await conn.query(
        `SELECT h.*, ${D("h.AS_ON_DT", "AS_ON_ISO")} FROM eosb_prov_hdr h
          WHERE h.PROV_TYPE = ? AND h.PROV_NO = ? FOR UPDATE`,
        [type, provNo]
      );
      if (!h) throw new Error("Provision run not found");
      if (h.STATUS === "P") throw new Error(`Already posted – voucher ${h.VCHR_NO}`);

      const [[c]] = await conn.query(
        "SELECT GRAT_EXP_AC, GRAT_PROV_AC, LS_EXP_AC, LS_PROV_AC FROM emp_catg_mst WHERE catg_code = ?",
        [h.EMP_CATG]
      );
      const expAc = c && (type === "G" ? c.GRAT_EXP_AC : c.LS_EXP_AC);
      const catgProvAc = c && (type === "G" ? c.GRAT_PROV_AC : c.LS_PROV_AC);
      if (!expAc)
        throw new Error(`Set the ${TYPE_NAME[type]} expense account on Employee Category ${h.EMP_CATG}`);

      // provision (Cr) account: employee's own account in payroll_mst, else the category's
      const [rows] = await conn.query(
        `SELECT d.EMP_CODE, e.EMP_NAME, d.PROVISION,
                ${type === "G" ? "p.GRAT_PROV_AC" : "p.LS_PROV_AC"} AS EMP_PROV_AC
           FROM eosb_prov_dtl d
           LEFT JOIN emp_mst e ON e.EMP_CODE = d.EMP_CODE
           LEFT JOIN payroll_mst p ON p.EMP_CODE = d.EMP_CODE
          WHERE d.PROV_TYPE = ? AND d.PROV_NO = ? AND d.PROVISION <> 0 ORDER BY d.SR_NO`,
        [type, provNo]
      );
      if (!rows.length) throw new Error("No provision amounts to post");
      const noAc = rows.filter((r) => !(r.EMP_PROV_AC || catgProvAc)).map((r) => r.EMP_CODE);
      if (noAc.length)
        throw new Error(
          `${TYPE_NAME[type]} provision account missing for ${noAc.join(", ")} – set it in Employee Master (payroll) or on Category ${h.EMP_CATG}`
        );

      const tranType = TRAN_TYPE[type];
      const [[v]] = await conn.query(
        "SELECT COALESCE(MAX(CAST(VCHR_NO AS UNSIGNED)), 0) + 1 AS NX FROM tran_acc WHERE TRAN_TYPE = ? FOR UPDATE",
        [tranType]
      );
      const vchrNo = String(v.NX);
      const [[per]] = await conn.query(
        "SELECT Main_sr_no AS MAIN_SR_NO, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS TODAY, DATE_FORMAT(NOW(), '%H:%i:%s') AS NOWT FROM ac_period LIMIT 1"
      );
      const mainSr = per ? per.MAIN_SR_NO : null;
      const refNo = `${type === "G" ? "GRAT" : "LSAL"}-${provNo}`;
      const asOnTxt = dmy(h.AS_ON_ISO);
      const narr2 = `${type === "G" ? "GRAT" : "LSAL"} PROV ${provNo} / CATG ${h.EMP_CATG}`;

      let sr = 0;
      const lines = [];
      rows.forEach((r) => {
        const amt = r2(Math.abs(n(r.PROVISION)));
        const charge = n(r.PROVISION) > 0; // negative = write-back
        const narr1 = `${r.EMP_CODE} ${r.EMP_NAME || ""} - ${TYPE_NAME[type]} prov.${charge ? "" : " write-back"} upto ${asOnTxt}`.slice(0, 80);
        const line = (acc, dc) => [
          tranType, vchrNo, String(++sr), mainSr, h.AS_ON_ISO, acc, dc, amt, 0, 0,
          narr1, narr2.slice(0, 80), refNo, user, per ? per.TODAY : null, per ? per.NOWT : null,
        ];
        lines.push(line(expAc, charge ? "D" : "C"));
        lines.push(line(r.EMP_PROV_AC || catgProvAc, charge ? "C" : "D"));
      });
      await conn.query(TA_INSERT, [lines]);

      await conn.query(
        `UPDATE eosb_prov_hdr SET STATUS='P', TRAN_TYPE=?, VCHR_NO=?, POSTED_BY=?, POSTED_DT=NOW()
          WHERE PROV_TYPE=? AND PROV_NO=?`,
        [tranType, vchrNo, user, type, provNo]
      );
      await conn.commit();
      res.json({ success: true, vchrNo, tranType, message: `Posted – JV ${tranType}/${vchrNo} (${lines.length} lines)` });
    } catch (e) {
      await conn.rollback();
      console.error("eosb-prov/post", e);
      fail(res, 400, e.sqlMessage || e.message);
    } finally {
      conn.release();
    }
  });

  /* ---------- un-post (admin only) ---------- */
  router.post("/eosb-prov/unpost/:type/:provNo", async (req, res) => {
    const { type, provNo } = req.params;
    if (!TYPES.includes(type)) return fail(res, 400, "Invalid type");
    if (userOf(req) !== ADMIN_USER) return fail(res, 403, "Only admin can un-post");
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[h]] = await conn.query(
        "SELECT STATUS, TRAN_TYPE, VCHR_NO FROM eosb_prov_hdr WHERE PROV_TYPE=? AND PROV_NO=? FOR UPDATE",
        [type, provNo]
      );
      if (!h || h.STATUS !== "P") throw new Error("Run is not posted");
      await conn.query("DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?", [h.TRAN_TYPE, h.VCHR_NO]);
      await conn.query(
        `UPDATE eosb_prov_hdr SET STATUS='D', TRAN_TYPE=NULL, VCHR_NO=NULL, POSTED_BY=NULL, POSTED_DT=NULL
          WHERE PROV_TYPE=? AND PROV_NO=?`,
        [type, provNo]
      );
      await conn.commit();
      res.json({ success: true, message: `JV ${h.TRAN_TYPE}/${h.VCHR_NO} removed – run is a draft again` });
    } catch (e) {
      await conn.rollback();
      fail(res, 400, e.sqlMessage || e.message);
    } finally {
      conn.release();
    }
  });

  /* ---------- delete a draft ---------- */
  router.delete("/eosb-prov/run/:type/:provNo", async (req, res) => {
    const { type, provNo } = req.params;
    if (!TYPES.includes(type)) return fail(res, 400, "Invalid type");
    try {
      const [r] = await db.query(
        "DELETE FROM eosb_prov_hdr WHERE PROV_TYPE = ? AND PROV_NO = ? AND STATUS = 'D'",
        [type, provNo]
      );
      if (!r.affectedRows) return fail(res, 400, "Only a draft run can be deleted");
      res.json({ success: true, message: `Run No. ${provNo} deleted` });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  return router;
};
