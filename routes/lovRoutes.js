// ---------------------------------------------------------------------------
// lovRoutes.js
//
// GET /api/lov/:lovType?search=term
//
// Generic List-of-Values search used by SalesInquiryEnt.tsx's LovField /
// LovModal components (and reusable for any future screen's code+search
// fields). Returns [{ code, label }, ...], capped at 25 rows.
//
// *** VERIFY BEFORE USE ***
// I don't have your actual master-table schemas for salesman, location,
// job-type, reason, compliance, or engineer codes — only cus_mst/sup_mst
// (confirmed elsewhere in this app) and acc_mst. Everything below is a
// best-guess mapping based on typical naming in this codebase (e.g.
// ACC_MST(ACC_CODE, ACC_DESC) pattern). Each entry in LOV_CONFIG is
// independent, so fixing a wrong table/column name is a one-line change —
// it won't affect the other LOV types.
// ---------------------------------------------------------------------------

const LOV_CONFIG = {
  customer: { table: "cus_mst", code: "CUST_CODE", label: "CUST_NAME" },
  employee: { table: "sman_mst", code: "SMAN_CODE", label: "SMAN_NAME" }, // used for ESTIMATE_BY
  salesman: { table: "sman_mst", code: "SMAN_CODE", label: "SMAN_NAME" },
  engineer: { table: "sman_mst", code: "SMAN_CODE", label: "SMAN_NAME" }, // engineers assumed to share sman_mst too
  location: { table: "loc_mst", code: "LOC_CODE", label: "LOC_DESC" },
  "job-type": { table: "job_type_mst", code: "JOB_TYPE_CODE", label: "JOB_TYPE_DESC" },
  reason: { table: "salinq_regret_mst", code: "REGRET_CODE", label: "REGRET_REASON" },
  compliance: { table: "compliance_mst", code: "COMPLIANCE_CODE", label: "COMPLIANCE_DESC" },
  "inq-status": { table: "inq_status_mst", code: "STAT_CODE", label: "STAT_DESC" },
};

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  router.get("/lov/:lovType", async (req, res) => {
    const { lovType } = req.params;
    const search = (req.query.search || "").trim();
    const cfg = LOV_CONFIG[lovType];

    if (!cfg) {
      return res.status(404).json({ message: `Unknown LOV type: ${lovType}` });
    }

    try {
      let sql = `SELECT ${cfg.code} AS code, ${cfg.label} AS label FROM ${cfg.table}`;
      const params = [];
      if (search) {
        sql += ` WHERE ${cfg.code} LIKE ? OR ${cfg.label} LIKE ?`;
        params.push(`%${search}%`, `%${search}%`);
      }
      sql += ` ORDER BY ${cfg.code} LIMIT 25`;

      const [rows] = await db.query(sql, params);
      res.json(rows);
    } catch (err) {
      console.error(`[lov/${lovType}] query failed:`, err.message);
      res.status(500).json({ message: `Failed to search ${lovType}. Check LOV_CONFIG table/column names.` });
    }
  });

  return router;
};
