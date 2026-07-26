// ============================================================
// middleware/authMiddleware.js — v2: role + user-override resolution
//
// Backward compatible: the default export is still the same
// verify-token function, so every existing line like
//   app.use("/ai", authMiddleware, chequeScanRoutes);
// keeps working unchanged.
//
// CHANGED vs v1:
//   getPermissions(role) → getPermissions(role, username)
//   Resolution: role_permissions gives the default for everyone in
//   that role; user_permission_overrides then overrides individual
//   columns for that specific username, module by module, wherever
//   the override column is non-NULL.
//   requirePermission() now passes req.user.username through
//   automatically — no existing call site needs to change, e.g.
//   authMiddleware.requirePermission("PV", "can_add") still works
//   exactly as before.
//
// Requires sql/03_user_permission_overrides.sql to have been run
// (you've already created this table).
// ============================================================
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;
// generate by:
// c:> node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Token missing" });
  }

  const token = authHeader.split(" ")[1]; // Bearer TOKEN

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, username, role }
    next();
  } catch (err) {
    const message =
      err.name === "TokenExpiredError" ? "Session expired" : "Invalid token";
    return res.status(401).json({ message });
  }
}

// ------------------------------------------------------------
let db = null; // promise-wrapped pool, set by init()

authMiddleware.init = function (connection) {
  db = typeof connection.promise === "function" ? connection.promise() : connection;
};

// Cache key combines role + username, since the resolved map is per-user now
const permCache = new Map(); // "role||username" -> { at: ms, map }
const CACHE_TTL_MS = 60 * 1000;

/**
 * Returns the EFFECTIVE permission map for this specific user:
 * role defaults, with any non-NULL user_permission_overrides column
 * taking precedence, per module.
 *
 * Result shape (unchanged from v1):
 *   { PV: { can_view: 'Y', can_add: 'Y', ... }, RV: {...}, ... }
 */
async function getPermissions(role, username) {
  if (!db) throw new Error("authMiddleware.init(connection) was not called");
  const cacheKey = `${role}||${username || ""}`;
  const hit = permCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.map;

  const [roleRows] = await db.query(
    `SELECT module_code, can_view, can_add, can_edit, can_delete, can_post
       FROM role_permissions WHERE role_name = ?`,
    [role]
  );

  const map = {};
  for (const r of roleRows) {
    map[r.module_code] = {
      can_view: r.can_view,
      can_add: r.can_add,
      can_edit: r.can_edit,
      can_delete: r.can_delete,
      can_post: r.can_post,
    };
  }

  if (username) {
    const [overrideRows] = await db.query(
      `SELECT module_code, can_view, can_add, can_edit, can_delete, can_post
         FROM user_permission_overrides WHERE username = ?`,
      [username]
    );
    for (const o of overrideRows) {
      if (!map[o.module_code]) {
        // user has an override for a module their role has no row for —
        // start from all-N, then apply whatever the override specifies
        map[o.module_code] = { can_view: 'N', can_add: 'N', can_edit: 'N', can_delete: 'N', can_post: 'N' };
      }
      const m = map[o.module_code];
      if (o.can_view   !== null) m.can_view   = o.can_view;
      if (o.can_add    !== null) m.can_add    = o.can_add;
      if (o.can_edit   !== null) m.can_edit   = o.can_edit;
      if (o.can_delete !== null) m.can_delete = o.can_delete;
      if (o.can_post   !== null) m.can_post   = o.can_post;
    }
  }

  permCache.set(cacheKey, { at: Date.now(), map });
  return map;
}
authMiddleware.getPermissions = getPermissions;
authMiddleware.clearPermissionCache = () => permCache.clear();

/**
 * Route guard. Use AFTER authMiddleware (needs req.user):
 *   app.post("/api/pvent/save",
 *     authMiddleware,
 *     authMiddleware.requirePermission("PV", "can_add"),
 *     handler);
 *
 * action: 'can_view' | 'can_add' | 'can_edit' | 'can_delete' | 'can_post'
 */
authMiddleware.requirePermission = function (moduleCode, action) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.role) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const perms = await getPermissions(req.user.role, req.user.username);
      if (perms[moduleCode] && perms[moduleCode][action] === "Y") return next();
      return res.status(403).json({
        message: `Access denied: ${action.replace("can_", "")} on ${moduleCode}`,
      });
    } catch (err) {
      console.error("Permission check failed:", err);
      return res.status(500).json({ message: "Permission check failed" });
    }
  };
};

/** Only role 'admin' passes. Use for /api/register, user mgmt, permission matrix. */
authMiddleware.requireAdmin = function (req, res, next) {
  if (req.user && req.user.role === "admin") return next();
  return res.status(403).json({ message: "Admin access required" });
};

module.exports = authMiddleware;
