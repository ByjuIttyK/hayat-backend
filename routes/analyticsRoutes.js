/**
 * analyticsRoutes.js  — v2 (corrected for hayat schema)
 * Al Hayat ERP — Analytics & Intelligence API
 *
 * Schema corrections applied vs v1:
 *   job_mst       → job_card
 *   JOB_STATUS    → CLOSED / CANCEL_IND flags
 *   PROJECT_NAME  → PROJ_NAME
 *   CUST_NAME     → join cus_mst on CUST_CODE (aliased)
 *   VOUCHERS.VCHR_DATE → DATTE
 *   VOUCHERS.VCHR_TYPE → TRAN_TYPE  ('03'=BankRV '04'=BankPV '05'=JV)
 *   TRAN_ACC.DR_CR     → DB_CR
 *   TRAN_ACC.VCHR_DATE → DATTE
 *   pdc_rcd/isu.CHQ_STATUS → REALISED ('Y'=realised, NULL/'N'=pending)
 *   pdc_rcd/isu.CHQ_AMT    → AMOUNT
 *   srv_items.UNIT_COST    → STD_COST
 *   purchase_hdr.NET_AMOUNT→ INV_AMOUNT
 *   purchase_hdr.SUPP_CODE → SUP_CODE
 *   supp_mst               → sup_mst
 *   CHART_ACC              → acc_mst
 *
 * Register in HayatDb.js (add these 2 lines near other route registrations):
 *   const analyticsRoutes = require('./routes/analyticsRoutes')(connection);
 *   app.use('/api/analytics', analyticsRoutes);
 */

const express = require('express');

const makeDb = (connection) => (sql, params = []) =>
  new Promise((resolve, reject) =>
    connection.query(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows)
    )
  );

const safeDb = (db) => async (sql, params = []) => {
  try { return await db(sql, params); }
  catch (e) { console.error('[analyticsRoutes safeDb]', e.message); return []; }
};

