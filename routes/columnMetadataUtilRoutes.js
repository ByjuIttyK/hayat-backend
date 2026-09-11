// routes/columnMetadataUtilRoutes.js
// ---------------------------------------------------------------------------
// Column Metadata utility — maintains the column_metadata table
// Primary key: (module_name, column_id)
//
// Table names are lowercase on purpose: the VPS MySQL runs with
// lower_case_table_names=0 (case-sensitive).
//
//   GET  /api/colmeta-util/modules          distinct module names
//   GET  /api/colmeta-util/rows?module=X    rows ordered by module_name, column_id
//   POST /api/colmeta-util/save             { deletes, updates, inserts } — one transaction
//
// Register in HayatDb.js:
//   const columnMetadataUtilRoutes = require("./routes/columnMetadataUtilRoutes");
//   app.use("/api", columnMetadataUtilRoutes(connection));
// ---------------------------------------------------------------------------
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  // Promise wrapper over the callback pool (works if a promise pool is passed too)
  const db = typeof connection.promise === "function" ? connection.promise() : connection;

  class InputError extends Error {}

  // ── Input cleaning ────────────────────────────────────────────────────────
  const cleanKey = (k, where) => {
    const module_name = String(k?.module_name ?? "").trim();
    const column_id = Number(k?.column_id);
    if (!module_name || !Number.isInteger(column_id)) {
      throw new InputError(`${where}: module name and column ID are required.`);
    }
    return { module_name, column_id };
  };

  const cleanRecord = (r, where) => {
    const module_name = String(r?.module_name ?? "").trim();
    const column_id = Number(r?.column_id);
    const label = `${where} (${module_name || "no module"} / ${r?.column_id ?? "?"})`;

    if (!module_name) throw new InputError(`${label}: module name is required.`);
    if (module_name.length > 50) throw new InputError(`${label}: module name is longer than 50 characters.`);
    if (!Number.isInteger(column_id) || column_id < 1 || column_id > 2147483647) {
      throw new InputError(`${label}: column ID must be a whole number from 1.`);
    }

    const text = (v, max, name) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      if (!s) return null;
      if (s.length > max) throw new InputError(`${label}: ${name} is longer than ${max} characters.`);
      return s;
    };

    let flex = null;
    if (r.flex !== null && r.flex !== undefined && String(r.flex).trim() !== "") {
      flex = Math.round(Number(r.flex) * 100) / 100;
      if (!Number.isFinite(flex) || Math.abs(flex) >= 10000) {
        throw new InputError(`${label}: flex must be a number below 10000.`);
      }
    }

    let cell_style = null;
    if (r.cell_style !== null && r.cell_style !== undefined) {
      const s = typeof r.cell_style === "string" ? r.cell_style.trim() : JSON.stringify(r.cell_style);
      if (s) {
        try {
          JSON.parse(s);
        } catch (_) {
          throw new InputError(`${label}: cell style is not valid JSON.`);
        }
        cell_style = s;
      }
    }

    return {
      module_name,
      column_id,
      field: text(r.field, 50, "field"),
      header_name: text(r.header_name, 100, "header name"),
      sortable: Number(r.sortable) ? 1 : 0,
      editable: Number(r.editable) ? 1 : 0,
      flex,
      cell_style,
    };
  };

  // ── GET distinct modules ──────────────────────────────────────────────────
  router.get("/colmeta-util/modules", async (req, res) => {
    try {
      const [rows] = await db.query(
        "SELECT DISTINCT module_name FROM column_metadata ORDER BY module_name"
      );
      res.json(rows.map((r) => r.module_name));
    } catch (err) {
      console.error("colmeta-util/modules:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET rows (optionally for one module) ──────────────────────────────────
  router.get("/colmeta-util/rows", async (req, res) => {
    try {
      const moduleName = String(req.query.module ?? "").trim();
      const params = [];
      // CAST keeps cell_style as JSON text (mysql2 would otherwise parse it)
      let sql = `SELECT module_name, column_id, field, header_name, sortable, editable, flex,
                        CAST(cell_style AS CHAR) AS cell_style
                   FROM column_metadata`;
      if (moduleName) {
        sql += " WHERE module_name = ?";
        params.push(moduleName);
      }
      sql += " ORDER BY module_name, column_id";

      const [rows] = await db.query(sql, params);
      res.json(
        rows.map((r) => ({
          module_name: r.module_name,
          column_id: r.column_id,
          field: r.field,
          header_name: r.header_name,
          sortable: Number(r.sortable) ? 1 : 0,
          editable: Number(r.editable) ? 1 : 0,
          flex: r.flex === null ? null : Number(r.flex), // DECIMAL arrives as string
          cell_style: r.cell_style ?? "",
        }))
      );
    } catch (err) {
      console.error("colmeta-util/rows:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST save (delete + update + insert in one transaction) ───────────────
  router.post("/colmeta-util/save", async (req, res) => {
    let deletes, updates, inserts;
    try {
      const body = req.body || {};
      const lists = [body.deletes ?? [], body.updates ?? [], body.inserts ?? []];
      if (!lists.every(Array.isArray)) throw new InputError("deletes, updates and inserts must be arrays.");

      deletes = lists[0].map((k, i) => cleanKey(k, `Deleted row ${i + 1}`));
      updates = lists[1].map((u, i) => ({
        orig: cleanKey(u?.orig, `Changed row ${i + 1}`),
        data: cleanRecord(u?.data, `Changed row ${i + 1}`),
      }));
      inserts = lists[2].map((r, i) => cleanRecord(r, `New row ${i + 1}`));
    } catch (err) {
      if (err instanceof InputError) return res.status(400).json({ error: err.message });
      console.error("colmeta-util/save (input):", err);
      return res.status(500).json({ error: err.message });
    }

    const writes = [...updates.map((u) => u.data), ...inserts];

    // Duplicate keys inside the request (MySQL collation is case-insensitive)
    const seen = new Set();
    for (const r of writes) {
      const key = `${r.module_name.toUpperCase()}\u0000${r.column_id}`;
      if (seen.has(key)) {
        return res.status(400).json({
          error: `Column ID ${r.column_id} appears twice for module ${r.module_name}.`,
        });
      }
      seen.add(key);
    }

    if (!deletes.length && !writes.length) {
      return res.json({ success: true, inserted: 0, updated: 0, deleted: 0 });
    }

    let conn;
    let pooled = false;
    try {
      pooled = typeof db.getConnection === "function";
      conn = pooled ? await db.getConnection() : db;
      await conn.beginTransaction();

      // Remove deleted rows AND the old keys of changed rows first, so that
      // renumbering or swapping column IDs within a module never collides.
      const removeKeys = [...deletes, ...updates.map((u) => u.orig)];
      for (const k of removeKeys) {
        await conn.query(
          "DELETE FROM column_metadata WHERE module_name = ? AND column_id = ?",
          [k.module_name, k.column_id]
        );
      }

      if (writes.length) {
        await conn.query(
          `INSERT INTO column_metadata
             (module_name, column_id, field, header_name, sortable, editable, flex, cell_style)
           VALUES ?`,
          [
            writes.map((r) => [
              r.module_name, r.column_id, r.field, r.header_name,
              r.sortable, r.editable, r.flex, r.cell_style,
            ]),
          ]
        );
      }

      await conn.commit();
      res.json({
        success: true,
        inserted: inserts.length,
        updated: updates.length,
        deleted: deletes.length,
      });
    } catch (err) {
      if (conn) {
        try { await conn.rollback(); } catch (_) { /* ignore */ }
      }
      if (err && err.code === "ER_DUP_ENTRY") {
        const m = /Duplicate entry '(.+?)'/.exec(err.sqlMessage || err.message || "");
        return res.status(409).json({
          error: `Module and column ID already exist${m ? ` (${m[1]})` : ""}. Use a different column ID.`,
        });
      }
      console.error("colmeta-util/save:", err);
      res.status(500).json({ error: err.message || "Save failed." });
    } finally {
      if (conn && pooled) conn.release();
    }
  });

  return router;
};
