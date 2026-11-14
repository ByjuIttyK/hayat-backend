// routes/quotConversionApi.js
// Quotation → Job → Invoice → Settlement conversion analysis
// Register in HayatDb.js:
//   app.use("/api", require("./routes/quotConversionApi")(connection));
//
// GET /api/quot-conversion?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Rules
//  - A quotation and its revisions (0000005932, 0000005932/01, /02 ...) are counted ONCE
//    (the "quote family" = QUOT_NO before the '/'), dated by its first revision.
//  - Converted   : job_card.QUOT_REF points to any revision of the family (CANCEL_IND <> 'Y')
//  - Invoiced    : fab_inv_hdr.JOB_NO = job_card.JOB_NO (INV_CANCELLED <> 'Y')
//  - Settled     : SUM(adj_dtl.STLD_AMT) where STLD_DOC = INV_NO and STLD_TYPE = '06'
//                  settled when outstanding <= 0.01, partly when something is settled

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;

  // Invoice value compared with settlements.
  // If fab_inv_hdr.NET_AMT is BEFORE VAT, change to: IFNULL(h.NET_AMT,0) + IFNULL(h.VAT_AMOUNT,0)
  const INV_AMT = "IFNULL(h.NET_AMT,0)";

  const BASE_CTE = `
    q AS (
      SELECT SUBSTRING_INDEX(TRIM(qh.QUOT_NO),'/',1) AS BASE_NO,
             MIN(qh.QUOT_DATE)                       AS QUOT_DATE,
             MAX(qh.CUST_CODE)                       AS CUST_CODE,
             COUNT(*)                                AS REVS
        FROM quot_hdr qh
       GROUP BY SUBSTRING_INDEX(TRIM(qh.QUOT_NO),'/',1)
      HAVING MIN(qh.QUOT_DATE) BETWEEN ? AND ?
    ),
    j AS (
      SELECT SUBSTRING_INDEX(TRIM(jc.QUOT_REF),'/',1) AS BASE_NO,
             jc.JOB_NO,
             jc.START_DATE,
             IFNULL(jc.CONTRACT_AMT,0)               AS CONTRACT_AMT
        FROM job_card jc
       WHERE IFNULL(TRIM(jc.QUOT_REF),'') <> ''
         AND IFNULL(jc.CANCEL_IND,'N') <> 'Y'
    )`;

  const SQL_QUOTES = `
    WITH ${BASE_CTE}
    SELECT q.BASE_NO, q.QUOT_DATE, q.CUST_CODE, c.CUST_NAME, q.REVS
      FROM q
      LEFT JOIN cus_mst c ON c.CUST_CODE = q.CUST_CODE`;

  const SQL_JOBS = `
    WITH ${BASE_CTE}
    SELECT j.BASE_NO, j.JOB_NO, j.START_DATE, j.CONTRACT_AMT
      FROM j
      JOIN q ON q.BASE_NO = j.BASE_NO`;

  const SQL_INVOICES = `
    WITH ${BASE_CTE},
    s AS (
      SELECT STLD_DOC, SUM(IFNULL(STLD_AMT,0)) AS AMT
        FROM adj_dtl
       WHERE STLD_TYPE = '06'
       GROUP BY STLD_DOC
    )
    SELECT h.INV_NO, h.INV_DATE, h.JOB_NO, h.CUST_CODE, h.FINAL_INV,
           ${INV_AMT}      AS INV_AMT,
           IFNULL(s.AMT,0) AS STLD_AMT,
           j.BASE_NO
      FROM fab_inv_hdr h
      JOIN j ON j.JOB_NO = h.JOB_NO
      JOIN q ON q.BASE_NO = j.BASE_NO
      LEFT JOIN s ON s.STLD_DOC = h.INV_NO
     WHERE IFNULL(h.INV_CANCELLED,'N') <> 'Y'`;

  const num = (v) => Number(v || 0);
  const r2 = (v) => Math.round(v * 100) / 100;
  const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : 0);

  const ym = (d) => {
    if (!d) return "";
    if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return String(d).slice(0, 7);
  };
  const dmy = (d) => {
    if (!d) return "";
    const x = d instanceof Date ? d : new Date(d);
    if (isNaN(x)) return String(d);
    return `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}/${x.getFullYear()}`;
  };

  router.get("/quot-conversion", async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to dates are required (YYYY-MM-DD)" });
    const p = [from, to];

    try {
      const [[quotes], [jobs], [invoices]] = await Promise.all([
        db.query(SQL_QUOTES, p),
        db.query(SQL_JOBS, p),
        db.query(SQL_INVOICES, p),
      ]);

      // ---- index ----
      const jobsByBase = {};
      jobs.forEach((j) => (jobsByBase[j.BASE_NO] = jobsByBase[j.BASE_NO] || []).push(j));
      const invByJob = {};
      invoices.forEach((i) => (invByJob[i.JOB_NO] = invByJob[i.JOB_NO] || []).push(i));

      // ---- invoice status ----
      let invSettled = 0, invPartly = 0, invUnsettled = 0;
      let invAmt = 0, stldAmt = 0, outAmt = 0;
      const outstanding = [];
      invoices.forEach((i) => {
        const amt = num(i.INV_AMT);
        const st = Math.min(num(i.STLD_AMT), amt > 0 ? amt : num(i.STLD_AMT));
        const os = r2(amt - num(i.STLD_AMT));
        invAmt += amt;
        stldAmt += st;
        if (os <= 0.01) invSettled++;
        else {
          outAmt += os;
          if (num(i.STLD_AMT) > 0) invPartly++;
          else invUnsettled++;
          outstanding.push({
            INV_NO: i.INV_NO,
            INV_DATE: dmy(i.INV_DATE),
            JOB_NO: i.JOB_NO,
            QUOT_NO: i.BASE_NO,
            CUST_CODE: i.CUST_CODE,
            INV_AMT: r2(amt),
            STLD_AMT: r2(num(i.STLD_AMT)),
            OS_AMT: os,
            AGE_DAYS: i.INV_DATE ? Math.floor((Date.now() - new Date(i.INV_DATE).getTime()) / 86400000) : null,
          });
        }
      });

      // ---- jobs ----
      const jobsInvoiced = jobs.filter((j) => invByJob[j.JOB_NO]);
      const jobsFinal = jobsInvoiced.filter((j) => invByJob[j.JOB_NO].some((i) => i.FINAL_INV === "Y"));
      const contractAmt = jobs.reduce((a, j) => a + num(j.CONTRACT_AMT), 0);

      // ---- quote families ----
      const converted = quotes.filter((q) => jobsByBase[q.BASE_NO]);
      const quoteInvoiced = (q) => (jobsByBase[q.BASE_NO] || []).some((j) => invByJob[j.JOB_NO]);

      // ---- monthly cohort (by quotation month) ----
      const mMap = {};
      quotes.forEach((q) => {
        const k = ym(q.QUOT_DATE);
        const m = (mMap[k] = mMap[k] || { MONTH: k, QUOTES: 0, CONVERTED: 0, INVOICED: 0 });
        m.QUOTES++;
        if (jobsByBase[q.BASE_NO]) m.CONVERTED++;
        if (quoteInvoiced(q)) m.INVOICED++;
      });
      const monthly = Object.values(mMap).sort((a, b) => a.MONTH.localeCompare(b.MONTH));

      // ---- customers ----
      const cMap = {};
      quotes.forEach((q) => {
        const k = q.CUST_CODE || "-";
        const c = (cMap[k] = cMap[k] || { CUST_CODE: k, CUST_NAME: q.CUST_NAME || "", QUOTES: 0, CONVERTED: 0, JOBS: 0, INVOICED_JOBS: 0, OS_AMT: 0 });
        c.QUOTES++;
        const js = jobsByBase[q.BASE_NO] || [];
        if (js.length) c.CONVERTED++;
        c.JOBS += js.length;
        c.INVOICED_JOBS += js.filter((j) => invByJob[j.JOB_NO]).length;
      });
      const custName = {};
      quotes.forEach((q) => (custName[q.CUST_CODE] = q.CUST_NAME));
      outstanding.forEach((o) => {
        o.CUST_NAME = custName[o.CUST_CODE] || "";
        if (cMap[o.CUST_CODE]) cMap[o.CUST_CODE].OS_AMT = r2(cMap[o.CUST_CODE].OS_AMT + o.OS_AMT);
      });
      const customers = Object.values(cMap)
        .map((c) => ({ ...c, CONV_PCT: pct(c.CONVERTED, c.QUOTES) }))
        .sort((a, b) => b.QUOTES - a.QUOTES)
        .slice(0, 15);

      outstanding.sort((a, b) => b.OS_AMT - a.OS_AMT);

      res.json({
        period: { from, to },
        summary: {
          QUOTES: quotes.length,
          REVISIONS: quotes.reduce((a, q) => a + num(q.REVS), 0),
          CONVERTED: converted.length,
          CONV_PCT: pct(converted.length, quotes.length),
          JOBS: jobs.length,
          CONTRACT_AMT: r2(contractAmt),
          JOBS_INVOICED: jobsInvoiced.length,
          JOBS_INV_PCT: pct(jobsInvoiced.length, jobs.length),
          JOBS_FINAL: jobsFinal.length,
          INVOICES: invoices.length,
          INV_AMT: r2(invAmt),
          INV_SETTLED: invSettled,
          INV_PARTLY: invPartly,
          INV_UNSETTLED: invUnsettled,
          SETTLED_PCT: pct(invSettled, invoices.length),
          STLD_AMT: r2(stldAmt),
          OS_AMT: r2(outAmt),
        },
        monthly,
        customers,
        outstanding: outstanding.slice(0, 100),
      });
    } catch (err) {
      console.error("quot-conversion:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
