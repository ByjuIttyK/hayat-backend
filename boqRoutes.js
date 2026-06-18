"use strict";
/**
 * boqRoutes.js  — BOQ CRUD routes for JobCostEstimation
 * Mount in HayatDb.js:
 *   const boqRoutes = require('./boqRoutes')(connection);
 *   app.use('/api', boqRoutes);
 *
 * NOTE: ACTUAL_QTY, ACTUAL_COST, VARIANCE are NOT stored in job_boq.
 *       They are computed live from siv_items via /api/job-boq-actuals.
 */
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const db = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, r) => err ? reject(err) : resolve(r))
    );

  // ── GET /api/job-boq/:jobNo/:srNo — load saved BOQ rows ──────────────────
  router.get("/job-boq/:jobNo/:srNo", async (req, res) => {
    const { jobNo, srNo } = req.params;
    try {
      const rows = await db(
        `SELECT SEQ_NO, COST_TYPE, ITEM_CODE, DESCRIPTION,
                UNIT, QTY, UNIT_COST, TOTAL_COST, REMARKS
         FROM   job_boq
         WHERE  JOB_NO = ? AND PANEL_SR_NO = ?
         ORDER  BY SEQ_NO`,
        [jobNo, srNo]
      );
      res.json(rows.map(r => ({
        SEQ:         r.SEQ_NO,
        COST_TYPE:   r.COST_TYPE,
        ITEM_CODE:   r.ITEM_CODE,
        DESCRIPTION: r.DESCRIPTION,
        UNIT:        r.UNIT,
        QTY:         r.QTY,
        UNIT_COST:   r.UNIT_COST,
        TOTAL_COST:  r.TOTAL_COST,
        REMARKS:     r.REMARKS,
      })));
    } catch (err) {
      console.error("[job-boq GET]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/job-boq-save — save BOQ rows (estimated only) ──────────────
  router.post("/job-boq-save", async (req, res) => {
    const { jobNo, srNo, rows = [] } = req.body;
    if (!jobNo || !srNo) return res.status(400).json({ error: "jobNo and srNo required" });
    try {
      await db("DELETE FROM job_boq WHERE JOB_NO = ? AND PANEL_SR_NO = ?", [jobNo, srNo]);
      const valid = rows.filter(r => r.ITEM_CODE || r.DESCRIPTION);
      if (valid.length > 0) {
        const vals = valid.map(r => [
          jobNo, srNo,
          r.SEQ         || 1,
          r.COST_TYPE   || "COMP",
          r.ITEM_CODE   || "",
          r.DESCRIPTION || "",
          r.UNIT        || "NOS",
          Number(r.QTY)        || 0,
          Number(r.UNIT_COST)  || 0,
          Number(r.TOTAL_COST) || 0,
          r.REMARKS || "",
        ]);
        await db(
          `INSERT INTO job_boq
             (JOB_NO, PANEL_SR_NO, SEQ_NO, COST_TYPE, ITEM_CODE,
              DESCRIPTION, UNIT, QTY, UNIT_COST, TOTAL_COST, REMARKS)
           VALUES ?`,
          [vals]
        );
      }
      console.log(`[job-boq-save] Job=${jobNo} Panel=${srNo} saved=${valid.length}`);
      res.json({ success: true, saved: valid.length });
    } catch (err) {
      console.error("[job-boq-save]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /api/job-boq/:jobNo/:srNo — delete panel BOQ ──────────────────
  router.delete("/job-boq/:jobNo/:srNo", async (req, res) => {
    const { jobNo, srNo } = req.params;
    try {
      const result = await db(
        "DELETE FROM job_boq WHERE JOB_NO = ? AND PANEL_SR_NO = ?",
        [jobNo, srNo]
      );
      console.log(`[job-boq DELETE] Job=${jobNo} Panel=${srNo} deleted=${result.affectedRows}`);
      res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
      console.error("[job-boq DELETE]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/job-boq-actuals/:jobNo/:srNo ────────────────────────────────
  // Compute live actuals from siv_items using AVGCOST() stored function.
  // Never stored in DB — always fresh from SIV transactions.
  router.get("/job-boq-actuals/:jobNo/:srNo", async (req, res) => {
    const { jobNo, srNo } = req.params;
    try {
      const rows = await db(
        `SELECT
           item_code                                        AS ITEM_CODE,
           SUM(qty)                                        AS ACT_QTY,
           SUM(qty * AVGCOST('01', item_code, siv_date))   AS ACT_TOTAL
         FROM   siv_items
         WHERE  job_no   = ?
           AND  panel_no = ?
         GROUP  BY item_code`,
        [jobNo, srNo]
      );
      res.json(rows.map(r => ({
        ITEM_CODE: String(r.ITEM_CODE || "").trim(),
        ACT_QTY:   Number(r.ACT_QTY)   || 0,
        ACT_TOTAL: Number(r.ACT_TOTAL)  || 0,
      })));
    } catch (err) {
      console.error("[job-boq-actuals]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/job-tab-totals/:jobNo ────────────────────────────────────────
  // Returns aggregated totals for all tab badges in one request
  router.get("/job-tab-totals/:jobNo", async (req, res) => {
    const { jobNo } = req.params;

    // Safe query — returns 0 on any error instead of crashing
    const safeDb = async (sql, params) => {
      try {
        const [row] = await db(sql, params);
        return row || {};
      } catch { return {}; }
    };

    try {
      const [boq, pur, inv, siv, grtn, job, labr, othr] = await Promise.all([
        safeDb(`SELECT IFNULL(SUM(TOTAL_COST),0) AS BOQ_EST FROM job_boq WHERE JOB_NO=?`, [jobNo]),
        safeDb(`SELECT IFNULL(SUM(qty*cost),0) AS PURCHASE_AMT FROM srv_items WHERE job_no=?`, [jobNo]),
        safeDb(`SELECT IFNULL(SUM(net_amt),0) AS SALES_INV_AMT FROM fab_inv WHERE job_no=?`, [jobNo]),
        safeDb(`SELECT IFNULL(SUM(qty * AVGCOST('01', item_code, siv_date)),0) AS STORE_ISSUES FROM siv_items WHERE job_no=?`, [jobNo]),
        safeDb(`SELECT IFNULL(SUM(qty*cost),0) AS GOODS_RTN FROM srv_items WHERE job_no=? AND tran_type='RETURN'`, [jobNo]),
        safeDb(`SELECT IFNULL(contract_amt,0) AS CONTRACT_AMT, IFNULL(contract_amt * IFNULL(vat_pct,0) / 100, 0) AS VAT_AMT FROM job_master WHERE job_no=?`, [jobNo]),
        safeDb(`SELECT IFNULL(SUM(TOTAL_COST),0) AS LABOUR_COST FROM job_boq WHERE JOB_NO=? AND COST_TYPE='LABR'`, [jobNo]),
        safeDb(`SELECT IFNULL(SUM(TOTAL_COST),0) AS OTHER_COST  FROM job_boq WHERE JOB_NO=? AND COST_TYPE='OTHR'`, [jobNo]),
      ]);

      res.json({
        // Tab badge totals
        BOQ_EST:        Number(boq.BOQ_EST)        || 0,
        PURCHASE_AMT:   Number(pur.PURCHASE_AMT)   || 0,
        SALES_INV_AMT:  Number(inv.SALES_INV_AMT)  || 0,
        STORE_ISSUES:   Number(siv.STORE_ISSUES)   || 0,
        GOODS_RTN:      Number(grtn.GOODS_RTN)     || 0,
        // P&L fields
        CONTRACT_AMT:   Number(job.CONTRACT_AMT)   || 0,
        VAT_AMT:        Number(job.VAT_AMT)        || 0,
        INVOICED_AMT:   Number(inv.SALES_INV_AMT)  || 0,
        PURCHASE_COST:  Number(pur.PURCHASE_AMT)   || 0,
        ISSUED_COST:    Number(siv.STORE_ISSUES)   || 0,
        GOODS_RTN_COST: Number(grtn.GOODS_RTN)     || 0,
        LABOUR_COST:    Number(labr.LABOUR_COST)   || 0,
        OTHER_COST:     Number(othr.OTHER_COST)    || 0,
        BOQ_EST_TOTAL:  Number(boq.BOQ_EST)        || 0,
      });
    } catch (err) {
      console.error("[job-tab-totals]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;   // ← always last
};
