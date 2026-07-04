// ac_period_api.js  — Financial Period CRUD
// Mount in HayatDb.js:  app.use('/api/ac-period', require('./routes/ac_period_api')(connection));

module.exports = function (connection) {
  const router = require("express").Router();

  // ── GET — fetch the single period record ─────────────────────────────────────
  router.get("/current", async (req, res) => {
    try {
      const [rows] = await connection.promise().query(
         `SELECT DATE_FORMAT(START_DATE,'%Y-%m-%d') AS START_DATE,
              DATE_FORMAT(END_DATE,'%Y-%m-%d')   AS END_DATE,
              Main_sr_no
       FROM ac_period LIMIT 1`
      );
      if (rows.length === 0) return res.status(404).json({ message: "No period found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("ac_period GET:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST — insert new period (only if table is empty) ────────────────────────
  router.post("/", async (req, res) => {
    const { START_DATE, END_DATE, Main_sr_no } = req.body;
    if (!START_DATE || !END_DATE)
      return res.status(400).json({ message: "START_DATE and END_DATE are required." });

    try {
      const [existing] = await connection.promise().query("SELECT COUNT(*) AS cnt FROM ac_period");
      if (existing[0].cnt > 0)
        return res.status(409).json({ message: "Period already exists. Use PUT to update." });

      await connection.promise().query(
        "INSERT INTO ac_period (START_DATE, END_DATE, Main_sr_no) VALUES (?, ?, ?)",
        [START_DATE, END_DATE, Main_sr_no ?? null]
      );
      res.json({ message: "Period created." });
    } catch (err) {
      console.error("ac_period POST:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── PUT — update the single existing period ───────────────────────────────────
  router.put("/", async (req, res) => {
    const { START_DATE, END_DATE, Main_sr_no } = req.body;
    if (!START_DATE || !END_DATE)
      return res.status(400).json({ message: "START_DATE and END_DATE are required." });

    try {
      const [result] = await connection.promise().query(
        "UPDATE ac_period SET START_DATE = ?, END_DATE = ?, Main_sr_no = ?",
        [START_DATE, END_DATE, Main_sr_no ?? null]
      );
      if (result.affectedRows === 0)
        return res.status(404).json({ message: "No period record to update." });
      res.json({ message: "Period updated." });
    } catch (err) {
      console.error("ac_period PUT:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── DELETE — remove the period record ────────────────────────────────────────
  router.delete("/", async (req, res) => {
    try {
      await connection.promise().query("DELETE FROM ac_period");
      res.json({ message: "Period deleted." });
    } catch (err) {
      console.error("ac_period DELETE:", err);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};
