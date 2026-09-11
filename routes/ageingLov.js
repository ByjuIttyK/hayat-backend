// LOVs for the Customer Ageing screen (CusAgeingInv.tsx).
//
//   GET /api/lov/salesmen   -> [{ SMAN_CODE, SMAN_NAME }]  from sman_mst
//   GET /api/lov/customers  -> [{ CUST_CODE, CUST_NAME }]  from cus_mst
//
// Rows keep the master column names, because the screen's Lov reads them by
// valueKey/labelKey. Table names are lowercase for the Linux VPS.
// All salesmen are listed, active or not: old invoices can still belong to
// a salesman who has since been deactivated.
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/ageingLov")(connection));
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const reply = (res, what) => (err, rows) => {
    if (err) {
      console.error(`${what} LOV failed:`, err.sqlMessage || err.message);
      return res.status(500).json({ error: `${what} LOV failed` });
    }
    res.json(rows);
  };

  router.get("/lov/salesmen", (req, res) => {
    connection.query(
      "SELECT SMAN_CODE, SMAN_NAME FROM sman_mst ORDER BY SMAN_CODE",
      reply(res, "Salesman")
    );
  });

  router.get("/lov/customers", (req, res) => {
    connection.query(
      "SELECT CUST_CODE, CUST_NAME FROM cus_mst ORDER BY CUST_NAME",
      reply(res, "Customer")
    );
  });

  return router;
};
