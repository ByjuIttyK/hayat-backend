// routes/empDocsApi.js — Employee documents (emp_docs) + department and trade (emp_mst.DEPT_CODE / TRADE_CODE)
// 01-Nov-2026: lookups also return departments, and trades with their department;
//              load / save carry DEPT_CODE alongside TRADE_CODE.
// Register in HayatDb.js:
//   const empDocsApi = require("./routes/empDocsApi");
//   app.use("/api", empDocsApi(connection));
//
// GET  /api/emp-docs-lookups   -> { docTypes: [{code,name,remindDays}], depts: [{code,name}],
//                                   trades: [{code,name,deptCode,deptName}] }
// GET  /api/emp-docs/:code     -> { tradeCode, deptCode, docs: [{DOC_TYPE, DOC_NO, ISSUE_DT, EXPIRY_DT, ISSUE_PLACE, REMARKS}] }
//                                 dates as dd/MM/yyyy
// PUT  /api/emp-docs/:code     body { tradeCode, deptCode, docs: [{DOC_TYPE, DOC_NO, ISSUE_DT, EXPIRY_DT, ISSUE_PLACE, REMARKS}] }
//                                 dates as yyyy-MM-dd (or null). Saves the department, trade and replaces the
//                                 employee's document set in one transaction: rows sent are inserted or
//                                 updated, document types not sent are deleted.
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
    );

  const fail = (status, message) => Object.assign(new Error(message), { status });
  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const str = (v, max) => {
    const s = v == null ? "" : String(v).trim();
    return s ? s.slice(0, max) : null;
  };

  // ---------- lookups for the Documents tab and the Trade dropdown ----------
  router.get("/emp-docs-lookups", async (req, res) => {
    try {
      const [docTypes, depts, trades] = await Promise.all([
        q(connection,
          `SELECT DOC_TYPE AS code, DOC_NAME AS name, REMIND_DAYS AS remindDays
             FROM doc_type_mst
            WHERE APPLIES_TO = 'E'
            ORDER BY DOC_NAME`),
        q(connection,
          `SELECT DEPT_CODE AS code, DEPT_NAME AS name
             FROM dept_mst
            ORDER BY DEPT_CODE`),
        q(connection,
          `SELECT t.TRADE_CODE AS code, t.TRADE_NAME AS name,
                  t.DEPT_CODE AS deptCode, d.DEPT_NAME AS deptName
             FROM trade_mst t
             LEFT JOIN dept_mst d ON d.DEPT_CODE = t.DEPT_CODE
            ORDER BY t.DEPT_CODE, t.TRADE_CODE`),
      ]);
      res.json({ docTypes, depts, trades });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- load one employee's trade code + documents ----------
  router.get("/emp-docs/:code", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    try {
      const [emp, docs] = await Promise.all([
        q(connection, "SELECT TRADE_CODE, DEPT_CODE FROM emp_mst WHERE EMP_CODE = ?", [code]),
        q(connection,
          `SELECT DOC_TYPE, DOC_NO,
                  DATE_FORMAT(ISSUE_DT,  '%d/%m/%Y') AS ISSUE_DT,
                  DATE_FORMAT(EXPIRY_DT, '%d/%m/%Y') AS EXPIRY_DT,
                  ISSUE_PLACE, REMARKS
             FROM emp_docs
            WHERE EMP_CODE = ?`, [code]),
      ]);
      res.json({ tradeCode: emp[0]?.TRADE_CODE || "", deptCode: emp[0]?.DEPT_CODE || "", docs });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- save trade code + documents ----------
  router.put("/emp-docs/:code", (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const tradeCode = str(req.body?.tradeCode, 4);
    const deptCode = str(req.body?.deptCode, 2);
    const docs = Array.isArray(req.body?.docs) ? req.body.docs : [];
    const user = str(req.user?.username || req.user?.user_name || req.user?.user_id, 20);

    // validate before touching the database
    const seen = new Set();
    for (const d of docs) {
      const t = str(d.DOC_TYPE, 10);
      if (!t) return res.status(400).json({ message: "Document type missing on a line" });
      if (seen.has(t)) return res.status(400).json({ message: `Document ${t} appears twice` });
      seen.add(t);
      for (const k of ["ISSUE_DT", "EXPIRY_DT"]) {
        if (d[k] && !isYmd(String(d[k]))) {
          return res.status(400).json({ message: `${t}: invalid ${k === "ISSUE_DT" ? "issue" : "expiry"} date` });
        }
      }
      if (!d.EXPIRY_DT) return res.status(400).json({ message: `${t}: expiry date is required` });
      if (d.ISSUE_DT && d.ISSUE_DT > d.EXPIRY_DT) {
        return res.status(400).json({ message: `${t}: expiry date is before the issue date` });
      }
    }

    connection.getConnection(async (err, conn) => {
      if (err) return res.status(500).json({ message: err.message });
      try {
        await q(conn, "START TRANSACTION");

        if (tradeCode) {
          const t = await q(conn, "SELECT 1 FROM trade_mst WHERE TRADE_CODE = ?", [tradeCode]);
          if (!t.length) throw fail(400, `Trade code ${tradeCode} is not in the trade master`);
        }
        if (deptCode) {
          const d = await q(conn, "SELECT 1 FROM dept_mst WHERE DEPT_CODE = ?", [deptCode]);
          if (!d.length) throw fail(400, `Department ${deptCode} is not in the department master`);
        }
        const upd = await q(conn, "UPDATE emp_mst SET TRADE_CODE = ?, DEPT_CODE = ? WHERE EMP_CODE = ?",
          [tradeCode, deptCode, code]);
        if (upd.affectedRows === 0) throw fail(404, `Employee ${code} not found`);

        // drop the document types no longer on the screen
        const types = [...seen];
        if (types.length) {
          await q(conn, "DELETE FROM emp_docs WHERE EMP_CODE = ? AND DOC_TYPE NOT IN (?)", [code, types]);
        } else {
          await q(conn, "DELETE FROM emp_docs WHERE EMP_CODE = ?", [code]);
        }

        // insert new / update existing — one row per (EMP_CODE, DOC_TYPE)
        for (const d of docs) {
          await q(conn,
            `INSERT INTO emp_docs
                    (EMP_CODE, DOC_TYPE, DOC_NO, ISSUE_DT, EXPIRY_DT, ISSUE_PLACE, REMARKS, CREATED_BY)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                    DOC_NO      = VALUES(DOC_NO),
                    ISSUE_DT    = VALUES(ISSUE_DT),
                    EXPIRY_DT   = VALUES(EXPIRY_DT),
                    ISSUE_PLACE = VALUES(ISSUE_PLACE),
                    REMARKS     = VALUES(REMARKS),
                    MODIFIED_BY = ?`,
            [
              code, str(d.DOC_TYPE, 10), str(d.DOC_NO, 30),
              d.ISSUE_DT || null, d.EXPIRY_DT,
              str(d.ISSUE_PLACE, 40), str(d.REMARKS, 200),
              user, user,
            ]);
        }

        await q(conn, "COMMIT");
        res.json({ ok: true, message: `Documents saved (${docs.length})` });
      } catch (e) {
        await q(conn, "ROLLBACK").catch(() => {});
        res.status(e.status || 500).json({ message: e.message });
      } finally {
        conn.release();
      }
    });
  });

  return router;
};
