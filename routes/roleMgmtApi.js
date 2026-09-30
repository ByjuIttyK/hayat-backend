// routes/roleMgmtApi.js
// Role Management — list / create / edit description / delete roles.
// Register in HayatDb.js AFTER authMiddleware.init(connection):
//   const roleMgmtApi = require("./routes/roleMgmtApi");
//   app.use("/api", roleMgmtApi(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const pool = connection.promise();

  const PROTECTED_ROLES = ["admin"];
  const ROLE_NAME_RE = /^[a-z][a-z0-9_]{1,29}$/; // lowercase, 2-30 chars

  // Only admin may use these endpoints.
  // Adjust if your authMiddleware puts the role somewhere other than req.user.role
  function adminOnly(req, res, next) {
    const role = String(req.user?.role || "").toLowerCase();
    if (role !== "admin") {
      return res.status(403).json({ message: "Only admin can manage roles." });
    }
    next();
  }

  // Finds the login-name column of the users table, so the delete check can
  // say which users still hold the role.
  let userNameCol = null;
  async function getUserNameCol() {
    if (userNameCol) return userNameCol;
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'users'`
    );
    const names = cols.map((c) => c.COLUMN_NAME);
    const pref = ["user_name", "username", "usr_name", "login_id", "user_id", "name"];
    userNameCol =
      pref.map((p) => names.find((n) => n.toLowerCase() === p)).find(Boolean) || names[0];
    return userNameCol;
  }

  // Columns of role_permissions to copy (everything except role_name and
  // auto-increment keys), read from the table so this works whatever the
  // permission flag columns are called.
  async function getPermCopyCols(conn) {
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, EXTRA FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'role_permissions'
        ORDER BY ORDINAL_POSITION`
    );
    return cols
      .filter(
        (c) =>
          c.COLUMN_NAME.toLowerCase() !== "role_name" &&
          !String(c.EXTRA).toLowerCase().includes("auto_increment")
      )
      .map((c) => "`" + c.COLUMN_NAME + "`");
  }

  // ── List roles with user and permission counts ────────────────────────
  router.get("/role-mgmt/roles", adminOnly, async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT r.role_name AS ROLE_NAME,
                r.remarks   AS REMARKS,
                (SELECT COUNT(*) FROM users u WHERE u.role = r.role_name)            AS USER_CNT,
                (SELECT COUNT(*) FROM role_permissions p WHERE p.role_name = r.role_name) AS PERM_CNT
           FROM roles r
          ORDER BY r.role_name`
      );
      res.json(rows);
    } catch (err) {
      console.error("role-mgmt list:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── Create role (optionally copying rights from another role) ─────────
  router.post("/role-mgmt/roles", adminOnly, async (req, res) => {
    const roleName = String(req.body.role_name || "").trim().toLowerCase();
    const remarks = String(req.body.remarks || "").trim();
    const copyFrom = String(req.body.copy_from || "").trim().toLowerCase();

    if (!ROLE_NAME_RE.test(roleName)) {
      return res.status(400).json({
        message:
          "Role name must be 2-30 characters: lowercase letters, digits or underscore, starting with a letter.",
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [dup] = await conn.query("SELECT 1 FROM roles WHERE role_name = ?", [roleName]);
      if (dup.length) {
        await conn.rollback();
        return res.status(409).json({ message: `Role '${roleName}' already exists.` });
      }

      await conn.query("INSERT INTO roles (role_name, remarks) VALUES (?, ?)", [roleName, remarks]);

      let copied = 0;
      if (copyFrom) {
        const [src] = await conn.query("SELECT 1 FROM roles WHERE role_name = ?", [copyFrom]);
        if (!src.length) {
          await conn.rollback();
          return res.status(400).json({ message: `Role '${copyFrom}' to copy from was not found.` });
        }
        const cols = await getPermCopyCols(conn);
        const colList = cols.join(", ");
        const [r] = await conn.query(
          `INSERT INTO role_permissions (role_name, ${colList})
           SELECT ?, ${colList} FROM role_permissions WHERE role_name = ?`,
          [roleName, copyFrom]
        );
        copied = r.affectedRows;
      }

      await conn.commit();
      res.json({ message: `Role '${roleName}' created.`, copied });
    } catch (err) {
      await conn.rollback();
      console.error("role-mgmt create:", err);
      res.status(500).json({ message: err.message });
    } finally {
      conn.release();
    }
  });

  // ── Edit description only (role_name is the key other tables use) ─────
  router.put("/role-mgmt/roles/:name", adminOnly, async (req, res) => {
    const roleName = String(req.params.name || "").toLowerCase();
    const remarks = String(req.body.remarks || "").trim();
    try {
      const [r] = await pool.query("UPDATE roles SET remarks = ? WHERE role_name = ?", [
        remarks,
        roleName,
      ]);
      if (!r.affectedRows) return res.status(404).json({ message: "Role not found." });
      res.json({ message: "Description updated." });
    } catch (err) {
      console.error("role-mgmt update:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── Delete role (refused while any user holds it) ─────────────────────
  router.delete("/role-mgmt/roles/:name", adminOnly, async (req, res) => {
    const roleName = String(req.params.name || "").toLowerCase();

    if (PROTECTED_ROLES.includes(roleName)) {
      return res.status(400).json({ message: `The '${roleName}' role cannot be deleted.` });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const nameCol = await getUserNameCol();
      const [users] = await conn.query(
        `SELECT \`${nameCol}\` AS UNAME FROM users WHERE role = ?`,
        [roleName]
      );
      if (users.length) {
        await conn.rollback();
        return res.status(409).json({
          message: `Cannot delete: ${users.length} user(s) still have this role. Reassign them in User Management first.`,
          users: users.map((u) => u.UNAME),
        });
      }

      await conn.query("DELETE FROM role_permissions WHERE role_name = ?", [roleName]);
      const [r] = await conn.query("DELETE FROM roles WHERE role_name = ?", [roleName]);
      if (!r.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ message: "Role not found." });
      }

      await conn.commit();
      res.json({ message: `Role '${roleName}' deleted.` });
    } catch (err) {
      await conn.rollback();
      console.error("role-mgmt delete:", err);
      res.status(500).json({ message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};
