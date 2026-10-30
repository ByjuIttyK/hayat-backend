// routes/empMstApi.js
// Miniature Employee Master + Payroll Master (emp_mst / payroll_mst, linked by EMP_CODE)
// Register in HayatDb.js:  app.use("/api", require("./routes/empMstApi")(connection));
// 30-Oct-2026: NATION_CODE is the nation_mst code (VARCHAR 3, e.g. UAE) — no longer a number;
//              payroll_mst.ACCRUED_SAL_AC (acc_mst 213… account, "Accrued Sal A/c (Cr)") added;
//              EMP_CATG now saved on ADD; delete blocked when the employee has salary revisions.

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
        `SELECT e.EMP_CODE, e.EMP_NAME, e.EMP_CATG,e.CARD_NO, e.GENDER, e.NATION_CODE,
                p.BASIC_SAL, p.SHIFT_CODE, p.OT_ELIGIBLE, p.ACCRUED_SAL_AC
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
        `SELECT e.EMP_CODE, e.EMP_NAME, e.CARD_NO, e.GENDER, e.NATION_CODE,e.EMP_CATG,
                p.BASIC_SAL, p.SHIFT_CODE, p.OT_ELIGIBLE, p.ACCRUED_SAL_AC,
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
    const catg = clean(data.EMP_CATG)?.toUpperCase() || null;
    const nation = clean(data.NATION_CODE)?.toUpperCase() || null; // nation_mst code, e.g. UAE
    const accruedAc = clean(data.ACCRUED_SAL_AC);                   // acc_mst 213… account
    const basic = Number(data.BASIC_SAL || 0);
    const shift = clean(data.SHIFT_CODE)?.toUpperCase() || null;
    const ot = data.OT_ELIGIBLE === "N" ? "N" : "Y";

    const conn = await pool.getConnection();
    try {
      // dropdown values must still exist in their masters
      if (nation) {
        const [n] = await conn.query(`SELECT 1 FROM nation_mst WHERE NATION_CODE = ?`, [nation]);
        if (!n.length) throw Object.assign(new Error(`Nation ${nation} is not in the nation master`), { status: 400 });
      }
      if (accruedAc) {
        const [a] = await conn.query(`SELECT 1 FROM acc_mst WHERE ACC_CODE = ? AND ACC_CODE LIKE '231%'`, [accruedAc]);
        if (!a.length) throw Object.assign(new Error(`Accrued Sal A/c ${accruedAc} is not a 231… account in acc_mst`), { status: 400 });
      }

      await conn.beginTransaction();

      if (mode === "ADD") {
        await conn.query(
          `INSERT INTO emp_mst (EMP_CODE, EMP_NAME, EMP_CATG, CARD_NO, GENDER, NATION_CODE, CREATED_BY)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [empCode, empName, catg, cardNo, gender, nation, user]
        );
        await conn.query(
          `INSERT INTO payroll_mst (EMP_CODE, BASIC_SAL, SHIFT_CODE, OT_ELIGIBLE, ACCRUED_SAL_AC, CREATED_BY)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [empCode, basic, shift, ot, accruedAc, user]
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
          `INSERT INTO payroll_mst (EMP_CODE, BASIC_SAL, SHIFT_CODE, OT_ELIGIBLE, ACCRUED_SAL_AC, CREATED_BY)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE BASIC_SAL = VALUES(BASIC_SAL), SHIFT_CODE = VALUES(SHIFT_CODE),
                                   OT_ELIGIBLE = VALUES(OT_ELIGIBLE), ACCRUED_SAL_AC = VALUES(ACCRUED_SAL_AC),
                                   MODIFIED_BY = ?`,
          [empCode, basic, shift, ot, accruedAc, user, user]
        );
      }

      await conn.commit();
      res.json({ success: true, EMP_CODE: empCode, message: `Employee ${empCode} saved successfully` });
    } catch (err) {
      await conn.rollback().catch(() => {});
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
      // block delete if the employee already has time sheets or salary revisions
      for (const [tbl, what] of [["time_sheet_hdr", "time sheet(s)"], ["sal_rev_hdr", "salary revision(s)"]]) {
        try {
          const [cnt] = await conn.query(`SELECT COUNT(*) AS n FROM ${tbl} WHERE EMP_CODE = ?`, [empCode]);
          if (cnt[0].n > 0) return res.status(409).json({ message: `Cannot delete — ${empCode} has ${cnt[0].n} ${what}` });
        } catch (e) {
          if (e.code !== "ER_NO_SUCH_TABLE") throw e;
        }
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
