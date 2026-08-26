/**
 * User Management Routes
 * File: E:\hayatApi\routes\userMgmtRoutes.js
 *
 * All endpoints require JWT + admin role.
 *
 * GET  /api/users              → list all users
 * POST /api/users              → create new user (bcrypt hash)
 * PUT  /api/users/:id/toggle   → activate / deactivate
 * PUT  /api/users/:id/reset-password → reset password
 * DELETE /api/users/:id        → delete (non-self)
 *
 * Registration in HayatDb.js (after JWT middleware is set up):
 *   const userMgmt = require('./routes/userMgmtRoutes');
 *   app.use('/api', verifyToken, userMgmt(connection));
 *   // or if you want to apply auth per-route, the route itself checks req.user.role
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const SALT_ROUNDS = 10;

// ── Role check middleware ──────────────────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  next();
};

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  // ── GET /api/users — list all users ─────────────────────────────────────────
  router.get('/users', adminOnly, async (req, res) => {
    try {
      const rows = await q(
        `SELECT id, username, user_abbr, role, is_active,
                DATE_FORMAT(created_at,'%d/%m/%Y %H:%i') AS created_at
         FROM users ORDER BY username`
      );
      res.json(rows);
    } catch (err) {
      console.error('[users GET]', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/users — create user ────────────────────────────────────────────
  router.post('/users', adminOnly, async (req, res) => {
    const { username, user_abbr, password, role } = req.body;
    if (!username || !user_abbr || !password || !role) {
      return res.status(400).json({ message: 'username, user_abbr, password and role are required.' });
    }
    try {
      // Check duplicate
      const existing = await q('SELECT id FROM users WHERE username = ?', [username]);
      if (existing.length) {
        return res.status(409).json({ message: `Username "${username}" already exists.` });
      }
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      const result = await q(
        'INSERT INTO users (username, user_abbr, password_hash, role, is_active) VALUES (?,?,?,?,1)',
        [username.trim(), user_abbr.trim().toUpperCase(), hash, role]
      );
      res.status(201).json({ message: 'User created successfully.', id: result.insertId });
    } catch (err) {
      console.error('[users POST]', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── PUT /api/users/:id/toggle — activate / deactivate ───────────────────────
  router.put('/users/:id/toggle', adminOnly, async (req, res) => {
    const { id } = req.params;
    if (Number(id) === req.user.id) {
      return res.status(400).json({ message: 'You cannot deactivate your own account.' });
    }
    try {
      await q('UPDATE users SET is_active = NOT is_active WHERE id = ?', [id]);
      const [row] = await q('SELECT is_active FROM users WHERE id = ?', [id]);
      res.json({ message: row.is_active ? 'User activated.' : 'User deactivated.', is_active: row.is_active });
    } catch (err) {
      console.error('[users toggle]', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── PUT /api/users/:id/role — update role ────────────────────────────────────
  router.put('/users/:id/role', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    if (!role || !['admin','user','viewer'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Must be admin, user or viewer.' });
    }
    try {
      await q('UPDATE users SET role = ? WHERE id = ?', [role, id]);
      res.json({ message: `Role updated to "${role}".` });
    } catch (err) {
      console.error('[users role]', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── PUT /api/users/:id/reset-password ───────────────────────────────────────
  router.put('/users/:id/reset-password', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }
    try {
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      await q('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
      res.json({ message: 'Password reset successfully.' });
    } catch (err) {
      console.error('[users reset-password]', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── DELETE /api/users/:id ────────────────────────────────────────────────────
  router.delete('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    if (Number(id) === req.user.id) {
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    }
    try {
      await q('DELETE FROM users WHERE id = ?', [id]);
      res.json({ message: 'User deleted.' });
    } catch (err) {
      console.error('[users DELETE]', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};
