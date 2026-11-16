// routes/jobSalesIncenAcRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Master for job_sales_incen_ac — the commission / sales-incentive G/L accounts
// that the Commission tab of Project Job Creation reads.
//
//   GET    /api/job-sales-incen-ac                 list (acc_code order)
//   GET    /api/job-sales-incen-ac/lookup/:code    A/c head from acc_mst
//   POST   /api/job-sales-incen-ac                 add     { accCode, accHead }
//   PUT    /api/job-sales-incen-ac/:code           edit    { accCode, accHead }
//   DELETE /api/job-sales-incen-ac/:code           delete
//
// Only G/L accounts that exist in acc_mst can be added. A blank head is filled
// from acc_mst. Table name is lowercase — the VPS MySQL is case-sensitive.
//
// Register in HayatDb.js:
//   app.use("/api", authMiddleware, require("./routes/jobSalesIncenAcRoutes")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  const clean = (v) => String(v ?? "").trim();

  // ── list ───────────────────────────────────────────────────────────────────
  router.get("/job-sales-incen-ac", async (req, res) => {
    try {
      const rows = await q(
        "SELECT acc_code AS ACC_CODE, acc_head AS ACC_HEAD FROM job_sales_incen_ac ORDER BY acc_code");
      res.json(rows);
    } catch (err) {
      console.error("job-sales-incen-ac list:", err);
      res.status(500).json({ message: "Could not load the accounts" });
    }
  });

  // ── A/c head of a G/L code ────────────────────────────────────────────────
  router.get("/job-sales-incen-ac/lookup/:code", async (req, res) => {
    try {
      const rows = await q("SELECT acc_code AS ACC_CODE, acc_head AS ACC_HEAD FROM acc_mst WHERE acc_code = ?",
        [clean(req.params.code)]);
      if (!rows.length) return res.status(404).json({ message: "Not a G/L account in acc_mst" });
      res.json(rows[0]);
    } catch (err) {
      console.error("job-sales-incen-ac lookup:", err);
      res.status(500).json({ message: "Lookup failed" });
    }
  });

  // shared checks for add / edit → { code, head } or throws { status, message }
  const validate = async (body, originalCode) => {
    const code = clean(body.accCode);
    let head = clean(body.accHead);
    if (!code) throw { status: 400, message: "Enter the A/c Code" };

    const gl = await q("SELECT acc_head FROM acc_mst WHERE acc_code = ?", [code]);
    if (!gl.length) throw { status: 400, message: `${code} is not a G/L account in acc_mst` };
    if (!head) head = clean(gl[0].acc_head);

    if (code !== originalCode) {
      const dup = await q("SELECT 1 FROM job_sales_incen_ac WHERE acc_code = ?", [code]);
      if (dup.length) throw { status: 409, message: `${code} is already in the list` };
    }
    return { code, head };
  };

  const fail = (res, err, what) => {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    console.error(`job-sales-incen-ac ${what}:`, err);
    res.status(500).json({ message: `Could not ${what} the account` });
  };

  // ── add ────────────────────────────────────────────────────────────────────
  router.post("/job-sales-incen-ac", async (req, res) => {
    try {
      const { code, head } = await validate(req.body || {}, null);
      await q("INSERT INTO job_sales_incen_ac (acc_code, acc_head) VALUES (?, ?)", [code, head]);
      res.json({ ok: true, accCode: code, accHead: head });
    } catch (err) { fail(res, err, "add"); }
  });

  // ── edit (the code itself may be changed) ─────────────────────────────────
  router.put("/job-sales-incen-ac/:code", async (req, res) => {
    const original = clean(req.params.code);
    try {
      const exists = await q("SELECT 1 FROM job_sales_incen_ac WHERE acc_code = ?", [original]);
      if (!exists.length) throw { status: 404, message: `${original} is no longer in the list` };
      const { code, head } = await validate(req.body || {}, original);
      await q("UPDATE job_sales_incen_ac SET acc_code = ?, acc_head = ? WHERE acc_code = ?",
        [code, head, original]);
      res.json({ ok: true, accCode: code, accHead: head });
    } catch (err) { fail(res, err, "save"); }
  });

  // ── delete ─────────────────────────────────────────────────────────────────
  router.delete("/job-sales-incen-ac/:code", async (req, res) => {
    try {
      const r = await q("DELETE FROM job_sales_incen_ac WHERE acc_code = ?", [clean(req.params.code)]);
      if (!r.affectedRows) return res.status(404).json({ message: "Account not found" });
      res.json({ ok: true });
    } catch (err) { fail(res, err, "delete"); }
  });

  return router;
};
