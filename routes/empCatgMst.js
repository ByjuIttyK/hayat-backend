// routes/empCatgMst.js
// Employee Category Master (emp_catg_mst) — list / add / edit / delete
// Register in HayatDb.js:
//   const empCatgMst = require("./routes/empCatgMst");
//   app.use("/api", empCatgMst(connection));

const express = require("express");

// Accounts allowed as Salary Debit A/c (always picked from acc_mst).
// Edit this one condition if the list of accounts changes.
const SAL_AC_WHERE = "(a.acc_code = '601-004-0-001' OR a.acc_head LIKE 'WAGES%')";

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  const fail = (res, err, status = 500) => {
    console.error("emp-catg:", err);
    res.status(status).json({ success: false, message: err.message || String(err) });
  };

  // Validate code / name / account; returns an error message or null
  const validate = async (b, isAdd) => {
    const code = String(b.catg_code || "").trim().toUpperCase();
    const name = String(b.catg_name || "").trim();
    const ac = String(b.salary_debit_ac || "").trim();
    if (isAdd && !code) return "Category Code is required";
    if (code.length > 2) return "Category Code can be at most 2 characters";
    if (!name) return "Category Name is required";
    if (name.length > 50) return "Category Name can be at most 50 characters";
    if (!ac) return "Salary Debit A/c is required";
    const ok = await q(`SELECT 1 FROM acc_mst a WHERE a.acc_code = ? AND ${SAL_AC_WHERE}`, [ac]);
    if (!ok.length) return `Account ${ac} is not allowed as Salary Debit A/c`;
    return null;
  };

  // Listing
  router.get("/emp-catg", async (req, res) => {
    try {
      const rows = await q(
        `SELECT c.catg_code, c.catg_name, c.Salary_debit_ac AS salary_debit_ac,
                a.acc_head AS salary_debit_head
           FROM emp_catg_mst c
           LEFT JOIN acc_mst a ON a.acc_code = c.Salary_debit_ac
          ORDER BY c.catg_code`
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      fail(res, err);
    }
  });

  // Drop-down: allowed salary / wages accounts from acc_mst
  router.get("/emp-catg/sal-ac-list", async (req, res) => {
    try {
      const rows = await q(
        `SELECT a.acc_code, a.acc_head FROM acc_mst a WHERE ${SAL_AC_WHERE} ORDER BY a.acc_code`
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      fail(res, err);
    }
  });

  // Next employee code for a category: <catg_code> + LPAD(MAX(serial)+1, 3, '0')
  // e.g. catg W, highest W021 -> W022 ; first employee of a category -> W001
  router.get("/emp-catg/:code/next-emp-code", async (req, res) => {
    try {
      const catg = String(req.params.code || "").trim().toUpperCase();
      if (!catg) return fail(res, new Error("Category Code is required"), 400);
      const rows = await q(
        `SELECT CONCAT(?, LPAD(COALESCE(MAX(CAST(SUBSTRING(emp_code, CHAR_LENGTH(?) + 1, 3) AS UNSIGNED)), 0) + 1, 3, '0')) AS next_code
           FROM emp_mst
          WHERE emp_catg = ?`,
        [catg, catg, catg]
      );
      res.json({ success: true, next_code: rows[0].next_code });
    } catch (err) {
      fail(res, err);
    }
  });

  // Add
  router.post("/emp-catg", async (req, res) => {
    try {
      const msg = await validate(req.body, true);
      if (msg) return fail(res, new Error(msg), 400);
      const code = String(req.body.catg_code).trim().toUpperCase();
      await q(
        `INSERT INTO emp_catg_mst (catg_code, catg_name, Salary_debit_ac) VALUES (?, ?, ?)`,
        [code, req.body.catg_name.trim(), req.body.salary_debit_ac.trim()]
      );
      res.json({ success: true, message: `Category ${code} added` });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY")
        return fail(res, new Error("This Category Code already exists"), 409);
      fail(res, err);
    }
  });

  // Edit (code itself is not changed)
  router.put("/emp-catg/:code", async (req, res) => {
    try {
      const msg = await validate(req.body, false);
      if (msg) return fail(res, new Error(msg), 400);
      const r = await q(
        `UPDATE emp_catg_mst SET catg_name = ?, Salary_debit_ac = ? WHERE catg_code = ?`,
        [req.body.catg_name.trim(), req.body.salary_debit_ac.trim(), req.params.code]
      );
      if (!r.affectedRows) return fail(res, new Error("Category not found"), 404);
      res.json({ success: true, message: `Category ${req.params.code} updated` });
    } catch (err) {
      fail(res, err);
    }
  });

  // Delete
  router.delete("/emp-catg/:code", async (req, res) => {
    try {
      const r = await q(`DELETE FROM emp_catg_mst WHERE catg_code = ?`, [req.params.code]);
      if (!r.affectedRows) return fail(res, new Error("Category not found"), 404);
      res.json({ success: true, message: `Category ${req.params.code} deleted` });
    } catch (err) {
      if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED")
        return fail(res, new Error("Category is in use and cannot be deleted"), 409);
      fail(res, err);
    }
  });

  return router;
};
