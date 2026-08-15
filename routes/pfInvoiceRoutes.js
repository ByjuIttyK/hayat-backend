// routes/pfInvoiceRoutes.js
//
// Factory-pattern route module (matches HayatDb.js convention). Mount at root
// or at /api — the shim exposes routes under both:
//   const pfInvoiceRoutes = require('./routes/pfInvoiceRoutes');
//   app.use(pfInvoiceRoutes(connection));
//
// Header  = pfinv_net   (INV_NO is the key; no auto-increment on the Oracle-
//                        migrated table, so INV_NO is generated MM/YY style)
// Lines   = pfinv_items (SR_NO per line; PANEL_NO added — see pfinv_items_ddl.sql)
//
// ⚠ LOV endpoints below query customer / bank / job / panel / quotation
//   sources. Table & column names are best guesses from context — adjust the
//   marked queries to your actual schema.
const { nextInvNo, nextInvNoAtomic, invYearSuffix } = require('../helpers/nextInvNo');

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  const db = typeof connection.promise === 'function' ? connection.promise() : connection;
  const isPool = typeof db.getConnection === 'function';

  async function withTxn(fn) {
    const conn = isPool ? await db.getConnection() : db;
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (err) {
      try { await conn.rollback(); } catch (_) { /* best effort */ }
      throw err;
    } finally {
      if (isPool) conn.release();
    }
  }

  // ── INV_NO preview: NN/YY (e.g. 25/26), the running number per fin-year. ──
  //
  // NOTE the path has NO '/api' prefix — the mount shim at the bottom of this
  // file exposes every route under both '/' and '/api'. Declaring '/api/...'
  // here would resolve to '/api/api/...' and 404.
  //
  // PREVIEW ONLY. Uses the MAX()-based nextInvNo, never nextInvNoAtomic —
  // the atomic one would burn a sequence number every time a user tabs out of
  // the date field, leaving gaps for invoices that were never saved.
  router.get('/pf-nextinvno/:invDate', async (req, res) => {
    try {
      const invDate = req.params.invDate;

      // invYearSuffix throws a 400-tagged error on a malformed date, so a bad
      // param never reaches the query.
      const yy = invYearSuffix(invDate);
      const invNo = await nextInvNo(db, invDate);

      res.json({
        INV_NO: invNo,
        SERIES: yy,
        PREVIEW: true,   // the client must not treat this as an assigned number
      });
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ message: err.message });
      }
      console.error('pf-nextinvno:', err);
      res.status(500).json({ message: 'Could not work out the next invoice number' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  LOV endpoints
  // ─────────────────────────────────────────────────────────────────────────

  // Customers — ⚠ confirm table/columns (PartyStatment used /api/customers →
  // CUST_NAME; adapt to your customer master).
  // cus_mst calls the column CONTACT_PR (confirmed from DESC CUS_MST), so it
  // is aliased to CONTACT_PER — the name the screen reads.
  router.get('/pf-custlst', async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT CUST_CODE, CUST_NAME, CONTACT_PR AS CONTACT_PER
           FROM cus_mst ORDER BY CUST_NAME LIMIT 1000`
      );
      res.json(rows);
    } catch (err) {
      console.error('pf-custlst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // Banks — from sales_bank_dtl (BANK_CODE, BANK_DETAILS).
  router.get('/pf-banklst', async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT BANK_CODE, BANK_DETAILS AS BANK_NAME
           FROM sales_bank_dtl
          WHERE BANK_CODE IS NOT NULL
          ORDER BY BANK_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error('pf-banklst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // Validate a bank code exists in sales_bank_dtl (used on save / manual entry).
  router.get('/pf-bankchk/:bankCode', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT BANK_CODE, BANK_DETAILS AS BANK_NAME
           FROM sales_bank_dtl WHERE BANK_CODE = ? LIMIT 1`,
        [req.params.bankCode]
      );
      res.json({ valid: rows.length > 0, bank: rows[0] || null });
    } catch (err) {
      console.error('pf-bankchk error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Jobs for the Job LOV — scoped to a customer (":custCode" = "_" = all).
  //
  //  ⚠ COLUMN NAME TO CONFIRM: JobQueryScreen.tsx types this column as
  //    QUOTE_REF, you referred to it as QUOT_REF. Whichever job_card actually
  //    has, alias it to QUOT_REF — the screen reads that name.
  //
  //  LPO_DATE goes over the wire as ISO (YYYY-MM-DD) exactly like INV_DATE.
  //  The dd/mm/yyyy the user sees is a presentation concern handled in the
  //  screen; keeping the wire format ISO means no ambiguity server-side.
  // ─────────────────────────────────────────────────────────────────────────
  const JOB_LOV_SQL = `
    SELECT j.JOB_NO,
           j.CUST_CODE,
           c.CUST_NAME,
           j.CONTACT_PER,
           j.LPO_NO,
           DATE_FORMAT(j.LPO_DATE,'%Y-%m-%d') AS LPO_DATE,
           j.DESIGNER,
           j.QUOT_REF
      FROM job_card j
      LEFT JOIN cus_mst c ON c.CUST_CODE = j.CUST_CODE`;

  router.get('/pf-joblst/:custCode', async (req, res) => {
    const { custCode } = req.params;
    try {
      const all = !custCode || custCode === '_';
      const [rows] = await db.query(
        all
          ? `${JOB_LOV_SQL} ORDER BY j.JOB_NO DESC LIMIT 1000`
          : `${JOB_LOV_SQL} WHERE j.CUST_CODE = ? ORDER BY j.JOB_NO DESC`,
        all ? [] : [custCode]
      );
      res.json(rows);
    } catch (err) {
      console.error('pf-joblst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // Single job — same shape as the LOV row. Used when the user types a Job No
  // by hand instead of picking from the list, so both paths fill the same
  // fields and cannot drift apart.
  router.get('/pf-jobinfo/:jobNo', async (req, res) => {
    try {
      const [rows] = await db.query(
        `${JOB_LOV_SQL} WHERE j.JOB_NO = ? LIMIT 1`, [req.params.jobNo]);
      if (!rows.length) return res.status(404).json({ message: 'Job not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('pf-jobinfo error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // Currencies — code, name, and conversion rate. ⚠ confirm table/columns.
  // Expected shape consumed by the screen: { CURR_CODE, CURR_NAME, CONV_RATE }.
  router.get('/pf-currlst', async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT CUR_CODE AS CURR_CODE, CUR_NAME AS CURR_NAME, DHS_CONV_RATE AS CONV_RATE FROM nation_mst WHERE CUR_CODE IS NOT NULL ORDER BY CUR_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error('pf-currlst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });
//
// ── Proforma Invoice browser list (module_name = 'PFINV') ──
  router.get('/pf-invlst', async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT h.INV_NO,
                DATE_FORMAT(h.INV_DATE, '%Y-%m-%d') AS INV_DATE,
                h.CUST_CODE,
                c.CUST_NAME,
                h.NARRATION,
                h.JOB_NO,
                h.QUOT_NO,
                h.LPO_NO,
                h.CURR_ENCY,
                h.BANK_CODE,
                h.AMOUNT
           FROM PFINV_NET h
           LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
          WHERE IFNULL(h.CANCELLED, 'N') <> 'Y'
          ORDER BY h.INV_DATE DESC, h.INV_NO DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error('pf-invlst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });
  // Quotations — scoped to a job when one is passed (":jobNo" = "_" means all).
  router.get('/pf-quotlst/:jobNo', async (req, res) => {
    const { jobNo } = req.params;
    try {
      const all = !jobNo || jobNo === '_';
      const [rows] = await db.query(
        all
          ? `SELECT QUOTE_NO AS QUOT_NO, JOB_NO FROM job_quot_no ORDER BY QUOTE_NO DESC LIMIT 1000`
          : `SELECT QUOTE_NO AS QUOT_NO, JOB_NO FROM job_quot_no WHERE JOB_NO = ? ORDER BY QUOTE_NO DESC`,
        all ? [] : [jobNo]
      );
      res.json(rows);
    } catch (err) {
      console.error('pf-quotlst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // Panels for a job — ⚠ confirm the panel source (the PANELS LOV in your
  // metadata pointed at api/jobpanels; adapt this query to that table).
  router.get('/pf-panellst/:jobNo', async (req, res) => {
    const { jobNo } = req.params;
    try {
      const [rows] = await db.query(
        `SELECT SR_NO AS PANEL_NO, PANEL_REF AS PANEL_NAME FROM job_panels WHERE JOB_NO = ? ORDER BY PANEL_NO`,
        [jobNo]
      );
      res.json(rows);
    } catch (err) {
      console.error('pf-panellst error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // Shared with DrawingRegister — job → quotation + customer name.
  router.get('/getJobInfo/:jobNo', async (req, res) => {
    const { jobNo } = req.params;
    const out = { JOB_NO: jobNo, QUOTE_NO: null, CLIENT_NAME: null };
    try {
      const [q] = await db.query(
        `SELECT MAX(QUOTE_NO) AS QUOTE_NO FROM job_quot_no WHERE JOB_NO = ?`, [jobNo]);
      out.QUOTE_NO = (q[0] && q[0].QUOTE_NO) || null;
    } catch (err) { console.error('getJobInfo (quote):', err.message); }
    try {
      const [c] = await db.query(
        `SELECT c.CUST_NAME AS CLIENT_NAME FROM job_card j
           JOIN cus_mst c ON c.CUST_CODE = j.CUST_CODE
          WHERE j.JOB_NO = ? LIMIT 1`, [jobNo]);
      out.CLIENT_NAME = (c[0] && c[0].CLIENT_NAME) || null;
    } catch (err) { console.error('getJobInfo (cust):', err.message); }
    res.json(out);
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  GET one invoice (header + items) for EDIT
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/getPfInvoice/:invNo', async (req, res) => {
    const { invNo } = req.params;
    try {
      const [h] = await db.query(
        `SELECT n.*, DATE_FORMAT(n.INV_DATE,'%Y-%m-%d') AS INV_DATE,
                c.CUST_NAME AS CUST_NAME,
                cu.CUR_NAME AS CURR_NAME, cu.DHS_CONV_RATE AS CONV_RATE
           FROM pfinv_net n
           LEFT JOIN cus_mst  c  ON c.CUST_CODE  = n.CUST_CODE
           LEFT JOIN nation_mst cu ON cu.CUR_CODE = n.CURR_ENCY
          WHERE n.INV_NO = ?`,
        [invNo]
      );
      if (!h.length) return res.status(404).json({ message: 'Invoice not found' });

      const [items] = await db.query(
        `SELECT SR_NO, PANEL_NO, ITEM_CODE, ITEM_NAME, QTY, UNIT, RATE, VAT_PERC, DISCOUNT
           FROM pfinv_items
          WHERE INV_NO = ?
          ORDER BY CAST(SR_NO AS UNSIGNED)`,
        [invNo]
      );
      res.json({ header: h[0], items });
    } catch (err) {
      console.error('getPfInvoice error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Print payload — everything the PDF needs in one round trip.
  //  Line-level money is computed HERE, not in the template, so the printed
  //  figures come from the same arithmetic the totals use.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/pf-invprint/:invNo', async (req, res) => {
    const { invNo } = req.params;
    try {
      const [hr] = await db.query(
        `SELECT n.*,
                DATE_FORMAT(n.INV_DATE,'%Y-%m-%d') AS INV_DATE,
                c.CUST_NAME, c.CUST_ADR1, c.CUST_ADR2, c.CUST_ADR3, c.CUST_ADR4,
                c.CUS_TEL1, c.CUS_FAX1,
                c.VAT_REG_NO AS CUST_VAT_NO,
                cu.CUR_CODE  AS CURR_CODE,
                b.BANK_DETAILS
           FROM pfinv_net n
           LEFT JOIN cus_mst        c  ON c.CUST_CODE  = n.CUST_CODE
           LEFT JOIN nation_mst     cu ON cu.CUR_CODE  = n.CURR_ENCY
           LEFT JOIN sales_bank_dtl b  ON b.BANK_CODE  = n.BANK_CODE
          WHERE n.INV_NO = ?`,
        [invNo]
      );
      if (!hr.length) return res.status(404).json({ message: 'Invoice not found' });
      const header = hr[0];

      const [rows] = await db.query(
        `SELECT SR_NO, PANEL_NO, ITEM_CODE, ITEM_NAME, QTY, UNIT, RATE, VAT_PERC, DISCOUNT
           FROM pfinv_items
          WHERE INV_NO = ?
          ORDER BY CAST(SR_NO AS UNSIGNED)`,
        [invNo]
      );

      // Letterhead comes from the company master, not from constants in the
      // template — one row, so a change of address or phone number reaches
      // every printed document without a redeploy.
      const [cmp] = await db.query(
        `SELECT CMP_CODE, NAME, PLACE, ADDRESS1, ADDRESS2, PHONE, FAX, EMAIL, WEB_SITE
           FROM company ORDER BY CMP_CODE LIMIT 1`
      );

      const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
      const items = rows.map((it) => {
        const amount = r2((Number(it.QTY) || 0) * (Number(it.RATE) || 0));
        const disc   = r2(it.DISCOUNT);
        const net    = r2(amount - disc);
        const vatAmt = r2(net * ((Number(it.VAT_PERC) || 0) / 100));
        return {
          ...it,
          AMOUNT: amount,
          DISCOUNT: disc || null,
          DISC_PERC: amount ? r2((disc / amount) * 100) || null : null,
          NET_AMOUNT: net,
          VAT_AMOUNT: vatAmt,
          TOTAL_AMOUNT: r2(net + vatAmt),
        };
      });

      // Header-level totals win when present — they are what was saved and what
      // the customer was quoted; the line sums are only a fallback for older
      // rows saved before the totals columns were populated.
      const lineNet = r2(items.reduce((a, i) => a + i.NET_AMOUNT, 0));
      const lineVat = r2(items.reduce((a, i) => a + i.VAT_AMOUNT, 0));
      header.AMOUNT     = header.AMOUNT     != null ? r2(header.AMOUNT)     : lineNet;
      header.VAT_AMOUNT = header.VAT_AMOUNT != null ? r2(header.VAT_AMOUNT) : lineVat;
      header.NET_AMOUNT = r2(header.AMOUNT + header.VAT_AMOUNT);

      res.json({
        header,
        items,
        company: buildCompany(cmp[0] || {}),
      });
    } catch (err) {
      console.error('pf-invprint error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  POST create invoice (header + items) in one transaction
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/savePfInvoice', async (req, res) => {
    const { header = {}, items = [] } = req.body;
    if (!header.CUST_CODE) return res.status(400).json({ message: 'Customer Code is required' });
    // The invoice number is derived from the date, so a missing date is fatal
    // here rather than something to default away.
    if (!header.INV_DATE) return res.status(400).json({ message: 'Invoice Date is required' });

    try {
      const out = await withTxn(async (conn) => {
        const invDate = header.INV_DATE || null;

        // Cut the number HERE, inside the transaction, from the invoice date —
        // never from header.INV_NO, which at best holds a stale preview the
        // browser fetched minutes ago. nextInvNoAtomic takes a row lock on
        // pfinv_sequence that is held until COMMIT, so two users saving at the
        // same instant queue up instead of both landing on the same number.
        const invNo = await nextInvNoAtomic(conn, invDate);

        await conn.query(
          `INSERT INTO pfinv_net
             (INV_NO, INV_DATE, CUST_CODE, AMOUNT, NARRATION, DISCOUNT, ROUND_OFF,
              ATTN, CURR_ENCY, CANCELLED, FREIGHT_TERMS, JOB_NO, PAYMENT_TERMS,
              LPO_NO, QUOT_NO, VAT_PERC, VAT_AMOUNT, BANK_CODE, CONTRACT_AMT_PERCENT)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            invNo, invDate, header.CUST_CODE, num(header.AMOUNT), header.NARRATION || null,
            num(header.DISCOUNT), num(header.ROUND_OFF), header.ATTN || null,
            header.CURR_ENCY || null, 'N', header.FREIGHT_TERMS || null, header.JOB_NO || null,
            header.PAYMENT_TERMS || null, header.LPO_NO || null, header.QUOT_NO || null,
            num(header.VAT_PERC), num(header.VAT_AMOUNT), header.BANK_CODE || null,
            num(header.CONTRACT_AMT_PERCENT),
          ]
        );

        await insertItems(conn, invNo, invDate, header.CUST_CODE, items);
        return { INV_NO: invNo };
      });

      res.json({ message: 'Saved', ...out });
    } catch (err) {
      console.error('savePfInvoice error:', err);
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  PUT update invoice — header fields + full replace of the lines
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/updatePfInvoice/:invNo', async (req, res) => {
    const { invNo } = req.params;
    const { header = {}, items = [] } = req.body;

    try {
      await withTxn(async (conn) => {
        const invDate = header.INV_DATE || null;

        const [r] = await conn.query(
          `UPDATE pfinv_net SET
             INV_DATE=?, CUST_CODE=?, AMOUNT=?, NARRATION=?, DISCOUNT=?, ROUND_OFF=?,
             ATTN=?, CURR_ENCY=?, FREIGHT_TERMS=?, JOB_NO=?, PAYMENT_TERMS=?,
             LPO_NO=?, QUOT_NO=?, VAT_PERC=?, VAT_AMOUNT=?, BANK_CODE=?, CONTRACT_AMT_PERCENT=?
           WHERE INV_NO=?`,
          [
            invDate, header.CUST_CODE, num(header.AMOUNT), header.NARRATION || null,
            num(header.DISCOUNT), num(header.ROUND_OFF), header.ATTN || null,
            header.CURR_ENCY || null, header.FREIGHT_TERMS || null, header.JOB_NO || null,
            header.PAYMENT_TERMS || null, header.LPO_NO || null, header.QUOT_NO || null,
            num(header.VAT_PERC), num(header.VAT_AMOUNT), header.BANK_CODE || null,
            num(header.CONTRACT_AMT_PERCENT), invNo,
          ]
        );
        if (r.affectedRows === 0) throw new Error('Invoice not found');

        // Replace lines wholesale — simplest correct behaviour for a grid edit.
        await conn.query(`DELETE FROM pfinv_items WHERE INV_NO = ?`, [invNo]);
        await insertItems(conn, invNo, invDate, header.CUST_CODE, items);
      });

      res.json({ message: 'Updated', INV_NO: invNo });
    } catch (err) {
      console.error('updatePfInvoice error:', err);
      const code = /not found/.test(err.message) ? 404 : 500;
      res.status(code).json({ message: err.message || 'Server error' });
    }
  });

  // ── Shared line-insert helper. Re-sequences SR_NO as 0001, 0002, … ──
  async function insertItems(conn, invNo, invDate, custCode, items) {
    let sr = 0;
    for (const it of items) {
      sr += 1;
      await conn.query(
        `INSERT INTO pfinv_items
           (INV_NO, INV_DATE, CUST_CODE, SR_NO, PANEL_NO, LOC_CODE, ITEM_CODE,
            QTY, UNIT, RATE, ITEM_NAME, VAT_PERC, DISCOUNT)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          invNo, invDate, custCode, String(sr).padStart(4, '0'), it.PANEL_NO || null,
          it.LOC_CODE || '01', it.ITEM_CODE || null, num(it.QTY), it.UNIT || null,
          num(it.RATE), it.ITEM_NAME || null, num(it.VAT_PERC), num(it.DISCOUNT),
        ]
      );
    }
  }

  // Maps the `company` row onto the four letterhead lines of the Oracle report.
  // PHONE already carries its own "Tel:" prefix in the data, so it is printed
  // verbatim; EMAIL and WEB_SITE are bare values and get their labels here.
  function buildCompany(c) {
    return {
      NAME: c.NAME || '',
      ADDRESS: [c.ADDRESS1, c.PLACE].filter(Boolean).join(', '),
      ADDRESS2: c.ADDRESS2 || '',
      TEL: c.PHONE || '',
      FAX: c.FAX ? `Fax:${c.FAX}` : '',
      EMAIL: c.EMAIL ? `E-mail:${c.EMAIL}` : '',
      WEB: c.WEB_SITE ? `Website: ${c.WEB_SITE}` : '',
      // ⚠ The `company` table has no VAT column, so the trade licence VAT
      //   number stays here. Add one to `company` and read it if you would
      //   rather it were data too.
      VAT_REG_NO: '100590144000003',
      LOGO: '/HayatLogo.jpg',
    };
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  // ── Mount shim: expose under both / and /api ──
  const mount = express.Router();
  mount.use('/api', router);
  mount.use('/', router);
  return mount;
};
