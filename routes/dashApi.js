// routes/dashApi.js — Home dashboard data (components/dashboard)
// Register in HayatDb.js:
//   const dashApi = require("./routes/dashApi");
//   app.use("/api", dashApi(connection));
//
// One route per card, so a slow or failing query only affects its own card.
//   GET /api/dash/kpis          -> { tiles: [{ key, label, value, sub, tone }] }
//   GET /api/dash/pdc?days=15   -> { rows: [...], totals: { rcvAmt, rcvCnt, isuAmt, isuCnt } }
//   GET /api/dash/doc-expiry    -> { summary: [{ DOC_TYPE, DOC_NAME, expired, due30, due60, due90 }], rows: [...] }
//   GET /api/dash/workforce     -> { byStatus: [{ status, cnt }], byDept: [{ code, name, cnt }] }
//   GET /api/dash/due-sales     -> { parties: [{ code, name, total, overdue, due7, maxOver, count, docs: [...] }], totals }
//   GET /api/dash/due-purchase  -> same shape, for suppliers
//
// Due sales: v_cus_unpaid_inv (the view SP_CUS_AGEING_INV reads), balance = Dr - Cr per document;
//   due date = document date + fab_inv_hdr.CR_DAYS for the invoice, else cus_mst.CR_LIMIT_DAYS.
// Due purchases: tran_acc purchase invoices (07 PI, 27 IP) on supplier accounts less adj_dtl settlements
//   (STLD_TYPE + STLD_DOC); due date = document date + sup_mst.CR_PERIOD.
//
// PDCs come from the v_all_cheques view (pdc_rcd, pdc_isu, current_chq):
//   receipts = TRAN_TYPE 01 / 03, payments = TRAN_TYPE 02 / 04; realised cheques (REALISED = 'Y') are left out.
//   The view carries PARTY_CODE only; the name comes from cus_mst / sup_mst / acc_mst.
const express = require("express");

