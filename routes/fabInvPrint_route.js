// ============================================================
// File: routes/fabInvPrint.js  (add to HayatDb.js router)
// GET /api/fab-inv/print-data/:invNo
// Returns all data needed for PDF generation
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../db/connection');          // your existing mysql2 pool

router.get('/fab-inv/print-data/:invNo', async (req, res) => {
  const { invNo } = req.params;

  try {
    // 1. Company info
    const [[company]] = await db.promise().query(
      `SELECT NAME, ADDRESS1, ADDRESS2, PLACE, PHONE, FAX, EMAIL, WEB_SITE
       FROM COMPANY LIMIT 1`
    );

    // 2. Company VAT
    const [[vatMst]] = await db.promise().query(
      `SELECT VAT_REG_NO, VAT_PERC FROM VAT_MST LIMIT 1`
    );

    // 3. Invoice header
    const [[hdr]] = await db.promise().query(
      `SELECT * FROM FAB_INV_HDR WHERE INV_NO = ?`, [invNo]
    );
    if (!hdr) return res.status(404).json({ error: 'Invoice not found' });

    // 4. Customer  — CUS_ABBR2 holds customer TRN in legacy data
    //    but many records have 'ACTIVE' there. Pull the actual VAT_REG_NO
    //    column if present, fall back to CUS_ABBR2.
    const [[cust]] = await db.promise().query(
      `SELECT CUST_NAME, CUST_ADR1, CUST_ADR2, CUST_ADR3, CUST_ADR4,
              CUS_TEL1, CUS_FAX1,
              COALESCE(VAT_REG_NO, '') AS CUST_TRN
       FROM CUS_MST WHERE CUST_CODE = ?`, [hdr.CUST_CODE]
    );

    // 5. Line items
    const [items] = await db.promise().query(
      `SELECT SR_NO, INV_ITEM_DESC, INV_QTY, INV_UNIT,
              INV_RATE, VAT_PERC, DIS_COUNT
       FROM FAB_INV_DTL WHERE INV_NO = ? ORDER BY SR_NO`, [invNo]
    );

    // 6. Bank details
    let bank = null;
    if (hdr.BANK_CODE) {
      const [[bankRow]] = await db.promise().query(
        `SELECT BANK_CODE, BANK_DETAILS
         FROM SALES_BANK_DTL WHERE BANK_CODE = ?`, [hdr.BANK_CODE]
      );
      bank = bankRow || null;
    }

    res.json({ company, vatMst, hdr, cust, items, bank });

  } catch (err) {
    console.error('fab-inv print-data error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
