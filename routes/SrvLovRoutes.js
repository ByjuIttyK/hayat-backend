// routes/SrvLovRoutes.js
//
// SRV LOV — optionally filtered by supplier. Used by PinvLocal.tsx's
// Srv No (1) LOV. ModalLov builds the URL as:
//     <dataApi>            when no dataFilter is passed
//     <dataApi>/<supCode>  when a supplier is selected
// ...so both shapes are registered below against the same handler.
//
// NOTE: lowercase table names — MySQL on the Linux VPS runs with
// lower_case_table_names=0.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  function srvLovHandler(req, res) {
    const supCode = (req.params.supCode || "").trim();
    console.log("SRV LOV == supCode ", supCode || "(all)");

    let sql =
      "select a.SRV_NO, DATE_FORMAT(a.SRV_DATE,'%d/%m/%Y') SRV_DATE, " +
      "       a.SUP_CODE, b.SUP_NAME, a.LPO_NO, a.INV_NO " +
      "  from srv_hdr a " +
      "  left outer join sup_mst b on (a.SUP_CODE = b.SUP_CODE) ";

    const params = [];
    if (supCode) {
      sql += " where a.SUP_CODE = ? ";
      params.push(supCode);
    }
    sql += " order by a.SRV_NO desc ";

    connection.query(sql, params, function (err, result) {
      if (err) {
        console.error("Error executing query:", err);
        res.status(500).json({ error: "Query execution error" });
      } else {
        console.log("SRV LOV rows =", result ? result.length : 0);
        res.json(result || []);
      }
    });
  }

  // Unfiltered — no supplier chosen yet
  router.get("/srvlov", srvLovHandler);

  // Filtered by supplier — ModalLov appends /<SupCd> when dataFilter is set
  router.get("/srvlov/:supCode", srvLovHandler);

  return router;
};
