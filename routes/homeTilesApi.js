// routes/homeTilesApi.js
// Home page tiles (SAP Fiori / Oracle style home) — every tile's figures in one call.
//
//   GET /api/home-tiles            → { asOf, period:{from,to}, tiles:[...] }
//   GET /api/home-tiles?refresh=1  → same, bypassing the 5-minute cache
//
// Register in HayatDb.js:
//   app.use("/api", authMiddleware, require("./routes/homeTilesApi")(connection));
//
// How it is built
//  - TILES below is the whole list. Each tile runs on its own: if one query fails
//    (a column named differently, a view missing) that tile comes back as
//    type 'error' and the rest still show.
//  - The result is cached in memory for 5 minutes and shared by all users — the
//    home page is opened many times a day and the figures do not change by the
//    second. The Refresh button on the page passes refresh=1.
//  - Access rights are applied on the screen (usePermissions.canView on each
//    tile's `access` key), the same keys as Mainmenu.tsx.
//  - Adding a tile later = one more entry in TILES. The screen already knows how
//    to draw each `type` (number, ageing, bars, line, donut, pie, hbar).
//
// Data sources (same rules as the existing screens)
//  - Sales            : fab_inv_hdr (INV_CANCELLED <> 'Y'), value NET_AMT   (as salesCollectionApi.js)
//  - Invoice balances : NET_AMT − adj_dtl settlements, STLD_TYPE '06'       (as salesCollectionApi.js)
//  - Cheques received : v_all_cheques TRAN_TYPE '03', PDCTYPE 'PDCRCD', REALISED <> 'Y', AMOUNT <> 0
//  - Collections      : tran_acc credits to customer accounts (cus_mst) in RECEIPT_TYPES
//  - Inquiries        : sales_inquiry → quot_hdr.INQ_NO → job_card.QUOT_REF  (as inqConversionApi.js)
//  - Exceptions       : the CHECKS exported by exceptionCenterRoutes.js

const express = require("express");

let EXCEPTION_CHECKS = [];
try { EXCEPTION_CHECKS = require("./exceptionCenterRoutes").CHECKS || []; }
catch (e) { console.warn("home-tiles: exceptionCenterRoutes not found — Exception Centre tile off"); }

const CACHE_MS = 5 * 60 * 1000;
// Receipt voucher tran types: 01 = Cash Receipt, 03 = Bank Receipt (RvEntBank).
// VERIFY: salesCollectionApi.js labels '02' as Cash Receipt; the menu uses RV/01.
const RECEIPT_TYPES = ["01", "03"];
// Settlement mix pie: tran type → label (anything else is "Other")
const MIX_LABEL = { "01": "Cash", "03": "Bank / cheque", "05": "Journal", "10": "Credit note" };

