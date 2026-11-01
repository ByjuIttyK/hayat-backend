// routes/empExtApi.js — extended employee master fields (emp_mst / hr_mst / payroll_mst)
// Register in HayatDb.js:
//   const empExtApi = require("./routes/empExtApi");
//   app.use("/api", empExtApi(connection));
//
// GET /api/emp-ext/:code  -> { EMP_STATUS, BIRTH_DT, ..., MARITAL_STATUS, ..., PAY_MODE, IBAN, ... }
//                            dates as dd/MM/yyyy, missing hr / payroll rows come back as defaults
// PUT /api/emp-ext/:code  body: the same keys, dates as yyyy-MM-dd or null.
//                            One transaction: UPDATE emp_mst, upsert hr_mst, UPDATE (or INSERT) payroll_mst.
// Called by the Employee Master after the employee itself has been saved (hooks/useEmpExt.ts).
const express = require("express");

// field lists: k = column, t = s (string, max length) | d (date) | n (number) | yn (Y/N) | c (code from a set)
const EMP_FIELDS = [
  { k: "EMP_STATUS", t: "c", set: ["A", "L", "R", "T", "X"], def: "A" },
  { k: "BIRTH_DT", t: "d" },
  { k: "APPT_DT", t: "d" },
  { k: "PROBATION_END_DT", t: "d" },
  { k: "CONFIRM_DT", t: "d" },
  { k: "REPORTS_TO", t: "s", max: 4, upper: true },
  { k: "WORK_LOCATION", t: "s", max: 40 },
  { k: "EXIT_DT", t: "d" },
  { k: "EXIT_REASON", t: "s", max: 100 },
];
const HR_FIELDS = [
  { k: "MARITAL_STATUS", t: "c", set: ["S", "M", "D", "W"] },
  { k: "BLOOD_GROUP", t: "s", max: 3, upper: true },
  { k: "BIRTH_PLACE", t: "s", max: 40 },
  { k: "MOBILE_NO", t: "s", max: 20 },
  { k: "EMAIL", t: "s", max: 80 },
  { k: "UAE_ADDRESS", t: "s", max: 200 },
  { k: "HOME_ADDRESS", t: "s", max: 200 },
  { k: "HOME_PHONE", t: "s", max: 20 },
  { k: "EMERG_NAME", t: "s", max: 60 },
  { k: "EMERG_RELATION", t: "s", max: 30 },
  { k: "EMERG_PHONE", t: "s", max: 20 },
  { k: "CONTRACT_TYPE", t: "c", set: ["L", "U"] },
  { k: "CONTRACT_START_DT", t: "d" },
  { k: "CONTRACT_END_DT", t: "d" },
  { k: "MOHRE_PERSON_CODE", t: "s", max: 20 },
  { k: "VISA_SPONSOR", t: "s", max: 80 },
  { k: "LEAVE_DAYS_PA", t: "n", def: 30 },
  { k: "LEAVE_OPBAL", t: "n", def: 0 },
  { k: "LEAVE_OPBAL_DT", t: "d" },
  { k: "LAST_LEAVE_DT", t: "d" },
  { k: "LAST_RESUME_DT", t: "d" },
  { k: "TICKET_ELIGIBLE", t: "yn" },
  { k: "TICKET_SECTOR", t: "s", max: 40, upper: true },
  { k: "TICKET_CLASS", t: "c", set: ["E", "B"] },
  { k: "TICKET_EVERY_YRS", t: "n" },
  { k: "LAST_TICKET_DT", t: "d" },
  { k: "GRATUITY_START_DT", t: "d" },
  { k: "ACCOMMODATION", t: "yn" },
  { k: "FAMILY_IN_UAE", t: "yn" },
  { k: "MED_INS_CATG", t: "s", max: 20 },
];
const PAY_FIELDS = [
  { k: "PAY_MODE", t: "c", set: ["W", "E", "C"], def: "W" },
  { k: "BANK_NAME", t: "s", max: 60 },
  { k: "IBAN", t: "s", max: 34, upper: true, nospace: true },
  { k: "ROUTING_CODE", t: "s", max: 9 },
];

const LABEL = {
  BIRTH_DT: "Date of birth", APPT_DT: "Appointment date", PROBATION_END_DT: "Probation end",
  CONFIRM_DT: "Confirmation date", EXIT_DT: "Exit date", CONTRACT_START_DT: "Contract start",
  CONTRACT_END_DT: "Contract end", LEAVE_OPBAL_DT: "Leave balance as on", LAST_LEAVE_DT: "Last leave",
  LAST_RESUME_DT: "Resumed on", LAST_TICKET_DT: "Last ticket", GRATUITY_START_DT: "Gratuity start",
};

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// one body value -> the value stored, or throws a 400 with a readable message
function norm(f, raw) {
  const fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  const blank = raw == null || String(raw).trim() === "";
  switch (f.t) {
    case "d":
      if (blank) return null;
      if (!isYmd(String(raw))) fail(`${LABEL[f.k] || f.k}: invalid date`);
      return String(raw);
    case "n": {
      if (blank) return f.def ?? null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) fail(`${f.k}: invalid number`);
      return n;
    }
    case "yn":
      return String(raw || "").toUpperCase() === "Y" ? "Y" : "N";
    case "c": {
      if (blank) return f.def ?? null;
      const v = String(raw).trim().toUpperCase();
      if (!f.set.includes(v)) fail(`${f.k}: invalid value ${v}`);
      return v;
    }
    default: {
      if (blank) return null;
      let v = String(raw).trim();
      if (f.nospace) v = v.replace(/\s+/g, "");
      if (f.upper) v = v.toUpperCase();
      return v.slice(0, f.max);
    }
  }
}

