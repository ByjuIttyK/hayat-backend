// routes/holidayMstApi.js
// Holiday Master (holiday_mst) — list / add / edit / delete
// Register in HayatDb.js:  app.use("/api", require("./routes/holidayMstApi")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const pool = connection.promise();

  const userOf = (req) =>
    String(
      (req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) ||
        req.body?.user ||
        "system"
    ).slice(0, 20);

  const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(new Date(s + "T00:00:00Z"));

  // ---------- years that have holidays (for the year filter) ----------
  router.get("/holiday-mst/years", async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT DISTINCT YEAR(HOL_DATE) AS YR FROM holiday_mst ORDER BY YR DESC`
      );
      res.json(rows.map((r) => r.YR));
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- list (optionally by year) ----------
  router.get("/holiday-mst/list", async (req, res) => {
    try {
      const yr = Number(req.query.year);
      const where = Number.isInteger(yr) && yr > 1900 ? "WHERE YEAR(HOL_DATE) = ?" : "";
      const [rows] = await pool.query(
        `SELECT DATE_FORMAT(HOL_DATE, '%Y-%m-%d') AS HOL_DATE, HOL_DESC,
                DAYNAME(HOL_DATE) AS DAY_NAME, CREATED_BY, MODIFIED_BY
           FROM holiday_mst ${where}
          ORDER BY HOL_DATE`,
        where ? [yr] : []
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- save (ADD / EDIT) ----------
  // EDIT may change the date itself (e.g. an expected holiday confirmed on another day)
  router.post("/save-holiday-mst", async (req, res) => {
    const { mode, origDate, data } = req.body || {};
    const user = userOf(req);
    const hDate = String(data?.HOL_DATE || "").trim();
    const hDesc = String(data?.HOL_DESC || "").trim();

    if (!isIsoDate(hDate)) return res.status(400).json({ message: "Enter a valid holiday date" });
    if (!hDesc) return res.status(400).json({ message: "Description is required" });
    if (hDesc.length > 60) return res.status(400).json({ message: "Description is max 60 characters" });

    try {
      if (mode === "ADD") {
        await pool.query(
          `INSERT INTO holiday_mst (HOL_DATE, HOL_DESC, CREATED_BY) VALUES (?, ?, ?)`,
          [hDate, hDesc, user]
        );
      } else {
        if (!isIsoDate(origDate)) return res.status(400).json({ message: "Original date missing" });
        const [r] = await pool.query(
          `UPDATE holiday_mst SET HOL_DATE = ?, HOL_DESC = ?, MODIFIED_BY = ? WHERE HOL_DATE = ?`,
          [hDate, hDesc, user, origDate]
        );
        if (!r.affectedRows) return res.status(404).json({ message: "Holiday not found" });
      }
      res.json({ success: true, HOL_DATE: hDate, message: "Holiday saved successfully" });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY")
        return res.status(409).json({ message: `A holiday already exists on ${hDate.split("-").reverse().join("/")}` });
      console.error("save-holiday-mst", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- delete ----------
  router.delete("/holiday-mst/:date", async (req, res) => {
    const hDate = req.params.date;
    if (!isIsoDate(hDate)) return res.status(400).json({ message: "Invalid date" });
    try {
      const [r] = await pool.query(`DELETE FROM holiday_mst WHERE HOL_DATE = ?`, [hDate]);
      if (!r.affectedRows) return res.status(404).json({ message: "Holiday not found" });
      res.json({ success: true, message: "Holiday deleted" });
    } catch (err) {
      console.error("delete holiday-mst", err);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};
