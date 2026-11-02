// acPeriodApi — current accounting period for InfoGrid's period chip.
// Register in HayatDb.js:
//   const acPeriodApi = require("./routes/acPeriodApi");
//   app.use("/api", acPeriodApi(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  // ac_period is always one row. Dates go out as 'yyyy-MM-dd' strings so the
  // browser's time zone can't shift them by a day.
  router.get("/ac-period", (req, res) => {
    connection.query(
      "SELECT DATE_FORMAT(START_DATE,'%Y-%m-%d') AS START_DATE, " +
      "       DATE_FORMAT(END_DATE,'%Y-%m-%d')   AS END_DATE " +
      "FROM ac_period",
      (error, rows) => {
        if (error) {
          console.error("ac-period error:", error);
          return res.status(500).json({ error: error.message });
        }
        res.json(rows[0] || {});
      }
    );
  });

  return router;
};
