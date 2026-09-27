/**
 * Access Rights Routes
 * File: E:\hayatApi\routes\accessRightsRoutes.js
 *
 * Rights are given per MENU GROUP (module_code = Mainmenu.tsx `key`).
 * Tables: app_modules, roles, role_permissions, user_permission_overrides
 * (created by sql/access_rights_step1.sql).
 *
 * Any logged-in user
 *   GET  /api/my-permissions                      → own effective rights (menu uses this)
 *
 * Read (admin, or anyone with View on the 'utilities' group)
 *   GET  /api/access/modules                      → menu groups
 *   GET  /api/access/roles                        → roles + number of users in each
 *   GET  /api/access/roles/:role/permissions      → rights grid for one role (all groups)
 *   GET  /api/access/users                        → users + their role
 *   GET  /api/access/users/:username/overrides    → role value + user exception, per group
 *
 * Write (admin only)
 *   POST   /api/access/roles                      → { role_name, remarks, copy_from? }
 *   PUT    /api/access/roles/:role                → { remarks }
 *   DELETE /api/access/roles/:role                → only if no user has the role
 *   PUT    /api/access/roles/:role/permissions    → { rows:[{module_code,can_view,can_add,can_edit,can_delete,can_post}] }
 *   PUT    /api/access/users/:username/overrides  → { rows:[{module_code,can_view..can_post: 'Y'|'N'|null}] }
 *
 * Registration in HayatDb.js, just after  app.use("/api", authMiddleware);
 *   authMiddleware.init(connection);
 *   app.use("/api", require("./routes/accessRightsRoutes")(connection));
 */

const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");

const ACTIONS = ["can_view", "can_add", "can_edit", "can_delete", "can_post"];
const PROTECTED_ROLES = ["admin", "user", "viewer"];   // cannot be deleted
const yn = (v) => (v === "Y" || v === true || v === 1 ? "Y" : "N");
const ynOrNull = (v) => (v === null || v === undefined || v === "" ? null : yn(v));

