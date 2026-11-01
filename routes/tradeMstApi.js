// routes/tradeMstApi.js — Trade Master (trade_mst) maintenance
// Register in HayatDb.js:
//   const tradeMstApi = require("./routes/tradeMstApi");
//   app.use("/api", tradeMstApi(connection));
//
// Trade code = department code (2 digits) + 2-digit serial, e.g. 1015 = Accountant in dept 10.
//
// GET    /api/trade-mst          -> [{ TRADE_CODE, TRADE_NAME, DEPT_CODE, DEPT_NAME, EMP_COUNT }]
// POST   /api/trade-mst          body { TRADE_CODE, TRADE_NAME, DEPT_CODE }   (add)
// PUT    /api/trade-mst/:code    body { TRADE_NAME }   (edit — code and department stay fixed)
// DELETE /api/trade-mst/:code    refused while any employee carries the trade
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
    );

  const clean = (v) => String(v ?? "").trim();
  const cleanName = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

  const checkName = (name) => {
    if (!name) return "Trade name is required";
    if (name.length > 60) return "Trade name: max 60 characters";
    return null;
  };

  // ---------- list, grouped order: department, then trade code ----------
  router.get("/trade-mst", async (req, res) => {
    try {
      const rows = await q(
        `SELECT t.TRADE_CODE, t.TRADE_NAME, t.DEPT_CODE, d.DEPT_NAME,
                (SELECT COUNT(*) FROM emp_mst e WHERE e.TRADE_CODE = t.TRADE_CODE) AS EMP_COUNT
           FROM trade_mst t
           LEFT JOIN dept_mst d ON d.DEPT_CODE = t.DEPT_CODE
          ORDER BY t.DEPT_CODE, t.TRADE_CODE`
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- add ----------
  router.post("/trade-mst", async (req, res) => {
    const code = clean(req.body?.TRADE_CODE);
    const dept = clean(req.body?.DEPT_CODE);
    const name = cleanName(req.body?.TRADE_NAME);
    if (!/^[0-9]{2}$/.test(dept)) return res.status(400).json({ message: "Select the department" });
    if (!/^[0-9]{4}$/.test(code)) return res.status(400).json({ message: "Trade code must be 4 digits" });
    if (code.slice(0, 2) !== dept) {
      return res.status(400).json({ message: `Trade code must start with the department code ${dept}` });
    }
    const bad = checkName(name);
    if (bad) return res.status(400).json({ message: bad });
    try {
      const dup = await q("SELECT TRADE_CODE FROM trade_mst WHERE UPPER(TRADE_NAME) = UPPER(?)", [name]);
      if (dup.length) return res.status(409).json({ message: `"${name}" already exists as trade ${dup[0].TRADE_CODE}` });
      await q("INSERT INTO trade_mst (TRADE_CODE, TRADE_NAME, DEPT_CODE) VALUES (?, ?, ?)", [code, name, dept]);
      res.json({ ok: true, message: `Trade ${code} added` });
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ message: `Trade code ${code} already exists` });
      if (e.code === "ER_NO_REFERENCED_ROW_2") return res.status(400).json({ message: `Department ${dept} does not exist` });
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- edit (name only) ----------
  router.put("/trade-mst/:code", async (req, res) => {
    const code = clean(req.params.code);
    const name = cleanName(req.body?.TRADE_NAME);
    const bad = checkName(name);
    if (bad) return res.status(400).json({ message: bad });
    try {
      const dup = await q(
        "SELECT TRADE_CODE FROM trade_mst WHERE UPPER(TRADE_NAME) = UPPER(?) AND TRADE_CODE <> ?",
        [name, code]
      );
      if (dup.length) return res.status(409).json({ message: `"${name}" already exists as trade ${dup[0].TRADE_CODE}` });
      const r = await q("UPDATE trade_mst SET TRADE_NAME = ? WHERE TRADE_CODE = ?", [name, code]);
      if (r.affectedRows === 0) return res.status(404).json({ message: `Trade ${code} not found` });
      res.json({ ok: true, message: `Trade ${code} updated` });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- delete (only when no employee uses it) ----------
  router.delete("/trade-mst/:code", async (req, res) => {
    const code = clean(req.params.code);
    try {
      const used = await q("SELECT COUNT(*) AS n FROM emp_mst WHERE TRADE_CODE = ?", [code]);
      const n = Number(used[0]?.n || 0);
      if (n > 0) {
        return res.status(409).json({
          message: `Trade ${code} is assigned to ${n} employee${n > 1 ? "s" : ""} — change their trade first`,
        });
      }
      const r = await q("DELETE FROM trade_mst WHERE TRADE_CODE = ?", [code]);
      if (r.affectedRows === 0) return res.status(404).json({ message: `Trade ${code} not found` });
      res.json({ ok: true, message: `Trade ${code} deleted` });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  return router;
};