// ---------- helpers ----------
const num = (v) => Number(v || 0);
const r2 = (v) => Math.round(num(v) * 100) / 100;
const toD = (v) => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const dmy = (d) => (d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "");
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) => Math.round((a - b) / 86400000);
const sum = (rows, f = "A") => rows.reduce((a, r) => a + num(r[f]), 0);
const money = (v) => r2(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** months from f to t inclusive, as [{key:'2026-01', label:'Jan'}], at most `max` (the latest ones) */
const monthList = (f, t, max = 12) => {
  const out = [];
  const d = new Date(f.getFullYear(), f.getMonth(), 1);
  while (d <= t && out.length < 60) { out.push({ key: ym(d), label: MON[d.getMonth()] }); d.setMonth(d.getMonth() + 1); }
  return out.slice(-max);
};

// ---------- the tiles ----------
// section: work | sales | purchase | analysis   span: columns out of 6
// run(db, ctx) returns the tile's data, or null to leave the tile out.
const TILES = [
  // ── My work ──────────────────────────────────────────────────────────────
  {
    key: "exceptions", section: "work", title: "Exception Centre", sub: "Need attention",
    access: "exceptCenter", href: "/ExceptionCenter",
    async run(db, ctx) {
      const ex = await ctx.exceptions();
      if (!ex) return null;
      const counts = Object.values(ex);
      const total = counts.reduce((a, n) => a + n, 0);
      const hit = counts.filter((n) => n > 0).length;
      return { type: "number", value: total, format: "count", unit: `documents · ${hit} of ${counts.length} checks`, tone: total ? "red" : "blue" };
    },
  },
  {
    key: "pdc_due", section: "work", title: "PDCs due", sub: "Received · next 7 days",
    access: "pdcr", href: "/PdcRcdRegister",
    async run(db, ctx) {
      const end = addDays(ctx.today, 7);
      const due = (await ctx.pdcInHand()).filter((c) => c.D && c.D >= ctx.today && c.D <= end);
      return { type: "number", value: due.length, format: "count", unit: `AED ${money(sum(due))}`, tone: due.length ? "orange" : "blue" };
    },
  },
  {
    key: "pdc_past_due", section: "work", title: "PDCs past due", sub: "Cheque date passed · not realised",
    access: "pdcr", href: "/PdcRcdRegister",
    async run(db, ctx) {
      const past = (await ctx.pdcInHand()).filter((c) => !c.D || c.D < ctx.today);
      return { type: "number", value: past.length, format: "count", unit: `AED ${money(sum(past))}`, tone: past.length ? "red" : "blue" };
    },
  },
  {
    key: "pdc_in_hand", section: "work", title: "PDCs in hand", sub: "Received · not yet realised",
    access: "pdcr", href: "/PdcRcdRegister",
    async run(db, ctx) {
      const all = await ctx.pdcInHand();
      return { type: "number", value: r2(sum(all)), format: "amount", unit: `AED · ${all.length} cheques`, tone: "blue" };
    },
  },
  {
    key: "bank_rv_today", section: "work", title: "Bank receipts today", sub: "",
    access: "bankrv", href: "/InfoGrid/RV/03",
    async run(db, ctx) {
      const [[r]] = await db.query(
        `SELECT COUNT(DISTINCT VCHR_NO) AS N,
                SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE 0 END) AS A
           FROM tran_acc
          WHERE TRAN_TYPE = '03' AND DATTE BETWEEN ? AND ?`,
        [ctx.todayYmd, `${ctx.todayYmd} 23:59:59`]
      );
      const n = num(r && r.N);
      return { type: "number", value: r2(r && r.A), format: "amount", unit: `AED · ${n} voucher${n === 1 ? "" : "s"}`, tone: "blue" };
    },
  },
  {
    key: "old_invoices", section: "work", title: "Invoices over 90 days", sub: "Still open",
    access: "cusageing", href: "/CusAgeingInv/01/01",
    async run(db, ctx) {
      const open = await ctx.openInvoices();
      const old = open.filter((i) => i.AGE > 90);
      const amt = old.reduce((a, i) => a + i.BAL, 0);
      return {
        type: "number", value: old.length, format: "count",
        unit: `AED ${r2(amt).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, tone: old.length ? "red" : "blue",
      };
    },
  },

  // ── Receivables and sales ────────────────────────────────────────────────
  {
    key: "sales_collection", section: "sales", span: 2, title: "Sales and collection", sub: "Manufacturing invoices · AED",
    access: "mfginv", href: "/InfoGrid/FABINV",
    async run(db, ctx) {
      const months = monthList(ctx.fromD, ctx.today < ctx.toD ? ctx.today : ctx.toD, 12);
      if (!months.length) return null;
      const f = `${months[0].key}-01`, t = `${ctx.todayYmd} 23:59:59`;
      const [[sales], coll] = await Promise.all([
        db.query(
          `SELECT DATE_FORMAT(INV_DATE, '%Y-%m') AS M, SUM(IFNULL(NET_AMT, 0)) AS A
             FROM fab_inv_hdr
            WHERE IFNULL(INV_CANCELLED, 'N') <> 'Y' AND INV_DATE BETWEEN ? AND ?
            GROUP BY M`, [f, t]),
        ctx.collectionsByMonth(f, t),
      ]);
      const s = Object.fromEntries(sales.map((x) => [x.M, num(x.A)]));
      return {
        type: "line",
        labels: months.map((m) => m.label),
        series: [
          { name: "Sales", color: "gold", values: months.map((m) => r2(s[m.key])) },
          { name: "Collection", color: "lightblue", values: months.map((m) => r2(coll[m.key])) },
        ],
      };
    },
  },
  {
    key: "receivables", section: "sales", title: "Receivables", sub: "Open invoices · ageing",
    access: "cusageing", href: "/CusAgeingSum/01/01",
    async run(db, ctx) {
      const open = await ctx.openInvoices();
      const B = [["0–30", 30], ["31–60", 60], ["61–90", 90], ["90+", Infinity]];
      const parts = B.map(([label]) => ({ label, amount: 0 }));
      open.forEach((i) => { parts[B.findIndex(([, max]) => i.AGE <= max)].amount += i.BAL; });
      parts.forEach((p) => (p.amount = r2(p.amount)));
      return { type: "ageing", total: r2(open.reduce((a, i) => a + i.BAL, 0)), parts };
    },
  },
  {
    key: "collections", section: "sales", title: "Collections", sub: "Last 6 months · AED",
    access: "bankrv", href: "/InfoGrid/RV/03",
    async run(db, ctx) {
      const months = monthList(new Date(ctx.today.getFullYear(), ctx.today.getMonth() - 5, 1), ctx.today, 6);
      const coll = await ctx.collectionsByMonth(`${months[0].key}-01`, `${ctx.todayYmd} 23:59:59`);
      const values = months.map((m) => r2(coll[m.key]));
      return { type: "bars", total: values[values.length - 1], totalLabel: "this month", labels: months.map((m) => m.label), values };
    },
  },
  {
    key: "inq_conversion", section: "sales", title: "Inquiry conversion", sub: "This period",
    access: "inqconv", href: "/InqConversion/MIS",
    async run(db, ctx) {
      const [[r]] = await db.query(
        `SELECT COUNT(*) AS N, SUM(CASE WHEN j.INQ_NO IS NOT NULL THEN 1 ELSE 0 END) AS W
           FROM sales_inquiry s
           LEFT JOIN (SELECT DISTINCT qh.INQ_NO
                        FROM job_card jc JOIN quot_hdr qh ON qh.QUOT_NO = jc.QUOT_REF) j
                  ON j.INQ_NO = s.INQ_NO
          WHERE s.INQ_DATE BETWEEN ? AND ?`,
        [ctx.from, `${ctx.to} 23:59:59`]
      );
      const n = num(r && r.N), w = num(r && r.W);
      return { type: "donut", pct: n ? Math.round((w * 1000) / n) / 10 : 0, label: `${w} of ${n} inquiries` };
    },
  },
  {
    key: "sales_period", section: "sales", title: "Sales this period", sub: "Manufacturing invoices",
    access: "mfginv", href: "/InfoGrid/FABINV",
    async run(db, ctx) {
      const [[r]] = await db.query(
        `SELECT COUNT(*) AS N, SUM(IFNULL(NET_AMT, 0)) AS A
           FROM fab_inv_hdr
          WHERE IFNULL(INV_CANCELLED, 'N') <> 'Y' AND INV_DATE BETWEEN ? AND ?`,
        [ctx.from, `${ctx.to} 23:59:59`]
      );
      const n = num(r && r.N);
      return { type: "number", value: r2(r && r.A), format: "amount", unit: `AED · ${n} invoice${n === 1 ? "" : "s"}`, tone: "gold" };
    },
  },

  // ── Purchase, stores and jobs ────────────────────────────────────────────
  {
    key: "payables", section: "purchase", title: "Payables", sub: "Supplier balances · as on today",
    access: "supbal", href: "/RepParamForm/SUPBAL",
    async run(db, ctx) {
      // Credit balance per supplier from tran_acc (DB_CR flag), suppliers in sup_mst
      const [[r]] = await db.query(
        `SELECT COUNT(*) AS N, SUM(BAL) AS A FROM (
           SELECT t.ACC_CODE, SUM(CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE -t.AMOUNT END) AS BAL
             FROM tran_acc t JOIN sup_mst s ON s.SUP_CODE = t.ACC_CODE
            WHERE t.DATTE <= ?
            GROUP BY t.ACC_CODE
         ) x WHERE BAL > 0.005`,
        [`${ctx.todayYmd} 23:59:59`]
      );
      const n = num(r && r.N);
      return { type: "number", value: r2(r && r.A), format: "amount", unit: `AED · ${n} supplier${n === 1 ? "" : "s"}`, tone: "blue" };
    },
  },
  {
    key: "open_lpos", section: "purchase", title: "Open LPOs", sub: "Items still to receive",
    access: "lpo", href: "/InfoGrid/LPO_NET",
    // An LPO is open when any line has received less than ordered (all SRVs on that line,
    // LPO no. from the SRV line, else srv_hdr.PO_NO — the Exception Centre's matching).
    // VERIFY: LPOs closed short (never to be received in full) also count until a
    // close flag exists on the LPO.
    async run(db, ctx) {
      const poOk = await ctx.hasCol("srv_hdr", "PO_NO");
      const eff = `COALESCE(NULLIF(TRIM(s.LPO_NO), ''), NULLIF(TRIM(s.PO_NO), '')${poOk ? ", NULLIF(TRIM(h.PO_NO), '')" : ""})`;
      const [[r]] = await db.query(
        `SELECT COUNT(DISTINCT l.LPO_NO) AS N
           FROM lpo_items l
           LEFT JOIN (SELECT ${eff} AS ELPO, CAST(s.SR_NO AS UNSIGNED) AS SRN, SUM(IFNULL(s.QTY, 0)) AS RQ
                        FROM srv_items s ${poOk ? "LEFT JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO" : ""}
                       GROUP BY ELPO, SRN) r
                  ON r.ELPO = TRIM(l.LPO_NO) AND r.SRN = l.SR_NO
          WHERE IFNULL(l.QTY, 0) > IFNULL(r.RQ, 0) + 0.0005`
      );
      return { type: "number", value: num(r && r.N), format: "count", unit: "LPOs", tone: "blue" };
    },
  },
  {
    key: "srv_not_invoiced", section: "purchase", title: "SRVs not invoiced", sub: "No Purchase JV yet",
    access: "exceptCenter", href: "/ExceptionCenter",
    async run(db, ctx) {
      const ex = await ctx.exceptions();
      if (!ex || ex.srv_no_pjv === undefined) return null;
      return { type: "number", value: ex.srv_no_pjv, format: "count", unit: "SRVs · this period", tone: ex.srv_no_pjv ? "orange" : "blue" };
    },
  },
  {
    key: "negative_stock", section: "purchase", title: "Negative stock", sub: "Items below zero · today",
    access: "exceptCenter", href: "/ExceptionCenter",
    async run(db, ctx) {
      const ex = await ctx.exceptions();
      if (!ex || ex.negative_stock === undefined) return null;
      return { type: "number", value: ex.negative_stock, format: "count", unit: "items", tone: ex.negative_stock ? "red" : "blue" };
    },
  },
  {
    key: "material_issued", section: "purchase", title: "Material issued", sub: "SIVs · this month",
    access: "siv", href: "/InfoGrid/SIV",
    async run(db, ctx) {
      const m0 = ymd(new Date(ctx.today.getFullYear(), ctx.today.getMonth(), 1));
      const [[r]] = await db.query(
        `SELECT COUNT(DISTINCT h.SIV_NO) AS N, SUM(IFNULL(i.QTY, 0) * IFNULL(i.STD_COST, 0)) AS A
           FROM siv_hdr h JOIN siv_items i ON i.SIV_NO = h.SIV_NO
          WHERE h.SIV_DATE BETWEEN ? AND ?`,
        [m0, `${ctx.todayYmd} 23:59:59`]
      );
      const n = num(r && r.N);
      return { type: "number", value: r2(r && r.A), format: "amount", unit: `AED · ${n} SIV${n === 1 ? "" : "s"}`, tone: "orange" };
    },
  },
  {
    key: "jobs_opened", section: "purchase", title: "Jobs opened", sub: "This period",
    access: "mfgjob", href: "/JobQueryScreen/01/01",
    async run(db, ctx) {
      // job_card.START_DATE — the job date column used by inqConversionApi.js
      const [[r]] = await db.query(
        `SELECT COUNT(*) AS N FROM job_card WHERE START_DATE BETWEEN ? AND ?`,
        [ctx.from, `${ctx.to} 23:59:59`]
      );
      return { type: "number", value: num(r && r.N), format: "count", unit: "job cards", tone: "blue" };
    },
  },

  // ── Analysis ─────────────────────────────────────────────────────────────
  {
    key: "top_customers", section: "analysis", span: 2, title: "Top 5 customers", sub: "Outstanding · AED",
    access: "cusbal", href: "/RepParamForm/CUSBAL",
    async run(db, ctx) {
      const open = await ctx.openInvoices();
      const by = {};
      open.forEach((i) => {
        const c = (by[i.CUST_CODE] = by[i.CUST_CODE] || { label: i.CUST_NAME || i.CUST_CODE, amount: 0 });
        c.amount += i.BAL;
      });
      const rows = Object.values(by).sort((a, b) => b.amount - a.amount).slice(0, 5)
        .map((c) => ({ label: c.label, amount: r2(c.amount) }));
      return { type: "hbar", rows };
    },
  },
  {
    key: "settle_mix", section: "analysis", span: 2, title: "How customers paid", sub: "Credits to customer accounts · this period",
    access: "cusbal", href: "/AcLedger/View",
    async run(db, ctx) {
      const [rows] = await db.query(
        `SELECT t.TRAN_TYPE AS T, SUM(t.AMOUNT) AS A
           FROM tran_acc t JOIN cus_mst c ON c.CUST_CODE = t.ACC_CODE
          WHERE t.DB_CR = 'C' AND t.DATTE BETWEEN ? AND ?
          GROUP BY t.TRAN_TYPE`,
        [ctx.from, `${ctx.to} 23:59:59`]
      );
      // Sales returns / other credits fold into "Other"
      const agg = {};
      rows.forEach((r) => { const k = MIX_LABEL[r.T] || "Other"; agg[k] = (agg[k] || 0) + num(r.A); });
      const parts = Object.entries(agg).map(([label, amount]) => ({ label, amount: r2(amount) }))
        .filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount);
      return { type: "pie", total: r2(parts.reduce((a, p) => a + p.amount, 0)), parts };
    },
  },
  {
    key: "pdc_maturity", section: "analysis", span: 2, title: "PDCs in hand", sub: "By cheque month · AED",
    access: "pdcr", href: "/PdcRcdRegister",
    async run(db, ctx) {
      const rows = await ctx.pdcInHand();
      const next = [];
      for (let k = 0; k < 6; k++) { const d = new Date(ctx.today.getFullYear(), ctx.today.getMonth() + k, 1); next.push({ key: ym(d), label: MON[d.getMonth()] }); }
      const slots = [{ key: "PAST", label: "Due" }, ...next, { key: "LATER", label: "Later" }].map((s) => ({ ...s, v: 0 }));
      rows.forEach((r) => {
        const d = r.D;
        let s;
        if (!d || d <= ctx.today) s = slots[0];
        else s = slots.find((x) => x.key === ym(d)) || slots[slots.length - 1];
        s.v += num(r.A);
      });
      const values = slots.map((s) => r2(s.v));
      return {
        type: "bars", total: r2(values.reduce((a, v) => a + v, 0)), totalLabel: `${rows.length} cheques`,
        labels: slots.map((s) => s.label), values, highlightFirst: true,
      };
    },
  },
];

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;
  let cache = null;               // { at, data }
  const colCache = new Map();

  async function hasCol(table, col) {
    if (!colCache.has(table)) {
      try {
        const [rows] = await db.query(`SHOW COLUMNS FROM ${table}`);
        colCache.set(table, new Set(rows.map((r) => String(r.Field).toUpperCase())));
      } catch (e) { colCache.set(table, new Set()); }
    }
    return colCache.get(table).has(col.toUpperCase());
  }

  /** Per-request context: dates plus shared lookups, each run at most once. */
  async function makeContext() {
    const today = toD(new Date());
    let fromD = null, toDt = null;
    try {
      const [[p]] = await db.query("SELECT START_DATE, END_DATE FROM ac_period LIMIT 1");
      fromD = toD(p && p.START_DATE); toDt = toD(p && p.END_DATE);
    } catch (e) { /* fall back below */ }
    fromD = fromD || new Date(today.getFullYear(), 0, 1);
    toDt = toDt || today;

    let openP = null, pdcP = null, exP = null;
    const collP = new Map();
    return {
      today, todayYmd: ymd(today), fromD, toD: toDt, from: ymd(fromD), to: ymd(toDt),
      hasCol,
      // PDCs received and not realised: [{ D: cheque date, A: amount }]
      pdcInHand() {
        if (!pdcP) pdcP = db.query(
          `SELECT CHQ_DATE AS D, IFNULL(AMOUNT, 0) AS A
             FROM v_all_cheques
            WHERE TRAN_TYPE = '03' AND PDCTYPE = 'PDCRCD'
              AND IFNULL(REALISED, 'N') <> 'Y' AND IFNULL(AMOUNT, 0) <> 0`
        ).then(([rows]) => rows.map((r) => ({ D: toD(r.D), A: num(r.A) })));
        return pdcP;
      },
      // Exception Centre checks over the period: { checkKey: row count }, or null when unavailable
      exceptions() {
        if (!exP) exP = EXCEPTION_CHECKS.length
          ? Promise.all(EXCEPTION_CHECKS.map(async (c) => {
              try { return [c.key, (await c.run(db, this.from, this.to)).length]; }
              catch (e) { return [c.key, 0]; }
            })).then((pairs) => Object.fromEntries(pairs))
          : Promise.resolve(null);
        return exP;
      },
      // Open manufacturing invoices with balance and age in days (as on today)
      openInvoices() {
        if (!openP) openP = db.query(
          `SELECT * FROM (
             SELECT h.INV_NO, h.INV_DATE, h.CUST_CODE, c.CUST_NAME,
                    IFNULL(h.NET_AMT, 0) - IFNULL(s.AMT, 0) AS BAL
               FROM fab_inv_hdr h
               LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
               LEFT JOIN (SELECT STLD_DOC, SUM(IFNULL(STLD_AMT, 0)) AS AMT
                            FROM adj_dtl WHERE STLD_TYPE = '06' GROUP BY STLD_DOC) s
                      ON s.STLD_DOC = h.INV_NO
              WHERE IFNULL(h.INV_CANCELLED, 'N') <> 'Y'
           ) x WHERE BAL > 0.01`
        ).then(([rows]) => rows.map((i) => {
          const d = toD(i.INV_DATE);
          return { ...i, BAL: r2(i.BAL), AGE: d ? daysBetween(today, d) : 0 };
        }));
        return openP;
      },
      // Receipt-voucher credits to customer accounts, by month { 'YYYY-MM': amount }
      collectionsByMonth(f, t) {
        const k = `${f}|${t}`;
        if (!collP.has(k)) collP.set(k, db.query(
          `SELECT DATE_FORMAT(t.DATTE, '%Y-%m') AS M, SUM(t.AMOUNT) AS A
             FROM tran_acc t JOIN cus_mst c ON c.CUST_CODE = t.ACC_CODE
            WHERE t.TRAN_TYPE IN (?) AND t.DB_CR = 'C' AND t.DATTE BETWEEN ? AND ?
            GROUP BY M`, [RECEIPT_TYPES, f, t]
        ).then(([rows]) => Object.fromEntries(rows.map((r) => [r.M, num(r.A)]))));
        return collP.get(k);
      },
    };
  }

  router.get("/home-tiles", async (req, res) => {
    if (cache && req.query.refresh !== "1" && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
    try {
      const ctx = await makeContext();
      const tiles = await Promise.all(TILES.map(async (t) => {
        const base = { key: t.key, section: t.section, span: t.span || 1, title: t.title, sub: t.sub || "", access: t.access, href: t.href };
        try {
          const v = await t.run(db, ctx);
          return v ? { ...base, ...v } : null;
        } catch (err) {
          console.error(`home-tiles ${t.key}:`, err.message);
          return { ...base, type: "error", error: err.message };
        }
      }));
      const data = {
        asOf: new Date().toISOString(),
        period: { from: dmy(ctx.fromD), to: dmy(ctx.toD) },
        tiles: tiles.filter(Boolean),
      };
      cache = { at: Date.now(), data };
      res.json(data);
    } catch (err) {
      console.error("home-tiles error:", err);
      res.status(500).json({ error: "Failed to load the home tiles", detail: err.message });
    }
  });

  return router;
};
