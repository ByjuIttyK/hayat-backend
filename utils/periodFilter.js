// periodFilter — period condition for InfoGrid list queries.
//
// The list screen sends ?fromDate=yyyy-MM-dd&toDate=yyyy-MM-dd.
// Missing or badly formatted dates fall back to the current ac_period.
// `col` comes from the route's own code (e.g. "v.DATTE"), never from the request.
//
// Usage in a route:
//   const periodFilter = require("../utils/periodFilter");
//   const pf = periodFilter(req, "v.DATTE");
//   sql:    "WHERE v.TRAN_TYPE = ? " + pf.sql + "ORDER BY ..."
//   params: [..., ...pf.params]

const ISO = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function periodFilter(req, col) {
  const from = ISO.test(req.query.fromDate || "") ? req.query.fromDate : null;
  const to   = ISO.test(req.query.toDate   || "") ? req.query.toDate   : null;
  return {
    sql:
      ` AND ${col} >= COALESCE(?, (SELECT START_DATE FROM ac_period)) ` +
      ` AND ${col} <  COALESCE(?, (SELECT END_DATE FROM ac_period)) + INTERVAL 1 DAY `,
    params: [from, to],
  };
};
