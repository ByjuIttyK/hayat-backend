// routes/shiftMstApi.js
// Shift Master (shift_mst) — list / get / add / edit / delete
// Register in HayatDb.js:  app.use("/api", require("./routes/shiftMstApi")(connection));

const express = require("express");

const COLS = [
  "SHIFT_CODE", "SHIFT_NAME", "SHIFT_IN", "SHIFT_OUT",
  "IN_EARLY_MRG", "IN_LATE_MRG", "OUT_EARLY_MRG", "OUT_LATE_MRG",
  "LUNCH_FROM", "LUNCH_TO", "TEA1_FROM", "TEA1_TO", "TEA2_FROM", "TEA2_TO",
  "STD_MINS", "OT_BREAK_DEDUCT", "OT_ROUND_MINS", "LATE_FROM_MRG", "WEEK_OFF_DAY", "ACTIVE_FLAG",
];
const TIME_COLS = ["SHIFT_IN", "SHIFT_OUT", "LUNCH_FROM", "LUNCH_TO", "TEA1_FROM", "TEA1_TO", "TEA2_FROM", "TEA2_TO"];
const INT_COLS = ["IN_EARLY_MRG", "IN_LATE_MRG", "OUT_EARLY_MRG", "OUT_LATE_MRG", "STD_MINS", "OT_ROUND_MINS", "WEEK_OFF_DAY"];
const YN_COLS = ["OT_BREAK_DEDUCT", "LATE_FROM_MRG", "ACTIVE_FLAG"];
const REQUIRED_TIMES = ["SHIFT_IN", "SHIFT_OUT"];

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const toMin = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};

/** Validates and normalises the posted record. Times as HH:MM[:SS] -> HH:MM:00 */
function cleanShift(d = {}) {
  const r = {};
  r.SHIFT_CODE = String(d.SHIFT_CODE || "").trim().toUpperCase();
  r.SHIFT_NAME = String(d.SHIFT_NAME || "").trim();
  if (!r.SHIFT_CODE || r.SHIFT_CODE.length > 4) throw httpErr(400, "Shift Code is required (max 4 characters)");
  if (!r.SHIFT_NAME) throw httpErr(400, "Shift Name is required");
  if (r.SHIFT_NAME.length > 40) throw httpErr(400, "Shift Name is max 40 characters");

  for (const c of TIME_COLS) {
    const v = String(d[c] ?? "").trim();
    if (!v) {
      if (REQUIRED_TIMES.includes(c)) throw httpErr(400, `${c.replace("_", " ")} is required`);
      r[c] = null;
      continue;
    }
    const m = v.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m || +m[1] > 23 || +m[2] > 59) throw httpErr(400, `${c}: invalid time ${v}`);
    r[c] = `${m[1].padStart(2, "0")}:${m[2]}:00`;
  }
  for (const c of INT_COLS) {
    const n = Number(d[c]);
    if (!Number.isInteger(n) || n < 0) throw httpErr(400, `${c}: invalid number`);
    r[c] = n;
  }
  for (const c of YN_COLS) r[c] = d[c] === "Y" ? "Y" : "N";

  if (toMin(r.SHIFT_OUT) <= toMin(r.SHIFT_IN)) throw httpErr(400, "Shift Out must be after Shift In");
  if (r.WEEK_OFF_DAY < 1 || r.WEEK_OFF_DAY > 7) throw httpErr(400, "Week Off Day must be 1 to 7");
  if (r.STD_MINS < 1 || r.STD_MINS > 720) throw httpErr(400, "Std Minutes must be 1 to 720");
  if (r.OT_ROUND_MINS < 1) throw httpErr(400, "OT Rounding must be at least 1 minute");

  for (const [f, t, label] of [["LUNCH_FROM", "LUNCH_TO", "Lunch"], ["TEA1_FROM", "TEA1_TO", "Tea break 1"], ["TEA2_FROM", "TEA2_TO", "Tea break 2"]]) {
    if (!!r[f] !== !!r[t]) throw httpErr(400, `${label}: enter both From and To, or leave both blank`);
    if (r[f] && toMin(r[t]) <= toMin(r[f])) throw httpErr(400, `${label}: To must be after From`);
  }
  return r;
}

