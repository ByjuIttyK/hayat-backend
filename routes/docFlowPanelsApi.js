// routes/docFlowPanelsApi.js
// Panel-wise Document Flow: Quotation line → Job panel → SIVs → Sales invoices, one row per panel.
//   GET /api/doc-flow-panels?docType=QUOT|JOB|SIV|INV&docNo=...&jobNo=(optional)&threshold=0.5
// Register in HayatDb.js:
//   app.use("/api", require("./routes/docFlowPanelsApi")(connection));
const express = require("express");

const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round(num(v) * 100) / 100;
// Panel key: "001", "01", "1" all become "1"; anything else is trimmed + upper-cased
const pkey = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toUpperCase();
};
const dmy = (d) => {
  if (!d) return "";
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return String(d);
  return `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}/${x.getFullYear()}`;
};
const pick = (row, names) => {
  if (!row) return null;
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((kk) => kk.toUpperCase() === n);
    if (k && row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  return null;
};
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toUpperCase();

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;
  const q = async (sql, p = []) => (await db.query(sql, p))[0];
  const isNum = (s) => /^\d+$/.test(String(s ?? "").trim());

  async function resolveJobs(docType, docNo) {
    let rows = [];
    switch (docType) {
      case "JOB":
        return [String(docNo)];
      case "QUOT":
        rows = await q("SELECT JOB_NO FROM job_card WHERE QUOT_REF = ? ORDER BY JOB_NO", [docNo]);
        if (!rows.length && isNum(docNo))
          rows = await q(
            "SELECT JOB_NO FROM job_card WHERE QUOT_REF NOT LIKE '%/%' AND CAST(QUOT_REF AS UNSIGNED) = CAST(? AS UNSIGNED) ORDER BY JOB_NO",
            [docNo]
          );
        break;
      case "SIV":
        rows = await q("SELECT DISTINCT JOB_NO FROM siv_items WHERE SIV_NO = ? AND JOB_NO IS NOT NULL AND JOB_NO <> ''", [docNo]);
        break;
      case "INV":
        rows = await q("SELECT JOB_NO FROM fab_inv_hdr WHERE INV_NO = ? AND JOB_NO IS NOT NULL AND JOB_NO <> ''", [docNo]);
        break;
      default:
        return [];
    }
    return rows.map((r) => String(r.JOB_NO));
  }

  async function quotLines(ref) {
    if (!ref) return { quotNo: null, rows: [] };
    // Panel No of a quotation line = LPAD(SR_NO,3,'0')  (quot line 1 = job panel 001)
    const cols = "QUOT_NO, LPAD(TRIM(SR_NO),3,'0') AS PANEL_NO, ITEM_CODE, ITEM_NAME, QTY, RATE";
    const order = "ORDER BY CAST(SR_NO AS UNSIGNED), SR_NO";
    let rows = await q(`SELECT ${cols} FROM quot_item WHERE QUOT_NO = ? ${order}`, [ref]);
    if (!rows.length && isNum(ref))
      rows = await q(
        `SELECT ${cols} FROM quot_item WHERE QUOT_NO NOT LIKE '%/%' AND CAST(QUOT_NO AS UNSIGNED) = CAST(? AS UNSIGNED) ${order}`,
        [ref]
      );
    return { quotNo: rows[0]?.QUOT_NO ?? ref, rows };
  }

  router.get("/doc-flow-panels", async (req, res) => {
    try {
      const docType = String(req.query.docType || "").toUpperCase();
      const docNo = String(req.query.docNo || "").trim();
      const threshold = req.query.threshold != null ? num(req.query.threshold) : 0.5;
      if (!docNo) return res.status(400).json({ error: "docNo is required" });

      const jobs = await resolveJobs(docType, docNo);
      const notes = [];
      let jobNo = req.query.jobNo ? String(req.query.jobNo) : jobs[0];

      // Quotation with no job yet: show the quotation lines only
      if (!jobNo) {
        if (docType !== "QUOT")
          return res.json({ jobs: [], job: null, quotNo: null, rows: [], summary: null, threshold, notes: ["No job is linked to this document."] });
        const ql = await quotLines(docNo);
        const rows = ql.rows.map((l) => ({
          key: pkey(l.PANEL_NO), panelNo: String(l.PANEL_NO),
          quot: { srNo: String(l.PANEL_NO), name: l.ITEM_NAME, qty: num(l.QTY), rate: num(l.RATE), value: r2(num(l.QTY) * num(l.RATE)) },
          panel: null, sivs: [], sivValue: 0, invoices: [], invValue: 0, ratio: null, flag: "NO_JOB",
        }));
        return res.json({
          jobs: [], job: null, quotNo: ql.quotNo, rows, threshold,
          summary: { panels: rows.length, quotValue: r2(rows.reduce((a, r) => a + r.quot.value, 0)), sivValue: 0, invValue: 0, flagged: 0 },
          notes: ["This quotation has not been converted to a job yet."],
        });
      }

      // Job header
      const jc = (await q("SELECT * FROM job_card WHERE JOB_NO = ?", [jobNo]))[0] || null;
      const custCode = pick(jc, ["CUST_CODE"]);
      let custName = null;
      if (custCode) custName = (await q("SELECT cust_name FROM cus_mst WHERE cust_code = ?", [custCode]))[0]?.cust_name ?? null;
      const quotRef = pick(jc, ["QUOT_REF"]);

      const [ql, panels, sivRows, invRows] = await Promise.all([
        quotLines(quotRef),
        q("SELECT * FROM job_panels WHERE JOB_NO = ? ORDER BY CAST(SR_NO AS UNSIGNED), SR_NO", [jobNo]),
        q(
          `SELECT SIV_NO, MAX(SIV_DATE) AS SIV_DATE, PANEL_NO, COUNT(*) AS LINE_CNT,
                  SUM(COALESCE(QTY,0) * COALESCE(STD_COST,0)) AS VAL
             FROM siv_items WHERE JOB_NO = ?
            GROUP BY SIV_NO, PANEL_NO ORDER BY SIV_NO`,
          [jobNo]
        ),
        q(
          `SELECT d.INV_NO, d.INV_DATE, d.SR_NO, d.PANEL_NO, d.INV_ITEM_DESC, d.INV_QTY, d.INV_RATE, d.DIS_COUNT,
                  h.CONTRACT_AMT_PERCENT
             FROM fab_inv_dtl d JOIN fab_inv_hdr h ON h.INV_NO = d.INV_NO
            WHERE h.JOB_NO = ? ORDER BY d.INV_NO, d.SR_NO`,
          [jobNo]
        ),
      ]);
      if (!quotRef) notes.push("Job has no Quotation Ref — quotation column left blank.");

      const map = new Map();
      const row = (key, display) => {
        if (!map.has(key))
          map.set(key, { key, panelNo: display, quot: null, panel: null, sivs: [], sivValue: 0, invoices: [], invValue: 0, ratio: null, flag: "" });
        return map.get(key);
      };

      panels.forEach((p) => {
        const r = row(pkey(p.SR_NO), String(p.SR_NO));
        r.panel = { srNo: String(p.SR_NO), ref: p.PANEL_REF, qty: num(p.QTY), drawNo: p.DRAW_NO && p.DRAW_NO !== "--" ? p.DRAW_NO : "", deliveryReq: dmy(p.DELIVERY_REQ), remarks: p.REMARKS || "" };
      });
      // Quotation lines matched to job_panels.SR_NO by LPAD(quot_item.SR_NO,3,'0')
      ql.rows.forEach((l) => {
        const k = pkey(l.PANEL_NO);
        const r = row(k, map.get(k)?.panelNo ?? String(l.PANEL_NO));
        const v = num(l.QTY) * num(l.RATE);
        if (!r.quot) r.quot = { srNo: String(l.PANEL_NO), name: l.ITEM_NAME, qty: num(l.QTY), rate: num(l.RATE), value: 0 };
        r.quot.value = r2(r.quot.value + v);
      });

      const byRef = new Map(panels.map((p) => [norm(p.PANEL_REF), pkey(p.SR_NO)]));
      sivRows.forEach((s) => {
        const k = pkey(s.PANEL_NO) || "_NOPANEL";
        const r = row(k, k === "_NOPANEL" ? "—" : String(s.PANEL_NO));
        r.sivs.push({ sivNo: s.SIV_NO, date: dmy(s.SIV_DATE), lines: num(s.LINE_CNT), value: r2(s.VAL) });
        r.sivValue = r2(r.sivValue + num(s.VAL));
      });
      let unmatchedInv = 0;
      invRows.forEach((d) => {
        let k = pkey(d.PANEL_NO);
        if (!k) k = byRef.get(norm(d.INV_ITEM_DESC)) || "";      // no Panel No: try matching the description to a panel ref
        if (!k) { k = "_NOPANEL"; unmatchedInv++; }
        const r = row(k, k === "_NOPANEL" ? "—" : map.get(k)?.panelNo ?? String(d.PANEL_NO));
        const line = num(d.INV_QTY) * num(d.INV_RATE) - num(d.DIS_COUNT);
        let pct = d.CONTRACT_AMT_PERCENT == null ? 1 : num(d.CONTRACT_AMT_PERCENT);
        if (pct > 1) pct = pct / 100;                               // stored as 100 or as 1.00
        if (pct <= 0) pct = 1;
        const billed = r2(line * pct);
        r.invoices.push({ invNo: d.INV_NO, date: dmy(d.INV_DATE), srNo: String(d.SR_NO), desc: d.INV_ITEM_DESC, qty: num(d.INV_QTY), rate: num(d.INV_RATE), amount: r2(line), billed, pct: Math.round(pct * 1000) / 10 });
        r.invValue = r2(r.invValue + billed);
      });
      if (unmatchedInv) notes.push(`${unmatchedInv} invoice line(s) carry no Panel No and could not be matched to a panel.`);

      const rows = Array.from(map.values()).sort((a, b) => {
        if (a.key === "_NOPANEL") return 1;
        if (b.key === "_NOPANEL") return -1;
        const na = isNum(a.key), nb = isNum(b.key);
        if (na && nb) return Number(a.key) - Number(b.key);
        if (na !== nb) return na ? -1 : 1;
        return a.key.localeCompare(b.key);
      });
      rows.forEach((r) => {
        r.ratio = r.invValue > 0 ? Math.round((r.sivValue / r.invValue) * 1000) / 10 : null;
        if (r.key === "_NOPANEL") r.flag = "NOPANEL";
        else if (r.invValue > 0 && r.sivValue < threshold * r.invValue) r.flag = "LOW";
        else if (r.invValue > 0) r.flag = "OK";
        else if (r.sivValue > 0) r.flag = "NOT_INV";
        else r.flag = r.panel ? "IDLE" : "NO_PANEL";
      });

      res.json({
        jobs: jobs.length ? jobs : [jobNo],
        job: { jobNo, quotRef, custCode, custName, project: pick(jc, ["PROJECT_NAME", "PROJECT", "PROJ_NAME", "JOB_DESC"]) },
        quotNo: ql.quotNo,
        rows,
        threshold,
        summary: {
          panels: panels.length,
          quotValue: r2(rows.reduce((a, r) => a + (r.quot?.value || 0), 0)),
          sivValue: r2(rows.reduce((a, r) => a + r.sivValue, 0)),
          invValue: r2(rows.reduce((a, r) => a + r.invValue, 0)),
          flagged: rows.filter((r) => r.flag === "LOW").length,
        },
        notes,
      });
    } catch (err) {
      console.error("doc-flow-panels:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Line items behind one card of a panel lane (double-click on a card)
  //   GET /api/doc-flow-panels/lines?kind=QUOT|JOB|INV|SIV&jobNo=&quotNo=&panel=<lane key; "_NOPANEL" = lines without a panel no>
  router.get("/doc-flow-panels/lines", async (req, res) => {
    try {
      const kind = String(req.query.kind || "").toUpperCase();
      const jobNo = String(req.query.jobNo || "");
      const quotNo = String(req.query.quotNo || "");
      const panel = String(req.query.panel || "");
      const same = (v) => (panel === "_NOPANEL" ? pkey(v) === "" : pkey(v) === panel);
      let lines = [];

      if (kind === "QUOT") {
        const rows = await q(
          `SELECT QUOT_NO, LPAD(TRIM(SR_NO),3,'0') AS PANEL_NO, SR_NO, SUB_SR_NO, OPTION_NO, ITEM_CODE, ITEM_NAME, QTY, UNIT, RATE
             FROM quot_item WHERE QUOT_NO = ? ORDER BY CAST(SR_NO AS UNSIGNED), SR_NO, SUB_SR_NO`, [quotNo]);
        lines = rows.filter((r) => same(r.PANEL_NO)).map((r) => ({
          docNo: r.QUOT_NO, srNo: r.SUB_SR_NO ? `${r.SR_NO}.${r.SUB_SR_NO}` : String(r.SR_NO), code: r.ITEM_CODE, desc: r.ITEM_NAME,
          qty: num(r.QTY), unit: r.UNIT || "", rate: num(r.RATE), amount: r2(num(r.QTY) * num(r.RATE)), extra: r.OPTION_NO ? `Option ${r.OPTION_NO}` : "",
        }));
      } else if (kind === "JOB") {
        const rows = await q("SELECT * FROM job_panels WHERE JOB_NO = ? ORDER BY CAST(SR_NO AS UNSIGNED), SR_NO", [jobNo]);
        lines = rows.filter((r) => same(r.SR_NO)).map((r) => ({
          docNo: r.JOB_NO, srNo: String(r.SR_NO), code: r.DRAW_NO && r.DRAW_NO !== "--" ? r.DRAW_NO : "", desc: r.PANEL_REF,
          qty: num(r.QTY), unit: "", rate: num(r.UNIT_RATE), amount: r2(r.AMOUNT),
          costs: [["Material", num(r.COST_MAT)], ["Consumables", num(r.COST_CONS)], ["Labour", num(r.LABOUR_CHARGES)], ["Transport", num(r.TRANSPORT_EXP)], ["Other", num(r.OTHER_EXP)]],
          extra: [r.DELIVERY_REQ ? `Delivery ${dmy(r.DELIVERY_REQ)}` : "", r.REMARKS || ""].filter(Boolean).join(" · "),
        }));
      } else if (kind === "SIV") {
        const rows = await q(
          `SELECT SIV_NO, SIV_DATE, SR_NO, ITEM_CODE, QTY, STD_COST, PANEL_NO
             FROM siv_items WHERE JOB_NO = ? ORDER BY SIV_NO, CAST(SR_NO AS UNSIGNED)`, [jobNo]);
        const mine = rows.filter((r) => same(r.PANEL_NO));
        // item names (kept separate so an item_mst column difference can't break the lines)
        const names = new Map();
        const codes = [...new Set(mine.map((r) => r.ITEM_CODE).filter(Boolean))];
        if (codes.length) {
          try {
            (await q("SELECT * FROM item_mst WHERE ITEM_CODE IN (?)", [codes])).forEach((i) =>
              names.set(i.ITEM_CODE, pick(i, ["ITEM_NAME", "ITEM_DESC", "ITEM_DESCRIPTION", "DESCRIPTION", "ITEM_DESCR"])));
          } catch (e) { /* names stay blank */ }
        }
        lines = mine.map((r) => ({
          docNo: r.SIV_NO, date: dmy(r.SIV_DATE), srNo: String(r.SR_NO), code: r.ITEM_CODE, desc: names.get(r.ITEM_CODE) || "",
          qty: num(r.QTY), unit: "", rate: num(r.STD_COST), amount: r2(num(r.QTY) * num(r.STD_COST)), extra: "",
        }));
      } else if (kind === "INV") {
        const [rows, panels] = await Promise.all([
          q(`SELECT d.INV_NO, d.INV_DATE, d.SR_NO, d.PANEL_NO, d.INV_ITEM_DESC, d.INV_QTY, d.INV_UNIT, d.INV_RATE, d.DIS_COUNT, d.VAT_PERC, h.CONTRACT_AMT_PERCENT
               FROM fab_inv_dtl d JOIN fab_inv_hdr h ON h.INV_NO = d.INV_NO
              WHERE h.JOB_NO = ? ORDER BY d.INV_NO, d.SR_NO`, [jobNo]),
          q("SELECT SR_NO, PANEL_REF FROM job_panels WHERE JOB_NO = ?", [jobNo]),
        ]);
        const byRef = new Map(panels.map((p) => [norm(p.PANEL_REF), pkey(p.SR_NO)]));
        lines = rows
          .filter((d) => {
            const k = pkey(d.PANEL_NO) || byRef.get(norm(d.INV_ITEM_DESC)) || "";
            return panel === "_NOPANEL" ? k === "" : k === panel;
          })
          .map((d) => {
            let pct = d.CONTRACT_AMT_PERCENT == null ? 1 : num(d.CONTRACT_AMT_PERCENT);
            if (pct > 1) pct = pct / 100;
            if (pct <= 0) pct = 1;
            const line = num(d.INV_QTY) * num(d.INV_RATE) - num(d.DIS_COUNT);
            return {
              docNo: d.INV_NO, date: dmy(d.INV_DATE), srNo: String(d.SR_NO), code: d.PANEL_NO || "", desc: d.INV_ITEM_DESC,
              qty: num(d.INV_QTY), unit: d.INV_UNIT || "", rate: num(d.INV_RATE), amount: r2(line * pct),
              extra: [num(d.DIS_COUNT) ? `Disc ${r2(d.DIS_COUNT)}` : "", pct !== 1 ? `Billed ${Math.round(pct * 1000) / 10} %` : "", d.VAT_PERC != null ? `VAT ${num(d.VAT_PERC)} %` : ""].filter(Boolean).join(" · "),
            };
          });
      } else {
        return res.status(400).json({ error: "kind must be QUOT, JOB, INV or SIV" });
      }
      res.json({ kind, lines, total: r2(lines.reduce((a, l) => a + l.amount, 0)) });
    } catch (err) {
      console.error("doc-flow-panels/lines:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