const RCV_TYPES = ["01", "03"];
const ISU_TYPES = ["02", "04"];

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
    );
  const fail = (res, e) => res.status(500).json({ message: e.sqlMessage || e.message });

  // ---------- due invoices (receivables / payables) ----------
  const PUR_TYPES = ["07", "27"];

  const dueSalesDocs = () => q(
    `SELECT v.Acc_code AS PARTY_CODE, MAX(c.CUST_NAME) AS PARTY_NAME,
            v.Tran_type AS TRAN_TYPE, MAX(tt.TYPE_ABBR) AS TYPE_ABBR, v.Vchr_no AS DOC_NO,
            DATE_FORMAT(v.Datte, '%Y-%m-%d') AS DOC_DATE,
            SUM(v.Dr_amt) AS DOC_AMT, SUM(v.Cr_amt) AS SETTLED,
            SUM(v.Dr_amt) - SUM(v.Cr_amt) AS BALANCE,
            COALESCE(MAX(f.CR_DAYS), MAX(c.CR_LIMIT_DAYS), 0) AS CR_DAYS
       FROM v_cus_unpaid_inv v
       JOIN cus_mst c ON c.CUST_CODE = v.Acc_code
       LEFT JOIN fab_inv_hdr f ON f.INV_NO = v.Vchr_no AND v.Tran_type = '06'
       LEFT JOIN tran_type tt ON tt.TRAN_TYPE = v.Tran_type
      WHERE v.Datte <= CURDATE()
      GROUP BY v.Acc_code, v.Tran_type, v.Vchr_no, v.Datte
     HAVING BALANCE > 0.005`
  );

  const duePurchaseDocs = () => q(
    `SELECT t.ACC_CODE AS PARTY_CODE, MAX(s.SUP_NAME) AS PARTY_NAME,
            t.TRAN_TYPE, MAX(tt.TYPE_ABBR) AS TYPE_ABBR, t.vchr_no AS DOC_NO,
            DATE_FORMAT(t.DATTE, '%Y-%m-%d') AS DOC_DATE,
            SUM(CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE -t.AMOUNT END) AS DOC_AMT,
            MAX(COALESCE(a.STLD, 0)) AS SETTLED,
            SUM(CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE -t.AMOUNT END) - MAX(COALESCE(a.STLD, 0)) AS BALANCE,
            COALESCE(MAX(s.CR_PERIOD), 0) AS CR_DAYS
       FROM tran_acc t
       JOIN sup_mst s ON s.SUP_CODE = t.ACC_CODE
       LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
       LEFT JOIN (SELECT ACC_CODE, STLD_TYPE, STLD_DOC, SUM(STLD_AMT) AS STLD
                    FROM adj_dtl
                   WHERE STLD_TYPE IN (?)
                   GROUP BY ACC_CODE, STLD_TYPE, STLD_DOC) a
              ON a.ACC_CODE = t.ACC_CODE AND a.STLD_TYPE = t.TRAN_TYPE AND a.STLD_DOC = t.vchr_no
      WHERE t.TRAN_TYPE IN (?)
        AND t.DATTE <= CURDATE()
      GROUP BY t.ACC_CODE, t.TRAN_TYPE, t.vchr_no, t.DATTE
     HAVING BALANCE > 0.005`,
    [PUR_TYPES, PUR_TYPES]
  );

  // documents -> parties (most overdue first), each with its documents (oldest due first)
  const DAY = 86400000;
  const today0 = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const dmy = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

  function buildDue(rows) {
    const t0 = today0();
    const map = new Map();
    const totals = { total: 0, overdue: 0, due7: 0, parties: 0, docs: 0 };
    for (const r of rows) {
      const [y, m, dd] = String(r.DOC_DATE).split("-").map(Number);
      const docDate = new Date(y, m - 1, dd);
      const crDays = Number(r.CR_DAYS) || 0;
      const due = new Date(docDate.getTime() + crDays * DAY);
      const daysOver = Math.round((t0 - due) / DAY);            // > 0 overdue, <= 0 not yet due
      const bal = Number(r.BALANCE) || 0;
      const doc = {
        TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR || r.TRAN_TYPE, DOC_NO: r.DOC_NO,
        DOC_DATE: dmy(docDate), DUE_DATE: dmy(due), CR_DAYS: crDays, DAYS_OVER: daysOver,
        DOC_AMT: Number(r.DOC_AMT) || 0, SETTLED: Number(r.SETTLED) || 0, BALANCE: bal,
      };
      if (!map.has(r.PARTY_CODE)) {
        map.set(r.PARTY_CODE, { code: r.PARTY_CODE, name: r.PARTY_NAME || r.PARTY_CODE, total: 0, overdue: 0, due7: 0, maxOver: -99999, count: 0, docs: [] });
      }
      const p = map.get(r.PARTY_CODE);
      p.docs.push(doc);
      p.total += bal; p.count++;
      if (daysOver > 0) p.overdue += bal;
      else if (daysOver >= -7) p.due7 += bal;
      if (daysOver > p.maxOver) p.maxOver = daysOver;
      totals.total += bal; totals.docs++;
      if (daysOver > 0) totals.overdue += bal;
      else if (daysOver >= -7) totals.due7 += bal;
    }
    const parties = [...map.values()];
    parties.forEach((p) => p.docs.sort((a, b) => b.DAYS_OVER - a.DAYS_OVER));
    parties.sort((a, b) => b.overdue - a.overdue || b.total - a.total);
    totals.parties = parties.length;
    return { parties, totals };
  }

  // the two lists are also used by the headline tiles; keep each for a minute
  const cache = {};
  const cached = async (key, fn) => {
    const c = cache[key];
    if (c && Date.now() - c.at < 60000) return c.val;
    const val = await fn();
    cache[key] = { at: Date.now(), val };
    return val;
  };
  const dueSales = () => cached("sales", async () => buildDue(await dueSalesDocs()));
  const duePurchase = () => cached("purchase", async () => buildDue(await duePurchaseDocs()));

  router.get("/dash/due-sales", async (req, res) => {
    try {
      if (req.query.fresh) delete cache.sales;
      res.json(await dueSales());
    } catch (e) { fail(res, e); }
  });
  router.get("/dash/due-purchase", async (req, res) => {
    try {
      if (req.query.fresh) delete cache.purchase;
      res.json(await duePurchase());
    } catch (e) { fail(res, e); }
  });

  // ---------- PDCs maturing in the next N days (not yet realised) ----------
  const pdcRows = (days) => q(
    `SELECT CASE WHEN c.TRAN_TYPE IN (?) THEN 'R' ELSE 'I' END AS DIR,
            c.TRAN_TYPE, c.VCHR_NO,
            DATE_FORMAT(c.CHQ_DATE, '%d/%m/%Y') AS CHQ_DATE_DMY,
            DATEDIFF(c.CHQ_DATE, CURDATE())     AS DAYS_LEFT,
            c.CHQ_NO, c.CHQ_BANK, b.ACC_HEAD     AS BANK_NAME,
            c.PARTY_CODE,
            COALESCE(cu.CUST_NAME, su.SUP_NAME, ga.ACC_HEAD, c.PARTY_CODE) AS PARTY_NAME,
            ABS(c.AMOUNT) AS AMOUNT                                -- issued cheques are stored negative
       FROM v_all_cheques c
       LEFT JOIN acc_mst b  ON b.ACC_CODE   = c.CHQ_BANK
       LEFT JOIN cus_mst cu ON cu.CUST_CODE = c.PARTY_CODE     -- party name: customer,
       LEFT JOIN sup_mst su ON su.SUP_CODE  = c.PARTY_CODE     -- supplier,
       LEFT JOIN acc_mst ga ON ga.ACC_CODE  = c.PARTY_CODE     -- or G/L account
      WHERE c.TRAN_TYPE IN (?)
        AND COALESCE(c.REALISED, 'N') <> 'Y'
        AND c.CHQ_DATE >= CURDATE()
        AND c.CHQ_DATE <  CURDATE() + INTERVAL ? DAY
      ORDER BY c.CHQ_DATE, DIR, c.AMOUNT DESC`,
    [RCV_TYPES, [...RCV_TYPES, ...ISU_TYPES], days]
  );

  router.get("/dash/pdc", async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 15, 1), 90);
    try {
      const rows = await pdcRows(days);
      const totals = { rcvAmt: 0, rcvCnt: 0, isuAmt: 0, isuCnt: 0 };
      rows.forEach((r) => {
        const a = Number(r.AMOUNT) || 0;
        if (r.DIR === "R") { totals.rcvAmt += a; totals.rcvCnt++; } else { totals.isuAmt += a; totals.isuCnt++; }
      });
      res.json({ days, rows, totals });
    } catch (e) { fail(res, e); }
  });

  // ---------- employee documents expired or due within 90 days (active / on-leave staff) ----------
  router.get("/dash/doc-expiry", async (req, res) => {
    try {
      const rows = await q(
        `SELECT d.EMP_CODE, e.EMP_NAME, e.EMP_CATG, e.DEPT_CODE, dp.DEPT_NAME,
                d.DOC_TYPE, t.DOC_NAME, t.REMIND_DAYS, d.DOC_NO,
                DATE_FORMAT(d.EXPIRY_DT, '%d/%m/%Y') AS EXPIRY_DMY,
                DATEDIFF(d.EXPIRY_DT, CURDATE())     AS DAYS_LEFT
           FROM emp_docs d
           JOIN doc_type_mst t ON t.DOC_TYPE = d.DOC_TYPE
           JOIN emp_mst e      ON e.EMP_CODE = d.EMP_CODE
           LEFT JOIN dept_mst dp ON dp.DEPT_CODE = e.DEPT_CODE
          WHERE e.EMP_STATUS IN ('A', 'L')
            AND d.EXPIRY_DT IS NOT NULL
            AND d.EXPIRY_DT <= CURDATE() + INTERVAL 90 DAY
          ORDER BY d.EXPIRY_DT, e.EMP_NAME`
      );
      // per document type: expired / within 30 / 60 / 90 days — every employee type listed, even at zero
      const types = await q(
        `SELECT DOC_TYPE, DOC_NAME FROM doc_type_mst WHERE APPLIES_TO = 'E' ORDER BY DOC_NAME`
      );
      const summary = types.map((t) => ({ ...t, expired: 0, due30: 0, due60: 0, due90: 0 }));
      rows.forEach((r) => {
        const s = summary.find((x) => x.DOC_TYPE === r.DOC_TYPE);
        if (!s) return;
        const n = Number(r.DAYS_LEFT);
        if (n < 0) s.expired++;
        else if (n <= 30) s.due30++;
        else if (n <= 60) s.due60++;
        else s.due90++;
      });
      res.json({ summary, rows });
    } catch (e) { fail(res, e); }
  });

  // ---------- workforce: by status, and active / on-leave staff by department ----------
  router.get("/dash/workforce", async (req, res) => {
    try {
      const [byStatus, byDept] = await Promise.all([
        q(`SELECT EMP_STATUS AS status, COUNT(*) AS cnt FROM emp_mst GROUP BY EMP_STATUS`),
        q(`SELECT COALESCE(e.DEPT_CODE, '') AS code, COALESCE(d.DEPT_NAME, 'No department') AS name, COUNT(*) AS cnt
             FROM emp_mst e
             LEFT JOIN dept_mst d ON d.DEPT_CODE = e.DEPT_CODE
            WHERE e.EMP_STATUS IN ('A', 'L')
            GROUP BY e.DEPT_CODE, d.DEPT_NAME
            ORDER BY cnt DESC, code`),
      ]);
      res.json({
        byStatus: byStatus.map((r) => ({ status: r.status, cnt: Number(r.cnt) })),
        byDept: byDept.map((r) => ({ code: r.code, name: r.name, cnt: Number(r.cnt) })),
      });
    } catch (e) { fail(res, e); }
  });

  // ---------- headline figures ----------
  // Each tile is worked out on its own; a tile whose query fails is left out rather than failing the strip.
  router.get("/dash/kpis", async (req, res) => {
    const tiles = [];
    const tryTile = async (fn) => { try { const t = await fn(); if (t) tiles.push(t); } catch (e) { /* skip */ } };

    await tryTile(async () => {
      const r = await pdcRows(7);
      const rc = r.filter((x) => x.DIR === "R");
      return {
        key: "pdcRcv7", label: "PDC Rcvd · 7 days", tone: "blue",
        value: rc.reduce((s, x) => s + (Number(x.AMOUNT) || 0), 0), money: true,
        sub: `${rc.length} cheque${rc.length === 1 ? "" : "s"} to deposit`,
      };
    });
    await tryTile(async () => {
      const r = await pdcRows(7);
      const is = r.filter((x) => x.DIR === "I");
      return {
        key: "pdcIsu7", label: "PDC Issued · 7 days", tone: "orange",
        value: is.reduce((s, x) => s + (Number(x.AMOUNT) || 0), 0), money: true,
        sub: `${is.length} cheque${is.length === 1 ? "" : "s"} to fund`,
      };
    });
    await tryTile(async () => {
      const [x] = await q(
        `SELECT SUM(DATEDIFF(d.EXPIRY_DT, CURDATE()) < 0) AS expired,
                SUM(DATEDIFF(d.EXPIRY_DT, CURDATE()) BETWEEN 0 AND 30) AS due30
           FROM emp_docs d JOIN emp_mst e ON e.EMP_CODE = d.EMP_CODE
          WHERE e.EMP_STATUS IN ('A', 'L') AND d.EXPIRY_DT IS NOT NULL`
      );
      const expired = Number(x?.expired || 0), due30 = Number(x?.due30 || 0);
      return {
        key: "docs", label: "Emp. Documents", tone: expired ? "red" : due30 ? "gold" : "grey",
        value: expired, sub: `expired · ${due30} due in 30d`,
      };
    });
    await tryTile(async () => {
      const [x] = await q(
        `SELECT SUM(EMP_STATUS = 'A') AS active, SUM(EMP_STATUS = 'L') AS onLeave FROM emp_mst`
      );
      return {
        key: "staff", label: "Workforce", tone: "navy",
        value: Number(x?.active || 0), sub: `active · ${Number(x?.onLeave || 0)} on leave`,
      };
    });

    await tryTile(async () => {
      const d = await dueSales();
      const n = d.parties.filter((p) => p.overdue > 0).length;
      return {
        key: "rcvOverdue", label: "Receivables Overdue", tone: "red",
        value: d.totals.overdue, money: true,
        sub: `${n} customer${n === 1 ? "" : "s"} · due ${Math.round(d.totals.total / 1000).toLocaleString("en-US")} K`,
      };
    });
    await tryTile(async () => {
      const d = await duePurchase();
      return {
        key: "payDue", label: "Payables Due · 7 days", tone: "gold",
        value: d.totals.overdue + d.totals.due7, money: true,
        sub: `incl. overdue · ${d.totals.parties} suppliers`,
      };
    });
    await tryTile(async () => {
      const [x] = await q(
        `SELECT COUNT(*) AS n FROM item_mst
          WHERE COALESCE(REORD_LVL, 0) > 0 AND COALESCE(CL_STOCK, 0) < REORD_LVL`
      );
      return {
        key: "lowStock", label: "Below Re-order", tone: Number(x?.n) ? "orange" : "grey",
        value: Number(x?.n || 0), sub: "items under re-order level",
      };
    });

    res.json({ tiles });
  });

  return router;
};
