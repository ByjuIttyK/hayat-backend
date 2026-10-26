// routes/allowDedMstApi.js
// Allowance master (allow_mst) and Deduction master (ded_mst) — ADD / EDIT / DELETE.
// Register in HayatDb.js:
//   const allowDedMstApi = require("./routes/allowDedMstApi");
//   app.use("/api", allowDedMstApi(connection));
//
// Endpoints (:kind = allow | ded)
//   GET    /api/allow-ded-mst/:kind              list
//   GET    /api/allow-ded-mst/:kind/next-code    MAX(code)+1 for a new record
//   POST   /api/allow-ded-mst/:kind              add
//   PUT    /api/allow-ded-mst/:kind/:code        edit (description, type)
//   DELETE /api/allow-ded-mst/:kind/:code        delete

const express = require("express");

// Table names lowercase (VPS is case-sensitive).
// refs: tables that use the code — delete is refused while a row there points at it.
// Fill these in as payroll_mst / payroll detail tables come in, e.g.
//   { table: "payroll_allow", col: "ALLOW_CODE", label: "Payroll allowances" }
const MASTERS = {
  allow: {
    table: "allow_mst",
    code: "ALLOW_CODE",
    desc: "ALLOW_DESC",
    type: "ALLOW_TYPE",
    label: "Allowance",
    refs: [],
  },
  ded: {
    table: "ded_mst",
    code: "DED_CODE",
    desc: "DED_DESC",
    type: "DED_TYPE",
    label: "Deduction",
    refs: [],
  },
};

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const getCfg = (req, res) => {
    const m = MASTERS[req.params.kind];
    if (!m) res.status(404).json({ error: "Unknown master" });
    return m;
  };

  const userOf = (req) =>
    req.user?.user_name || req.user?.username || req.user?.USER_ID || req.user?.user_id || "SYSTEM";

  const validate = (b, needCode) => {
    const descr = String(b.descr ?? "").trim().toUpperCase();
    const type = String(b.type ?? "").trim().toUpperCase();
    const code = Number(b.code);
    if (needCode && (!Number.isInteger(code) || code <= 0)) return { err: "Code must be a whole number above 0" };
    if (!descr) return { err: "Description is required" };
    if (!["F", "V"].includes(type)) return { err: "Type must be F (Fixed) or V (Variable)" };
    return { code, descr, type };
  };

  // ---- list ----
  router.get("/allow-ded-mst/:kind", async (req, res) => {
    const m = getCfg(req, res);
    if (!m) return;
    try {
      const [rows] = await db.query(
        `SELECT ${m.code} AS code, ${m.desc} AS descr, ${m.type} AS type,
                CREATED_BY AS createdBy,
                DATE_FORMAT(CREATED_DT, '%d/%m/%Y %H:%i') AS createdDt,
                MODIFIED_BY AS modifiedBy,
                DATE_FORMAT(MODIFIED_DT, '%d/%m/%Y %H:%i') AS modifiedDt
           FROM ${m.table}
          ORDER BY ${m.code}`
      );
      res.json({ rows });
    } catch (e) {
      console.error(`allow-ded-mst list ${m.table}:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- next code ----
  router.get("/allow-ded-mst/:kind/next-code", async (req, res) => {
    const m = getCfg(req, res);
    if (!m) return;
    try {
      const [[r]] = await db.query(`SELECT IFNULL(MAX(${m.code}), 0) + 1 AS nextCode FROM ${m.table}`);
      res.json({ nextCode: Number(r.nextCode) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- add ----
  router.post("/allow-ded-mst/:kind", async (req, res) => {
    const m = getCfg(req, res);
    if (!m) return;
    const v = validate(req.body, true);
    if (v.err) return res.status(400).json({ error: v.err });
    try {
      const [[dup]] = await db.query(`SELECT COUNT(*) AS n FROM ${m.table} WHERE ${m.code} = ?`, [v.code]);
      if (dup.n > 0) return res.status(409).json({ error: `${m.label} code ${v.code} already exists` });
      await db.query(
        `INSERT INTO ${m.table} (${m.code}, ${m.desc}, ${m.type}, CREATED_BY, CREATED_DT)
         VALUES (?, ?, ?, ?, NOW())`,
        [v.code, v.descr, v.type, userOf(req)]
      );
      res.json({ ok: true, code: v.code });
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY")
        return res.status(409).json({ error: `${m.label} code ${v.code} already exists` });
      console.error(`allow-ded-mst add ${m.table}:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- edit ----
  router.put("/allow-ded-mst/:kind/:code", async (req, res) => {
    const m = getCfg(req, res);
    if (!m) return;
    const code = Number(req.params.code);
    const v = validate(req.body, false);
    if (v.err) return res.status(400).json({ error: v.err });
    try {
      const [r] = await db.query(
        `UPDATE ${m.table}
            SET ${m.desc} = ?, ${m.type} = ?, MODIFIED_BY = ?, MODIFIED_DT = NOW()
          WHERE ${m.code} = ?`,
        [v.descr, v.type, userOf(req), code]
      );
      if (r.affectedRows === 0) return res.status(404).json({ error: `${m.label} code ${code} not found` });
      res.json({ ok: true, code });
    } catch (e) {
      console.error(`allow-ded-mst edit ${m.table}:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- delete ----
  router.delete("/allow-ded-mst/:kind/:code", async (req, res) => {
    const m = getCfg(req, res);
    if (!m) return;
    const code = Number(req.params.code);
    try {
      for (const ref of m.refs) {
        const [[u]] = await db.query(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.col} = ?`, [code]);
        if (u.n > 0)
          return res.status(409).json({
            error: `${m.label} code ${code} is used in ${ref.label || ref.table} (${u.n} rows) — cannot delete`,
          });
      }
      const [r] = await db.query(`DELETE FROM ${m.table} WHERE ${m.code} = ?`, [code]);
      if (r.affectedRows === 0) return res.status(404).json({ error: `${m.label} code ${code} not found` });
      res.json({ ok: true });
    } catch (e) {
      if (e.code === "ER_ROW_IS_REFERENCED_2" || e.code === "ER_ROW_IS_REFERENCED")
        return res.status(409).json({ error: `${m.label} code ${code} is in use — cannot delete` });
      console.error(`allow-ded-mst delete ${m.table}:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
