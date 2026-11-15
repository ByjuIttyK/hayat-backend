// routes/sivDetailRoutes.js
// SIV List (InfoGrid/SIV) — detail panel under the list.
//
//   GET /api/siv-detail/:sivNo           Header, items (stock now / after SIV), G/L (tran type 21)
//   GET /api/siv-detail/:sivNo/sources   Which receipts the issued qty came from (FIFO estimate)
//   GET /api/siv-detail/:sivNo/job       Job quick view + job items issued vs BOQ (job_boq)
//
// Register in HayatDb.js:
//   const sivDetailRoutes = require('./routes/sivDetailRoutes');
//   app.use('/api', sivDetailRoutes(connection));

const express = require('express');

const SIV_TRAN_TYPE = '21';
const STOCK_LOC = '01';
const MATERIAL_TYPE = 'M';   // siv_hdr.SIV_TYPE for Materials (panel no. expected)

// stock_trans: Doc_no, Doc_date, Loc_code, Item_code, Qty (+ in / − out), Std_cost,
// SUP_CODE, NARRATION, Stock_tran_type, Job_no, sORT_ORD
const ORDER = 'Doc_date, sORT_ORD, Doc_no';

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const n3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
const dmy = (v) => {
  const d = toDate(v);
  return d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '';
};
const pick = (row, re) => {
  if (!row) return null;
  const k = Object.keys(row).find((key) => re.test(key) && row[key] != null && String(row[key]).trim() !== '');
  return k ? row[k] : null;
};

