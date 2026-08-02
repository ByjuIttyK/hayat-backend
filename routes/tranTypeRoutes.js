// ---------------------------------------------------------------------------
// tranTypeRoutes.js
//
// Backend for TranTypeEnt.tsx (called from infoGrid.tsx with ADD/EDIT/DELETE).
// tran_type has TRAN_TYPE as its natural primary key (varchar(2), no
// surrogate ID), so all lookups/updates/deletes key off it directly.
//
// Endpoints:
//   GET    /api/tran-types              -> list all (for infoGrid's grid)
//   GET    /api/tran-types/:tranType    -> single row (EDIT/DELETE prefill)
//   POST   /api/tran-types              -> create (ADD)
//   PUT    /api/tran-types/:tranType    -> update (EDIT) — TRAN_TYPE itself
//                                           is not renameable via this route
//   DELETE /api/tran-types/:tranType    -> delete (DELETE)
//
// Only TRAN_TYPE, TYPE_DES, TYPE_ABBR, CLOSED_PERIOD, NL_ENABLED are exposed
// on the entry screen. USER_NAME is stamped server-side from the logged-in
// user; DOC_IMAGE_LOC / ENTRY_FORM are left untouched by this screen.
// ---------------------------------------------------------------------------

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  // Normalise an empty-string date input to NULL (MySQL rejects '' as a date).
  const toNullableDate = (v) => (v === "" || v === undefined ? null : v);

  // TODO: replace with however the app already resolves the logged-in
  // username server-side (e.g. from the JWT payload via authMiddleware),
  // rather than trusting a client-supplied value.
  const getUsername = (req) => req.user?.username || req.body?.username || null;

  // -------------------------------------------------------------------------
  // GET /api/tran-types
  // -------------------------------------------------------------------------
  router.get("/tran-types", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT TRAN_TYPE, TYPE_DES, TYPE_ABBR, CLOSED_PERIOD, NL_ENABLED
         FROM tran_type
         ORDER BY TRAN_TYPE`
      );
      res.json(rows);
    } catch (err) {
      console.error("[tran-types] list failed:", err);
      res.status(500).json({ message: "Failed to fetch transaction types" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/tran-types/:tranType
  // -------------------------------------------------------------------------
  router.get("/tran-types/:tranType", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT TRAN_TYPE, TYPE_DES, TYPE_ABBR, CLOSED_PERIOD, NL_ENABLED
         FROM tran_type WHERE TRAN_TYPE = ?`,
        [req.params.tranType]
      );
      if (rows.length === 0) {
        return res.status(404).json({ message: "Transaction type not found" });
      }
      res.json(rows[0]);
    } catch (err) {
      console.error("[tran-types/:tranType] fetch failed:", err);
      res.status(500).json({ message: "Failed to fetch transaction type" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/tran-types  (ADD)
  // -------------------------------------------------------------------------
  router.post("/tran-types", async (req, res) => {
    const { TRAN_TYPE, TYPE_DES, TYPE_ABBR, CLOSED_PERIOD, NL_ENABLED } = req.body || {};
    if (!TRAN_TYPE) {
      return res.status(400).json({ message: "TRAN_TYPE is required" });
    }
    try {
      const [existing] = await db.query(
        `SELECT TRAN_TYPE FROM tran_type WHERE TRAN_TYPE = ?`,
        [TRAN_TYPE]
      );
      if (existing.length > 0) {
        return res.status(409).json({ message: `Transaction type "${TRAN_TYPE}" already exists` });
      }

      await db.query(
        `INSERT INTO tran_type
           (TRAN_TYPE, TYPE_DES, TYPE_ABBR, CLOSED_PERIOD, NL_ENABLED, USER_NAME)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          TRAN_TYPE,
          TYPE_DES || null,
          TYPE_ABBR || null,
          toNullableDate(CLOSED_PERIOD),
          NL_ENABLED || "N",
          getUsername(req),
        ]
      );
      res.status(201).json({ message: "Transaction type created", TRAN_TYPE });
    } catch (err) {
      console.error("[tran-types] create failed:", err);
      res.status(500).json({ message: "Failed to create transaction type" });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/tran-types/:tranType  (EDIT)
  // TRAN_TYPE is the primary key and is not changed by this route — the URL
  // param is the source of truth; any TRAN_TYPE in the body is ignored.
  // -------------------------------------------------------------------------
  router.put("/tran-types/:tranType", async (req, res) => {
    const { tranType } = req.params;
    const { TYPE_DES, TYPE_ABBR, CLOSED_PERIOD, NL_ENABLED } = req.body || {};
    try {
      const [result] = await db.query(
        `UPDATE tran_type
           SET TYPE_DES = ?, TYPE_ABBR = ?, CLOSED_PERIOD = ?, NL_ENABLED = ?, USER_NAME = ?
         WHERE TRAN_TYPE = ?`,
        [
          TYPE_DES || null,
          TYPE_ABBR || null,
          toNullableDate(CLOSED_PERIOD),
          NL_ENABLED || "N",
          getUsername(req),
          tranType,
        ]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Transaction type not found" });
      }
      res.json({ message: "Transaction type updated", TRAN_TYPE: tranType });
    } catch (err) {
      console.error("[tran-types/:tranType] update failed:", err);
      res.status(500).json({ message: "Failed to update transaction type" });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/tran-types/:tranType  (DELETE)
  //
  // NOTE: tran_type is referenced (informally, by value — there's no FK
  // constraint on TRAN_TYPE across vouchers/tran_acc/pdc_rcd/pdc_isu/etc.)
  // from a large number of tables throughout the app. Deleting a code that's
  // still in use won't fail at the DB level; it'll just leave orphaned
  // TRAN_TYPE values sitting in transaction tables with no matching
  // description. Consider adding an explicit "is this code referenced
  // anywhere" check here before allowing delete, similar in spirit to
  // itemTransactionCheckRoutes.js for item_mst.
  // -------------------------------------------------------------------------
  router.delete("/tran-types/:tranType", async (req, res) => {
    try {
      const [result] = await db.query(
        `DELETE FROM tran_type WHERE TRAN_TYPE = ?`,
        [req.params.tranType]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Transaction type not found" });
      }
      res.json({ message: "Transaction type deleted" });
    } catch (err) {
      console.error("[tran-types/:tranType] delete failed:", err);
      res.status(500).json({ message: "Failed to delete transaction type" });
    }
  });

  return router;
};
