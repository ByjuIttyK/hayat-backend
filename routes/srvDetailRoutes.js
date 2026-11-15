// routes/srvDetailRoutes.js
// SRV List (InfoGrid/SRV, SRVFP) — detail panel under the list.
//
//   GET /api/srv-detail/:srvNo        Items, PJV(s), G/L lines, payments (adj_dtl 07)
//   GET /api/srv-detail/:srvNo/fifo   Where the received qty went (FIFO estimate)
//
// Register in HayatDb.js:
//   const srvDetailRoutes = require('./routes/srvDetailRoutes');
//   app.use('/api', srvDetailRoutes(connection));
//
// Table names are lower case (VPS is case-sensitive).

const express = require('express');

// ── stock_trans view (FIFO tab) ───────────────────────────────────────────
// Doc_no, Doc_date, Loc_code, Item_code, Qty (+ inward / − outward), Std_cost,
// SUP_CODE, NARRATION, Stock_tran_type, Job_no, sORT_ORD
const ST = {
  view: 'stock_trans',
  item: 'Item_code',
  loc: 'Loc_code',
  date: 'Doc_date',
  docNo: 'Doc_no',
  docType: 'Stock_tran_type',
  qty: 'Qty',
  job: 'Job_no',
  sort: 'sORT_ORD',
};
// Stock_tran_type codes. Anything not listed here shows as "Ret / Adj".
const SIV_TYPES = ['S.I.V'];        // Store Issue Vouchers
const DO_TYPES = ['S.INV'];         // Sales (trading) invoices
// Others seen: S.RET, RM.RET, P.RET, S.ADJ, TRF.Out / TRF.In -> "Ret / Adj"
const STOCK_LOC = '01';             // stock is kept in location 01 only

const PAY_TYPE_LABEL = { '02': 'Cash Payment', '04': 'Cheque Payment' };

// ── helpers ───────────────────────────────────────────────────────────────
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

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
  if (!d) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
// first non-empty value whose column name matches the pattern (any case)
const pick = (row, re) => {
  if (!row) return null;
  const k = Object.keys(row).find((key) => re.test(key) && row[key] != null && String(row[key]).trim() !== '');
  return k ? row[k] : null;
};

// Cheque detail of a cheque PV: pdc_isu (post-dated) or current_chq (current).
// SELECT * + pick() so a column-name difference does not break the panel.
async function chequesOf(db, vchrNo) {
  const out = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sources = [
    { src: 'PDC', sql: 'SELECT * FROM pdc_isu WHERE VCHR_NO = ?' },
    { src: 'CUR', sql: "SELECT * FROM current_chq WHERE TRAN_TYPE = '04' AND VCHR_NO = ?" },
  ];
  for (const s of sources) {
    try {
      const [rows] = await db.query(s.sql, [vchrNo]);
      for (const r of rows) {
        const chqDate = toDate(pick(r, /^(chq|cheque)_?date$/i));
        let status;
        if (s.src === 'CUR') {
          status = String(pick(r, /^realised$/i) ?? '').toUpperCase() === 'Y' ? 'Realised' : 'Current – not realised';
        } else if (chqDate && chqDate > today) {
          status = `PDC due ${dmy(chqDate)}`;
        } else {
          // PDC Issued Reversal stamps BATCH_NO on pdc_isu when the PDC is realised
          status = pick(r, /^batch_no$/i) ? 'Realised' : 'PDC matured';
        }
        out.push({
          src: s.src,
          chqNo: String(pick(r, /^(chq|cheque)_?no$/i) ?? ''),
          chqDate: dmy(chqDate),
          bank: String(pick(r, /^(chq_bank|bank_name|bank_code|bank)$/i) ?? ''),
          amount: n2(pick(r, /^amount$/i)),
          status,
        });
      }
    } catch (e) {
      // table / column not as expected — skip this source quietly
    }
  }
  return out;
}

