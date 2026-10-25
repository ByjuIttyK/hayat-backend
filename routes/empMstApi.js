// routes/empMstApi.js
// Miniature Employee Master + Payroll Master (emp_mst / payroll_mst, linked by EMP_CODE)
// Register in HayatDb.js:  app.use("/api", require("./routes/empMstApi")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const pool = connection.promise(); // mysql2 pool -> promise wrapper

  const userOf = (req) =>
    (req.user && (req.user.username || req.user.user_id || req.user.USER_ID)) ||
    req.body?.user ||
    null;

  const clean = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());

  // ---------- LIST ----------
  router.get("/emp-mst/list", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT e.EMP_CODE, e.EMP_NAME, e.CARD_NO, e.GENDER, e.NATION_CODE,
                p.BASIC_SAL, p.SHIFT_CODE, p.OT_ELIGIBLE
           FROM emp_mst e
           LEFT JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
          ORDER BY e.EMP_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error("emp-mst/list", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- DISTINCT SHIFT CODES (for the dropdown) ----------
  router.get("/emp-mst/shifts", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT DISTINCT SHIFT_CODE FROM payroll_mst
          WHERE SHIFT_CODE IS NOT NULL AND SHIFT_CODE <> '' ORDER BY SHIFT_CODE`
      );
      res.json(rows.map((r) => r.SHIFT_CODE));
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- SINGLE ----------
  router.get("/emp-mst/:code", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT e.EMP_CODE, e.EMP_NAME, e.CARD_NO, e.GENDER, e.NATION_CODE,
                p.BASIC_SAL, p.SHIFT_CODE, p.OT_ELIGIBLE,
                e.CREATED_BY, e.CREATED_DT, e.MODIFIED_BY, e.MODIFIED_DT
           FROM emp_mst e
           LEFT JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
          WHERE e.EMP_CODE = ?`,
        [req.params.code.toUpperCase()]
      );
      if (!rows.length) return res.status(404).json({ message: "Employee not found" });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- SAVE (ADD / EDIT) ----------
  router.post("/save-emp-mst", async (req, res) => {
    const { mode, data } = req.body || {};
    const user = userOf(req);

    const empCode = clean(data?.EMP_CODE)?.toUpperCase();
    const empName = clean(data?.EMP_NAME);
    if (!empCode || empCode.length > 4) return res.status(400).json({ message: "Emp Code is required (max 4 characters)" });
    if (!empName) return res.status(400).json({ message: "Employee Name is required" });

    const cardNo = clean(data.CARD_NO);
    const gender = clean(data.GENDER);
    const nation = clean(data.NATION_CODE) === null ? null : Number(data.NATION_CODE);
    const basic = Number(data.BASIC_SAL || 0);
    const shift = clean(data.SHIFT_CODE)?.toUpperCase() || null;
    const ot = data.OT_ELIGIBLE === "N" ? "N" : "Y";

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (mode === "ADD") {
        await conn.query(
          `INSERT INTO emp_mst (EMP_CODE, EMP_NAME, CARD_NO, GENDER, NATION_CODE, CREATED_BY)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [empCode, empName, cardNo, gender, nation, user]
        );
        await conn.query(
          `INSERT INTO payroll_mst (EMP_CODE, BASIC_SAL, SHIFT_CODE, OT_ELIGIBLE, CREATED_BY)
           VALUES (?, ?, ?, ?, ?)`,
          [empCode, basic, shift, ot, user]
        );
      } else {
        const [r] = await conn.query(
          `UPDATE emp_mst SET EMP_NAME = ?, CARD_NO = ?, GENDER = ?, NATION_CODE = ?, MODIFIED_BY = ?
            WHERE EMP_CODE = ?`,
          [empName, cardNo, gender, nation, user, empCode]
        );
        if (!r.affectedRows) throw Object.assign(new Error("Employee not found"), { status: 404 });

        // payroll row may be missing for imported employees -> upsert
        await conn.query(
          `INSERT INTO payroll_mst (EMP_CODE, BASIC_SAL, SHIFT_CODE, OT_ELIGIBLE, CREATED_BY)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE BASIC_SAL = VALUES(BASIC_SAL), SHIFT_CODE = VALUES(SHIFT_CODE),
                                   OT_ELIGIBLE = VALUES(OT_ELIGIBLE), MODIFIED_BY = ?`,
          [empCode, basic, shift, ot, user, user]
        );
      }

      await conn.commit();
      res.json({ success: true, EMP_CODE: empCode, message: `Employee ${empCode} saved successfully` });
    } catch (err) {
      await conn.rollback();
      if (err.code === "ER_DUP_ENTRY") {
        const msg = /CARD_NO/i.test(err.sqlMessage)
          ? `Card No ${cardNo} is already assigned to another employee`
          : `Emp Code ${empCode} already exists`;
        return res.status(409).json({ message: msg });
      }
      console.error("save-emp-mst", err);
      res.status(err.status || 500).json({ message: err.message });
    } finally {
      conn.release();
    }
  });

  // ---------- DELETE ----------
  router.delete("/emp-mst/:code", async (req, res) => {
    const empCode = req.params.code.toUpperCase();
    const conn = await pool.getConnection();
    try {
      // block delete if the employee already has time sheets
      try {
        const [ts] = await conn.query(`SELECT COUNT(*) AS n FROM time_sheet_hdr WHERE EMP_CODE = ?`, [empCode]);
        if (ts[0].n > 0)
          return res.status(409).json({ message: `Cannot delete — ${empCode} has ${ts[0].n} time sheet(s)` });
      } catch (e) {
        if (e.code !== "ER_NO_SUCH_TABLE") throw e;
      }

      await conn.beginTransaction();
      await conn.query(`DELETE FROM payroll_mst WHERE EMP_CODE = ?`, [empCode]);
      const [r] = await conn.query(`DELETE FROM emp_mst WHERE EMP_CODE = ?`, [empCode]);
      if (!r.affectedRows) throw Object.assign(new Error("Employee not found"), { status: 404 });
      await conn.commit();
      res.json({ success: true, message: `Employee ${empCode} deleted` });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("delete emp-mst", err);
      res.status(err.status || 500).json({ message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};
