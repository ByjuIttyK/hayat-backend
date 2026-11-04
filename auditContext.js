// auditContext.js – tells MySQL which ERP user is making each change.
//
// Every connection taken from the pool first runs  SET @app_user = '<login user>'
// (or NULL outside a request).  The aud_* triggers read @app_user to fill
// audit_log.user_name and tran_acc.USERNAME, so no save route has to change.
//
// HayatDb.js – after the pool is created and BEFORE the routes:
//   const auditContext = require("./auditContext");
//   auditContext.patchPool(connection);      // connection = your mysql2 pool
//   app.use(auditContext.middleware);        // place it before app.use("/api", ...)
//
// The user is read when the route takes its connection (by then the JWT
// middleware has set req.user), so the order relative to the auth middleware
// does not matter.
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

/** login name from the JWT payload – adjust if your token uses another field */
function userOf(req) {
  const u = req && req.user;
  if (!u) return null;
  const v = u.username || u.user_name || u.USERNAME || u.USER_ID || u.userId || u.user || u.name || u.email;
  return v ? String(v).slice(0, 30) : null;
}

function middleware(req, res, next) {
  als.run({ req }, () => next());
}

/** current request's user (null outside a request, e.g. a scheduled job) */
function currentUser() {
  const s = als.getStore();
  return s ? userOf(s.req) : null;
}

let patched = false;
function patchPool(pool) {
  if (patched) return pool;
  // accepts the callback pool, or a promise pool (whose core pool is .pool)
  const core = pool && pool.pool && typeof pool.pool.getConnection === "function" ? pool.pool : pool;
  if (!core || typeof core.getConnection !== "function") throw new Error("auditContext.patchPool: pass the mysql2 pool");
  const original = core.getConnection.bind(core);

  core.getConnection = function (cb) {
    const user = currentUser(); // read now, while still inside the request
    original((err, conn) => {
      if (err) return cb(err);
      conn.query("SET @app_user = ?", [user], (e) => {
        if (e) {
          conn.release();
          return cb(e);
        }
        cb(null, conn);
      });
    });
  };
  patched = true;
  return pool;
}

module.exports = { middleware, patchPool, currentUser, userOf };
