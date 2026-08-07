// LpoSaveRoutes.js
// Backend route for the LPO Entry screen (Lpoent.tsx).
// Factory pattern, matching the rest of Telltron ERP's route files:
//   const lpoSaveRoutes = require('./LpoSaveRoutes')(connection);
//   app.use('/api', lpoSaveRoutes);
//
// Exposes: POST /api/save-lpo
// Body shape (matches what Lpoent.tsx already sends):
//   {
//     lpoNet: {
//       LpoNo, LpoDt ("yyyy-MM-dd"), SupCd, Narration, Attn,
//       Amount, Discount, VatPerc, VatAmount, SmanCd
//     },
//     lpoItems: [
//       { SR_NO, MAIN_SR_NO, ITEM_CODE, ITEM_NAME, UNIT, CAT_CODE, QTY, RATE }, ...
//     ]
//   }
//
// Behavior:
//   - UPSERTs the lpo_net header — updates if LPO_NO already exists, inserts if not.
//     This lets ADD and EDIT modes both call this single endpoint safely.
//   - Replaces all lpo_items rows for that LPO_NO (delete-then-reinsert), matching
//     the established pattern already used elsewhere in this codebase (Quotation
//     module) rather than trying to diff/patch individual item rows.
//   - SR_NO is re-sequenced 1..N server-side from the filtered item list, rather
//     than trusting whatever the client sent — the grid's client-side SR_NO values
//     can have gaps (blank filler rows, deleted rows) and lpo_items.SR_NO is a
//     NOT NULL smallint primary/composite key, so this must always be clean.
//   - LPO_NO / LPO_DATE / SUP_CODE are copied onto every item row server-side from
//     the header payload, so the frontend doesn't need to duplicate them per line.
//   - Runs as a single transaction: if anything fails, the whole save rolls back —
//     you never end up with a saved header and no items, or vice versa.

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  router.post('/save-lpo', (req, res) => {
    const { lpoNet, lpoItems } = req.body || {};

    // ---- Basic validation before touching the database ----
    if (!lpoNet || !lpoNet.LpoNo || !String(lpoNet.LpoNo).trim()) {
      return res.status(400).json({ message: 'LPO No is required.' });
    }
    if (!Array.isArray(lpoItems) || lpoItems.length === 0) {
      return res.status(400).json({ message: 'At least one item line is required.' });
    }

    const lpoNo = String(lpoNet.LpoNo).trim();

    // Filter out any stray blank rows that slipped through (defensive — the
    // frontend already filters on ITEM_NAME, but never trust the client alone)
    const cleanItems = lpoItems.filter(
      (row) => row && row.ITEM_CODE && String(row.ITEM_CODE).trim()
    );
    if (cleanItems.length === 0) {
      return res.status(400).json({ message: 'No valid item rows to save — each row needs an Item Code.' });
    }

    connection.beginTransaction((txErr) => {
      if (txErr) {
        console.error('save-lpo: failed to start transaction:', txErr);
        return res.status(500).json({ message: 'Could not start database transaction.' });
      }

      // ---- Step 1: does this LPO_NO already exist? (decides insert vs update) ----
      connection.query(
        'SELECT LPO_NO FROM lpo_net WHERE LPO_NO = ? LIMIT 1',
        [lpoNo],
        (err, existingRows) => {
          if (err) {
            return connection.rollback(() =>
              res.status(500).json({ message: 'Error checking existing LPO.', error: err.message })
            );
          }

          const headerParams = [
            lpoNet.LpoDt || null,        // LPO_DATE — expects "yyyy-MM-dd"
            lpoNet.SupCd || null,        // SUP_CODE
            lpoNet.Amount || 0,          // AMOUNT (Net Amount: Taxable + VAT)
            lpoNet.Discount || 0,        // DISCOUNT
            lpoNet.Narration || null,    // NARRATION
            lpoNet.Attn || null,         // ATTN
            lpoNet.SmanCd || null,       // SMAN_CODE
            lpoNet.VatPerc || 0,         // VAT_PERC
            lpoNet.VatAmount || 0,       // VAT_AMOUNT
          ];

          const runHeaderWrite = (headerCallback) => {
            if (existingRows.length > 0) {
              // ---- UPDATE existing header ----
              const sql = `
                UPDATE lpo_net SET
                  LPO_DATE = ?, SUP_CODE = ?, AMOUNT = ?, DISCOUNT = ?,
                  NARRATION = ?, ATTN = ?, SMAN_CODE = ?, VAT_PERC = ?, VAT_AMOUNT = ?
                WHERE LPO_NO = ?
              `;
              connection.query(sql, [...headerParams, lpoNo], headerCallback);
            } else {
              // ---- INSERT new header ----
              const sql = `
                INSERT INTO lpo_net
                  (LPO_NO, LPO_DATE, SUP_CODE, AMOUNT, DISCOUNT,
                   NARRATION, ATTN, SMAN_CODE, VAT_PERC, VAT_AMOUNT)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `;
              connection.query(sql, [lpoNo, ...headerParams], headerCallback);
            }
          };

          runHeaderWrite((headerErr) => {
            if (headerErr) {
              return connection.rollback(() =>
                res.status(500).json({ message: 'Error saving LPO header.', error: headerErr.message })
              );
            }

            // ---- Step 2: clear existing item lines for this LPO ----
            connection.query(
              'DELETE FROM lpo_items WHERE LPO_NO = ?',
              [lpoNo],
              (delErr) => {
                if (delErr) {
                  return connection.rollback(() =>
                    res.status(500).json({ message: 'Error clearing old item lines.', error: delErr.message })
                  );
                }

                // ---- Step 3: re-insert item lines, SR_NO re-sequenced 1..N ----
                const itemRows = cleanItems.map((row, idx) => [
                  lpoNo,                              // LPO_NO
                  lpoNet.LpoDt || null,                // LPO_DATE (copied from header)
                  lpoNet.SupCd || null,                // SUP_CODE (copied from header)
                  idx + 1,                             // SR_NO — clean sequential smallint
                  row.LOC_CODE || null,                // LOC_CODE
                  row.ITEM_CODE || null,                // ITEM_CODE
                  Number(row.QTY) || 0,                // QTY
                  row.UNIT || null,                    // UNIT
                  Number(row.RATE) || 0,                // RATE
                  row.ITEM_NAME || null,                // ITEM_NAME
                  row.CAT_CODE || null,                 // CAT_CODE
                  row.JOB_NO || null,                   // JOB_NO
                  row.MAIN_SR_NO || 0,                  // MAIN_SR_NO
                ]);

                const insertItemsSql = `
                  INSERT INTO lpo_items
                    (LPO_NO, LPO_DATE, SUP_CODE, SR_NO, LOC_CODE, ITEM_CODE,
                     QTY, UNIT, RATE, ITEM_NAME, CAT_CODE, JOB_NO, MAIN_SR_NO)
                  VALUES ?
                `;

                connection.query(insertItemsSql, [itemRows], (itemsErr) => {
                  if (itemsErr) {
                    return connection.rollback(() =>
                      res.status(500).json({ message: 'Error saving item lines.', error: itemsErr.message })
                    );
                  }

                  // ---- All good — commit ----
                  connection.commit((commitErr) => {
                    if (commitErr) {
                      return connection.rollback(() =>
                        res.status(500).json({ message: 'Error committing save.', error: commitErr.message })
                      );
                    }

                    return res.json({
                      message: `LPO ${lpoNo} saved successfully.`,
                      LpoNo: lpoNo,
                      itemCount: itemRows.length,
                    });
                  });
                });
              }
            );
          });
        }
      );
    });
  });

  return router;
};
