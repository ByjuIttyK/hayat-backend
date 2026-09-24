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

  router.post('/save-fabinv', async (req, res) => {
    try {
      console.log("save-Proj.Invoice ==>", req.body);
      const { fabInvNet, fabInvItems } = req.body;
      if (!fabInvNet || !fabInvItems || !Array.isArray(fabInvItems) || fabInvItems.length === 0) {
        return res.status(400).json({ message: "Invalid Project Invoice data format" });
      }

      // The invoice the lines hang off. Taken from the header, not from the
      // rows: a row's own INV_NO can be blank on lines added in ADD mode before
      // the number was allocated, and anchoring the DELETE on a blank invoice
      // number is not a mistake worth risking.
      const invNo = String(fabInvNet.InvNo ?? "").trim();
      if (!invNo) {
        return res.status(400).json({ message: "Invoice No is required" });
      }

      // Currency / rate. A foreign-currency invoice without a usable rate is
      // refused rather than posted to the GL as if the amounts were AED.
      const currCode = String(fabInvNet.CurrCode ?? AED).trim() || AED;
      const isFc     = currCode !== AED;
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
          { invNo });
      }

      console.log("FABINV_HDR ==>", fabInvNet);
      console.log("FABINV Items ==>", fabInvItems);
      connection.getConnection((err, conn) => {
        if (err) {
          console.error("Error getting connection:", err);
          return res.status(500).json({ message: "Error getting connection" });
        }

        conn.beginTransaction(async (err) => {
          if (err) {
            console.error("Transaction Error:", err);
            conn.release();
            return res.status(500).json({ message: "Transaction error", error: err });
          }

          try {
            // ✅ Step 1: Insert/Update fab_inv_hdr
            const netQuery = `INSERT INTO fab_inv_hdr (
            INV_NO, INV_DATE, CUST_CODE, JOB_NO,
            LPO_NO, LPO_DATE, DO_NO, DO_DATE,
            DISCOUNT, NET_AMT, CASH_CUST_NAME, INV_CANCELLED,
            PROJECT_DETAIL, PAYMENT_TERMS, LUMPSUM, QUOT_NO,
            FINAL_INV, CURR_CODE, CONVERT_RATE, VAT_PERC,
            VAT_AMOUNT, CR_DAYS, RCP_TYPE, BANK_CODE,
            COMMI_AMT, CONTRACT_AMT_PERCENT, INV_ACK, ACK_DATE,
            ACK_USER
        )
        VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?
        )
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
            ACK_USER = VALUES(ACK_USER);`;

            const hdrResult = await q(conn, netQuery, [
              fabInvNet.InvNo, fabInvNet.InvDate, fabInvNet.CustCode, fabInvNet.JobNo,
              fabInvNet.LpoNo, fabInvNet.LpoDate, fabInvNet.DoNo, fabInvNet.DoDate,
              fabInvNet.Discount, fabInvNet.NetAmt, fabInvNet.CashCustName, fabInvNet.InvCancelled,
              fabInvNet.ProjectDetail, fabInvNet.PaymentTerms, fabInvNet.Lumpsum, fabInvNet.QuotNo,
              fabInvNet.FinalInv, fabInvNet.CurrCode, fabInvNet.ConvertRate, fabInvNet.VatPerc,
              fabInvNet.VatAmount, fabInvNet.CrDays, fabInvNet.RcpType, fabInvNet.BankCode,
              fabInvNet.CommiAmt, fabInvNet.ContractAmtPercent, fabInvNet.InvAck, fabInvNet.AckDate,
              fabInvNet.AckUser
            ]);
            console.log("fab_inv_hdr Insert/Update:", hdrResult);

            // ✅ Step 2: Delete the lines the user removed from the grid
            //
            // Runs BEFORE the upsert, not after. Reversed, a line whose SR_NO was
            // reused within the same save (deleted row 003, new row keyed into
            // the same slot) would be inserted and then immediately deleted
            // again, because it is absent from the "keep" list under its old
            // identity. Pruning first leaves the upsert to write the final state.
            //
            // NOT IN with an array is expanded by the driver into
            // ('001','002','003'). The nested array is deliberate: the driver
            // flattens one level per ? placeholder, so [invNo, keepSrNos] gives
            // a scalar for the first and a list for the second.
            if (canPrune) {
              const delResult = await q(conn,
                "DELETE FROM fab_inv_dtl WHERE INV_NO = ? AND SR_NO NOT IN (?)",
                [invNo, keepSrNos]);
              console.log("fab_inv_dtl removed lines:", delResult.affectedRows);
            }

            // ✅ Step 3: Insert/Update fab_inv_dtl
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
                VAT_PERC      = VALUES(VAT_PERC);
              `;
            // PANEL_NO reads row.PANEL_NO. It used to read row.ITEM_CODE, which
            // the screen has never sent — so every INSERT wrote PANEL_NO NULL,
            // and COALESCE(VALUES(PANEL_NO), PANEL_NO) on the UPDATE side turned
            // that into "keep whatever is there", hiding it on saved rows.
            //
            // COALESCE is gone from the update list for the same reason: it made
            // clearing a field impossible. Blanking a description sent NULL, and
            // COALESCE quietly restored the old text.
            const values = fabInvItems.map(row => [
              row.INV_NO || invNo, row.SR_NO, row.PANEL_NO, row.INV_ITEM_DESC,
              row.INV_QTY, row.INV_UNIT, row.INV_RATE, row.DIS_COUNT, row.VAT_PERC
            ]);
            const dtlResult = await q(conn, itemsQuery, [values]);
            console.log("fab_inv_dtl Insert/Update:", dtlResult);

            // ✅ Step 4: Post GL Entries to tran_acc
            // tran_acc is kept in AED. For a foreign-currency invoice the amounts
            // are converted here, BEFORE postToTranAcc() (shared service —
            // left untouched), by multiplying with ConvertRate.
            //
            // Each figure is rounded to 2 decimals on its own, so the converted
            // Net could differ from Gross − Disc + VAT by 0.01, and
            // postToTranAcc() rejects any Dr/Cr gap. Net (the customer debit)
            // is therefore derived from the converted legs so the entry always
            // balances.
            const rate    = isFc ? convRate : 1;
            const toAed   = v => Math.round((Number(v) || 0) * rate * 100) / 100;
            const grossAed = toAed(fabInvNet.GrossAmt);
            const vatAed   = toAed(fabInvNet.VatAmt);
            const discAed  = toAed(fabInvNet.Discount);
            const netAed   = isFc
              ? Math.round((grossAed - discAed + vatAed) * 100) / 100
              : Number(fabInvNet.NetAmt) || 0;

            // Map netData fields to match acc_posting_setup field names
            const glPayload = {
              ModuleName: "FABINV",
              InvNo: fabInvNet.InvNo,
              Date: fabInvNet.InvDate,
              Narr2: `Job:${fabInvNet.JobNo || ''} ${fabInvNet.PaymentTerms || ""}`,
              Narr1: `Lpo: ${fabInvNet.LpoNo || ''}  Dt: ${fabInvNet.LpoDate || ''}`,
              CustCd: fabInvNet.CustCode,
              GrossAmt: grossAed,                  // Matches FIELD_NAME for FABINV rule
              VatAmt: vatAed,                      // Matches FIELD_NAME for VAT rule
              DiscAmt: discAed,                    // Matches FIELD_NAME for DISCOUNT rule
              NetAmt: netAed,                      // Matches FIELD_NAME for NET_PAYABLE rule
              JobNo: fabInvNet.JobNo || null,
              PanelNo: null,
              PartyName: fabInvNet.CustName || null,
              RevAc: fabInvNet.RevAc || null
            };
            await postToTranAcc(glPayload, conn);
            console.log('Sales Inv- glPayLoad=', glPayload,
              isFc ? `(converted from ${currCode} @ ${convRate})` : '');
            // G/L Ledger posting ends

            conn.commit((err) => {
              if (err) {
                console.error("Commit Error:", err);
                // The connection was leaked here on a failed commit — every
                // commit error permanently cost the pool one slot.
                return conn.rollback(() => {
                  conn.release();
                  res.status(500).json({ message: "Commit error", error: err });
                });
              }
              conn.release();
              res.json({ message: "Project Invoice saved successfully!" });
            });

          } catch (error) {
            console.error("Proj. Inv. Transaction Failed:", error);
            conn.rollback(() => {
              conn.release();
              res.status(500).json({ message: "Proj Inv. Transaction failed, rolled back", error });
            });
          }
        });
      });
    } catch (error) {
      console.log("Project Inv save - internal error :", error);
      res.status(500).json({ message: "Internal Server Error (Project Invoice)", error });
    }
  });

  return router;
};
