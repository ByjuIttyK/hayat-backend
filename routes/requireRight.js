// =====================================================================
// middleware/requireRight.js — checks the logged-in user's ROLE rights
// (users.role → role_permissions) before a route runs. Replaces checks on the
// user name ('admin').
//
//   router.post('/time-sheet/revoke/:tshtNo',
//     requireRight('timesheet', ['can_post', 'can_delete']), handler);
//
// Adjust the two lines marked ADJUST to your db pool and JWT user field.
// =====================================================================
const pool = require('../db'); // ADJUST: your mysql2/promise pool

/** Rights of the user's role for one module: { can_view: true, can_add: false, ... } */
async function getRoleRights(userName, moduleCode) {
  const [rows] = await pool.query(
    `SELECT rp.can_view, rp.can_add, rp.can_edit, rp.can_delete, rp.can_post
       FROM users u
       JOIN role_permissions rp ON rp.role_name = u.role
      WHERE u.user_name = ? AND rp.module_code = ?`,
    [userName, moduleCode],
  );
  const r = rows[0] || {};
  const yes = (v) => v === 1 || v === true || String(v || '').toUpperCase() === 'Y';
  return {
    can_view: yes(r.can_view),
    can_add: yes(r.can_add),
    can_edit: yes(r.can_edit),
    can_delete: yes(r.can_delete),
    can_post: yes(r.can_post),
  };
}

/** Express middleware: every listed right must be ticked for the user's role. */
function requireRight(moduleCode, needed) {
  const list = Array.isArray(needed) ? needed : [needed];
  return async (req, res, next) => {
    try {
      const userName = req.user?.user_name || req.user?.username; // ADJUST: field set by your JWT middleware
      if (!userName) return res.status(401).json({ error: 'Not logged in' });
      const rights = await getRoleRights(userName, moduleCode);
      const missing = list.filter((c) => !rights[c]);
      if (missing.length) return res.status(403).json({ error: `Not allowed for your role (${moduleCode}: ${missing.join(', ')})` });
      req.rights = rights;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

module.exports = { requireRight, getRoleRights };

// ---------------------------------------------------------------------
// Time sheet routes — use it like this (paths as in your timeSheetRoutes.js):
//
//   const { requireRight, getRoleRights } = require('../middleware/requireRight');
//   const TS = 'timesheet';
//
//   save (new)        → requireRight(TS, 'can_add')      (inside: if TSHT_NO exists → also can_edit)
//   save (existing)   → requireRight(TS, 'can_edit')
//   delete sheet      → requireRight(TS, 'can_delete')
//   delete attachment → requireRight(TS, 'can_edit')
//   time approve      → requireRight(TS, 'can_post')
//   revoke approval   → requireRight(TS, ['can_post', 'can_delete'])
//   payslip data      → requireRight('payslip', 'can_view')
//
// In the GET of a sheet, replace the user-name test for canRevoke with:
//   const r = await getRoleRights(userName, TS);
//   canRevoke: r.can_post && r.can_delete,
// ---------------------------------------------------------------------
