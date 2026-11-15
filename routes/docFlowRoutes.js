// routes/docFlowRoutes.js
// Document Flow (SAP-style) — the whole chain a document belongs to.
//
//   GET /api/doc-flow/:type/:no      purchase: LPO | SRV | PJV | PV (?tt=02|04)
//                                    sales:    INQ | QUOT | JOB | INV | RV (?tt=03)
//
// Purchase chain:  LPO → SRV(s) → PJV(s) → Payment(s) (PV / cheque)
//   LPO → SRV  : srv_items.LPO_NO / srv_items.PO_NO, else srv_hdr.PO_NO / LPO_NO
//   SRV → PJV  : purchase_hdr.SRV_NO (cancelled PJVs left out)
//   PJV → PV   : adj_dtl STLD_TYPE '07', STLD_DOC = PJV no → SOURCE_TYPE / SOURCE_DOC
//   PV → cheque: pdc_isu (post-dated) / current_chq (current)
// Steps not done yet come back as ghost nodes (SRV not booked, PJV not paid).
//
// Register in HayatDb.js:
//   const docFlowRoutes = require('./routes/docFlowRoutes');
//   app.use('/api', docFlowRoutes(connection));

const express = require('express');

const PUR_TT = '07';
const DEFAULT_CREDIT_DAYS = 60;
const MAX_SRVS = 60;            // an LPO with more SRVs than this is cut, with a note
const PAY_LABEL = { '02': 'Cash payment', '04': 'Cheque payment' };

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const n3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const t = (v) => String(v ?? '').trim();
const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
};
const dmy = (v) => {
  const d = toDate(v);
  return d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '';
};
const aed = (v) => `AED ${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (v) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const pick = (row, re) => {
  if (!row) return null;
  const k = Object.keys(row).find((key) => re.test(key) && row[key] != null && String(row[key]).trim() !== '');
  return k ? row[k] : null;
};
const isSupplierCode = (c) => /^.[A-Za-z][0-9]/.test(t(c));   // 2nd char alpha, 3rd numeric
const srNum = (v) => { const n = parseInt(t(v), 10); return isNaN(n) ? t(v) : n; };

const colCache = new Map();
async function cols(db, table) {
  if (!colCache.has(table)) {
    try {
      const [rows] = await db.query(`SHOW COLUMNS FROM ${table}`);
      colCache.set(table, rows.map((r) => String(r.Field)));
    } catch (e) { colCache.set(table, []); }
  }
  return colCache.get(table);
}
async function hdrLpoCols(db) {
  const c = await cols(db, 'srv_hdr');
  return [/^po_?no$/i, /^lpo_?no$/i].map((re) => c.find((k) => re.test(k))).filter(Boolean);
}

async function chequesOf(db, vchrNo) {
  const out = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const s of [
    { src: 'PDC', sql: 'SELECT * FROM pdc_isu WHERE VCHR_NO = ?' },
    { src: 'CUR', sql: "SELECT * FROM current_chq WHERE TRAN_TYPE = '04' AND VCHR_NO = ?" },
  ]) {
    try {
      const [rows] = await db.query(s.sql, [vchrNo]);
      rows.forEach((r) => {
        const d = toDate(pick(r, /^(chq|cheque)_?date$/i));
        let status;
        if (s.src === 'CUR') status = t(pick(r, /^realised$/i)).toUpperCase() === 'Y' ? 'Realised' : 'Not realised';
        else if (d && d > today) status = `PDC due ${dmy(d)}`;
        else status = pick(r, /^batch_no$/i) ? 'Realised' : 'PDC matured';
        out.push({ chqNo: t(pick(r, /^(chq|cheque)_?no$/i)), chqDate: dmy(d), bank: t(pick(r, /^(chq_bank|bank_name|bank_code|bank)$/i)), status, pdc: s.src === 'PDC' && d && d > today });
      });
    } catch (e) { /* source not available */ }
  }
  return out;
}


// ══ Sales chain ════════════════════════════════════════════════════════════
//   Inquiry (sales_inquiry) → Quotation(s) (quot_hdr.INQ_NO, revisions /01 /02)
//   → Job (job_card.QUOT_REF) → Drawings (drawing_register.JOB_NO) + SIVs (siv_hdr.JOB_NO)
//   → Invoices (fab_inv_hdr.JOB_NO) → Receipts (adj_dtl STLD_TYPE '06') → cheques (v_all_cheques '03')
const SALES_TYPES = ['INQ', 'QUOT', 'JOB', 'INV', 'RV'];
const SINV_TT = '06';
const RCPT_LABEL = { '01': 'Cash receipt', '02': 'Cash receipt', '03': 'Bank receipt' };
const isCustomerCode = (c) => /^.[A-Za-z]{2}/.test(t(c));     // alphabets in 2nd and 3rd characters

async function findCol(db, table, res) {
  const c = await cols(db, table);
  for (const re of res) { const k = c.find((x) => re.test(x)); if (k) return k; }
  return null;
}
const baseQuote = (q) => t(q).replace(/\/\d+$/, '');
const uniq = (a) => [...new Set(a.map(t).filter(Boolean))];

async function salesFlow(db, type, no, tt) {
  const notes = [];
  const inqKey = await findCol(db, 'sales_inquiry', [/^inq_?no$/i, /^enq_?no$/i, /^rfq_?no$/i]);
  const inqJob = await findCol(db, 'sales_inquiry', [/^job_?no$/i]);

  let inqNos = [], quotNos = [], jobNos = [], invNos = [];

  // ── 1. starting point ──
  if (type === 'INQ') inqNos = [no];
  if (type === 'QUOT') quotNos = [no];
  if (type === 'JOB') jobNos = [no];
  if (type === 'INV' || type === 'RV') {
    if (type === 'INV') invNos = [no];
    else {
      const [a] = await db.query(
        `SELECT DISTINCT STLD_DOC FROM adj_dtl WHERE STLD_TYPE = ? AND SOURCE_DOC = ? ${tt ? 'AND SOURCE_TYPE = ?' : ''}`,
        tt ? [SINV_TT, no, tt] : [SINV_TT, no]);
      invNos = uniq(a.map((x) => x.STLD_DOC));
      if (!invNos.length) notes.push('This receipt does not settle any sales invoice (type 06).');
    }
    if (invNos.length) {
      const [j] = await db.query('SELECT DISTINCT JOB_NO FROM fab_inv_hdr WHERE INV_NO IN (?)', [invNos]);
      jobNos = uniq(j.map((x) => x.JOB_NO));
    }
  }

  // ── 2. walk up: job → quote → inquiry ──
  if (jobNos.length) {
    const [q] = await db.query('SELECT JOB_NO, QUOT_REF FROM job_card WHERE JOB_NO IN (?)', [jobNos]);
    quotNos = uniq([...quotNos, ...q.map((x) => x.QUOT_REF)]);
    if (inqKey && inqJob) {
      const [i] = await db.query(`SELECT ${inqKey} AS K FROM sales_inquiry WHERE ${inqJob} IN (?)`, [jobNos]);
      inqNos = uniq([...inqNos, ...i.map((x) => x.K)]);
    }
  }
  if (quotNos.length) {
    const [i] = await db.query('SELECT DISTINCT INQ_NO FROM quot_hdr WHERE QUOT_NO IN (?)', [quotNos]);
    inqNos = uniq([...inqNos, ...i.map((x) => x.INQ_NO)]);
  }

  // ── 3. walk down: inquiry → all its quotes and revisions → jobs → invoices ──
  const bases = uniq(quotNos.map(baseQuote));
  const qWhere = [], qArgs = [];
  if (inqNos.length) { qWhere.push('INQ_NO IN (?)'); qArgs.push(inqNos); }
  bases.forEach((b) => { qWhere.push('(QUOT_NO = ? OR QUOT_NO LIKE ?)'); qArgs.push(b, `${b}/%`); });
  let quotes = [];
  if (qWhere.length) { [quotes] = await db.query(`SELECT * FROM quot_hdr WHERE ${qWhere.join(' OR ')} ORDER BY QUOT_NO`, qArgs); }
  quotNos = uniq([...quotNos, ...quotes.map((x) => x.QUOT_NO)]);

  if (quotNos.length) {
    const [j] = await db.query('SELECT JOB_NO FROM job_card WHERE QUOT_REF IN (?)', [quotNos]);
    jobNos = uniq([...jobNos, ...j.map((x) => x.JOB_NO)]);
  }
  if (inqNos.length && inqKey && inqJob) {
    const [j] = await db.query(`SELECT ${inqJob} AS J FROM sales_inquiry WHERE ${inqKey} IN (?)`, [inqNos]);
    jobNos = uniq([...jobNos, ...j.map((x) => x.J)]);
  }
  let jobs = [];
  if (jobNos.length) { [jobs] = await db.query('SELECT * FROM job_card WHERE JOB_NO IN (?)', [jobNos]); }
  let invs = [];
  if (jobNos.length || invNos.length) {
    const w = [], a = [];
    if (jobNos.length) { w.push('JOB_NO IN (?)'); a.push(jobNos); }
    if (invNos.length) { w.push('INV_NO IN (?)'); a.push(invNos); }
    [invs] = await db.query(`SELECT * FROM fab_inv_hdr WHERE ${w.join(' OR ')} ORDER BY INV_NO`, a);
  }
  invNos = uniq([...invNos, ...invs.map((x) => x.INV_NO)]);

  let inqs = [];
  if (inqNos.length && inqKey) { [inqs] = await db.query(`SELECT * FROM sales_inquiry WHERE ${inqKey} IN (?)`, [inqNos]); }

  // customer
  let custCode = t(pick(jobs[0], /^cust_?code$/i)) || t(pick(quotes[0], /^cust_?code$/i)) || t(pick(inqs[0], /^cust_?code$/i)) || t(pick(invs[0], /^cust_?code$/i));
  let custName = '', creditDays = DEFAULT_CREDIT_DAYS;
  if (custCode) {
    try {
      const [[c]] = await db.query('SELECT * FROM cus_mst WHERE CUST_CODE = ? LIMIT 1', [custCode]);
      custName = t(pick(c, /^cust?_?name$/i));
      const cd = Number(pick(c, /^(cr|credit)_?(days|period)$|^pay_?days$/i));
      if (cd > 0) creditDays = cd;
    } catch (e) { /* optional */ }
  }

  // ── 4. money: invoices in the G/L, settlements, job material ──
  const invTotal = {}, posted = new Set(), settled = {};
  let rcpRows = [];
  if (invNos.length) {
    const [gl] = await db.query(
      `SELECT VCHR_NO, ACC_CODE, SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END) AS DR
         FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO IN (?) GROUP BY VCHR_NO, ACC_CODE`, [SINV_TT, invNos]);
    gl.forEach((g) => {
      posted.add(t(g.VCHR_NO));
      if (isCustomerCode(g.ACC_CODE)) invTotal[t(g.VCHR_NO)] = (invTotal[t(g.VCHR_NO)] || 0) + Number(g.DR);
    });
    [rcpRows] = await db.query(
      `SELECT a.STLD_DOC, a.SOURCE_TYPE, a.SOURCE_DOC, a.SOURCE_DATE, IFNULL(a.STLD_AMT, 0) AS AMT,
              v.DATTE, v.CHEQUE_NO, v.BANK_NAME, IFNULL(v.CAN_CEL, 'N') AS CXL
         FROM adj_dtl a LEFT JOIN vouchers v ON v.TRAN_TYPE = a.SOURCE_TYPE AND v.VCHR_NO = a.SOURCE_DOC
        WHERE a.STLD_TYPE = ? AND a.STLD_DOC IN (?) ORDER BY a.SOURCE_DATE, a.SOURCE_DOC`, [SINV_TT, invNos]);
    rcpRows.forEach((r) => { if (t(r.CXL).toUpperCase() !== 'Y') settled[t(r.STLD_DOC)] = (settled[t(r.STLD_DOC)] || 0) + Number(r.AMT); });
  }
  const variations = {}, sivAgg = {}, draws = {};
  if (jobNos.length) {
    try {
      const [v] = await db.query('SELECT JOB_NO, SUM(IFNULL(AMOUNT, 0)) AS A FROM job_variations WHERE JOB_NO IN (?) GROUP BY JOB_NO', [jobNos]);
      v.forEach((x) => { variations[t(x.JOB_NO)] = Number(x.A) || 0; });
    } catch (e) { /* no variations table */ }
    const [sv] = await db.query(
      `SELECT h.JOB_NO, COUNT(DISTINCT h.SIV_NO) AS N, SUM(IFNULL(i.QTY, 0) * IFNULL(i.STD_COST, 0)) AS V,
              SUM(CASE WHEN IFNULL(i.STD_COST, 0) = 0 AND IFNULL(i.QTY, 0) <> 0 THEN 1 ELSE 0 END) AS Z,
              MIN(h.SIV_DATE) AS F, MAX(h.SIV_DATE) AS L, MAX(h.SIV_NO) AS LAST
         FROM siv_hdr h JOIN siv_items i ON i.SIV_NO = h.SIV_NO
        WHERE h.JOB_NO IN (?) GROUP BY h.JOB_NO`, [jobNos]);
    sv.forEach((x) => { sivAgg[t(x.JOB_NO)] = x; });
    try {
      const [d] = await db.query('SELECT * FROM drawing_register WHERE JOB_NO IN (?)', [jobNos]);
      d.forEach((x) => { (draws[t(x.JOB_NO)] = draws[t(x.JOB_NO)] || []).push(x); });
    } catch (e) { /* optional */ }
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const wonQuotes = new Set(jobs.map((j) => t(j.QUOT_REF)));
  const curId = (k) => {
    if (type === 'RV') return null;
    return `${type}:${no}`;
  };

  // ── 5. nodes ──
  const inqNodes = inqs.map((r) => {
    const k = t(r[inqKey]);
    const hasQ = quotes.some((q) => t(q.INQ_NO) === k);
    const hasJ = jobs.length > 0 && (hasQ ? quotes.some((q) => t(q.INQ_NO) === k && wonQuotes.has(t(q.QUOT_NO))) : !!t(pick(r, /^job_?no$/i)));
    const st = hasJ ? 'Converted' : hasQ ? 'Quoted' : 'Open';
    return {
      id: `INQ:${k}`, stage: 'INQ', type: 'INQ', no: k, date: dmy(pick(r, /^(inq|enq|rfq)_?date$|^date$/i)),
      sub: t(pick(r, /project|subject|^remarks?$/i)) || custName, amount: '', status: st,
      tone: st === 'Converted' ? 'done' : st === 'Quoted' ? 'info' : 'open', view: { type: 'INQ', no: k },
      facts: [['Inquiry Date', dmy(pick(r, /^(inq|enq|rfq)_?date$|^date$/i))], ['Customer', custName || custCode || '—'],
        ['Project', t(pick(r, /project|subject/i)) || '—'], ['Salesman', t(pick(r, /^sman_?(code|cd)$/i)) || '—'],
        ['Quotations', String(quotes.filter((q) => t(q.INQ_NO) === k).length)], ['Status', st]],
    };
  });
  const quoteNodes = quotes.map((q) => {
    const qn = t(q.QUOT_NO);
    const later = quotes.some((x) => baseQuote(x.QUOT_NO) === baseQuote(qn) && t(x.QUOT_NO) > qn);
    const st = wonQuotes.has(qn) ? 'Won' : later ? 'Revised' : jobs.length ? 'Not used' : 'Open';
    const amt = Number(pick(q, /^(net_?)?amount$|^net_?amt$|^quot_?amt$|^tot_?amt$|^total(_amt)?$/i)) || 0;
    const rev = (qn.match(/\/(\d+)$/) || [])[1];
    return {
      id: `QUOT:${qn}`, stage: 'QUOT', type: 'QUOT', no: qn, date: dmy(pick(q, /^quot_?date$|^date$/i)),
      sub: rev ? `Revision ${rev}` : 'Original', amount: amt ? aed(amt) : '', status: st,
      tone: st === 'Won' ? 'done' : st === 'Open' ? 'info' : 'open', view: { type: 'QUOT', no: qn },
      facts: [['Quote Date', dmy(pick(q, /^quot_?date$|^date$/i))], ['Revision', rev || '00'], ['Value', amt ? aed(amt) : '—'],
        ['Inquiry', t(q.INQ_NO) || '—'], ['Project', t(pick(q, /project|subject/i)) || '—'], ['Status', st]],
    };
  });
  const invByJob = {};
  invs.forEach((iv) => { (invByJob[t(iv.JOB_NO)] = invByJob[t(iv.JOB_NO)] || []).push(iv); });

  const jobNodes = jobs.map((j) => {
    const jn = t(j.JOB_NO);
    const base = Number(pick(j, /^contract_?amt$/i)) || 0;
    const vat = Number(pick(j, /^vat_?perc$/i)) || 0;
    const contract = base + base * vat / 100 + (variations[jn] || 0);
    const invoiced = (invByJob[jn] || []).reduce((s, iv) => s + (invTotal[t(iv.INV_NO)] ?? (Number(pick(iv, /^(net_?)?amount$|^inv_?amt$|^net_?amt$|^total$/i)) || 0)), 0);
    const pct = contract ? Math.round((invoiced / contract) * 100) : 0;
    const st = !invoiced ? 'Not invoiced' : pct >= 99.5 ? 'Fully invoiced' : `${pct}% invoiced`;
    const sv = sivAgg[jn];
    return {
      id: `JOB:${jn}`, stage: 'JOB', type: 'JOB', no: jn, date: dmy(pick(j, /^job_?date$|^date$/i)),
      sub: t(pick(j, /^project(_name)?$|^job_?desc|^description$/i)) || custName, amount: aed(contract), status: st,
      tone: st === 'Fully invoiced' ? 'done' : st === 'Not invoiced' ? 'open' : 'part', view: { type: 'JOB', no: jn },
      facts: [['Job Date', dmy(pick(j, /^job_?date$|^date$/i))], ['Quote Ref', t(j.QUOT_REF) || '—'], ['Contract (incl VAT + var.)', aed(contract)],
        ['Invoiced', aed(invoiced)], ['Material issued', sv ? aed(sv.V) : 'AED 0.00'], ['Customer', custName || custCode || '—']],
      _contract: contract, _invoiced: invoiced, _mat: sv ? Number(sv.V) || 0 : 0,
    };
  });
  const ghostInv = jobNodes.filter((j) => !(invByJob[j.no] || []).length).map((j) => ({
    id: `NOINV:${j.no}`, stage: 'INV', type: 'INV', no: 'Not invoiced yet', ghost: true, sub: `Job ${j.no}`,
    amount: j.amount, status: 'Pending', tone: 'ghost', facts: [['Job', j.no], ['Contract', j.amount], ['Invoiced', 'AED 0.00']],
  }));

  const invNodes = [], ghostRcp = [];
  invs.forEach((iv) => {
    const n = t(iv.INV_NO);
    const total = n2(invTotal[n] ?? (Number(pick(iv, /^(net_?)?amount$|^inv_?amt$|^net_?amt$|^total$/i)) || 0));
    const set = n2(settled[n] || 0), bal = n2(total - set);
    const d = toDate(pick(iv, /^inv_?date$|^date$/i));
    const due = d ? new Date(d.getTime() + creditDays * 86400000) : null;
    const st = !posted.has(n) ? 'Not in G/L' : bal <= 0.004 ? 'Paid' : set > 0 ? 'Part paid' : 'Unpaid';
    invNodes.push({
      id: `INV:${n}`, stage: 'INV', type: 'INV', no: n, date: dmy(d),
      sub: `Job ${t(iv.JOB_NO) || '—'}`, amount: aed(total), status: st,
      tone: st === 'Paid' ? 'done' : st === 'Not in G/L' ? 'bad' : st === 'Part paid' ? 'part' : 'open', view: { type: 'INV', no: n },
      facts: [['Invoice Date', dmy(d)], ['Job', t(iv.JOB_NO) || '—'], ['Total (incl VAT)', aed(total)], ['Received', aed(set)], ['Balance', aed(bal)], ['Due', dmy(due) || '—']],
      _total: total, _set: set,
    });
    if (bal > 0.004 && posted.has(n)) {
      const days = due ? Math.round((due - today) / 86400000) : null;
      ghostRcp.push({
        id: `DUE:${n}`, stage: 'RCP', type: 'RV', no: 'Not received yet', ghost: true, sub: `${n} balance`, amount: aed(bal),
        status: due ? (days < 0 ? `${-days} days overdue` : `Due ${dmy(due)}`) : 'Open', tone: days != null && days < 0 ? 'bad' : 'ghost',
        facts: [['Invoice', n], ['Total', aed(total)], ['Received', aed(set)], ['Balance', aed(bal)], [`Due (${creditDays} days)`, dmy(due) || '—'], ['Days to due', days == null ? '—' : String(days)]],
      });
    }
  });

  // receipts, one node per voucher; cheque detail from v_all_cheques
  const byV = new Map();
  rcpRows.forEach((r) => {
    const k = `${t(r.SOURCE_TYPE)}|${t(r.SOURCE_DOC)}`;
    if (!byV.has(k)) byV.set(k, { tt: t(r.SOURCE_TYPE), no: t(r.SOURCE_DOC), d: r.SOURCE_DATE || r.DATTE, amt: 0, invs: [], chq: t(r.CHEQUE_NO), bank: t(r.BANK_NAME), cxl: t(r.CXL).toUpperCase() === 'Y' });
    const v = byV.get(k); v.amt += Number(r.AMT); if (!v.invs.includes(t(r.STLD_DOC))) v.invs.push(t(r.STLD_DOC));
  });
  const rcpNodes = [];
  for (const v of byV.values()) {
    let status = v.cxl ? 'Cancelled' : v.tt === '03' ? 'Received' : 'Settled';
    let tone = v.cxl ? 'bad' : 'done';
    let chqTxt = v.chq, chqDate = '';
    if (!v.cxl && v.tt === '03') {
      try {
        const [ch] = await db.query("SELECT * FROM v_all_cheques WHERE TRAN_TYPE = '03' AND VCHR_NO = ?", [v.no]);
        if (ch.length) {
          const parts = ch.map((c) => {
            const d = toDate(pick(c, /^(chq|cheque)_?date$/i));
            const real = t(pick(c, /^realised$/i)).toUpperCase() === 'Y';
            const pdc = t(pick(c, /^pdc_?type$/i)).toUpperCase() === 'PDCRCD';
            return real ? 'Realised' : pdc && d && d > today ? `PDC due ${dmy(d)}` : 'Not realised';
          });
          status = [...new Set(parts)].join(', ');
          tone = parts.every((p) => p === 'Realised') ? 'done' : 'part';
          chqTxt = ch.map((c) => t(pick(c, /^(chq|cheque)_?no$/i))).filter(Boolean).join(', ') || v.chq;
          chqDate = ch.map((c) => dmy(pick(c, /^(chq|cheque)_?date$/i))).filter(Boolean).join(', ');
          if (!v.bank) v.bank = ch.map((c) => t(pick(c, /bank/i))).filter(Boolean)[0] || '';
        }
      } catch (e) { /* view not available */ }
    }
    rcpNodes.push({
      id: `RV:${v.tt}:${v.no}`, stage: 'RCP', type: 'RV', no: v.no, date: dmy(v.d),
      sub: chqTxt ? `Cheque ${chqTxt}${v.bank ? ' · ' + v.bank : ''}` : (RCPT_LABEL[v.tt] || `Type ${v.tt}`),
      amount: aed(v.amt), status, tone, view: { type: 'RV', no: v.no, tranType: v.tt },
      facts: [['Date', dmy(v.d)], ['Type', `${RCPT_LABEL[v.tt] || 'Type'} (${v.tt})`], ['Cheque', chqTxt || '—'],
        ['Cheque Date', chqDate || '—'], ['Settles', v.invs.join(', ')], ['Amount', aed(v.amt)]],
    });
  }

  // lane under the job: drawings + material
  const lane = [];
  jobNodes.forEach((j) => {
    const ds = draws[j.no] || [];
    if (ds.length) {
      const nos = ds.map((d) => t(pick(d, /^drawing_?no$/i))).filter(Boolean);
      lane.push({
        id: `DRAW:${j.no}`, stage: 'LANE', type: 'DRAW', no: ds.length === 1 ? nos[0] : `${ds.length} drawings`,
        date: dmy(pick(ds[0], /^draw(ing)?_?date$|^date$/i)), sub: `Job ${j.no}${ds.length > 1 ? ' · ' + nos.slice(0, 2).join(', ') : ''}`,
        amount: '', status: 'Drawing register', tone: 'info',
        facts: [['Job', j.no], ['Drawings', String(ds.length)], ['Numbers', nos.slice(0, 6).join(', ') || '—']],
      });
    }
    const sv = sivAgg[j.no];
    lane.push(sv ? {
      id: `SIVS:${j.no}`, stage: 'LANE', type: 'SIV', no: `${sv.N} SIV(s)`, date: `${dmy(sv.F)} – ${dmy(sv.L)}`,
      sub: `Job ${j.no} · last ${t(sv.LAST)}`, amount: aed(sv.V),
      status: Number(sv.Z) ? `${sv.Z} at zero cost` : 'Issued', tone: Number(sv.Z) ? 'bad' : 'info',
      view: { type: 'SIV', no: t(sv.LAST) },
      facts: [['Job', j.no], ['SIVs', String(sv.N)], ['Material value', aed(sv.V)], ['Zero-cost lines', String(sv.Z)], ['First', dmy(sv.F)], ['Last', dmy(sv.L)]],
    } : {
      id: `SIVS:${j.no}`, stage: 'LANE', type: 'SIV', no: 'No issues yet', ghost: true, sub: `Job ${j.no}`, amount: '', status: 'Pending', tone: 'ghost',
      facts: [['Job', j.no], ['SIVs', '0']],
    });
  });

  // mark the opened document
  const all = [...inqNodes, ...quoteNodes, ...jobNodes, ...invNodes, ...rcpNodes, ...lane];
  const cur = type === 'RV' ? rcpNodes.find((r) => r.no === no) : all.find((n) => n.id === curId());
  if (cur) cur.current = true;

  const contract = jobNodes.reduce((s, j) => s + j._contract, 0);
  const invoiced = invNodes.reduce((s, i) => s + i._total, 0);
  const received = invNodes.reduce((s, i) => s + i._set, 0);
  const material = jobNodes.reduce((s, j) => s + j._mat, 0);
  const clean = (n) => { const o = { ...n }; Object.keys(o).forEach((k) => { if (k.startsWith('_')) delete o[k]; }); return o; };
  if (!inqNodes.length && quoteNodes.length) notes.push('No sales inquiry is linked to these quotations (quot_hdr.INQ_NO blank).');

  return {
    chain: 'sales', opened: { type, no }, title: `${type} ${no}`, party: custName || custCode,
    summary: [
      { label: 'Contract', value: aed(contract) },
      { label: 'Material issued', value: aed(material) },
      { label: 'Invoiced', value: aed(invoiced) },
      { label: 'Received', value: aed(received), tone: 'blue' },
      { label: 'Outstanding', value: aed(invoiced - received), tone: invoiced - received > 0.004 ? 'orange' : '' },
    ],
    stages: [
      { key: 'INQ', label: 'Inquiry', nodes: inqNodes.length ? inqNodes.map(clean) : [{ id: 'NOINQ', stage: 'INQ', type: 'INQ', no: 'No inquiry', ghost: true, sub: 'quoted directly', status: '—', tone: 'ghost', facts: [['Note', 'No sales inquiry linked']] }] },
      { key: 'QUOT', label: 'Quotation', nodes: quoteNodes.length ? quoteNodes.map(clean) : [{ id: 'NOQ', stage: 'QUOT', type: 'QUOT', no: 'Not quoted yet', ghost: true, sub: '', status: 'Pending', tone: 'ghost', facts: [['Note', 'No quotation for this inquiry']] }] },
      { key: 'JOB', label: 'Manufacturing Job', nodes: jobNodes.length ? jobNodes.map(clean) : [{ id: 'NOJOB', stage: 'JOB', type: 'JOB', no: 'No job yet', ghost: true, sub: '', status: 'Pending', tone: 'ghost', facts: [['Note', 'No job_card with this quotation as QUOT_REF']] }] },
      { key: 'INV', label: 'Sales Invoice', nodes: [...invNodes, ...ghostInv].map(clean) },
      { key: 'RCP', label: 'Receipt', nodes: [...rcpNodes, ...ghostRcp].map(clean) },
    ],
    lane: lane.length ? { afterStage: 'JOB', label: 'DRAWINGS & MATERIAL FOR THE JOB', dashed: false, nodes: lane.map(clean) } : null,
    links: [],
    notes,
  };
}

module.exports = function (connection) {
  const router = express.Router();

  router.get('/doc-flow/:type/:no', async (req, res) => {
    const type = t(req.params.type).toUpperCase();
    const no = t(req.params.no);
    if (!no || ![...['LPO', 'SRV', 'PJV', 'PV'], ...SALES_TYPES].includes(type)) {
      return res.status(400).json({ error: 'Use /api/doc-flow/<LPO|SRV|PJV|PV|INQ|QUOT|JOB|INV|RV>/<no>' });
    }
    const db = connection.promise();
    if (SALES_TYPES.includes(type)) {
      try {
        return res.json(await salesFlow(db, type, no, t(req.query.tt)));
      } catch (err) {
        console.error('doc-flow sales error:', err);
        return res.status(500).json({ error: 'Failed to build the document flow', detail: err.message });
      }
    }
    const notes = [];
    try {
      const hCols = await hdrLpoCols(db);
      const hdrExpr = hCols.map((c) => `NULLIF(TRIM(h.${c}), '')`).join(', ');
      const effLpo = `COALESCE(NULLIF(TRIM(s.LPO_NO), ''), NULLIF(TRIM(s.PO_NO), '')${hdrExpr ? ', ' + hdrExpr : ''})`;
      const hdrJoin = hCols.length ? 'LEFT JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO' : '';

      // ── 1. find the starting set ──────────────────────────────────────────
      let lpoNo = '';
      let srvNos = [];
      let extraPjvs = [];          // PJVs reached from a PV that have no SRV (non-stock / non-goods)

      const lpoOfSrvs = async (srvs) => {
        if (!srvs.length) return '';
        const [r] = await db.query(
          `SELECT ${effLpo} AS L, COUNT(*) AS N FROM srv_items s ${hdrJoin}
            WHERE s.SRV_NO IN (?) GROUP BY L ORDER BY N DESC`, [srvs]);
        const found = r.map((x) => t(x.L)).filter(Boolean);
        if (found.length > 1) notes.push(`These SRVs refer to more than one LPO (${found.join(', ')}); showing ${found[0]}.`);
        return found[0] || '';
      };

      if (type === 'LPO') lpoNo = no;
      if (type === 'SRV') { srvNos = [no]; lpoNo = await lpoOfSrvs(srvNos); }
      if (type === 'PJV' || type === 'PV') {
        let pjvs = [no];
        if (type === 'PV') {
          const tt = t(req.query.tt);
          const [a] = await db.query(
            `SELECT DISTINCT STLD_DOC FROM adj_dtl WHERE STLD_TYPE = ? AND SOURCE_DOC = ? ${tt ? 'AND SOURCE_TYPE = ?' : ''}`,
            tt ? [PUR_TT, no, tt] : [PUR_TT, no]);
          pjvs = a.map((x) => t(x.STLD_DOC)).filter(Boolean);
          if (!pjvs.length) notes.push('This payment does not settle any purchase invoice (tran type 07).');
        }
        if (pjvs.length) {
          const [p] = await db.query(`SELECT PJV_NO, SRV_NO FROM purchase_hdr WHERE PJV_NO IN (?)`, [pjvs]);
          srvNos = [...new Set(p.map((x) => t(x.SRV_NO)).filter(Boolean))];
          const inHdr = new Set(p.map((x) => t(x.PJV_NO)));
          extraPjvs = pjvs.filter((x) => !inHdr.has(x) || !t((p.find((y) => t(y.PJV_NO) === x) || {}).SRV_NO));
          lpoNo = await lpoOfSrvs(srvNos);
        }
      }

      // whole LPO picture: every SRV received against it
      if (lpoNo) {
        const hdrWhere = hCols.map((c) => ` OR TRIM(h.${c}) = ?`).join('');
        const [r] = await db.query(
          `SELECT s.SRV_NO, MIN(s.SRV_DATE) AS D FROM srv_items s ${hdrJoin}
            WHERE TRIM(s.LPO_NO) = ? OR TRIM(s.PO_NO) = ?${hdrWhere}
            GROUP BY s.SRV_NO ORDER BY D, s.SRV_NO`,
          [lpoNo, lpoNo, ...hCols.map(() => lpoNo)]);
        const all = r.map((x) => t(x.SRV_NO));
        if (all.length > MAX_SRVS) notes.push(`LPO ${lpoNo} has ${all.length} SRVs; showing the latest ${MAX_SRVS}.`);
        srvNos = [...new Set([...all.slice(-MAX_SRVS), ...srvNos])];
      }

      // ── 2. LPO node ───────────────────────────────────────────────────────
      let lpoNode = null, supCode = '', partyName = '';
      if (lpoNo) {
        let hdr = null;
        try { [[hdr]] = await db.query('SELECT * FROM lpo_net WHERE TRIM(LPO_NO) = ? LIMIT 1', [lpoNo]); } catch (e) { /* optional */ }
        const [lines] = await db.query(
          `SELECT SR_NO, ITEM_CODE, IFNULL(QTY, 0) AS QTY, IFNULL(RATE, 0) AS RATE, SUP_CODE, LPO_DATE FROM lpo_items WHERE TRIM(LPO_NO) = ?`, [lpoNo]);
        const [rcv] = srvNos.length ? await db.query(
          `SELECT s.SR_NO, s.ITEM_CODE, IFNULL(s.QTY, 0) AS QTY FROM srv_items s ${hdrJoin}
            WHERE s.SRV_NO IN (?) AND ${effLpo} = ?`, [srvNos, lpoNo]) : [[]];
        let ordered = 0, received = 0, pending = 0, over = 0, value = 0;
        lines.forEach((l) => {
          const got = rcv.filter((r) => srNum(r.SR_NO) === srNum(l.SR_NO) && (!t(l.ITEM_CODE) || t(r.ITEM_CODE) === t(l.ITEM_CODE)))
            .reduce((s, r) => s + Number(r.QTY), 0);
          ordered += Number(l.QTY); received += got; value += Number(l.QTY) * Number(l.RATE);
          if (got < Number(l.QTY)) pending += Number(l.QTY) - got;
          if (got > Number(l.QTY) + 0.0005) over++;
        });
        supCode = t(pick(hdr, /^sup_?code$/i)) || t((lines[0] || {}).SUP_CODE);
        const amt = Number(pick(hdr, /^amount$/i)) || value;
        const status = !srvNos.length ? 'Open' : pending > 0.0005 ? 'Part received' : 'Fully received';
        lpoNode = {
          id: `LPO:${lpoNo}`, stage: 'LPO', type: 'LPO', no: lpoNo,
          date: dmy(pick(hdr, /^(lpo_?)?date$|^datte$/i) || (lines[0] || {}).LPO_DATE),
          sub: `${lines.length} line(s)${pending > 0.0005 ? ` · ${qty(pending)} pending` : ''}`,
          amount: aed(amt), status, tone: status === 'Fully received' ? 'done' : status === 'Open' ? 'open' : 'part',
          view: { type: 'LPO', no: lpoNo },
          facts: [['Lines', String(lines.length)], ['Ordered qty', qty(ordered)], ['Received qty', qty(received)],
            ['Pending qty', qty(pending)], ['Over-received lines', String(over)], ['Value', aed(amt)]],
        };
        if (over) lpoNode.tone = 'bad';
      }

      // ── 3. SRV nodes ──────────────────────────────────────────────────────
      const srvNodes = [];
      if (srvNos.length) {
        const [agg] = await db.query(
          `SELECT SRV_NO, MIN(SRV_DATE) AS D, COUNT(*) AS N, SUM(IFNULL(QTY, 0)) AS Q,
                  SUM(IFNULL(QTY, 0) * IFNULL(COST, 0) - IFNULL(DISCOUNT, 0)) AS V
             FROM srv_items WHERE SRV_NO IN (?) GROUP BY SRV_NO`, [srvNos]);
        let hdrs = [];
        try { [hdrs] = await db.query('SELECT * FROM srv_hdr WHERE SRV_NO IN (?)', [srvNos]); } catch (e) { /* optional */ }
        srvNos.forEach((s) => {
          const a = agg.find((x) => t(x.SRV_NO) === s) || {};
          const h = hdrs.find((x) => t(x.SRV_NO) === s);
          if (!supCode) supCode = t(pick(h, /^sup_?code$/i));
          const inv = t(pick(h, /^(sup_?)?inv_?no$/i));
          srvNodes.push({
            id: `SRV:${s}`, stage: 'SRV', type: 'SRV', no: s, date: dmy(a.D),
            sub: inv ? `Inv ${inv}` : `${a.N || 0} line(s)`, amount: aed(a.V), status: 'Received', tone: 'info',
            view: { type: 'SRV', no: s },
            facts: [['SRV Date', dmy(a.D)], ['Supplier Inv', inv || '—'], ['Lines', String(a.N || 0)], ['Qty', qty(a.Q)], ['Value', aed(a.V)], ['LPO', lpoNo || '—']],
            _value: Number(a.V) || 0,
          });
        });
      }

      // ── 4. PJV nodes ──────────────────────────────────────────────────────
      const [pjvRows] = srvNos.length ? await db.query(
        `SELECT PJV_NO, PJV_DATE, SRV_NO, SUP_CODE, INV_NO, IFNULL(INV_AMOUNT, 0) AS AMT, IFNULL(VAT_AMOUNT, 0) AS VAT
           FROM purchase_hdr WHERE SRV_NO IN (?) AND IFNULL(CAN_CEL, 'N') <> 'Y' ORDER BY PJV_DATE, PJV_NO`, [srvNos]) : [[]];
      const pjvNos = [...new Set([...pjvRows.map((p) => t(p.PJV_NO)), ...extraPjvs])];
      if (!supCode && pjvRows[0]) supCode = t(pjvRows[0].SUP_CODE);

      // payable = supplier credit in the G/L; settled = adj_dtl (live vouchers only)
      const payable = {}, glDate = {}, posted = new Set(), settled = {};
      if (pjvNos.length) {
        const [gl] = await db.query(
          `SELECT VCHR_NO, ACC_CODE, MIN(DATTE) AS D, SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE -AMOUNT END) AS CR
             FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO IN (?) GROUP BY VCHR_NO, ACC_CODE`, [PUR_TT, pjvNos]);
        gl.forEach((g) => {
          const v = t(g.VCHR_NO); posted.add(v); glDate[v] = glDate[v] || g.D;
          const p = pjvRows.find((x) => t(x.PJV_NO) === v);
          const isSup = p ? t(g.ACC_CODE) === t(p.SUP_CODE) : isSupplierCode(g.ACC_CODE);
          if (isSup) { payable[v] = (payable[v] || 0) + Number(g.CR); if (!supCode) supCode = t(g.ACC_CODE); }
        });
      }
      let credit = DEFAULT_CREDIT_DAYS;
      if (supCode) {
        try {
          const [[m]] = await db.query('SELECT * FROM sup_mst WHERE SUP_CODE = ? LIMIT 1', [supCode]);
          partyName = t(pick(m, /^sup_?name$/i));
          const cd = Number(pick(m, /^(cr|credit)_?(days|period)$|^pay_?days$/i));
          if (cd > 0) credit = cd;
        } catch (e) { /* optional */ }
      }

      // payments
      let payRows = [];
      if (pjvNos.length) {
        [payRows] = await db.query(
          `SELECT a.STLD_DOC, a.SOURCE_TYPE, a.SOURCE_DOC, a.SOURCE_DATE, IFNULL(a.STLD_AMT, 0) AS AMT,
                  v.DATTE, v.CHEQUE_NO, v.BANK_NAME, IFNULL(v.CAN_CEL, 'N') AS CXL
             FROM adj_dtl a LEFT JOIN vouchers v ON v.TRAN_TYPE = a.SOURCE_TYPE AND v.VCHR_NO = a.SOURCE_DOC
            WHERE a.STLD_TYPE = ? AND a.STLD_DOC IN (?)
            ORDER BY a.SOURCE_DATE, a.SOURCE_DOC`, [PUR_TT, pjvNos]);
        payRows.forEach((r) => {
          if (t(r.CXL).toUpperCase() !== 'Y') settled[t(r.STLD_DOC)] = (settled[t(r.STLD_DOC)] || 0) + Number(r.AMT);
        });
      }

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const pjvNodes = [], ghostPays = [];
      pjvNos.forEach((pj) => {
        const p = pjvRows.find((x) => t(x.PJV_NO) === pj);
        const pay = n2(payable[pj] ?? (p ? p.AMT : 0));
        const set = n2(settled[pj] || 0);
        const bal = n2(pay - set);
        const d = toDate(p ? p.PJV_DATE : glDate[pj]);
        const due = d ? new Date(d.getTime() + credit * 86400000) : null;
        const status = !posted.has(pj) ? 'Not in G/L' : bal <= 0.004 ? 'Paid' : set > 0 ? 'Part paid' : 'Unpaid';
        pjvNodes.push({
          id: `PJV:${pj}`, stage: 'PJV', type: 'PJV', no: pj, date: dmy(d),
          sub: p ? `for SRV ${t(p.SRV_NO)}` : 'Non-stock / non-goods',
          amount: aed(pay), status,
          tone: status === 'Paid' ? 'done' : status === 'Not in G/L' ? 'bad' : status === 'Part paid' ? 'part' : 'open',
          view: { type: 'PJV', no: pj },
          facts: [['PJV Date', dmy(d)], ['Supplier Inv', p ? t(p.INV_NO) || '—' : '—'], ['Payable', aed(pay)],
            ['VAT', p ? aed(p.VAT) : '—'], ['Settled', aed(set)], ['Balance', aed(bal)]],
          _srv: p ? t(p.SRV_NO) : '', _bal: bal, _set: set, _pay: pay,
        });
        if (bal > 0.004 && posted.has(pj)) {
          const days = due ? Math.round((due - today) / 86400000) : null;
          ghostPays.push({
            id: `DUE:${pj}`, stage: 'PAY', type: 'PV', no: 'Not paid yet', date: '', ghost: true,
            sub: `${pj} balance`, amount: aed(bal),
            status: due ? (days < 0 ? `${-days} days overdue` : `Due ${dmy(due)}`) : 'Open',
            tone: days != null && days < 0 ? 'bad' : 'ghost',
            facts: [['PJV', pj], ['Payable', aed(pay)], ['Settled', aed(set)], ['Balance', aed(bal)],
              [`Due (${credit} days)`, dmy(due) || '—'], ['Days to due', days == null ? '—' : String(days)]],
            _pjv: pj,
          });
        }
      });

      // SRVs with no PJV → ghost
      const ghostPjvs = srvNodes.filter((s) => !pjvRows.some((p) => t(p.SRV_NO) === s.no)).map((s) => ({
        id: `NOPJV:${s.no}`, stage: 'PJV', type: 'PJV', no: 'Not booked', date: '', ghost: true,
        sub: `SRV ${s.no}`, amount: aed(s._value), status: 'PJV pending', tone: 'bad',
        facts: [['SRV', s.no], ['SRV Value', aed(s._value)], ['Action', 'Book in Purchase Invoice Local']],
        _srv: s.no,
      }));

      // ── 5. payment nodes (one per voucher) ───────────────────────────────
      const byVchr = new Map();
      payRows.forEach((r) => {
        const k = `${t(r.SOURCE_TYPE)}|${t(r.SOURCE_DOC)}`;
        if (!byVchr.has(k)) byVchr.set(k, { tt: t(r.SOURCE_TYPE), no: t(r.SOURCE_DOC), d: r.SOURCE_DATE || r.DATTE, amt: 0, pjvs: [], chq: t(r.CHEQUE_NO), bank: t(r.BANK_NAME), cxl: t(r.CXL).toUpperCase() === 'Y' });
        const v = byVchr.get(k);
        v.amt += Number(r.AMT); if (!v.pjvs.includes(t(r.STLD_DOC))) v.pjvs.push(t(r.STLD_DOC));
      });
      const payNodes = [];
      for (const v of byVchr.values()) {
        let status = v.cxl ? 'Cancelled' : v.tt === '02' ? 'Paid (cash)' : 'Paid';
        let tone = v.cxl ? 'bad' : 'done';
        let chqTxt = v.chq;
        if (v.tt === '04' && !v.cxl) {
          const ch = await chequesOf(db, v.no);
          if (ch.length) {
            status = ch.map((c) => c.status).join(', ');
            tone = ch.some((c) => c.pdc) ? 'part' : ch.some((c) => /Not realised|matured/.test(c.status)) ? 'part' : 'done';
            chqTxt = ch.map((c) => c.chqNo).filter(Boolean).join(', ') || v.chq;
            if (!v.bank) v.bank = ch.map((c) => c.bank).filter(Boolean)[0] || '';
          }
        }
        payNodes.push({
          id: `PV:${v.tt}:${v.no}`, stage: 'PAY', type: 'PV', no: v.no, date: dmy(v.d),
          sub: v.tt === '04' ? `Cheque ${chqTxt || '—'}${v.bank ? ' · ' + v.bank : ''}` : (PAY_LABEL[v.tt] || `Type ${v.tt}`),
          amount: aed(v.amt), status, tone,
          view: { type: 'PV', no: v.no, tranType: v.tt },
          facts: [['Date', dmy(v.d)], ['Type', `${PAY_LABEL[v.tt] || 'Type'} (${v.tt})`], ['Cheque', chqTxt || '—'],
            ['Bank', v.bank || '—'], ['Settles', v.pjvs.join(', ')], ['Amount', aed(v.amt)]],
          _pjvs: v.pjvs,
        });
      }

      // ── 6. mark the opened document, build links, summary ────────────────
      const allNodes = [...(lpoNode ? [lpoNode] : []), ...srvNodes, ...pjvNodes, ...ghostPjvs, ...payNodes, ...ghostPays];
      const curId = type === 'PV'
        ? (payNodes.find((p) => p.no === no) || {}).id
        : `${type}:${no}`;
      allNodes.forEach((n) => { if (n.id === curId) n.current = true; });

      const links = [];
      if (lpoNode) srvNodes.forEach((s) => links.push({ from: lpoNode.id, to: s.id }));
      pjvNodes.forEach((p) => { if (p._srv) links.push({ from: `SRV:${p._srv}`, to: p.id }); });
      ghostPjvs.forEach((g) => links.push({ from: `SRV:${g._srv}`, to: g.id }));
      payNodes.forEach((v) => v._pjvs.forEach((pj) => links.push({ from: `PJV:${pj}`, to: v.id })));
      ghostPays.forEach((g) => links.push({ from: `PJV:${g._pjv}`, to: g.id }));

      const totPay = pjvNodes.reduce((s, p) => s + p._pay, 0);
      const totSet = pjvNodes.reduce((s, p) => s + p._set, 0);
      const pendingQty = lpoNode ? lpoNode.facts[3][1] : '';
      const clean = (n) => { const o = { ...n }; Object.keys(o).forEach((k) => { if (k.startsWith('_')) delete o[k]; }); return o; };

      res.json({
        chain: 'purchase',
        opened: { type, no },
        title: `${type} ${no}`,
        party: partyName || supCode,
        summary: [
          { label: 'LPO', value: lpoNo ? `${lpoNo} · ${lpoNode.facts[0][1]} lines` : 'None' },
          { label: 'Received', value: `${srvNodes.length} SRV(s)${lpoNo ? ` · ${pendingQty} qty pending` : ''}` },
          { label: 'Booked', value: `${pjvNodes.length} PJV(s)${ghostPjvs.length ? ` · ${ghostPjvs.length} not booked` : ''}`, tone: ghostPjvs.length ? 'bad' : '' },
          { label: 'Paid', value: aed(totSet), tone: 'blue' },
          { label: 'Balance', value: aed(totPay - totSet), tone: totPay - totSet > 0.004 ? 'orange' : '' },
        ],
        stages: [
          { key: 'LPO', label: 'Purchase Order', nodes: lpoNode ? [clean(lpoNode)] : [{ id: 'NOLPO', stage: 'LPO', type: 'LPO', no: 'No LPO', ghost: true, sub: 'received without an LPO', status: 'Direct purchase', tone: 'ghost', facts: [['Note', 'The SRV lines and header carry no LPO no.']] }] },
          { key: 'SRV', label: 'Goods Receipt', nodes: srvNodes.map(clean) },
          { key: 'PJV', label: 'Purchase Invoice', nodes: [...pjvNodes, ...ghostPjvs].map(clean) },
          { key: 'PAY', label: 'Payment', nodes: [...payNodes, ...ghostPays].map(clean) },
        ],
        links,
        notes,
      });
    } catch (err) {
      console.error('doc-flow error:', err);
      res.status(500).json({ error: 'Failed to build the document flow', detail: err.message });
    }
  });

  return router;
};