module.exports = function (connection) {
  const router = express.Router();
  const db = typeof connection.promise === "function" ? connection.promise() : connection;
  const q = async (sql, params = []) => (await db.query(sql, params))[0];
  // pool → own connection for the transaction; single connection → use it directly
  const getConn = async () => (typeof db.getConnection === "function" ? db.getConnection() : db);

  // ── guards ────────────────────────────────────────────────────────────────
  const isAdmin = (req) => req.user && req.user.role === "admin";

  const canRead = async (req, res, next) => {
    try {
      if (isAdmin(req)) return next();
      const perms = await authMiddleware.getPermissions(req.user.role, req.user.username);
      if (perms.utilities && perms.utilities.can_view === "Y") return next();
      return res.status(403).json({ message: "Access denied: Access Rights" });
    } catch (e) { return res.status(500).json({ message: e.message }); }
  };
  const adminOnly = (req, res, next) =>
    isAdmin(req) ? next() : res.status(403).json({ message: "Admin access required." });

  const done = () => authMiddleware.clearPermissionCache();   // rights changed → drop cache

  // ── my own rights (menu, buttons) ─────────────────────────────────────────
  router.get("/my-permissions", async (req, res) => {
    try {
      const modules = await q(
        "SELECT module_code, is_entry FROM app_modules WHERE is_active='Y'");
      const perms = {};
      if (isAdmin(req)) {
        for (const m of modules) {
          perms[m.module_code] = { can_view: "Y", can_add: "Y", can_edit: "Y", can_delete: "Y", can_post: "Y" };
        }
      } else {
        const map = await authMiddleware.getPermissions(req.user.role, req.user.username);
        for (const m of modules) {
          perms[m.module_code] = map[m.module_code] ||
            { can_view: "N", can_add: "N", can_edit: "N", can_delete: "N", can_post: "N" };
        }
      }
      res.json({ username: req.user.username, role: req.user.role, isAdmin: isAdmin(req), perms });
    } catch (e) {
      console.error("[my-permissions]", e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // ── menu groups ───────────────────────────────────────────────────────────
  router.get("/access/modules", canRead, async (req, res) => {
    try {
      res.json(await q(
        `SELECT module_code, module_name, menu_group, is_entry, sort_order
           FROM app_modules WHERE is_active='Y' ORDER BY sort_order`));
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ── roles ─────────────────────────────────────────────────────────────────
  router.get("/access/roles", canRead, async (req, res) => {
    try {
      res.json(await q(
        `SELECT r.role_name, r.remarks,
                (SELECT COUNT(*) FROM users u WHERE u.role = r.role_name) AS user_count
           FROM roles r ORDER BY FIELD(r.role_name,'admin','user','viewer') DESC, r.role_name`));
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  router.post("/access/roles", adminOnly, async (req, res) => {
    const role = String(req.body.role_name || "").trim().toLowerCase();
    const remarks = String(req.body.remarks || "").trim() || null;
    const copyFrom = String(req.body.copy_from || "").trim();
    if (!/^[a-z0-9_]{2,50}$/.test(role)) {
      return res.status(400).json({ message: "Role name: 2-50 characters, letters, digits or _ only." });
    }
    try {
      if ((await q("SELECT 1 FROM roles WHERE role_name=?", [role])).length) {
        return res.status(409).json({ message: `Role "${role}" already exists.` });
      }
      await q("INSERT INTO roles (role_name, remarks) VALUES (?,?)", [role, remarks]);
      if (copyFrom) {
        await q(
          `INSERT INTO role_permissions (role_name, module_code, can_view, can_add, can_edit, can_delete, can_post)
           SELECT ?, module_code, can_view, can_add, can_edit, can_delete, can_post
             FROM role_permissions WHERE role_name=?`, [role, copyFrom]);
      } else {
        await q(
          `INSERT INTO role_permissions (role_name, module_code)
           SELECT ?, module_code FROM app_modules`, [role]);      // all 'N'
      }
      done();
      res.status(201).json({ message: `Role "${role}" created.` });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  router.put("/access/roles/:role", adminOnly, async (req, res) => {
    try {
      await q("UPDATE roles SET remarks=? WHERE role_name=?",
              [String(req.body.remarks || "").trim() || null, req.params.role]);
      res.json({ message: "Role updated." });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  router.delete("/access/roles/:role", adminOnly, async (req, res) => {
    const role = req.params.role;
    if (PROTECTED_ROLES.includes(role)) {
      return res.status(400).json({ message: `The "${role}" role cannot be deleted.` });
    }
    try {
      const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role=?", [role]);
      if (n > 0) {
        return res.status(400).json({ message: `${n} user(s) still have the "${role}" role. Change them first.` });
      }
      await q("DELETE FROM roles WHERE role_name=?", [role]);   // role_permissions cascade
      done();
      res.json({ message: `Role "${role}" deleted.` });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ── rights grid for a role ────────────────────────────────────────────────
  router.get("/access/roles/:role/permissions", canRead, async (req, res) => {
    try {
      res.json(await q(
        `SELECT m.module_code, m.module_name, m.menu_group, m.is_entry,
                COALESCE(p.can_view,'N')   AS can_view,
                COALESCE(p.can_add,'N')    AS can_add,
                COALESCE(p.can_edit,'N')   AS can_edit,
                COALESCE(p.can_delete,'N') AS can_delete,
                COALESCE(p.can_post,'N')   AS can_post
           FROM app_modules m
           LEFT JOIN role_permissions p ON p.module_code = m.module_code AND p.role_name = ?
          WHERE m.is_active='Y'
          ORDER BY m.sort_order`, [req.params.role]));
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  router.put("/access/roles/:role/permissions", adminOnly, async (req, res) => {
    const role = req.params.role;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (role === "admin") {
      return res.status(400).json({ message: "Admin always has full rights; nothing to save." });
    }
    if (!(await q("SELECT 1 FROM roles WHERE role_name=?", [role])).length) {
      return res.status(404).json({ message: `Role "${role}" not found.` });
    }
    const conn = await getConn();
    try {
      await conn.beginTransaction();
      for (const r of rows) {
        const v = ACTIONS.map((a) => yn(r[a]));
        if (v[0] === "N") { v[1] = v[2] = v[3] = v[4] = "N"; }   // no View → no other right
        await conn.query(
          `INSERT INTO role_permissions (role_name, module_code, can_view, can_add, can_edit, can_delete, can_post)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE can_view=VALUES(can_view), can_add=VALUES(can_add),
             can_edit=VALUES(can_edit), can_delete=VALUES(can_delete), can_post=VALUES(can_post)`,
          [role, r.module_code, ...v]);
      }
      await conn.commit();
      done();
      res.json({ message: `Rights saved for "${role}" (${rows.length} groups).` });
    } catch (e) {
      await conn.rollback();
      res.status(500).json({ message: e.message });
    } finally { if (conn !== db && conn.release) conn.release(); }
  });

  // ── users and per-user exceptions ─────────────────────────────────────────
  router.get("/access/users", canRead, async (req, res) => {
    try {
      res.json(await q(
        `SELECT u.username, u.role, u.is_active,
                (SELECT COUNT(*) FROM user_permission_overrides o WHERE o.username=u.username) AS override_count
           FROM users u ORDER BY u.username`));
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  router.get("/access/users/:username/overrides", canRead, async (req, res) => {
    try {
      const [u] = await q("SELECT role FROM users WHERE username=?", [req.params.username]);
      if (!u) return res.status(404).json({ message: "User not found." });
      const rows = await q(
        `SELECT m.module_code, m.module_name, m.menu_group, m.is_entry,
                COALESCE(p.can_view,'N') AS role_view,   COALESCE(p.can_add,'N') AS role_add,
                COALESCE(p.can_edit,'N') AS role_edit,   COALESCE(p.can_delete,'N') AS role_delete,
                COALESCE(p.can_post,'N') AS role_post,
                o.can_view, o.can_add, o.can_edit, o.can_delete, o.can_post
           FROM app_modules m
           LEFT JOIN role_permissions p ON p.module_code=m.module_code AND p.role_name=?
           LEFT JOIN user_permission_overrides o ON o.module_code=m.module_code AND o.username=?
          WHERE m.is_active='Y'
          ORDER BY m.sort_order`, [u.role, req.params.username]);
      res.json({ username: req.params.username, role: u.role, rows });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  router.put("/access/users/:username/overrides", adminOnly, async (req, res) => {
    const username = req.params.username;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const conn = await getConn();
    try {
      await conn.beginTransaction();
      for (const r of rows) {
        const v = ACTIONS.map((a) => ynOrNull(r[a]));
        if (v.every((x) => x === null)) {
          await conn.query(
            "DELETE FROM user_permission_overrides WHERE username=? AND module_code=?",
            [username, r.module_code]);
        } else {
          await conn.query(
            `INSERT INTO user_permission_overrides
               (username, module_code, can_view, can_add, can_edit, can_delete, can_post, updated_by)
             VALUES (?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE can_view=VALUES(can_view), can_add=VALUES(can_add),
               can_edit=VALUES(can_edit), can_delete=VALUES(can_delete), can_post=VALUES(can_post),
               updated_by=VALUES(updated_by)`,
            [username, r.module_code, ...v, req.user.username]);
        }
      }
      await conn.commit();
      done();
      res.json({ message: `Exceptions saved for "${username}".` });
    } catch (e) {
      await conn.rollback();
      res.status(500).json({ message: e.message });
    } finally { if (conn !== db && conn.release) conn.release(); }
  });

  return router;
};