module.exports = function (connection) {
  const router = express.Router();
  const pool = connection.promise();

  const userOf = (req) =>
    String(
      (req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) || req.body?.user || "system"
    ).slice(0, 20);

  const send = (res, err, tag) => {
    if (!err.status) console.error(tag, err);
    res.status(err.status || 500).json({ message: err.message });
  };

  // ---------- list, with how many employees use each shift ----------
  router.get("/shift-mst/list", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT s.SHIFT_CODE, s.SHIFT_NAME,
                TIME_FORMAT(s.SHIFT_IN, '%H:%i')  AS SHIFT_IN,
                TIME_FORMAT(s.SHIFT_OUT, '%H:%i') AS SHIFT_OUT,
                s.STD_MINS, s.WEEK_OFF_DAY, s.ACTIVE_FLAG,
                (SELECT COUNT(*) FROM payroll_mst p WHERE p.SHIFT_CODE = s.SHIFT_CODE) AS EMP_CNT
           FROM shift_mst s
          ORDER BY s.SHIFT_CODE`
      );
      res.json(rows);
    } catch (err) {
      send(res, err, "shift-mst/list");
    }
  });

  // ---------- one shift ----------
  router.get("/shift-mst/:code", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT ${COLS.map((c) => (TIME_COLS.includes(c) ? `TIME_FORMAT(${c}, '%H:%i') AS ${c}` : c)).join(", ")},
                CREATED_BY, CREATED_DT, MODIFIED_BY, MODIFIED_DT
           FROM shift_mst WHERE SHIFT_CODE = ?`,
        [String(req.params.code).toUpperCase()]
      );
      if (!rows.length) throw httpErr(404, "Shift not found");
      res.json(rows[0]);
    } catch (err) {
      send(res, err, "shift-mst/get");
    }
  });

  // ---------- save (ADD / EDIT) ----------
  router.post("/save-shift-mst", async (req, res) => {
    const { mode, data } = req.body || {};
    const user = userOf(req);
    try {
      const r = cleanShift(data);
      if (mode === "ADD") {
        await pool.query(
          `INSERT INTO shift_mst (${COLS.join(", ")}, CREATED_BY) VALUES (${COLS.map(() => "?").join(", ")}, ?)`,
          [...COLS.map((c) => r[c]), user]
        );
      } else {
        const upd = COLS.filter((c) => c !== "SHIFT_CODE");
        const [u] = await pool.query(
          `UPDATE shift_mst SET ${upd.map((c) => `${c} = ?`).join(", ")}, MODIFIED_BY = ? WHERE SHIFT_CODE = ?`,
          [...upd.map((c) => r[c]), user, r.SHIFT_CODE]
        );
        if (!u.affectedRows) throw httpErr(404, "Shift not found");
      }
      res.json({ success: true, SHIFT_CODE: r.SHIFT_CODE, message: `Shift ${r.SHIFT_CODE} saved successfully` });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: `Shift Code ${String(data?.SHIFT_CODE).toUpperCase()} already exists` });
      if (err.code === "ER_CHECK_CONSTRAINT_VIOLATED") return res.status(400).json({ message: err.sqlMessage });
      send(res, err, "save-shift-mst");
    }
  });

  // ---------- delete (blocked while employees or time sheets use the shift) ----------
  router.delete("/shift-mst/:code", async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    try {
      const [[p]] = await pool.query(`SELECT COUNT(*) AS n FROM payroll_mst WHERE SHIFT_CODE = ?`, [code]);
      if (p.n > 0) throw httpErr(409, `Cannot delete — ${p.n} employee(s) are on shift ${code}. Change their shift first.`);
      try {
        const [[t]] = await pool.query(`SELECT COUNT(*) AS n FROM time_sheet_dtl WHERE SHIFT_CODE = ?`, [code]);
        if (t.n > 0) throw httpErr(409, `Cannot delete — shift ${code} is used in ${t.n} time sheet day(s). Set it inactive instead.`);
      } catch (e) {
        if (e.code !== "ER_NO_SUCH_TABLE") throw e;
      }
      const [r] = await pool.query(`DELETE FROM shift_mst WHERE SHIFT_CODE = ?`, [code]);
      if (!r.affectedRows) throw httpErr(404, "Shift not found");
      res.json({ success: true, message: `Shift ${code} deleted` });
    } catch (err) {
      if (err.code === "ER_ROW_IS_REFERENCED_2")
        return res.status(409).json({ message: `Cannot delete — shift ${code} is in use. Set it inactive instead.` });
      send(res, err, "delete shift-mst");
    }
  });

  return router;
};
