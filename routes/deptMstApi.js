// routes/deptMstApi.js — Department Master (dept_mst) maintenance
// Register in HayatDb.js:
//   const deptMstApi = require("./routes/deptMstApi");
//   app.use("/api", deptMstApi(connection));
//
// GET    /api/dept-mst          -> [{ DEPT_CODE, DEPT_NAME, TRADE_COUNT, EMP_COUNT }]
// POST   /api/dept-mst          body { DEPT_CODE, DEPT_NAME }   (add)
// PUT    /api/dept-mst/:code    body { DEPT_NAME }              (edit — the code itself is not changed)
// DELETE /api/dept-mst/:code    refused while trades or employees refer to the department
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
    );

  const cleanCode = (v) => String(v ?? "").trim();
  const cleanName = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

  const check = (code, name, needCode = true) => {
    if (needCode && !/^[0-9]{2}$/.test(code)) return "Department code must be 2 digits (e.g. 05, 10)";
    if (!name) return "Department name is required";
    if (name.length > 60) return "Department name: max 60 characters";
    return null;
  };

  // ---------- list, with trade and employee counts ----------
  router.get("/dept-mst", async (req, res) => {
    try {
      const rows = await q(
        `SELECT d.DEPT_CODE, d.DEPT_NAME,
                (SELECT COUNT(*) FROM trade_mst t WHERE t.DEPT_CODE = d.DEPT_CODE) AS TRADE_COUNT,
                (SELECT COUNT(*) FROM emp_mst   e WHERE e.DEPT_CODE = d.DEPT_CODE) AS EMP_COUNT
           FROM dept_mst d
          ORDER BY d.DEPT_CODE`
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- add ----------
  router.post("/dept-mst", async (req, res) => {
    const code = cleanCode(req.body?.DEPT_CODE);
    const name = cleanName(req.body?.DEPT_NAME);
    const bad = check(code, name);
    if (bad) return res.status(400).json({ message: bad });
    try {
      const dup = await q("SELECT DEPT_CODE FROM dept_mst WHERE UPPER(DEPT_NAME) = UPPER(?)", [name]);
      if (dup.length) return res.status(409).json({ message: `"${name}" already exists as department ${dup[0].DEPT_CODE}` });
      await q("INSERT INTO dept_mst (DEPT_CODE, DEPT_NAME) VALUES (?, ?)", [code, name]);
      res.json({ ok: true, message: `Department ${code} added` });
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ message: `Department code ${code} already exists` });
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- edit (name only) ----------
  router.put("/dept-mst/:code", async (req, res) => {
    const code = cleanCode(req.params.code);
    const name = cleanName(req.body?.DEPT_NAME);
    const bad = check(code, name, false);
    if (bad) return res.status(400).json({ message: bad });
    try {
      const dup = await q(
        "SELECT DEPT_CODE FROM dept_mst WHERE UPPER(DEPT_NAME) = UPPER(?) AND DEPT_CODE <> ?",
        [name, code]
      );
      if (dup.length) return res.status(409).json({ message: `"${name}" already exists as department ${dup[0].DEPT_CODE}` });
      const r = await q("UPDATE dept_mst SET DEPT_NAME = ? WHERE DEPT_CODE = ?", [name, code]);
      if (r.affectedRows === 0) return res.status(404).json({ message: `Department ${code} not found` });
      res.json({ ok: true, message: `Department ${code} updated` });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- delete (only when nothing refers to it) ----------
  router.delete("/dept-mst/:code", async (req, res) => {
    const code = cleanCode(req.params.code);
    try {
      const [t] = await q("SELECT COUNT(*) AS n FROM trade_mst WHERE DEPT_CODE = ?", [code]);
      const [e] = await q("SELECT COUNT(*) AS n FROM emp_mst   WHERE DEPT_CODE = ?", [code]);
      const nt = Number(t?.n || 0), ne = Number(e?.n || 0);
      if (nt || ne) {
        const parts = [];
        if (nt) parts.push(`${nt} trade${nt > 1 ? "s" : ""}`);
        if (ne) parts.push(`${ne} employee${ne > 1 ? "s" : ""}`);
        return res.status(409).json({ message: `Department ${code} is used by ${parts.join(" and ")} — move them first` });
      }
      const r = await q("DELETE FROM dept_mst WHERE DEPT_CODE = ?", [code]);
      if (r.affectedRows === 0) return res.status(404).json({ message: `Department ${code} not found` });
      res.json({ ok: true, message: `Department ${code} deleted` });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};
