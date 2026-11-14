// routes/salesCollectionApi.js
// Sales & Collection Analysis — opened from the Chart button of the Project Invoice List (InfoGrid/FABINV)
// Register in HayatDb.js:
//   app.use("/api", require("./routes/salesCollectionApi")(connection));
//
// GET /api/sales-collection?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Sources
//   Sales        : fab_inv_hdr (INV_CANCELLED <> 'Y'), value = NET_AMT
//   Settlements  : adj_dtl  STLD_TYPE = '06', STLD_DOC = INV_NO   (SOURCE_DATE = settlement date)
//   Cheques rcvd : v_all_cheques TRAN_TYPE = '03', PDCTYPE PDCRCD (PDC) / CURRCD (current)
//                  realised when REALISED = 'Y'
// Receivable figures (ageing, top customers, PDCs in hand) are "as on today", over ALL open invoices.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;

  // Invoice value. If NET_AMT is before VAT change to: IFNULL(h.NET_AMT,0) + IFNULL(h.VAT_AMOUNT,0)
  const INV_AMT = "IFNULL(h.NET_AMT,0)";

  // adj_dtl.SOURCE_TYPE → label (tran types). Unknown codes show as "Type xx".
  const SOURCE_LABEL = { "02": "Cash Receipt", "03": "Bank Receipt", "05": "Journal (JV)", "10": "Credit Note" };
  const CREDIT_NOTE = "10";

  const SQL_INV = `
    SELECT h.INV_NO, h.INV_DATE, h.CUST_CODE, c.CUST_NAME,
           ${INV_AMT}      AS INV_AMT,
           IFNULL(s.AMT,0) AS STLD_AMT
      FROM fab_inv_hdr h
      LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
      LEFT JOIN (SELECT STLD_DOC, SUM(IFNULL(STLD_AMT,0)) AS AMT
                   FROM adj_dtl WHERE STLD_TYPE = '06' GROUP BY STLD_DOC) s
             ON s.STLD_DOC = h.INV_NO
     WHERE IFNULL(h.INV_CANCELLED,'N') <> 'Y'
       AND h.INV_DATE <= ?`;

  const SQL_STL = `
    SELECT a.STLD_DOC, a.SOURCE_DOC, a.SOURCE_TYPE, a.SOURCE_DATE, h.INV_DATE,
           IFNULL(a.STLD_AMT,0) AS AMT
      FROM adj_dtl a
      JOIN fab_inv_hdr h ON h.INV_NO = a.STLD_DOC
     WHERE a.STLD_TYPE = '06'
       AND IFNULL(h.INV_CANCELLED,'N') <> 'Y'`;

  const SQL_CHQ = `
    SELECT v.VCHR_NO, v.VCHR_DATE, v.CHQ_NO, v.CHQ_DATE, v.CHQ_BANK, v.PARTY_CODE, c.CUST_NAME,
           IFNULL(v.AMOUNT,0) AS AMOUNT, v.REALISED, v.JV_DATE_RLZ, v.PDCTYPE
      FROM v_all_cheques v
      LEFT JOIN cus_mst c ON c.CUST_CODE = v.PARTY_CODE
     WHERE v.TRAN_TYPE = '03'
       AND v.PDCTYPE IN ('PDCRCD','CURRCD')`;

  // ---------- helpers ----------
  const num = (v) => Number(v || 0);
  const r2 = (v) => Math.round(v * 100) / 100;
  const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : 0);
  const toD = (v) => {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const ym = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "");
  const dmy = (d) => (d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "");
  const days = (a, b) => Math.round((a - b) / 86400000);
  const inRange = (d, f, t) => d && d >= f && d <= t;
  const monthsBetween = (f, t) => {
    const out = [];
    const d = new Date(f.getFullYear(), f.getMonth(), 1);
    while (d <= t && out.length < 60) { out.push(ym(d)); d.setMonth(d.getMonth() + 1); }
    return out;
  };

  router.get("/sales-collection", async (req, res) => {
    const from = toD(req.query.from), to = toD(req.query.to);
    if (!from || !to) return res.status(400).json({ error: "from and to dates are required (YYYY-MM-DD)" });
    const today = toD(new Date());

    try {
      const [[inv], [stl], [chq]] = await Promise.all([
        db.query(SQL_INV, [req.query.to]),
        db.query(SQL_STL),
        db.query(SQL_CHQ),
      ]);

      inv.forEach((i) => {
        i.D = toD(i.INV_DATE);
        i.AMT = num(i.INV_AMT);
        i.ST = num(i.STLD_AMT);
        i.BAL = r2(i.AMT - i.ST);
      });
      stl.forEach((s) => { s.D = toD(s.SOURCE_DATE); s.ID = toD(s.INV_DATE); s.AMT = num(s.AMT); });
      chq.forEach((c) => {
        c.VD = toD(c.VCHR_DATE); c.CD = toD(c.CHQ_DATE); c.AMT = num(c.AMOUNT);
        c.REAL = String(c.REALISED || "").toUpperCase() === "Y";
        c.STATUS = c.REAL ? "REALISED" : (c.CD && c.CD > today ? "NOT_DUE" : "OVERDUE");
      });

      const months = monthsBetween(from, to);
      const blankMonth = () => Object.fromEntries(months.map((m) => [m, 0]));

      // ================= 1. Sales in the period =================
      const pInv = inv.filter((i) => inRange(i.D, from, to));
      const sales = pInv.reduce((a, i) => a + i.AMT, 0);
      const pCollected = pInv.reduce((a, i) => a + Math.min(i.ST, Math.max(i.AMT, 0)), 0);
      const pOutstanding = pInv.reduce((a, i) => a + Math.max(i.BAL, 0), 0);
      const zeroValue = pInv.filter((i) => i.AMT === 0).length;

      // by invoice month: collected / outstanding (stack = sales)
      const cohort = months.map((m) => ({ MONTH: m, SALES: 0, COLLECTED: 0, OUTSTANDING: 0, INVOICES: 0 }));
      const cIdx = Object.fromEntries(cohort.map((c, k) => [c.MONTH, k]));
      pInv.forEach((i) => {
        const c = cohort[cIdx[ym(i.D)]];
        if (!c) return;
        c.INVOICES++;
        c.SALES += i.AMT;
        c.COLLECTED += Math.min(i.ST, Math.max(i.AMT, 0));
        c.OUTSTANDING += Math.max(i.BAL, 0);
      });

      // ================= 2. Billed vs received in each month =================
      const recM = blankMonth(), cnM = blankMonth(), chqM = blankMonth();
      const mix = {};
      let wDays = 0, wAmt = 0;
      stl.forEach((s) => {
        if (inRange(s.D, from, to)) {
          const k = ym(s.D);
          if (s.SOURCE_TYPE === CREDIT_NOTE) cnM[k] += s.AMT; else recM[k] += s.AMT;
          const lbl = SOURCE_LABEL[s.SOURCE_TYPE] || `Type ${s.SOURCE_TYPE || "-"}`;
          mix[lbl] = (mix[lbl] || 0) + s.AMT;
        }
        // average days to collect — settlements of the period's invoices, credit notes excluded
        if (inRange(s.ID, from, to) && s.SOURCE_TYPE !== CREDIT_NOTE && s.D && s.AMT > 0) {
          wDays += Math.max(0, days(s.D, s.ID)) * s.AMT;
          wAmt += s.AMT;
        }
      });
      chq.forEach((c) => { if (inRange(c.VD, from, to)) chqM[ym(c.VD)] += c.AMT; });
      const activity = cohort.map((c) => ({
        MONTH: c.MONTH, SALES: r2(c.SALES),
        RECEIVED: r2(recM[c.MONTH]), CREDIT_NOTES: r2(cnM[c.MONTH]), CHQ_RCVD: r2(chqM[c.MONTH]),
      }));

      // ================= 3. Receivables as on today (all open invoices) =================
      const open = inv.filter((i) => i.BAL > 0.01);
      const receivable = open.reduce((a, i) => a + i.BAL, 0);
      const BUCKETS = [
        { k: "0-30", max: 30 }, { k: "31-60", max: 60 }, { k: "61-90", max: 90 },
        { k: "91-180", max: 180 }, { k: "181-365", max: 365 }, { k: "Over 365", max: Infinity },
      ];
      const ageing = BUCKETS.map((b) => ({ BUCKET: b.k, AMOUNT: 0, INVOICES: 0 }));
      open.forEach((i) => {
        const d = i.D ? days(today, i.D) : 0;
        const k = BUCKETS.findIndex((b) => d <= b.max);
        ageing[k].AMOUNT += i.BAL; ageing[k].INVOICES++;
      });
      ageing.forEach((a) => (a.AMOUNT = r2(a.AMOUNT)));

      // PDCs in hand = PDC received, not yet realised (any date)
      const pdcInHand = chq.filter((c) => c.PDCTYPE === "PDCRCD" && !c.REAL);
      const pdcInHandAmt = pdcInHand.reduce((a, c) => a + c.AMT, 0);

      // top customers by open balance, with their PDCs in hand
      const cust = {};
      open.forEach((i) => {
        const c = (cust[i.CUST_CODE] = cust[i.CUST_CODE] || { CUST_CODE: i.CUST_CODE, CUST_NAME: i.CUST_NAME || "", OS_AMT: 0, INVOICES: 0, OLDEST: null, PDC_AMT: 0 });
        c.OS_AMT += i.BAL; c.INVOICES++;
        if (i.D && (!c.OLDEST || i.D < c.OLDEST)) c.OLDEST = i.D;
      });
      pdcInHand.forEach((p) => { if (cust[p.PARTY_CODE]) cust[p.PARTY_CODE].PDC_AMT += p.AMT; });
      const custAll = Object.values(cust).map((c) => ({
        CUST_CODE: c.CUST_CODE, CUST_NAME: c.CUST_NAME, INVOICES: c.INVOICES,
        OS_AMT: r2(c.OS_AMT), PDC_AMT: r2(c.PDC_AMT), NET_AMT: r2(c.OS_AMT - c.PDC_AMT),
        OLDEST_DAYS: c.OLDEST ? days(today, c.OLDEST) : null,
      })).sort((a, b) => b.OS_AMT - a.OS_AMT);

      // ================= 4. Cheques =================
      const chqStatus = (type) => {
        const rows = chq.filter((c) => c.PDCTYPE === type && inRange(c.VD, from, to));
        const out = { COUNT: rows.length, AMOUNT: 0, REALISED: 0, NOT_DUE: 0, OVERDUE: 0, N_REALISED: 0, N_NOT_DUE: 0, N_OVERDUE: 0 };
        rows.forEach((c) => { out.AMOUNT += c.AMT; out[c.STATUS] += c.AMT; out["N_" + c.STATUS]++; });
        ["AMOUNT", "REALISED", "NOT_DUE", "OVERDUE"].forEach((k) => (out[k] = r2(out[k])));
        return out;
      };

      // maturity of PDCs in hand: past due, next 6 months, later
      const nextMonths = [];
      for (let k = 0; k < 6; k++) nextMonths.push(ym(new Date(today.getFullYear(), today.getMonth() + k, 1)));
      const maturity = [{ MONTH: "PAST", AMOUNT: 0, COUNT: 0 }, ...nextMonths.map((m) => ({ MONTH: m, AMOUNT: 0, COUNT: 0 })), { MONTH: "LATER", AMOUNT: 0, COUNT: 0 }];
      pdcInHand.forEach((p) => {
        let slot;
        if (!p.CD || p.CD <= today) slot = maturity[0];
        else slot = maturity.find((m) => m.MONTH === ym(p.CD)) || maturity[maturity.length - 1];
        slot.AMOUNT += p.AMT; slot.COUNT++;
      });
      maturity.forEach((m) => (m.AMOUNT = r2(m.AMOUNT)));

      const overdueChq = chq.filter((c) => c.STATUS === "OVERDUE")
        .sort((a, b) => (a.CD || 0) - (b.CD || 0))
        .map((c) => ({
          TYPE: c.PDCTYPE === "PDCRCD" ? "PDC" : "Current",
          VCHR_NO: c.VCHR_NO, VCHR_DATE: dmy(c.VD), CHQ_NO: c.CHQ_NO, CHQ_DATE: dmy(c.CD),
          PARTY_CODE: c.PARTY_CODE, CUST_NAME: c.CUST_NAME || "", AMOUNT: r2(c.AMT),
          DAYS: c.CD ? days(today, c.CD) : null,
        }));

      res.json({
        period: { from: req.query.from, to: req.query.to },
        summary: {
          SALES: r2(sales), INVOICES: pInv.length, ZERO_VALUE: zeroValue,
          COLLECTED: r2(pCollected), OUTSTANDING: r2(pOutstanding), COLL_PCT: pct(pCollected, sales),
          AVG_DAYS: wAmt ? Math.round(wDays / wAmt) : null,
          RECEIVABLE: r2(receivable), OPEN_INVOICES: open.length,
          PDC_IN_HAND: r2(pdcInHandAmt), PDC_IN_HAND_N: pdcInHand.length,
          NET_RECEIVABLE: r2(receivable - pdcInHandAmt),
        },
        cohort: cohort.map((c) => ({ ...c, SALES: r2(c.SALES), COLLECTED: r2(c.COLLECTED), OUTSTANDING: r2(c.OUTSTANDING) })),
        activity,
        mix: Object.entries(mix).map(([LABEL, AMOUNT]) => ({ LABEL, AMOUNT: r2(AMOUNT) })).sort((a, b) => b.AMOUNT - a.AMOUNT),
        ageing,
        customers: custAll.slice(0, 20),
        customersTotal: {
          COUNT: custAll.length,
          OS_AMT: r2(receivable),
          PDC_AMT: r2(custAll.reduce((a, c) => a + c.PDC_AMT, 0)),
          NET_AMT: r2(custAll.reduce((a, c) => a + c.NET_AMT, 0)),
        },
        cheques: { PDC: chqStatus("PDCRCD"), CURRENT: chqStatus("CURRCD") },
        maturity,
        overdueChq,
      });
    } catch (err) {
      console.error("sales-collection:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
