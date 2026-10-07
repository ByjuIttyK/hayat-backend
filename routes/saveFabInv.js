/**
 * Project (Fabrication) Invoice save
 * File: routes/saveFabInv.js
 * Route: POST /api/save-fabinv
 *
 * Saves fab_inv_hdr + fab_inv_dtl and posts the GL entries (tran_acc,
 * tran_type '06') in one transaction.
 *
 * Foreign-currency invoices (CurrCode <> '01'): Gross, VAT and Discount are
 * multiplied by ConvertRate before posting, so tran_acc is written in AED.
 * Net is derived from the converted legs so the entry balances.
 * postToTranAcc() (services/glPostingService.js) is used unchanged.
 *
 * Registration in HayatDb.js:
 *   const saveFabInv = require('./routes/saveFabInv');
 *   app.use('/api', saveFabInv(connection));
 */

const express = require('express');
const { postToTranAcc } = require('../services/glPostingService');

const AED = '01';

module.exports = function (connection) {
  const router = express.Router();

  // promisified query on a transaction connection
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (err, res) => (err ? reject(err) : resolve(res))));

  //- for next Inv No - help[ers
  const getConn = () => new Promise((ok, ko) =>
    connection.getConnection((e, c) => (e ? ko(e) : ok(c))));
  const begin = c => new Promise((ok, ko) => c.beginTransaction(e => (e ? ko(e) : ok())));
  const commit = c => new Promise((ok, ko) => c.commit(e => (e ? ko(e) : ok())));
  const rollback = c => new Promise(ok => c.rollback(() => ok()));

  router.post('/save-fabinv', async (req, res) => {
    try {
      console.log("save-Proj.Invoice ==>", req.body);
      const { fabInvNet, fabInvItems } = req.body;
      if (!fabInvNet || !fabInvItems || !Array.isArray(fabInvItems) || fabInvItems.length === 0) {
        return res.status(400).json({ message: "Invalid Project Invoice data format" });
      }

      // Missing mode = EDIT. An old browser still doing an ADD then fails the
      // existence check instead of overwriting anything.
      const mode = String(req.body.mode || '').toUpperCase() === 'ADD' ? 'ADD' : 'EDIT';
      const givenInvNo = String(fabInvNet.InvNo ?? '').trim();
      if (mode === 'EDIT' && !givenInvNo) {
        return res.status(400).json({ message: 'Invoice No is required' });
      }

      // Currency / rate. A foreign-currency invoice without a usable rate is
      // refused rather than posted to the GL as if the amounts were AED.
      const currCode = String(fabInvNet.CurrCode ?? AED).trim() || AED;
      const isFc = currCode !== AED;
      const convRate = Number(fabInvNet.ConvertRate);
      if (isFc && !(convRate > 0)) {
        return res.status(400).json({ message: `Conversion rate is required for currency ${currCode}` });
      }

      // SR_NO list to KEEP. Everything else on this invoice is deleted.
      //
      // Every row must carry one for the comparison to mean anything: if even a
      // single line arrived without an SR_NO, its counterpart in the table is
      // indistinguishable from a row the user deleted, and the DELETE would
      // remove a line that is still on screen. In that case the delete is
      // skipped and the save degrades to the old upsert-only behaviour — stale
      // rows survive, which is recoverable; wrongly deleted ones are not.
      const keepSrNos = fabInvItems.map(r =>
        r.SR_NO === null || r.SR_NO === undefined ? "" : String(r.SR_NO).trim());
      const canPrune = keepSrNos.every(s => s !== "");
      if (!canPrune) {
        console.warn("save-fabinv: a line arrived without SR_NO — skipping the prune of removed rows",
          { invNo: givenInvNo });
      }

      console.log("FABINV_HDR ==>", fabInvNet);
      console.log("FABINV Items ==>", fabInvItems);
      const saveOnce = async () => {
        const conn = await getConn();
        try {
          await begin(conn);           // fresh transaction = fresh snapshot for MAX

          let invNo = givenInvNo;
          if (mode === 'ADD') {
            const [r] = await q(conn,
              'SELECT COALESCE(MAX(CAST(INV_NO AS UNSIGNED)), 0) AS mx FROM fab_inv_hdr');
            //  invNo = String(Number(r.mx) + 1);   // match MaxVchrNo's format if it pads
            invNo = String(Number(r.mx) + 1).padStart(10, '0');
          } else {
            const ex = await q(conn,
              'SELECT INV_NO FROM fab_inv_hdr WHERE INV_NO = ? FOR UPDATE', [invNo]);
            if (!ex.length) {
              throw Object.assign(new Error(`Invoice ${invNo} not found`), { status: 404 });
            }
          }

          // ── Step 1: fab_inv_hdr ──
          // ADD = plain INSERT, so a number clash throws ER_DUP_ENTRY instead of
          // overwriting another user's invoice. EDIT keeps the upsert (row is
          // confirmed to exist and locked above).
          const insertPart = `INSERT INTO fab_inv_hdr (
              INV_NO, INV_DATE, CUST_CODE, JOB_NO,
              LPO_NO, LPO_DATE, DO_NO, DO_DATE,
              DISCOUNT, NET_AMT, CASH_CUST_NAME, INV_CANCELLED,
              PROJECT_DETAIL, PAYMENT_TERMS, LUMPSUM, QUOT_NO,
              FINAL_INV, CURR_CODE, CONVERT_RATE, VAT_PERC,
              VAT_AMOUNT, CR_DAYS, RCP_TYPE, BANK_CODE,
              COMMI_AMT, CONTRACT_AMT_PERCENT, INV_ACK, ACK_DATE,
              ACK_USER
            ) VALUES (
              ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,
              ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,  ?
            )`;
          const upsertPart = `
            ON DUPLICATE KEY UPDATE
              INV_DATE = VALUES(INV_DATE),
              CUST_CODE = VALUES(CUST_CODE),
              JOB_NO = VALUES(JOB_NO),
              LPO_NO = VALUES(LPO_NO),
              LPO_DATE = VALUES(LPO_DATE),
              DO_NO = VALUES(DO_NO),
              DO_DATE = VALUES(DO_DATE),
              DISCOUNT = VALUES(DISCOUNT),
              NET_AMT = VALUES(NET_AMT),
              CASH_CUST_NAME = VALUES(CASH_CUST_NAME),
              INV_CANCELLED = VALUES(INV_CANCELLED),
              PROJECT_DETAIL = VALUES(PROJECT_DETAIL),
              PAYMENT_TERMS = VALUES(PAYMENT_TERMS),
              LUMPSUM = VALUES(LUMPSUM),
              QUOT_NO = VALUES(QUOT_NO),
              FINAL_INV = VALUES(FINAL_INV),
              CURR_CODE = VALUES(CURR_CODE),
              CONVERT_RATE = VALUES(CONVERT_RATE),
              VAT_PERC = VALUES(VAT_PERC),
              VAT_AMOUNT = VALUES(VAT_AMOUNT),
              CR_DAYS = VALUES(CR_DAYS),
              RCP_TYPE = VALUES(RCP_TYPE),
              BANK_CODE = VALUES(BANK_CODE),
              COMMI_AMT = VALUES(COMMI_AMT),
              CONTRACT_AMT_PERCENT = VALUES(CONTRACT_AMT_PERCENT),
              INV_ACK = VALUES(INV_ACK),
              ACK_DATE = VALUES(ACK_DATE),
              ACK_USER = VALUES(ACK_USER)`;
          const netQuery = mode === 'ADD' ? insertPart : insertPart + upsertPart;

          const hdrResult = await q(conn, netQuery, [
            invNo, fabInvNet.InvDate, fabInvNet.CustCode, fabInvNet.JobNo,
            fabInvNet.LpoNo, fabInvNet.LpoDate, fabInvNet.DoNo, fabInvNet.DoDate,
            fabInvNet.Discount, fabInvNet.NetAmt, fabInvNet.CashCustName, fabInvNet.InvCancelled,
            fabInvNet.ProjectDetail, fabInvNet.PaymentTerms, fabInvNet.Lumpsum, fabInvNet.QuotNo,
            fabInvNet.FinalInv, fabInvNet.CurrCode, fabInvNet.ConvertRate, fabInvNet.VatPerc,
            fabInvNet.VatAmt, fabInvNet.CrDays, fabInvNet.RcpType, fabInvNet.BankCode,
            fabInvNet.CommiAmt, fabInvNet.ContractAmtPercent, fabInvNet.InvAck, fabInvNet.AckDate,
            fabInvNet.AckUser
          ]);
          console.log(`fab_inv_hdr ${mode}:`, invNo, hdrResult.affectedRows);

          // ── Step 2: delete lines removed from the grid (before the upsert) ──
          if (canPrune) {
            const delResult = await q(conn,
              'DELETE FROM fab_inv_dtl WHERE INV_NO = ? AND SR_NO NOT IN (?)',
              [invNo, keepSrNos]);
            console.log('fab_inv_dtl removed lines:', delResult.affectedRows);
          }

          // ── Step 3: fab_inv_dtl ──
          // Every line takes invNo — never row.INV_NO, which carries the
          // provisional number the screen showed before the save.
          const itemsQuery = `
            INSERT INTO fab_inv_dtl (INV_NO, SR_NO, PANEL_NO, INV_ITEM_DESC, INV_QTY, INV_UNIT, INV_RATE, DIS_COUNT, VAT_PERC)
            VALUES ?
            ON DUPLICATE KEY UPDATE
              PANEL_NO      = VALUES(PANEL_NO),
              INV_ITEM_DESC = VALUES(INV_ITEM_DESC),
              INV_QTY       = VALUES(INV_QTY),
              INV_UNIT      = VALUES(INV_UNIT),
              INV_RATE      = VALUES(INV_RATE),
              DIS_COUNT     = VALUES(DIS_COUNT),
              VAT_PERC      = VALUES(VAT_PERC)`;
          const values = fabInvItems.map(row => [
            invNo, row.SR_NO, row.PANEL_NO, row.INV_ITEM_DESC,
            row.INV_QTY, row.INV_UNIT, row.INV_RATE, row.DIS_COUNT, row.VAT_PERC
          ]);
          const dtlResult = await q(conn, itemsQuery, [values]);
          console.log('fab_inv_dtl Insert/Update:', dtlResult.affectedRows);

          // ── Step 4: GL posting (tran_acc in AED) ──
          const rate = isFc ? convRate : 1;
          const toAed = v => Math.round((Number(v) || 0) * rate * 100) / 100;
          const grossAed = toAed(fabInvNet.GrossAmt);
          const vatAed = toAed(fabInvNet.VatAmt);
          const discAed = toAed(fabInvNet.Discount);
          const netAed = isFc
            ? Math.round((grossAed - discAed + vatAed) * 100) / 100
            : Number(fabInvNet.NetAmt) || 0;

          const glPayload = {
            ModuleName: 'FABINV',
            InvNo: invNo,
            Date: fabInvNet.InvDate,
            Narr2: `Job:${fabInvNet.JobNo || ''} ${fabInvNet.PaymentTerms || ''}`,
            Narr1: `Lpo: ${fabInvNet.LpoNo || ''}  Dt: ${fabInvNet.LpoDate || ''}`,
            CustCd: fabInvNet.CustCode,
            GrossAmt: grossAed,
            VatAmt: vatAed,
            DiscAmt: discAed,
            NetAmt: netAed,
            JobNo: fabInvNet.JobNo || null,
            PanelNo: null,
            PartyName: fabInvNet.CustName || null,
            RevAc: fabInvNet.RevAc || null
          };
          await postToTranAcc(glPayload, conn);
          console.log('Proj Inv glPayload=', glPayload,
            isFc ? `(converted from ${currCode} @ ${convRate})` : '');

          await commit(conn);
          return invNo;
        } catch (e) {
          await rollback(conn);
          throw e;
        } finally {
          conn.release();              // always, on every path
        }
      };

      // ── Run it; on an invoice-number clash, retry with a new transaction ──
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const savedNo = await saveOnce();
          return res.json({ message: `Project Invoice ${savedNo} saved successfully!`, invNo: savedNo });
        } catch (e) {
          const numberClash = mode === 'ADD'
            && e.code === 'ER_DUP_ENTRY'
            && /fab_inv_hdr\.PRIMARY/.test(e.sqlMessage || '');
          if (numberClash && attempt < 5) {
            console.warn(`save-fabinv: invoice number clash, retrying (attempt ${attempt})`);
            continue;
          }
          console.error('Proj. Inv. save failed:', e);
          if (numberClash) {
            return res.status(409).json({
              message: 'Invoice number was taken by another user. Please click Save again.'
            });
          }
          return res.status(e.status || 500)
            .json({ message: `Project Invoice not saved: ${e.message || 'transaction rolled back'}` });
        }
      }
    } catch (error) {
      console.log("Project Inv save - internal error :", error);
      res.status(500).json({ message: "Internal Server Error (Project Invoice)", error });
    }
  });

  return router;
};