async function names(db, table, codeCol, nameRe, codes) {
  const out = {};
  const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return out;
  try {
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE ${codeCol} IN (?)`, [list]);
    rows.forEach((r) => { out[String(r[codeCol] ?? pick(r, new RegExp(`^${codeCol}$`, 'i'))).trim()] = String(pick(r, nameRe) ?? ''); });
  } catch (e) { /* names are optional */ }
  return out;
}

module.exports = function (connection) {
  const router = express.Router();

  // ── Header, items, G/L ──────────────────────────────────────────────────
  router.get('/siv-detail/:sivNo', async (req, res) => {
    const sivNo = String(req.params.sivNo || '').trim();
    if (!sivNo) return res.status(400).json({ error: 'SIV No required' });
    const db = connection.promise();
    try {
      const [[h]] = await db.query(
        `SELECT SIV_NO, SIV_DATE, DATE_FORMAT(SIV_DATE, '%Y-%m-%d') AS YMD, JOB_NO, PANEL_NO, CUST_CODE,
                SIV_TYPE, COST_CODE, STOCK_CODE, IFNULL(TOTAL_COST, 0) AS TOTAL_COST, NARRATION
           FROM siv_hdr WHERE SIV_NO = ?`, [sivNo]);
      if (!h) return res.status(404).json({ error: 'SIV not found' });

      const [lines] = await db.query(
        `SELECT s.SR_NO, s.ITEM_CODE, COALESCE(NULLIF(s.XL_ITEM_DESC, ''), i.ITEM_NAME1) AS ITEM_NAME,
                IFNULL(s.QTY, 0) AS QTY, IFNULL(s.STD_COST, 0) AS STD_COST, s.JOB_NO, s.PANEL_NO
           FROM siv_items s LEFT JOIN item_mst i ON i.ITEM_CODE = s.ITEM_CODE
          WHERE s.SIV_NO = ?
          ORDER BY CAST(s.SR_NO AS UNSIGNED), s.SR_NO`, [sivNo]);

      const codes = [...new Set(lines.map((l) => l.ITEM_CODE).filter(Boolean))];
      const stockNow = {}, stockAfter = {};
      if (codes.length) {
        const [now] = await db.query(
          `SELECT Item_code AS C, SUM(Qty) AS Q FROM stock_trans
            WHERE Item_code IN (?) AND Loc_code = ? GROUP BY Item_code`, [codes, STOCK_LOC]);
        now.forEach((r) => { stockNow[String(r.C).trim()] = n3(r.Q); });
        const [aft] = await db.query(
          `SELECT Item_code AS C, SUM(Qty) AS Q FROM stock_trans
            WHERE Item_code IN (?) AND Loc_code = ? AND DATE(Doc_date) <= ? GROUP BY Item_code`,
          [codes, STOCK_LOC, h.YMD]);
        aft.forEach((r) => { stockAfter[String(r.C).trim()] = n3(r.Q); });
      }

      const [glRows] = await db.query(
        `SELECT t.ACC_CODE, a.AC_HEAD, t.DB_CR, IFNULL(t.AMOUNT, 0) AS AMOUNT, t.NARRATION1
           FROM tran_acc t LEFT JOIN ac_list a ON a.AC_CODE = t.ACC_CODE
          WHERE t.TRAN_TYPE = ? AND t.VCHR_NO = ?
          ORDER BY t.DB_CR DESC, t.srno_row_id`, [SIV_TRAN_TYPE, sivNo]);
      const gl = glRows.map((r) => ({
        accCode: r.ACC_CODE, accHead: r.AC_HEAD || '',
        dr: r.DB_CR === 'D' ? n2(r.AMOUNT) : 0, cr: r.DB_CR === 'C' ? n2(r.AMOUNT) : 0,
        narration: r.NARRATION1 || '',
      }));

      const items = lines.map((l) => {
        const c = String(l.ITEM_CODE || '').trim();
        return {
          srNo: l.SR_NO, itemCode: c, itemName: l.ITEM_NAME || '', qty: n3(l.QTY),
          stdCost: Number(l.STD_COST), value: n2(Number(l.QTY) * Number(l.STD_COST)),
          stockAfter: stockAfter[c] ?? 0, stockNow: stockNow[c] ?? 0,
        };
      });
      const value = n2(items.reduce((s, i) => s + i.value, 0));
      const glDr = n2(gl.reduce((s, g) => s + g.dr, 0));
      const glCr = n2(gl.reduce((s, g) => s + g.cr, 0));

      const flags = [];
      const zero = items.filter((i) => !i.stdCost);
      if (zero.length) flags.push(`${zero.length} line(s) with zero cost — job cost understated`);
      if (String(h.SIV_TYPE || '').toUpperCase() === MATERIAL_TYPE && !String(h.PANEL_NO || '').trim()) flags.push('Materials SIV without a Panel No.');
      const short = items.filter((i) => i.stockAfter < 0);
      if (short.length) flags.push(`Stock went negative on ${dmy(h.SIV_DATE)} for ${short.map((i) => i.itemCode).join(', ')}`);
      if (!gl.length) flags.push('Not posted to the G/L (no tran type 21 entries)');
      else if (Math.abs(glDr - glCr) > 0.01) flags.push(`G/L does not balance: Dr ${glDr} / Cr ${glCr}`);
      else if (Math.abs(glDr - value) > 0.01) flags.push(`G/L amount ${glDr} differs from the item value ${value}`);

      const cust = await names(db, 'cus_mst', 'CUST_CODE', /^cust?_?name$/i, [h.CUST_CODE]);
      res.json({
        sivNo, date: dmy(h.SIV_DATE), jobNo: h.JOB_NO || '', panelNo: h.PANEL_NO || '',
        custCode: h.CUST_CODE || '', custName: cust[String(h.CUST_CODE || '').trim()] || '',
        sivType: h.SIV_TYPE || '', costCode: h.COST_CODE || '', stockCode: h.STOCK_CODE || '',
        totalCost: n2(h.TOTAL_COST), value, items, gl, flags,
      });
    } catch (err) {
      console.error('siv-detail error:', err);
      res.status(500).json({ error: 'Failed to load SIV detail', detail: err.message });
    }
  });

  // ── Source receipts (FIFO estimate) ─────────────────────────────────────
  // This SIV's slice of the item's cumulative outward qty is laid over the
  // cumulative inward layers (opening, SRVs, returns …) in date order.
  router.get('/siv-detail/:sivNo/sources', async (req, res) => {
    const sivNo = String(req.params.sivNo || '').trim();
    const db = connection.promise();
    try {
      const [lines] = await db.query(
        `SELECT s.ITEM_CODE, MAX(COALESCE(NULLIF(s.XL_ITEM_DESC, ''), i.ITEM_NAME1)) AS ITEM_NAME,
                SUM(IFNULL(s.QTY, 0)) AS QTY, MAX(IFNULL(s.STD_COST, 0)) AS STD_COST, MIN(CAST(s.SR_NO AS UNSIGNED)) AS ORD
           FROM siv_items s LEFT JOIN item_mst i ON i.ITEM_CODE = s.ITEM_CODE
          WHERE s.SIV_NO = ? GROUP BY s.ITEM_CODE ORDER BY ORD`, [sivNo]);

      const result = [];
      const supCodes = [];
      for (const ln of lines) {
        const item = String(ln.ITEM_CODE || '').trim();
        const qty = Number(ln.QTY) || 0;
        const [outs] = await db.query(
          `SELECT Doc_no, Stock_tran_type AS T, -Qty AS Q FROM stock_trans
            WHERE Item_code = ? AND Loc_code = ? AND Qty < 0 ORDER BY ${ORDER}`, [item, STOCK_LOC]);
        const idx = outs.findIndex((o) => String(o.Doc_no || '').trim() === sivNo
          && String(o.T || '').trim().toUpperCase() === 'S.I.V');
        if (idx < 0) {
          result.push({ itemCode: item, itemName: ln.ITEM_NAME || '', qty, stdCost: Number(ln.STD_COST), sources: [], short: 0, note: 'Not found in stock_trans' });
          continue;
        }
        const sliceStart = outs.slice(0, idx).reduce((s, o) => s + Number(o.Q), 0);
        const sliceEnd = sliceStart + qty;

        const [ins] = await db.query(
          `SELECT Doc_no, Stock_tran_type, Doc_date, Qty AS Q, IFNULL(Std_cost, 0) AS COST, SUP_CODE
             FROM stock_trans WHERE Item_code = ? AND Loc_code = ? AND Qty > 0 ORDER BY ${ORDER}`, [item, STOCK_LOC]);
        let cum = 0;
        const sources = [];
        for (const r of ins) {
          const start = cum, end = cum + Number(r.Q);
          cum = end;
          if (start >= sliceEnd) break;
          const ov = Math.min(end, sliceEnd) - Math.max(start, sliceStart);
          if (ov > 0) {
            const sup = String(r.SUP_CODE || '').trim();
            if (sup) supCodes.push(sup);
            sources.push({
              docNo: String(r.Doc_no || '').trim(), docType: String(r.Stock_tran_type || '').trim(),
              date: dmy(r.Doc_date), qty: n3(ov), cost: Number(r.COST), supCode: sup, supName: '',
            });
          }
        }
        const short = n3(Math.max(0, sliceEnd - Math.max(cum, sliceStart)));
        const srcValue = sources.reduce((s, x) => s + x.qty * x.cost, 0);
        const srcQty = sources.reduce((s, x) => s + x.qty, 0);
        result.push({
          itemCode: item, itemName: ln.ITEM_NAME || '', qty, stdCost: Number(ln.STD_COST),
          sources, short,
          avgSourceCost: srcQty ? Math.round((srcValue / srcQty) * 1000) / 1000 : 0,
          note: '',
        });
      }
      const sup = await names(db, 'sup_mst', 'SUP_CODE', /^sup_?name$/i, supCodes);
      result.forEach((r) => r.sources.forEach((s) => { s.supName = sup[s.supCode] || ''; }));
      res.json({ sivNo, lines: result });
    } catch (err) {
      console.error('siv-detail sources error:', err);
      res.status(500).json({ error: 'Failed to work out source receipts', detail: err.message });
    }
  });

  // ── Job quick view + issued vs BOQ ──────────────────────────────────────
  router.get('/siv-detail/:sivNo/job', async (req, res) => {
    const sivNo = String(req.params.sivNo || '').trim();
    const db = connection.promise();
    try {
      const [[h]] = await db.query(`SELECT JOB_NO, PANEL_NO, CUST_CODE FROM siv_hdr WHERE SIV_NO = ?`, [sivNo]);
      const jobNo = h ? String(h.JOB_NO || '').trim() : '';
      if (!jobNo) return res.json({ found: false, jobNo: '' });
      const panelNo = String(h.PANEL_NO || '').trim();

      const VAL = 'IFNULL(SUM(i.QTY * i.STD_COST), 0)';
      const [[job]] = await db.query(
        `SELECT COUNT(DISTINCT h.SIV_NO) AS N, ${VAL} AS V, MAX(h.SIV_DATE) AS LAST
           FROM siv_hdr h JOIN siv_items i ON i.SIV_NO = h.SIV_NO WHERE h.JOB_NO = ?`, [jobNo]);
      let panel = { N: 0, V: 0 };
      if (panelNo) {
        [[panel]] = await db.query(
          `SELECT COUNT(DISTINCT h.SIV_NO) AS N, ${VAL} AS V
             FROM siv_hdr h JOIN siv_items i ON i.SIV_NO = h.SIV_NO WHERE h.JOB_NO = ? AND h.PANEL_NO = ?`, [jobNo, panelNo]);
      }
      const [recent] = await db.query(
        `SELECT h.SIV_NO, h.SIV_DATE, h.PANEL_NO, ${VAL} AS V
           FROM siv_hdr h JOIN siv_items i ON i.SIV_NO = h.SIV_NO
          WHERE h.JOB_NO = ? GROUP BY h.SIV_NO, h.SIV_DATE, h.PANEL_NO
          ORDER BY h.SIV_DATE DESC, h.SIV_NO DESC LIMIT 6`, [jobNo]);

      // Issued to the job, item by item
      const [issued] = await db.query(
        `SELECT i.ITEM_CODE, MAX(COALESCE(NULLIF(i.XL_ITEM_DESC, ''), m.ITEM_NAME1)) AS ITEM_NAME,
                SUM(IFNULL(i.QTY, 0)) AS QTY, ${VAL} AS V
           FROM siv_hdr h JOIN siv_items i ON i.SIV_NO = h.SIV_NO
           LEFT JOIN item_mst m ON m.ITEM_CODE = i.ITEM_CODE
          WHERE h.JOB_NO = ? GROUP BY i.ITEM_CODE ORDER BY V DESC`, [jobNo]);

      // BOQ (job_boq) — material estimate; may be empty until the client uses it
      const [boq] = await db.query(
        `SELECT ITEM_CODE, MAX(DESCRIPTION) AS DESCRIPTION, SUM(IFNULL(QTY, 0)) AS QTY, SUM(IFNULL(TOTAL_COST, 0)) AS COST
           FROM job_boq WHERE JOB_NO = ? GROUP BY ITEM_CODE`, [jobNo]);
      const [[boqTot]] = await db.query(
        `SELECT COUNT(*) AS N, IFNULL(SUM(TOTAL_COST), 0) AS T,
                IFNULL(SUM(CASE WHEN PANEL_SR_NO = ? THEN TOTAL_COST ELSE 0 END), 0) AS TP
           FROM job_boq WHERE JOB_NO = ?`, [panelNo, jobNo]);

      const byItem = {};
      issued.forEach((r) => {
        const c = String(r.ITEM_CODE || '').trim();
        byItem[c] = { itemCode: c, itemName: r.ITEM_NAME || '', issuedQty: n3(r.QTY), issuedValue: n2(r.V), boqQty: null, boqCost: null };
      });
      boq.forEach((b) => {
        const c = String(b.ITEM_CODE || '').trim() || `(${String(b.DESCRIPTION || '').slice(0, 30)})`;
        const row = byItem[c] || (byItem[c] = { itemCode: c, itemName: b.DESCRIPTION || '', issuedQty: 0, issuedValue: 0, boqQty: null, boqCost: null });
        row.boqQty = n3(b.QTY); row.boqCost = n2(b.COST);
      });

      const cust = await names(db, 'cus_mst', 'CUST_CODE', /^cust?_?name$/i, [h.CUST_CODE]);
      res.json({
        found: true, jobNo, panelNo,
        custCode: h.CUST_CODE || '', custName: cust[String(h.CUST_CODE || '').trim()] || '',
        sivCount: Number(job.N) || 0, issuedValue: n2(job.V), lastSiv: dmy(job.LAST),
        panelSivCount: Number(panel.N) || 0, panelIssuedValue: n2(panel.V),
        boqLines: Number(boqTot.N) || 0, boqTotal: n2(boqTot.T), boqPanelTotal: n2(boqTot.TP),
        recent: recent.map((r) => ({ sivNo: r.SIV_NO, date: dmy(r.SIV_DATE), panelNo: r.PANEL_NO || '', value: n2(r.V) })),
        items: Object.values(byItem),
      });
    } catch (err) {
      console.error('siv-detail job error:', err);
      res.status(500).json({ error: 'Failed to load job', detail: err.message });
    }
  });

  return router;
};