module.exports = function (connection) {
  const router = express.Router();
  const db     = makeDb(connection);
  const safe   = safeDb(db);

  // ══════════════════════════════════════════════════════════════════════════
  //  1. JOB COST VARIANCE
  //     BOQ estimated (job_boq.QTY * UNIT_COST) vs
  //     actual issues (siv_items.QTY * AVGCOST)
  //     job_card: active = CLOSED != 'Y' AND CANCEL_IND != 'Y'
  // ══════════════════════════════════════════════════════════════════════════
  router.get('/job-cost-variance', async (req, res) => {
    try {
      // Estimated totals from job_boq grouped by job
      const estimated = await db(`
        SELECT
          b.JOB_NO,
          j.PROJ_NAME,
          j.CUST_CODE,
          c.CUST_NAME,
          j.CONTRACT_AMT,
          CASE
            WHEN j.CLOSED      = 'Y' THEN 'CLOSED'
            WHEN j.CANCEL_IND  = 'Y' THEN 'CANCELLED'
            ELSE 'ACTIVE'
          END                              AS JOB_STATUS,
          SUM(b.QTY * b.UNIT_COST)         AS EST_TOTAL,
          COUNT(DISTINCT b.PANEL_SR_NO)    AS PANEL_COUNT
        FROM   job_boq b
        JOIN   job_card j  ON j.JOB_NO   = b.JOB_NO
        LEFT JOIN cus_mst c ON c.CUST_CODE = j.CUST_CODE
        WHERE  (j.CLOSED     IS NULL OR j.CLOSED     != 'Y')
          AND  (j.CANCEL_IND IS NULL OR j.CANCEL_IND != 'Y')
        GROUP  BY b.JOB_NO, j.PROJ_NAME, j.CUST_CODE, c.CUST_NAME,
                  j.CONTRACT_AMT, j.CLOSED, j.CANCEL_IND
        ORDER  BY b.JOB_NO DESC
        LIMIT  50
      `);

      if (!estimated.length) return res.json([]);

      // Actual costs from siv_items using AVGCOST stored function
      const actuals = await db(`
        SELECT
          s.JOB_NO,
          SUM(s.QTY * AVGCOST('01', s.ITEM_CODE, s.SIV_DATE)) AS ACT_TOTAL,
          SUM(s.QTY)                                           AS ACT_QTY
        FROM   siv_items s
        WHERE  s.JOB_NO IN (${estimated.map(() => '?').join(',')})
        GROUP  BY s.JOB_NO
      `, estimated.map(r => r.JOB_NO));

      const actMap = {};
      actuals.forEach(r => { actMap[r.JOB_NO] = r; });

      const result = estimated.map(e => {
        const act      = actMap[e.JOB_NO] || {};
        const estTotal = Number(e.EST_TOTAL)   || 0;
        const actTotal = Number(act.ACT_TOTAL) || 0;
        const variance = estTotal > 0
          ? ((actTotal - estTotal) / estTotal) * 100
          : 0;

        return {
          jobNo:        e.JOB_NO,
          custCode:     e.CUST_CODE,
          custName:     e.CUST_NAME || e.CUST_CODE,
          projectName:  e.PROJ_NAME || '-',
          contractAmt:  Math.round(Number(e.CONTRACT_AMT) * 100) / 100,
          jobStatus:    e.JOB_STATUS,
          panelCount:   Number(e.PANEL_COUNT),
          estTotal:     Math.round(estTotal  * 100) / 100,
          actTotal:     Math.round(actTotal  * 100) / 100,
          variance:     Math.round(variance  * 100) / 100,
          status:       variance > 15 ? 'OVER'
                      : variance > 5  ? 'WATCH'
                      :                 'OK',
        };
      });

      res.json(result);
    } catch (err) {
      console.error('[analytics/job-cost-variance]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  2. INVENTORY OPTIMIZATION
  //     Stock = SUM(srv_items.QTY) - SUM(siv_items.QTY)
  //     Rate  = srv_items.STD_COST (last received cost)
  //     Consumption = siv_items issues last 6 months / 6
  // ══════════════════════════════════════════════════════════════════════════
  router.get('/inventory', async (req, res) => {
    try {
      const rows = await db(`
        SELECT
          i.ITEM_CODE,
          i.ITEM_NAME1                                        AS ITEM_NAME,
          i.CAT_CODE                                          AS CATEGORY,
          i.ITEM_UNIT                                         AS UNIT,
          COALESCE(stock.CURR_QTY,   0)                       AS CURR_QTY,
          COALESCE(cons.AVG_MONTHLY, 0)                       AS AVG_MONTHLY,
          COALESCE(cons.AVG_MONTHLY, 0) * 2                   AS REORDER_POINT,
          CASE
            WHEN COALESCE(cons.AVG_MONTHLY, 0) > 0
            THEN ROUND(COALESCE(stock.CURR_QTY, 0) /
                 (COALESCE(cons.AVG_MONTHLY, 0) / 30))
            ELSE 999
          END                                                 AS DAYS_REMAINING,
          COALESCE(stock.LAST_RATE, 0)                        AS LAST_RATE
        FROM item_mst i
        LEFT JOIN (
          SELECT
            ITEM_CODE,
            SUM(CASE WHEN TXN_TYPE = 'IN' THEN QTY ELSE -QTY END) AS CURR_QTY,
            MAX(LAST_RATE)                                          AS LAST_RATE
          FROM (
            SELECT ITEM_CODE, QTY, 'IN'  AS TXN_TYPE, STD_COST AS LAST_RATE
            FROM   srv_items WHERE LOC_CODE = '01'
            UNION ALL
            SELECT ITEM_CODE, QTY, 'OUT' AS TXN_TYPE, 0        AS LAST_RATE
            FROM   siv_items WHERE LOC_CODE = '01'
          ) txns
          GROUP BY ITEM_CODE
        ) stock ON stock.ITEM_CODE = i.ITEM_CODE
        LEFT JOIN (
          SELECT
            ITEM_CODE,
            SUM(QTY) / 6 AS AVG_MONTHLY
          FROM   siv_items
          WHERE  SIV_DATE >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
          GROUP  BY ITEM_CODE
        ) cons ON cons.ITEM_CODE = i.ITEM_CODE
        WHERE  i.LOC_CODE = '01'
          AND (COALESCE(stock.CURR_QTY,  0) > 0
            OR COALESCE(cons.AVG_MONTHLY, 0) > 0)
        ORDER  BY DAYS_REMAINING ASC
        LIMIT  200
      `);

      const result = rows.map(r => ({
        itemCode:      r.ITEM_CODE,
        itemName:      r.ITEM_NAME,
        category:      r.CATEGORY,
        unit:          r.UNIT,
        currQty:       Math.round(Number(r.CURR_QTY)       * 100) / 100,
        avgMonthly:    Math.round(Number(r.AVG_MONTHLY)    * 100) / 100,
        reorderPoint:  Math.round(Number(r.REORDER_POINT)  * 100) / 100,
        daysRemaining: Number(r.DAYS_REMAINING),
        lastRate:      Math.round(Number(r.LAST_RATE)      * 100) / 100,
        stockValue:    Math.round(Number(r.CURR_QTY) * Number(r.LAST_RATE) * 100) / 100,
        status: Number(r.DAYS_REMAINING) <= 7  ? 'CRITICAL'
               : Number(r.DAYS_REMAINING) <= 30 ? 'LOW'
               : Number(r.CURR_QTY) <= Number(r.REORDER_POINT) ? 'REORDER'
               :                                  'OK',
      }));

      res.json(result);
    } catch (err) {
      console.error('[analytics/inventory]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  3. CASH FLOW FORECAST
  //     Actual: TRAN_ACC filtered to bank ACC_CODEs (ACC_TYPE='BANK' in acc_mst)
  //             DB_CR field: 'C'=credit(inflow) 'D'=debit(outflow)
  //             Date field: DATTE
  //     PDC:    pdc_rcd — incoming cheques; REALISED='Y' means already cleared
  //             pdc_isu — outgoing cheques; REALISED='Y' means already cleared
  //             AMOUNT field (not CHQ_AMT)
  // ══════════════════════════════════════════════════════════════════════════
  router.get('/cash-flow', async (req, res) => {
    try {
      const [glActual, pdcIn, pdcOut, bankBal] = await Promise.all([

        // Actual daily bank movements — last 30 days
        safe(`
          SELECT
            t.DATTE                                                    AS TXN_DATE,
            SUM(CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE 0 END)     AS CASH_IN,
            SUM(CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE 0 END)     AS CASH_OUT
          FROM   tran_acc t
          JOIN   acc_mst  a ON a.ACC_CODE = t.ACC_CODE
          WHERE  a.ACC_TYPE = 'B'
            AND  t.DATTE >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
          GROUP  BY t.DATTE
          ORDER  BY t.DATTE
        `),

        // PDC cheques received — pending future inflows (REALISED != 'Y')
        safe(`
          SELECT
            DATE(CHQ_DATE)       AS TXN_DATE,
            SUM(AMOUNT)          AS AMOUNT
          FROM   pdc_rcd
          WHERE  (REALISED IS NULL OR REALISED != 'Y')
            AND  CHQ_DATE BETWEEN CURDATE()
                              AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)
          GROUP  BY DATE(CHQ_DATE)
          ORDER  BY TXN_DATE
        `),

        // PDC cheques issued — pending future outflows
        safe(`
          SELECT
            DATE(CHQ_DATE)       AS TXN_DATE,
            SUM(AMOUNT)          AS AMOUNT
          FROM   pdc_isu
          WHERE  (REALISED IS NULL OR REALISED != 'Y')
            AND  CHQ_DATE BETWEEN CURDATE()
                              AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)
          GROUP  BY DATE(CHQ_DATE)
          ORDER  BY TXN_DATE
        `),

        // Current bank balance
        safe(`
          SELECT
            SUM(CASE WHEN t.DB_CR='C' THEN t.AMOUNT ELSE -t.AMOUNT END) AS BAL
          FROM   tran_acc t
          JOIN   acc_mst  a ON a.ACC_CODE = t.ACC_CODE
          WHERE  a.ACC_TYPE = 'B'
        `),
      ]);

      const currentBalance = Number((bankBal[0] || {}).BAL) || 0;

      // Build date-keyed flow map
      const flowMap = {};
      glActual.forEach(r => {
        const d = r.TXN_DATE instanceof Date
          ? r.TXN_DATE.toISOString().slice(0, 10)
          : String(r.TXN_DATE).slice(0, 10);
        flowMap[d] = {
          date: d, type: 'ACTUAL',
          cashIn:  Math.round(Number(r.CASH_IN)  * 100) / 100,
          cashOut: Math.round(Number(r.CASH_OUT) * 100) / 100,
          pdcIn: 0, pdcOut: 0,
        };
      });

      pdcIn.forEach(r => {
        const d = r.TXN_DATE instanceof Date
          ? r.TXN_DATE.toISOString().slice(0, 10)
          : String(r.TXN_DATE).slice(0, 10);
        if (!flowMap[d]) flowMap[d] = { date: d, type: 'FORECAST', cashIn: 0, cashOut: 0, pdcIn: 0, pdcOut: 0 };
        flowMap[d].pdcIn = Math.round(Number(r.AMOUNT) * 100) / 100;
      });

      pdcOut.forEach(r => {
        const d = r.TXN_DATE instanceof Date
          ? r.TXN_DATE.toISOString().slice(0, 10)
          : String(r.TXN_DATE).slice(0, 10);
        if (!flowMap[d]) flowMap[d] = { date: d, type: 'FORECAST', cashIn: 0, cashOut: 0, pdcIn: 0, pdcOut: 0 };
        flowMap[d].pdcOut = Math.round(Number(r.AMOUNT) * 100) / 100;
      });

      // Running balance
      const sorted = Object.values(flowMap).sort((a, b) =>
        a.date.localeCompare(b.date));
      let running = currentBalance;
      const flow = sorted.map(day => {
        const net = (day.cashIn + day.pdcIn) - (day.cashOut + day.pdcOut);
        running = Math.round((running + net) * 100) / 100;
        return { ...day, net: Math.round(net * 100) / 100, runningBalance: running };
      });

      res.json({ currentBalance: Math.round(currentBalance * 100) / 100, flow });
    } catch (err) {
      console.error('[analytics/cash-flow]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  4. ANOMALY DETECTION
  //     Uses: purchase_hdr (INV_AMOUNT, SUP_CODE, INV_NO, INV_DATE)
  //           srv_items    (STD_COST, SRV_DATE, ITEM_CODE — no SUPP_CODE;
  //                         join purchase_hdr via SRV_NO→SRV_NO/PJV_NO)
  //           vouchers     (TRAN_TYPE: '04'=BankPV, DATTE, AMOUNT, ACC_CODE)
  //           acc_mst      (ACC_CODE, ACC_HEAD)
  //           sup_mst      (SUP_CODE, SUP_NAME)
  // ══════════════════════════════════════════════════════════════════════════
  router.get('/anomalies', async (req, res) => {
    try {
      const [duplicates, largePayments, roundNumbers, priceSpikes] = await Promise.all([

        // Duplicate invoice amounts from same supplier in last 90 days
        safe(`
          SELECT
            'DUPLICATE_AMOUNT'                                    AS ANOMALY_TYPE,
            p.SUP_CODE,
            s.SUP_NAME,
            p.INV_AMOUNT                                          AS AMOUNT,
            COUNT(*)                                              AS OCCURRENCE,
            MAX(p.INV_DATE)                                       AS LAST_DATE,
            GROUP_CONCAT(p.INV_NO ORDER BY p.INV_DATE)           AS INV_NOS,
            'Same amount invoiced multiple times by supplier'     AS DESCRIPTION
          FROM   purchase_hdr p
          JOIN   sup_mst s ON s.SUP_CODE = p.SUP_CODE
          WHERE  p.INV_DATE >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
            AND  (p.CAN_CEL IS NULL OR p.CAN_CEL != 'Y')
          GROUP  BY p.SUP_CODE, s.SUP_NAME, p.INV_AMOUNT
          HAVING COUNT(*) > 1
          ORDER  BY OCCURRENCE DESC
          LIMIT  20
        `),

        // Large single payments > 3x that supplier's 6-month average
        // VOUCHERS: TRAN_TYPE='04' = Bank Payment, DATTE = date, DB_CR not needed
        safe(`
          SELECT
            'LARGE_PAYMENT'                                        AS ANOMALY_TYPE,
            v.ACC_CODE                                             AS SUP_CODE,
            a.ACC_HEAD                                             AS SUP_NAME,
            v.AMOUNT,
            avg_pay.AVG_PAYMENT,
            ROUND(v.AMOUNT / avg_pay.AVG_PAYMENT, 1)              AS TIMES_ABOVE_AVG,
            v.DATTE                                                AS LAST_DATE,
            v.VCHR_NO                                              AS INV_NOS,
            CONCAT('Payment is ',
              ROUND(v.AMOUNT / avg_pay.AVG_PAYMENT, 1),
              'x above supplier average')                          AS DESCRIPTION
          FROM   vouchers v
          JOIN   acc_mst a ON a.ACC_CODE = v.ACC_CODE
          JOIN (
            SELECT ACC_CODE, AVG(AMOUNT) AS AVG_PAYMENT
            FROM   vouchers
            WHERE  TRAN_TYPE = '04'
              AND  DATTE >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
              AND  (CAN_CEL IS NULL OR CAN_CEL != 'Y')
            GROUP  BY ACC_CODE
            HAVING COUNT(*) >= 3
          ) avg_pay ON avg_pay.ACC_CODE = v.ACC_CODE
          WHERE  v.TRAN_TYPE = '04'
            AND  v.DATTE >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            AND  (v.CAN_CEL IS NULL OR v.CAN_CEL != 'Y')
            AND  v.AMOUNT > avg_pay.AVG_PAYMENT * 3
          ORDER  BY TIMES_ABOVE_AVG DESC
          LIMIT  10
        `),

        // Round number invoices >= 5000
        safe(`
          SELECT
            'ROUND_NUMBER'                                         AS ANOMALY_TYPE,
            p.SUP_CODE,
            s.SUP_NAME,
            p.INV_AMOUNT                                           AS AMOUNT,
            1                                                      AS OCCURRENCE,
            p.INV_DATE                                             AS LAST_DATE,
            p.INV_NO                                               AS INV_NOS,
            'Round number invoice — verify authenticity'           AS DESCRIPTION
          FROM   purchase_hdr p
          JOIN   sup_mst s ON s.SUP_CODE = p.SUP_CODE
          WHERE  p.INV_DATE >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
            AND  p.INV_AMOUNT >= 5000
            AND  MOD(p.INV_AMOUNT, 1000) = 0
            AND  (p.CAN_CEL IS NULL OR p.CAN_CEL != 'Y')
          ORDER  BY p.INV_AMOUNT DESC
          LIMIT  10
        `),

        // Price spikes: item STD_COST in latest SRV > 30% above 6-month avg
        safe(`
          SELECT
            'PRICE_SPIKE'                                          AS ANOMALY_TYPE,
            r.ITEM_CODE,
            i.ITEM_NAME1                                           AS ITEM_NAME,
            NULL                                                   AS SUP_CODE,
            i.ITEM_NAME1                                           AS SUP_NAME,
            r.STD_COST                                             AS CURRENT_PRICE,
            avg6.AVG_PRICE,
            ROUND(((r.STD_COST - avg6.AVG_PRICE) / avg6.AVG_PRICE) * 100, 1) AS PCT_ABOVE_AVG,
            r.SRV_DATE                                             AS LAST_DATE,
            r.SRV_NO                                               AS INV_NOS,
            CONCAT('SRV price ',
              ROUND(((r.STD_COST - avg6.AVG_PRICE) / avg6.AVG_PRICE) * 100, 1),
              '% above 6-month average')                           AS DESCRIPTION
          FROM (
            SELECT ITEM_CODE, STD_COST, SRV_DATE, SRV_NO,
                   ROW_NUMBER() OVER (PARTITION BY ITEM_CODE ORDER BY SRV_DATE DESC) AS rn
            FROM   srv_items
            WHERE  STD_COST IS NOT NULL AND STD_COST > 0
          ) r
          JOIN (
            SELECT ITEM_CODE, AVG(STD_COST) AS AVG_PRICE
            FROM   srv_items
            WHERE  SRV_DATE >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
              AND  STD_COST IS NOT NULL AND STD_COST > 0
            GROUP  BY ITEM_CODE
            HAVING COUNT(*) >= 2
          ) avg6 ON avg6.ITEM_CODE = r.ITEM_CODE
          JOIN item_mst i ON i.ITEM_CODE = r.ITEM_CODE
          WHERE  r.rn = 1
            AND  r.STD_COST > avg6.AVG_PRICE * 1.30
          ORDER  BY PCT_ABOVE_AVG DESC
          LIMIT  20
        `),
      ]);

      const severityMap = {
        DUPLICATE_AMOUNT: 'HIGH',
        LARGE_PAYMENT:    'HIGH',
        PRICE_SPIKE:      'MEDIUM',
        ROUND_NUMBER:     'LOW',
      };

      const all = [...duplicates, ...largePayments, ...roundNumbers, ...priceSpikes]
        .map(r => ({
          anomalyType:  r.ANOMALY_TYPE,
          severity:     severityMap[r.ANOMALY_TYPE] || 'LOW',
          suppCode:     r.SUP_CODE,
          suppName:     r.SUP_NAME || r.ITEM_NAME || '-',
          amount:       Math.round(Number(r.AMOUNT || r.CURRENT_PRICE) * 100) / 100,
          occurrence:   Number(r.OCCURRENCE) || 1,
          lastDate:     r.LAST_DATE
            ? (r.LAST_DATE instanceof Date
                ? r.LAST_DATE.toISOString().slice(0, 10)
                : String(r.LAST_DATE).slice(0, 10))
            : '',
          reference:    r.INV_NOS,
          description:  r.DESCRIPTION,
          pctAboveAvg:  r.PCT_ABOVE_AVG || r.TIMES_ABOVE_AVG || null,
        }))
        .sort((a, b) =>
          ['HIGH', 'MEDIUM', 'LOW'].indexOf(a.severity) -
          ['HIGH', 'MEDIUM', 'LOW'].indexOf(b.severity)
        );

      res.json(all);
    } catch (err) {
      console.error('[analytics/anomalies]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  5. SUMMARY — KPI cards
  // ══════════════════════════════════════════════════════════════════════════
  router.get('/summary', async (req, res) => {
    try {
      const [
        jobsOverBudget, criticalStock,
        pendingPdcIn, pendingPdcOut,
        anomalyCount, openJobs,
      ] = await Promise.all([

        // Jobs where actual cost > estimated by >15%
        safe(`
          SELECT COUNT(DISTINCT j.JOB_NO) AS CNT
          FROM   job_card j
          JOIN   job_boq  b ON b.JOB_NO = j.JOB_NO
          JOIN   siv_items s ON s.JOB_NO = j.JOB_NO
          WHERE  (j.CLOSED     IS NULL OR j.CLOSED     != 'Y')
            AND  (j.CANCEL_IND IS NULL OR j.CANCEL_IND != 'Y')
          GROUP  BY j.JOB_NO
          HAVING SUM(s.QTY * AVGCOST('01', s.ITEM_CODE, s.SIV_DATE)) >
                 SUM(b.QTY * b.UNIT_COST) * 1.15
        `),

        // Items with ≤ 7 days stock remaining
        safe(`
          SELECT COUNT(*) AS CNT
          FROM (
            SELECT
              ITEM_CODE,
              SUM(CASE WHEN T='IN' THEN QTY ELSE -QTY END) AS CURR_QTY
            FROM (
              SELECT ITEM_CODE, QTY, 'IN'  AS T FROM srv_items
              UNION ALL
              SELECT ITEM_CODE, QTY, 'OUT' AS T FROM siv_items
            ) x GROUP BY ITEM_CODE
          ) stk
          JOIN (
            SELECT ITEM_CODE, SUM(QTY)/6 AS AVG_MONTHLY
            FROM   siv_items
            WHERE  SIV_DATE >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
            GROUP  BY ITEM_CODE
          ) con ON con.ITEM_CODE = stk.ITEM_CODE
          WHERE  con.AVG_MONTHLY > 0
            AND  stk.CURR_QTY / (con.AVG_MONTHLY / 30) <= 7
        `),

        // PDC incoming — unrealised cheques due within 30 days
        safe(`
          SELECT COALESCE(SUM(AMOUNT), 0) AS AMT
          FROM   pdc_rcd
          WHERE  (REALISED IS NULL OR REALISED != 'Y')
            AND  CHQ_DATE <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        `),

        // PDC outgoing — unrealised cheques due within 30 days
        safe(`
          SELECT COALESCE(SUM(AMOUNT), 0) AS AMT
          FROM   pdc_isu
          WHERE  (REALISED IS NULL OR REALISED != 'Y')
            AND  CHQ_DATE <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        `),

        // Duplicate purchase invoices in last 90 days
        safe(`
          SELECT COUNT(*) AS CNT
          FROM (
            SELECT SUP_CODE, INV_AMOUNT
            FROM   purchase_hdr
            WHERE  INV_DATE >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
              AND  (CAN_CEL IS NULL OR CAN_CEL != 'Y')
            GROUP  BY SUP_CODE, INV_AMOUNT
            HAVING COUNT(*) > 1
          ) dups
        `),

        // Active jobs
        safe(`
          SELECT COUNT(*) AS CNT FROM job_card
          WHERE (CLOSED IS NULL OR CLOSED != 'Y')
            AND (CANCEL_IND IS NULL OR CANCEL_IND != 'Y')
        `),
      ]);

      res.json({
        jobsOverBudget: jobsOverBudget.length,
        criticalStock:  Number((criticalStock[0] || {}).CNT) || 0,
        pdcIncoming:    Math.round(Number((pendingPdcIn[0]  || {}).AMT) * 100) / 100,
        pdcOutgoing:    Math.round(Number((pendingPdcOut[0] || {}).AMT) * 100) / 100,
        anomalyCount:   Number((anomalyCount[0]  || {}).CNT) || 0,
        openJobs:       Number((openJobs[0]      || {}).CNT) || 0,
      });
    } catch (err) {
      console.error('[analytics/summary]', err.message);
      res.status(500).json({ error: err.message });
    }
  });



router.get('/job-cost-detail/:jobNo', async (req, res) => {
  const { jobNo } = req.params;
  try {

    // ── 1. Job header ────────────────────────────────────────────────────────
    const [jobHdr] = await db(`
      SELECT
        j.JOB_NO,
        j.PROJ_NAME,
        j.CUST_CODE,
        c.CUST_NAME,
        j.CONTRACT_AMT,
        j.START_DATE,
        j.LPO_NO,
        j.ALLOTTED_MAT_COST,
        CASE
          WHEN j.CLOSED     = 'Y' THEN 'CLOSED'
          WHEN j.CANCEL_IND = 'Y' THEN 'CANCELLED'
          ELSE 'ACTIVE'
        END AS JOB_STATUS
      FROM   job_card j
      LEFT JOIN cus_mst c ON c.CUST_CODE = j.CUST_CODE
      WHERE  j.JOB_NO = ?
    `, [jobNo]);

    if (!jobHdr) return res.status(404).json({ error: `Job ${jobNo} not found` });

    // ── 2. BOQ estimated lines ───────────────────────────────────────────────
    const boqRows = await db(`
      SELECT
        b.PANEL_SR_NO,
        b.SEQ_NO,
        b.COST_TYPE,
        b.ITEM_CODE,
        b.DESCRIPTION,
        b.UNIT,
        b.QTY          AS EST_QTY,
        b.UNIT_COST    AS EST_UNIT_COST,
        b.TOTAL_COST   AS EST_TOTAL
      FROM   job_boq b
      WHERE  b.JOB_NO = ?
      ORDER  BY b.PANEL_SR_NO, b.SEQ_NO
    `, [jobNo]);

    // ── 3. Actual issues from siv_items per item per panel ───────────────────
    const actRows = await db(`
      SELECT
        s.PANEL_NO                                              AS PANEL_SR_NO,
        s.ITEM_CODE,
        SUM(s.QTY)                                             AS ACT_QTY,
        SUM(s.QTY * AVGCOST('01', s.ITEM_CODE, s.SIV_DATE))   AS ACT_TOTAL,
        MAX(s.SIV_DATE)                                        AS LAST_ISSUE_DATE,
        GROUP_CONCAT(DISTINCT s.SIV_NO ORDER BY s.SIV_DATE)   AS SIV_NOS
      FROM   siv_items s
      WHERE  s.JOB_NO = ?
      GROUP  BY s.PANEL_NO, s.ITEM_CODE
    `, [jobNo]);

    // ── 4. Merge BOQ with actuals ─────────────────────────────────────────────
    // Build lookup: panelNo+itemCode → actual row
    const actMap = {};
    actRows.forEach(r => {
      const key = `${r.PANEL_SR_NO}__${r.ITEM_CODE}`;
      actMap[key] = r;
    });

    // Group BOQ rows by panel
    const panelMap = {};
    boqRows.forEach(b => {
      const panel = b.PANEL_SR_NO;
      if (!panelMap[panel]) panelMap[panel] = [];

      const key = `${panel}__${b.ITEM_CODE}`;
      const act = actMap[key] || {};

      const estTotal = Number(b.EST_TOTAL)     || 0;
      const actTotal = Number(act.ACT_TOTAL)   || 0;
      const actQty   = Number(act.ACT_QTY)     || 0;
      const estQty   = Number(b.EST_QTY)       || 0;
      const variance = estTotal > 0
        ? ((actTotal - estTotal) / estTotal) * 100
        : (actTotal > 0 ? 100 : 0);

      panelMap[panel].push({
        seqNo:        b.SEQ_NO,
        costType:     b.COST_TYPE,
        itemCode:     b.ITEM_CODE,
        description:  b.DESCRIPTION,
        unit:         b.UNIT,
        estQty:       Math.round(estQty   * 1000) / 1000,
        estUnitCost:  Math.round(Number(b.EST_UNIT_COST) * 100) / 100,
        estTotal:     Math.round(estTotal * 100) / 100,
        actQty:       Math.round(actQty   * 1000) / 1000,
        actUnitCost:  actQty > 0 ? Math.round((actTotal / actQty) * 100) / 100 : 0,
        actTotal:     Math.round(actTotal * 100) / 100,
        variance:     Math.round(variance * 100) / 100,
        varianceAmt:  Math.round((actTotal - estTotal) * 100) / 100,
        sivNos:       act.SIV_NOS || '',
        lastIssue:    act.LAST_ISSUE_DATE
          ? new Date(act.LAST_ISSUE_DATE).toISOString().slice(0, 10)
          : '',
        status:       variance > 15 ? 'OVER'
                    : variance > 5  ? 'WATCH'
                    : actTotal === 0 ? 'NO ISSUES'
                    :                  'OK',
      });
    });

    // ── 5. Also capture actual issues NOT in BOQ (extra items used) ──────────
    const boqItemKeys = new Set(boqRows.map(b => `${b.PANEL_SR_NO}__${b.ITEM_CODE}`));
    actRows.forEach(r => {
      const key = `${r.PANEL_SR_NO}__${r.ITEM_CODE}`;
      if (!boqItemKeys.has(key)) {
        const panel = r.PANEL_SR_NO || 'UNASSIGNED';
        if (!panelMap[panel]) panelMap[panel] = [];
        panelMap[panel].push({
          seqNo:       999,
          costType:    'EXTRA',
          itemCode:    r.ITEM_CODE,
          description: `⚠ Not in BOQ`,
          unit:        '',
          estQty:      0,
          estUnitCost: 0,
          estTotal:    0,
          actQty:      Math.round(Number(r.ACT_QTY)    * 1000) / 1000,
          actUnitCost: 0,
          actTotal:    Math.round(Number(r.ACT_TOTAL)  * 100)  / 100,
          variance:    100,
          varianceAmt: Math.round(Number(r.ACT_TOTAL)  * 100)  / 100,
          sivNos:      r.SIV_NOS || '',
          lastIssue:   r.LAST_ISSUE_DATE
            ? new Date(r.LAST_ISSUE_DATE).toISOString().slice(0, 10)
            : '',
          status:      'EXTRA',
        });
      }
    });

    // ── 6. Build panels array with subtotals ─────────────────────────────────
    const panels = Object.entries(panelMap)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([panelNo, lines]) => {
        const estTotal  = lines.reduce((s, r) => s + r.estTotal,  0);
        const actTotal  = lines.reduce((s, r) => s + r.actTotal,  0);
        const variance  = estTotal > 0
          ? ((actTotal - estTotal) / estTotal) * 100 : 0;
        return {
          panelNo,
          lines,
          estTotal:    Math.round(estTotal  * 100) / 100,
          actTotal:    Math.round(actTotal  * 100) / 100,
          variance:    Math.round(variance  * 100) / 100,
          varianceAmt: Math.round((actTotal - estTotal) * 100) / 100,
          status:      variance > 15 ? 'OVER'
                     : variance > 5  ? 'WATCH'
                     :                 'OK',
        };
      });

    // ── 7. Grand totals ──────────────────────────────────────────────────────
    const grandEst = panels.reduce((s, p) => s + p.estTotal, 0);
    const grandAct = panels.reduce((s, p) => s + p.actTotal, 0);
    const grandVar = grandEst > 0
      ? ((grandAct - grandEst) / grandEst) * 100 : 0;

    res.json({
      job: {
        jobNo:        jobHdr.JOB_NO,
        projName:     jobHdr.PROJ_NAME,
        custCode:     jobHdr.CUST_CODE,
        custName:     jobHdr.CUST_NAME,
        contractAmt:  Number(jobHdr.CONTRACT_AMT),
        startDate:    jobHdr.START_DATE
          ? new Date(jobHdr.START_DATE).toISOString().slice(0, 10) : '',
        lpoNo:        jobHdr.LPO_NO,
        allottedCost: Number(jobHdr.ALLOTTED_MAT_COST),
        jobStatus:    jobHdr.JOB_STATUS,
      },
      panels,
      totals: {
        grandEst:    Math.round(grandEst * 100) / 100,
        grandAct:    Math.round(grandAct * 100) / 100,
        grandVar:    Math.round(grandVar * 100) / 100,
        grandVarAmt: Math.round((grandAct - grandEst) * 100) / 100,
      },
    });

  } catch (err) {
    console.error('[analytics/job-cost-detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

  return router;
};
