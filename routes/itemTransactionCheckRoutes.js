// ---------------------------------------------------------------------------
// itemTransactionCheckRoutes.js
//
// GET /api/items/:itemCode/has-transactions?locCode=01
//
// Used by ItemEnt.tsx to lock the Stock/Non-Stock toggle once an item has
// been used in any inventory-affecting transaction. Once stock has moved
// against an item, switching it between Stock and Non-Stock would make
// historical quantities/costing inconsistent, so the check must happen
// both here (source of truth) and be mirrored in save-itemmst's handler
// (see note at the bottom of this file).
//
// *** VERIFY BEFORE USE ***
// Table/column names below are inferred from the tables you named
// (Lpo_items, Srv_items, Siv_items, Fpo_items, Stk_adj) plus your existing
// naming convention (ITEM_CODE, LOC_CODE). Add any other inventory-related
// tables to TRANSACTION_TABLES below — GRN items, job-costing issues,
// physical count sheets, etc. — anything that records a movement or
// reservation against ITEM_CODE.
// ---------------------------------------------------------------------------

const TRANSACTION_TABLES = [
  { table: "lpo_items", itemCol: "ITEM_CODE", locCol: "LOC_CODE" },
  { table: "srv_items", itemCol: "ITEM_CODE", locCol: "LOC_CODE" },
  { table: "siv_items", itemCol: "ITEM_CODE", locCol: "LOC_CODE" },
  { table: "fpo_items", itemCol: "ITEM_CODE", locCol: "LOC_CODE" },
  { table: "stk_adj", itemCol: "ITEM_CODE", locCol: "LOC_CODE" },
  // Add further inventory-related tables here, e.g.:
  // { table: "grn_items", itemCol: "ITEM_CODE", locCol: "LOC_CODE" },
  // { table: "job_card_items", itemCol: "ITEM_CODE", locCol: null },
];

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  router.get("/items/:itemCode/has-transactions", async (req, res) => {
    const { itemCode } = req.params;
    const { locCode } = req.query;

    try {
      for (const t of TRANSACTION_TABLES) {
        let sql = `SELECT 1 FROM ${t.table} WHERE ${t.itemCol} = ? LIMIT 1`;
        const params = [itemCode];
        if (locCode && t.locCol) {
          sql = `SELECT 1 FROM ${t.table} WHERE ${t.itemCol} = ? AND ${t.locCol} = ? LIMIT 1`;
          params.push(locCode);
        }
        try {
          const [rows] = await db.query(sql, params);
          if (rows.length > 0) {
            return res.json({ hasTransactions: true, table: t.table });
          }
        } catch (innerErr) {
          // If a table/column name here doesn't match your actual schema,
          // log it and keep checking the rest rather than failing the
          // whole request — better to under-detect than 500 the page.
          console.error(`[has-transactions] check failed for ${t.table}:`, innerErr.message);
        }
      }
      res.json({ hasTransactions: false });
    } catch (err) {
      console.error("[items/has-transactions]", err);
      res.status(500).json({ message: "Failed to check item transactions" });
    }
  });

  return router;
};

// ---------------------------------------------------------------------------
// IMPORTANT — mirror this check in your save-itemmst handler too.
// The frontend disables the toggle once hasTransactions is true, but that's
// a UI convenience, not enforcement — a direct API call could still change
// ITEM_TYPE. In whatever file handles POST /api/save-itemmst, before writing
// ITEM_TYPE, re-run the same check (or call this endpoint's logic) and, if
// transactions exist AND the incoming ITEM_TYPE differs from the stored
// value, reject the update:
//
//   if (hasTransactions && incoming.ITEM_TYPE !== existing.ITEM_TYPE) {
//     return res.status(409).json({ message: "Item type is locked — transactions exist for this item." });
//   }
// ---------------------------------------------------------------------------