// ── LPO status ────────────────────────────────────────────────────────────
// Effective LPO of an SRV line = srv_items.LPO_NO, else the SRV header's LPO no.
// The header column is found by name (LPO_NO / PO_NO) so a naming difference
// does not break the panel.
const SAFE_COL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const t = (v) => String(v ?? '').trim();
const srNum = (v) => { const n = parseInt(t(v), 10); return isNaN(n) ? t(v) : n; };

async function lpoStatus(db, srvNo, items) {
  // srv_hdr.PO_NO holds the LPO no. (srv_hdr.LPO_NO, srv_items.LPO_NO / PO_NO are usually blank).
  // All four are tried, header PO_NO first, so whichever is filled is used.
  let hdrLpo = '';
  let hdrCols = [];
  try {
    const [[hdr]] = await db.query('SELECT * FROM srv_hdr WHERE SRV_NO = ? LIMIT 1', [srvNo]);
    if (hdr) {
      const keys = Object.keys(hdr);
      hdrCols = [/^po_?no$/i, /^lpo_?no$/i]
        .map((re) => keys.find((k) => re.test(k)))
        .filter((k) => k && SAFE_COL.test(k));
      hdrLpo = hdrCols.map((k) => t(hdr[k])).find(Boolean) || '';
    }
  } catch (e) { /* no header table — line values only */ }

  const lines = items.map((r) => ({ ...r, ELPO: t(r.LPO_NO) || t(r.PO_NO) || hdrLpo }));
  const lpos = [...new Set(lines.map((l) => l.ELPO).filter(Boolean))];

  let lpoLines = [];
  let others = [];
  const lpoDate = {};
  if (lpos.length) {
    const [ll] = await db.query(
      `SELECT LPO_NO, SR_NO, ITEM_CODE, ITEM_NAME, UNIT, JOB_NO, LPO_DATE,
              IFNULL(QTY, 0) AS QTY, IFNULL(RATE, 0) AS RATE, IFNULL(DISC_PERCENT, 0) AS DISC_PERCENT
         FROM lpo_items WHERE TRIM(LPO_NO) IN (?)`, [lpos]);
    lpoLines = ll;
    // LPO date from the LPO header (lpo_net); date column found by name
    try {
      const [hn] = await db.query('SELECT * FROM lpo_net WHERE TRIM(LPO_NO) IN (?)', [lpos]);
      hn.forEach((h) => { lpoDate[t(h.LPO_NO)] = dmy(pick(h, /^(lpo_?)?date$|^datte$/i)); });
    } catch (e) { /* optional */ }

    // every SRV line received against these LPOs (line LPO_NO / PO_NO, else header PO_NO / LPO_NO)
    const hdrExpr = hdrCols.map((k) => `NULLIF(TRIM(h.${k}), '')`).join(', ');
    const effExpr = `COALESCE(NULLIF(TRIM(s.LPO_NO), ''), NULLIF(TRIM(s.PO_NO), '')${hdrExpr ? ', ' + hdrExpr : ''})`;
    const hdrWhere = hdrCols.map((k) => ` OR TRIM(h.${k}) IN (?)`).join('');
    const [oo] = await db.query(
      `SELECT s.SRV_NO, s.SRV_DATE, s.SR_NO, s.ITEM_CODE, IFNULL(s.QTY, 0) AS QTY, ${effExpr} AS ELPO
         FROM srv_items s ${hdrCols.length ? 'LEFT JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO' : ''}
        WHERE TRIM(s.LPO_NO) IN (?) OR TRIM(s.PO_NO) IN (?)${hdrWhere}`,
      [lpos, lpos, ...hdrCols.map(() => lpos)]);
    others = oo.filter((o) => lpos.includes(t(o.ELPO)));
  }

  const sameLine = (lpoNo, lpoLine, srv) =>
    t(srv.ELPO) === lpoNo && srNum(srv.SR_NO) === srNum(lpoLine.SR_NO)
    && (!t(lpoLine.ITEM_CODE) || t(srv.ITEM_CODE) === t(lpoLine.ITEM_CODE));
  const ts = (v) => { const d = toDate(v); return d ? d.getTime() : 0; };

  return lines.map((r) => {
    const qty = Number(r.QTY) || 0;
    const srvRate = qty ? (qty * Number(r.COST) - Number(r.DISCOUNT)) / qty : Number(r.COST);
    const l = r.ELPO
      ? lpoLines.find((x) => t(x.LPO_NO) === r.ELPO && srNum(x.SR_NO) === srNum(r.SR_NO)
        && (!t(x.ITEM_CODE) || t(x.ITEM_CODE) === t(r.ITEM_CODE)))
      : null;
    if (!l) {
      return {
        srNo: r.SR_NO, itemCode: r.ITEM_CODE, lpoNo: r.ELPO, matched: false, lpoSr: '', lpoDate: '',
        lpoItemName: '', lpoUnit: '', lpoJobNo: '', lpoQty: 0, recdBefore: 0, thisQty: qty,
        balAfterThis: 0, balNow: 0, lpoRate: 0, srvRate: Math.round(srvRate * 1000) / 1000, varPct: 0,
      };
    }
    const myT = ts(r.SRV_DATE);
    const onLine = others.filter((o) => sameLine(r.ELPO, l, o));
    const before = onLine
      .filter((o) => t(o.SRV_NO) !== srvNo && (ts(o.SRV_DATE) < myT || (ts(o.SRV_DATE) === myT && t(o.SRV_NO) < srvNo)))
      .reduce((s, o) => s + Number(o.QTY), 0);
    // all receipts on the line; this SRV's own line is counted once even if the query missed it
    const others2 = onLine.filter((o) => t(o.SRV_NO) !== srvNo).reduce((s, o) => s + Number(o.QTY), 0);
    const all = others2 + qty;
    const lpoQty = Number(l.QTY) || 0;
    const lpoRate = Number(l.RATE) * (1 - Number(l.DISC_PERCENT) / 100);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return {
      srNo: r.SR_NO, itemCode: r.ITEM_CODE, lpoNo: r.ELPO, matched: true,
      lpoSr: String(l.SR_NO), lpoDate: dmy(l.LPO_DATE) || lpoDate[r.ELPO] || '',
      lpoItemName: l.ITEM_NAME || '', lpoUnit: l.UNIT || '', lpoJobNo: l.JOB_NO || '',
      lpoQty, recdBefore: r3(before), thisQty: qty,
      balAfterThis: r3(lpoQty - before - qty),
      balNow: r3(lpoQty - all),
      lpoRate: r3(lpoRate), srvRate: r3(srvRate),
      varPct: lpoRate ? Math.round(((srvRate - lpoRate) / lpoRate) * 1000) / 10 : 0,
    };
  });
}

