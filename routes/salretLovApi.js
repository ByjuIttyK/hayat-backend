// ─────────────────────────────────────────────
//  Sales Return — drop-down list data  (/api/sret-lov/...)
//  Register in HayatDb.js:
//    const salretLovApi = require("./routes/salretLovApi");
//    app.use("/api", salretLovApi(connection));
//
//  ⚠ Table/column names marked CHECK are assumed — adjust to your schema.
//  Table names are lowercase for the Linux VPS.
// ─────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  const send = fn => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      console.error("sret-lov:", err.message);
      res.status(500).json({ error: err.message });
    }
  };

  // Customers
  router.get("/sret-lov/customers", send(() =>
    q(`SELECT CUST_CODE AS CODE, CUST_NAME AS NAME
         FROM cus_mst
        ORDER BY CUST_NAME`)));

  // Debit A/c — all accounts (GL + customers + suppliers)
  router.get("/sret-lov/accounts", send(() =>
    q(`SELECT AC_CODE AS CODE, AC_HEAD AS NAME
         FROM ac_list
        ORDER BY AC_CODE`)));

  // Salesmen  (CHECK: table sman_mst)
  router.get("/sret-lov/sman", send(() =>
    q(`SELECT SMAN_CODE AS CODE, SMAN_NAME AS NAME
         FROM sman_mst
        ORDER BY SMAN_CODE`)));

  // Fabrication invoices of one customer, latest first
  router.get("/sret-lov/invoices/:cust", send(req =>
    q(`SELECT h.INV_NO,
              DATE_FORMAT(h.INV_DATE, '%d/%m/%Y') AS INV_DATE,
              h.JOB_NO,
              j.SMAN_CODE
         FROM fab_inv_hdr h
         left join job_card j on (h.job_no= j.job_no) 
        WHERE h.CUST_CODE = ?
        ORDER BY h.INV_DATE DESC, h.INV_NO DESC`, [req.params.cust])));

  // Jobs of one customer  (CHECK: job_card.JOB_NAME / CUST_CODE)
  router.get("/sret-lov/jobs/:cust", send(req =>
    q(`SELECT JOB_NO, PROJ_NAME as JOB_NAME
         FROM job_card
        WHERE CUST_CODE = ?
        ORDER BY JOB_NO DESC`, [req.params.cust])));

  // Panels invoiced against a job — panel no / description from the fab invoice items
  // (CHECK: fab_inv_dtl columns ITEM_CODE = panel no, ITEM_DES1 = panel description, INV_QTY, INV_RATE, INV_UNIT)
  router.get("/sret-lov/job-panels/:job", send(req =>
    q(`SELECT d.ITEM_CODE,
              MAX(d.ITEM_DES1) AS ITEM_DES1,
              MAX(d.INV_UNIT)  AS INV_UNIT,
              SUM(d.INV_QTY)   AS QTY,
              MAX(d.INV_RATE)  AS INV_RATE
         FROM fab_inv_dtl d
         JOIN fab_inv_hdr h ON h.INV_NO = d.INV_NO
        WHERE h.JOB_NO = ?
        GROUP BY d.ITEM_CODE
        ORDER BY d.ITEM_CODE`, [req.params.job])));

  // Item master (used when there is no Job No)
  router.get("/sret-lov/items", send(() =>
    q(`SELECT ITEM_CODE, ITEM_NAME1
         FROM item_mst
        ORDER BY ITEM_CODE`)));

  return router;
};