const selectList = (fields, alias) =>
  fields.map((f) => (f.t === "d"
    ? `DATE_FORMAT(${alias}.${f.k}, '%d/%m/%Y') AS ${f.k}`
    : `${alias}.${f.k}`)).join(", ");

module.exports = function (connection) {
  const router = express.Router();

  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
    );

  // ---------- load ----------
  router.get("/emp-ext/:code", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    try {
      const [emp, hr, pay] = await Promise.all([
        q(connection, `SELECT ${selectList(EMP_FIELDS, "e")} FROM emp_mst e WHERE e.EMP_CODE = ?`, [code]),
        q(connection, `SELECT ${selectList(HR_FIELDS, "h")} FROM hr_mst h WHERE h.EMP_CODE = ?`, [code]),
        q(connection, `SELECT ${selectList(PAY_FIELDS, "p")} FROM payroll_mst p WHERE p.EMP_CODE = ?`, [code]),
      ]);
      if (!emp.length) return res.status(404).json({ message: `Employee ${code} not found` });
      res.json({ ...emp[0], ...(hr[0] || {}), ...(pay[0] || {}) });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ---------- save ----------
  router.put("/emp-ext/:code", (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const b = req.body || {};
    const user = String(req.user?.username || req.user?.user_name || req.user?.user_id || "").slice(0, 20) || null;

    let ev, hv, pv;
    try {
      ev = EMP_FIELDS.map((f) => norm(f, b[f.k]));
      hv = HR_FIELDS.map((f) => norm(f, b[f.k]));
      pv = PAY_FIELDS.map((f) => norm(f, b[f.k]));
    } catch (e) {
      return res.status(e.status || 400).json({ message: e.message });
    }
    const get = (fields, vals, k) => vals[fields.findIndex((f) => f.k === k)];

    // business checks
    const status = get(EMP_FIELDS, ev, "EMP_STATUS");
    if (get(EMP_FIELDS, ev, "REPORTS_TO") === code) return res.status(400).json({ message: "An employee cannot report to himself" });
    if (["R", "T", "X"].includes(status) && !get(EMP_FIELDS, ev, "EXIT_DT")) {
      return res.status(400).json({ message: "Exit date is required for a resigned, terminated or absconded employee" });
    }
    const email = get(HR_FIELDS, hv, "EMAIL");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Email address is not valid" });
    const iban = get(PAY_FIELDS, pv, "IBAN");
    if (iban && iban.startsWith("AE") && !/^AE\d{21}$/.test(iban)) {
      return res.status(400).json({ message: "UAE IBAN must be AE followed by 21 digits" });
    }
    const routing = get(PAY_FIELDS, pv, "ROUTING_CODE");
    if (routing && !/^\d{9}$/.test(routing)) return res.status(400).json({ message: "Routing code must be 9 digits" });

    connection.getConnection(async (err, conn) => {
      if (err) return res.status(500).json({ message: err.message });
      try {
        await q(conn, "START TRANSACTION");

        // emp_mst
        const upd = await q(conn,
          `UPDATE emp_mst SET ${EMP_FIELDS.map((f) => `${f.k} = ?`).join(", ")} WHERE EMP_CODE = ?`,
          [...ev, code]);
        if (upd.affectedRows === 0) throw Object.assign(new Error(`Employee ${code} not found`), { status: 404 });

        // hr_mst — one row per employee
        const hrCols = HR_FIELDS.map((f) => f.k);
        await q(conn,
          `INSERT INTO hr_mst (EMP_CODE, ${hrCols.join(", ")}, CREATED_BY)
           VALUES (?, ${hrCols.map(() => "?").join(", ")}, ?)
           ON DUPLICATE KEY UPDATE ${hrCols.map((c) => `${c} = VALUES(${c})`).join(", ")}, MODIFIED_BY = ?`,
          [code, ...hv, user, user]);

        // payroll_mst — normally created with the employee; insert a row if it is missing
        const has = await q(conn, "SELECT 1 FROM payroll_mst WHERE EMP_CODE = ?", [code]);
        if (has.length) {
          await q(conn,
            `UPDATE payroll_mst SET ${PAY_FIELDS.map((f) => `${f.k} = ?`).join(", ")} WHERE EMP_CODE = ?`,
            [...pv, code]);
        } else {
          try {
            await q(conn,
              `INSERT INTO payroll_mst (EMP_CODE, ${PAY_FIELDS.map((f) => f.k).join(", ")})
               VALUES (?, ${PAY_FIELDS.map(() => "?").join(", ")})`,
              [code, ...pv]);
          } catch (e) {
            throw Object.assign(new Error(
              `No payroll record for ${code}, and one could not be created for the bank details (${e.message}). ` +
              "Enter the payroll details and save again."), { status: 400 });
          }
        }

        await q(conn, "COMMIT");
        res.json({ ok: true, message: "Employment, HR and bank details saved" });
      } catch (e) {
        await q(conn, "ROLLBACK").catch(() => {});
        if (e.code === "ER_NO_REFERENCED_ROW_2") {
          return res.status(400).json({ message: "Reports To: that employee code does not exist" });
        }
        if (e.code === "ER_CHECK_CONSTRAINT_VIOLATED") {
          return res.status(400).json({ message: `A date or value is out of order (${e.sqlMessage || e.message})` });
        }
        res.status(e.status || 500).json({ message: e.message });
      } finally {
        conn.release();
      }
    });
  });

  return router;
};