module.exports = function (connection) {
  const router = express.Router();

  // ── Items, PJV, G/L, payments ───────────────────────────────────────────
  router.get('/srv-detail/:srvNo', async (req, res) => {
    const srvNo = String(req.params.srvNo || '').trim();
    if (!srvNo) return res.status(400).json({ error: 'SRV No required' });
    const db = connection.promise();
    try {
      const [items] = await db.query(
        `SELECT s.SR_NO, s.ITEM_CODE, i.ITEM_NAME1 AS ITEM_NAME,
                COALESCE(NULLIF(s.SRV_UNIT, ''), s.ITEM_UNIT) AS UNIT,
                IFNULL(s.QTY, 0) AS QTY, IFNULL(s.COST, 0) AS COST, IFNULL(s.DISCOUNT, 0) AS DISCOUNT,
                ROUND(IFNULL(s.QTY, 0) * IFNULL(s.COST, 0) - IFNULL(s.DISCOUNT, 0), 2) AS AMOUNT,
                s.LPO_NO, s.PO_NO, s.JOB_NO, s.SUP_ITEM_CODE, s.SRV_DATE
           FROM srv_items s
           LEFT JOIN item_mst i ON i.ITEM_CODE = s.ITEM_CODE
          WHERE s.SRV_NO = ?
          ORDER BY CAST(s.SR_NO AS UNSIGNED), s.SR_NO`,
        [srvNo]
      );

      // LPO status per SRV line. Matching as on the LPO list (Rcvd / Pending Qty):
      // LPO No + Sr No, plus Item Code when the LPO line's item code is not blank.
      // The line's LPO_NO is often blank — the LPO no. is then taken from srv_hdr.
      const lpo = await lpoStatus(db, srvNo, items);
      // Purchase Local booked against this SRV (PinvLocal), cancelled ones left out
      const [pjvRows] = await db.query(
        `SELECT PJV_NO, PJV_DATE, INV_NO, INV_DATE, SUP_CODE,
                IFNULL(INV_AMOUNT, 0) AS INV_AMOUNT, IFNULL(VAT_AMOUNT, 0) AS VAT_AMOUNT,
                IFNULL(DISCOUNT, 0) AS DISCOUNT, IFNULL(RND_OFF, 0) AS RND_OFF
           FROM purchase_hdr
          WHERE SRV_NO = ? AND IFNULL(CAN_CEL, 'N') <> 'Y'
          ORDER BY PJV_NO`,
        [srvNo]
      );
      const pjvNos = pjvRows.map((p) => p.PJV_NO);

      let gl = [];
      let settle = [];
      if (pjvNos.length) {
        const [glRows] = await db.query(
          `SELECT t.VCHR_NO, t.ACC_CODE, a.AC_HEAD, t.DB_CR, IFNULL(t.AMOUNT, 0) AS AMOUNT, t.NARRATION1
             FROM tran_acc t
             LEFT JOIN ac_list a ON a.AC_CODE = t.ACC_CODE
            WHERE t.TRAN_TYPE = '07' AND t.VCHR_NO IN (?)
            ORDER BY t.VCHR_NO, t.DB_CR DESC, t.srno_row_id`,
          [pjvNos]
        );
        gl = glRows.map((r) => ({
          pjvNo: r.VCHR_NO, accCode: r.ACC_CODE, accHead: r.AC_HEAD || '',
          dr: r.DB_CR === 'D' ? n2(r.AMOUNT) : 0,
          cr: r.DB_CR === 'C' ? n2(r.AMOUNT) : 0,
          narration: r.NARRATION1 || '',
        }));

        const [adj] = await db.query(
          `SELECT a.STLD_DOC, a.SOURCE_TYPE, a.SOURCE_DOC, a.SOURCE_DATE,
                  IFNULL(a.STLD_AMT, 0) AS STLD_AMT,
                  v.DATTE AS VCHR_DATE, v.CHEQUE_NO, v.BANK_NAME, IFNULL(v.CAN_CEL, 'N') AS V_CANCEL
             FROM adj_dtl a
             LEFT JOIN vouchers v ON v.TRAN_TYPE = a.SOURCE_TYPE AND v.VCHR_NO = a.SOURCE_DOC
            WHERE a.STLD_TYPE = '07' AND a.STLD_DOC IN (?)
            ORDER BY a.SOURCE_DATE, a.SOURCE_DOC`,
          [pjvNos]
        );
        for (const a of adj) {
          const type = String(a.SOURCE_TYPE || '');
          let cheques = [];
          let status = 'Settled';
          if (String(a.V_CANCEL).toUpperCase() === 'Y') status = 'PV cancelled';
          else if (type === '02') status = 'Paid (cash)';
          else if (type === '04') {
            cheques = await chequesOf(db, a.SOURCE_DOC);
            if (!cheques.length && a.CHEQUE_NO) {
              cheques = [{ src: 'PV', chqNo: String(a.CHEQUE_NO), chqDate: '', bank: a.BANK_NAME || '', amount: 0, status: 'Cheque' }];
            }
            status = cheques.length ? cheques.map((c) => c.status).join(', ') : 'Cheque';
          }
          settle.push({
            pjvNo: a.STLD_DOC,
            type,
            typeLabel: PAY_TYPE_LABEL[type] || `Type ${type || '?'}`,
            docNo: a.SOURCE_DOC,
            docDate: dmy(a.SOURCE_DATE || a.VCHR_DATE),
            amount: n2(a.STLD_AMT),
            cheques,
            status,
          });
        }
      }

      // Payable per PJV = supplier credit in the G/L (falls back to INV_AMOUNT)
      const pjvs = pjvRows.map((p) => {
        const supCr = gl
          .filter((g) => g.pjvNo === p.PJV_NO && g.accCode === p.SUP_CODE)
          .reduce((s, g) => s + g.cr - g.dr, 0);
        const payable = n2(supCr || p.INV_AMOUNT);
        const settled = n2(settle
          .filter((s) => s.pjvNo === p.PJV_NO && s.status !== 'PV cancelled')
          .reduce((t, s) => t + s.amount, 0));
        return {
          pjvNo: p.PJV_NO, pjvDate: dmy(p.PJV_DATE), invNo: p.INV_NO || '', invDate: dmy(p.INV_DATE),
          supCode: p.SUP_CODE, invAmount: n2(p.INV_AMOUNT), vatAmount: n2(p.VAT_AMOUNT),
          payable, settled, balance: n2(payable - settled),
        };
      });

      res.json({
        srvNo,
        items: items.map((r) => ({
          srNo: r.SR_NO, itemCode: r.ITEM_CODE, itemName: r.ITEM_NAME || '', unit: r.UNIT || '',
          qty: Number(r.QTY), cost: Number(r.COST), discount: n2(r.DISCOUNT), amount: n2(r.AMOUNT),
          lpoNo: r.LPO_NO || '', jobNo: r.JOB_NO || '', supItemCode: r.SUP_ITEM_CODE || '',
        })),
        lpo,
        pjvs,
        gl,
        settle,
      });
    } catch (err) {
      console.error('srv-detail error:', err);
      res.status(500).json({ error: 'Failed to load SRV detail', detail: err.message });
    }
  });

  // ── Supplier quick view ─────────────────────────────────────────────────
  // Ledger balance from tran_acc; open purchases = tran type 07 credits to the
  // supplier (Local, Non-Stock, Non-Goods) less adj_dtl settlements.
  // ?sup=<SUP_CODE> when the list row has it; else taken from the PJV / stock_trans.
  router.get('/srv-detail/:srvNo/supplier', async (req, res) => {
    const srvNo = String(req.params.srvNo || '').trim();
    const db = connection.promise();
    try {
      let sup = String(req.query.sup || '').trim();
      if (!sup) {
        const [[p]] = await db.query(
          `SELECT SUP_CODE FROM purchase_hdr WHERE SRV_NO = ? AND IFNULL(SUP_CODE, '') <> '' LIMIT 1`, [srvNo]);
        sup = p ? String(p.SUP_CODE).trim() : '';
      }
      if (!sup) {
        const [[s]] = await db.query(
          `SELECT ${ST.view}.SUP_CODE FROM ${ST.view}
            WHERE ${ST.docNo} = ? AND ${ST.qty} > 0 AND IFNULL(${ST.view}.SUP_CODE, '') <> '' LIMIT 1`, [srvNo]);
        sup = s ? String(s.SUP_CODE).trim() : '';
      }
      if (!sup) return res.json({ supCode: '', found: false });

      const [[m]] = await db.query(`SELECT * FROM sup_mst WHERE SUP_CODE = ? LIMIT 1`, [sup]);
      const supName = m ? String(pick(m, /^sup_?name$/i) ?? '') : '';
      const crDaysRaw = m ? pick(m, /^(cr|credit)_?(days|period)$|^pay_?days$/i) : null;
      const dueDays = Number(crDaysRaw) > 0 ? Number(crDaysRaw) : 60;

      const [[bal]] = await db.query(
        `SELECT IFNULL(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE -AMOUNT END), 0) AS BAL
           FROM tran_acc WHERE ACC_CODE = ?`, [sup]);

      const [bills] = await db.query(
        `SELECT t.VCHR_NO, MIN(t.DATTE) AS DATTE,
                SUM(CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE -t.AMOUNT END) AS AMT
           FROM tran_acc t
          WHERE t.TRAN_TYPE = '07' AND t.ACC_CODE = ?
          GROUP BY t.VCHR_NO`, [sup]);
      const nos = bills.map((b) => b.VCHR_NO);
      const stld = {};
      const srvOf = {};
      if (nos.length) {
        const [a] = await db.query(
          `SELECT STLD_DOC, SUM(IFNULL(STLD_AMT, 0)) AS S
             FROM adj_dtl WHERE STLD_TYPE = '07' AND STLD_DOC IN (?) GROUP BY STLD_DOC`, [nos]);
        a.forEach((r) => { stld[r.STLD_DOC] = Number(r.S) || 0; });
        const [p] = await db.query(
          `SELECT PJV_NO, SRV_NO FROM purchase_hdr WHERE PJV_NO IN (?)`, [nos]);
        p.forEach((r) => { srvOf[r.PJV_NO] = r.SRV_NO || ''; });
      }
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - dueDays);
      let overdue = 0, openCount = 0, openAmt = 0;
      const list = bills.map((b) => {
        const amt = n2(b.AMT);
        const balance = n2(amt - (stld[b.VCHR_NO] || 0));
        const d = toDate(b.DATTE);
        if (balance > 0.004) {
          openCount++; openAmt += balance;
          if (d && d < cutoff) overdue += balance;
        }
        return { pjvNo: b.VCHR_NO, date: dmy(d), sortKey: d ? d.getTime() : 0, srvNo: srvOf[b.VCHR_NO] || '', amount: amt, balance };
      }).sort((x, y) => y.sortKey - x.sortKey);

      const [[lp]] = await db.query(
        `SELECT MAX(SOURCE_DATE) AS D FROM adj_dtl WHERE STLD_TYPE = '07' AND ACC_CODE = ?`, [sup]);

      res.json({
        found: true, supCode: sup, supName, dueDays,
        ledgerBalance: n2(bal.BAL),
        openCount, openAmount: n2(openAmt), overdue: n2(overdue),
        lastPayment: dmy(lp && lp.D),
        recent: list.slice(0, 5).map(({ sortKey, ...r }) => r),
      });
    } catch (err) {
      console.error('srv-detail supplier error:', err);
      res.status(500).json({ error: 'Failed to load supplier', detail: err.message });
    }
  });

  // ── FIFO: where this receipt went ───────────────────────────────────────
  // For each SRV line: qty received before it (opening + earlier inward) is
  // consumed first; this line's slice is [before, before + qty] of the item's
  // cumulative outward movements, taken in date order.
  router.get('/srv-detail/:srvNo/fifo', async (req, res) => {
    const srvNo = String(req.params.srvNo || '').trim();
    if (!srvNo) return res.status(400).json({ error: 'SRV No required' });
    const db = connection.promise();
    try {
      const [lines] = await db.query(
        `SELECT s.SR_NO, s.ITEM_CODE, i.ITEM_NAME1 AS ITEM_NAME, IFNULL(s.QTY, 0) AS QTY, s.JOB_NO,
                DATE_FORMAT(s.SRV_DATE, '%Y-%m-%d') AS SRV_YMD
           FROM srv_items s
           LEFT JOIN item_mst i ON i.ITEM_CODE = s.ITEM_CODE
          WHERE s.SRV_NO = ?
          ORDER BY CAST(s.SR_NO AS UNSIGNED), s.SR_NO`,
        [srvNo]
      );
      if (!lines.length) return res.json({ srvNo, lines: [], consumedOn: '' });

      const srvYmd = lines[0].SRV_YMD;
      const sameSrvBefore = {};   // earlier lines of the same item in this SRV
      const outCache = {};
      const beforeCache = {};
      const result = [];

      for (const ln of lines) {
        const item = ln.ITEM_CODE;
        const qty = Number(ln.QTY) || 0;

        if (beforeCache[item] === undefined) {
          const [[b]] = await db.query(
            `SELECT IFNULL(SUM(${ST.qty}), 0) AS Q
               FROM ${ST.view}
              WHERE ${ST.item} = ? AND ${ST.loc} = ? AND ${ST.qty} > 0
                AND (${ST.date} < ? OR (DATE(${ST.date}) = ? AND ${ST.docNo} < ?))`,
            [item, STOCK_LOC, srvYmd, srvYmd, srvNo]
          );
          beforeCache[item] = Number(b.Q) || 0;
        }
        if (!outCache[item]) {
          const [outs] = await db.query(
            `SELECT ${ST.docNo} AS DOC_NO, ${ST.docType} AS DOC_TYPE, ${ST.date} AS DOC_DATE,
                    -${ST.qty} AS QTY, ${ST.job} AS JOB_NO
               FROM ${ST.view}
              WHERE ${ST.item} = ? AND ${ST.loc} = ? AND ${ST.qty} < 0
              ORDER BY ${ST.date}, ${ST.sort}, ${ST.docNo}`,
            [item, STOCK_LOC]
          );
          outCache[item] = outs;
        }

        const sliceStart = beforeCache[item] + (sameSrvBefore[item] || 0);
        const sliceEnd = sliceStart + qty;
        sameSrvBefore[item] = (sameSrvBefore[item] || 0) + qty;

        let cum = 0;
        const allocs = [];
        for (const o of outCache[item]) {
          const start = cum;
          const end = cum + Number(o.QTY);
          cum = end;
          if (start >= sliceEnd) break;
          const overlap = Math.min(end, sliceEnd) - Math.max(start, sliceStart);
          if (overlap > 0) {
            const t = String(o.DOC_TYPE || '').trim().toUpperCase();
            allocs.push({
              docNo: String(o.DOC_NO || '').trim(),
              docType: t,
              kind: SIV_TYPES.includes(t) ? 'SIV' : DO_TYPES.includes(t) ? 'DO' : 'OTHER',
              date: dmy(o.DOC_DATE),
              qty: n2(overlap),
              jobNo: String(o.JOB_NO || '').trim(), panelNo: '',
            });
          }
        }

        // Job / panel for the SIVs, from siv_items
        const sivNos = [...new Set(allocs.filter((a) => a.kind === 'SIV').map((a) => a.docNo))];
        if (sivNos.length) {
          const [jobs] = await db.query(
            `SELECT SIV_NO, MAX(JOB_NO) AS JOB_NO, MAX(PANEL_NO) AS PANEL_NO
               FROM siv_items
              WHERE SIV_NO IN (?) AND ITEM_CODE = ?
              GROUP BY SIV_NO`,
            [sivNos, item]
          );
          const byNo = Object.fromEntries(jobs.map((j) => [String(j.SIV_NO).trim(), j]));
          allocs.forEach((a) => {
            const j = byNo[a.docNo];
            if (j) { a.jobNo = a.jobNo || j.JOB_NO || ''; a.panelNo = j.PANEL_NO || ''; }
          });
        }

        const sum = (k) => n2(allocs.filter((a) => a.kind === k).reduce((s, a) => s + a.qty, 0));
        const siv = sum('SIV'), dout = sum('DO'), other = sum('OTHER');
        const inStore = n2(qty - siv - dout - other);
        result.push({
          srNo: ln.SR_NO, itemCode: item, itemName: ln.ITEM_NAME || '', qty,
          srvJobNo: ln.JOB_NO || '',
          siv, dout, other, inStore,
          allocs,
          lastDate: allocs.length ? allocs[allocs.length - 1].date : '',
        });
      }

      const allOut = result.every((r) => r.inStore <= 0);
      const consumedOn = allOut
        ? result.map((r) => r.lastDate).filter(Boolean)
          .sort((a, b) => toDate(a) - toDate(b)).pop() || ''
        : '';
      res.json({ srvNo, lines: result, consumedOn });
    } catch (err) {
      console.error('srv-detail fifo error:', err);
      res.status(500).json({ error: 'Failed to work out FIFO issues', detail: err.message });
    }
  });

  return router;
};
