// QuotTermsCondRoutes.js
// Factory pattern, matching the rest of Telltron ERP's route files:
//   const quotTermsCondRoutes = require('./QuotTermsCondRoutes')(connection);
//   app.use('/api', quotTermsCondRoutes);
//
// Exposes: GET /api/qtTermsCondMst
//
// Returns all default Terms & Conditions rows from quot_terms_cond_mst,
// ordered by SR_NO. Used by QuotTermsCond.tsx to pre-populate a brand-new
// Quotation (pageMode === "ADD") with the company's standard terms, before
// the user has typed anything of their own.
//
// This is a READ from the *master* table (quot_terms_cond_mst) — separate
// from the existing /api/qtTermEntQt/:quotNo route, which reads the terms
// already SAVED against a specific, existing quotation (quot_terms_cond).

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  router.get('/qtTermsCondMst', (req, res) => {
    const sql = `
      SELECT SR_NO, TERMS_HDR, TERMS_DETAILS
      FROM quot_terms_cond_mst
      ORDER BY SR_NO ASC
    `;
    connection.query(sql, (err, rows) => {
      if (err) {
        console.error('GET /qtTermsCondMst error:', err);
        return res.status(500).json({ message: 'Error fetching default Terms & Conditions.', error: err.message });
      }
      res.json(rows);
    });
  });

  return router;
};
