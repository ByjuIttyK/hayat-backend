// LedgerDrillRoutes.js
// Drill-down data for AcLedger: cheque details (v_all_cheques) and
// invoice settlement details (adj_dtl) for a given voucher.
//
// Register in HayatDb.js:
//   const ledgerDrillRoutes = require('./LedgerDrillRoutes')(connection);
//   app.use(ledgerDrillRoutes);

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  // ---------------------------------------------------------------
  // GET /api/ledger-drill/cheques/:tranType/:vchrNo
  // All cheques attached to the voucher, from the v_all_cheques view
  // ---------------------------------------------------------------
  router.get('/api/ledger-drill/cheques/:tranType/:vchrNo', (req, res) => {
    const { tranType, vchrNo } = req.params;

    const sql = `
      SELECT c.TRAN_TYPE,
             c.VCHR_NO,
             DATE_FORMAT(c.VCHR_DATE, '%d/%m/%Y')   AS VCHR_DATE,
             c.CHQ_NO,
             DATE_FORMAT(c.CHQ_DATE, '%d/%m/%Y')    AS CHQ_DATE,
             c.CHQ_BANK,
             c.PDC_CODE,
             c.PARTY_CODE,
             al.AC_HEAD                             AS PARTY_NAME,
             c.AMOUNT,
             c.NARRATION,
             c.JV_NO_RLZ,
             DATE_FORMAT(c.JV_DATE_RLZ, '%d/%m/%Y') AS JV_DATE_RLZ,
             c.REALISED,
             c.PDCTYPE
        FROM v_all_cheques c
        LEFT JOIN ac_list al ON al.AC_CODE = c.PARTY_CODE
       WHERE c.TRAN_TYPE = ?
         AND c.VCHR_NO   = ?
       ORDER BY c.CHQ_DATE, c.CHQ_NO`;

    connection.query(sql, [tranType, vchrNo], (err, rows) => {
      if (err) {
        console.error('ledger-drill/cheques error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    });
  });

  // ---------------------------------------------------------------
  // GET /api/ledger-drill/settlements/:tranType/:vchrNo?acc=<ACC_CODE>
  // Settlement rows from adj_dtl where the voucher appears either as
  // the SOURCE document (e.g. a PV/RV settling invoices) or as the
  // SETTLED document (e.g. an invoice settled by a later payment).
  // Optional ?acc= restricts to a party account (Customer/Supplier view).
  // ---------------------------------------------------------------
  router.get('/api/ledger-drill/settlements/:tranType/:vchrNo', (req, res) => {
    const { tranType, vchrNo } = req.params;
    const acc = (req.query.acc || '').toString().trim();

    let sql = `
      SELECT a.SOURCE_DOC,
             a.SOURCE_TYPE,
             DATE_FORMAT(a.SOURCE_DATE, '%d/%m/%Y') AS SOURCE_DATE,
             a.ACC_CODE,
             al.AC_HEAD                             AS ACC_NAME,
             a.STLD_DOC,
             a.STLD_TYPE,
             a.STLD_AMT,
             a.STLD_DBCR,
             DATE_FORMAT(a.STLD_DATE, '%d/%m/%Y')   AS STLD_DATE,
             a.DIV_CODE,
             a.MAIN_SR_NO,
             a.REF_NO
        FROM adj_dtl a
        LEFT JOIN ac_list al ON al.AC_CODE = a.ACC_CODE
       WHERE ( (a.SOURCE_DOC = ? AND a.SOURCE_TYPE = ?)
            OR (a.STLD_DOC   = ? AND a.STLD_TYPE   = ?) )`;

    const params = [vchrNo, tranType, vchrNo, tranType];

    if (acc !== '') {
      sql += ` AND a.ACC_CODE = ?`;
      params.push(acc);
    }

    sql += ` ORDER BY a.MAIN_SR_NO, a.STLD_DATE`;

    connection.query(sql, params, (err, rows) => {
      if (err) {
        console.error('ledger-drill/settlements error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    });
  });

  return router;
};
