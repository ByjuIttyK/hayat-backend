// fabInvDoRoutes.js
// Routes backing the multi-D/O panel on the Project / Fabrication Invoice screen.
//
// Table notes (fab_do_hdr / fab_do_dtl were cloned from the invoice tables in
// Oracle, so the column names read "INV_" but hold D/O values):
//   fab_do_hdr.INV_NO   = D/O number, padded  (0000000004)
//   fab_do_hdr.INV_DATE = D/O date
//   fab_do_hdr.DO_NO    = short D/O number shown to users (00004)
//   fab_do_hdr.DO_DATE  = unused (NULL)
//   fab_do_dtl.INV_NO   = D/O number, joins to the header
//   fab_do_dtl.INV_RATE = NULL on D/Os — invoice lines come in at rate 0
//
// Register in HayatDb.js:
//    const fabInvDoRoutes = require("./routes/fabInvDoRoutes");
//    app.use("/api", fabInvDoRoutes(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  /* ---------------------------------------------------------------- LOV */
  // GET /api/fabinv-do-lov?custCode=1CS0694&search=378&excludeLinked=0&invNo=...
  router.get("/fabinv-do-lov", (req, res) => {
    const custCode = (req.query.custCode || "").trim();
    const search = (req.query.search || "").trim();
    const invNo = (req.query.invNo || "").trim();
    const excludeLinked = String(req.query.excludeLinked || "0") === "1";

    const params = [];
    let sql = `
      SELECT h.INV_NO                      AS DO_NO,
             h.INV_DATE                    AS DO_DATE,
             h.DO_NO                       AS DO_SHORT_NO,
             h.CUST_CODE                   AS CUST_CODE,
             IFNULL(h.LPO_NO, '')          AS LPO_NO,
             IFNULL(h.JOB_NO, '')          AS JOB_NO,
             COUNT(d.srno_row_id)          AS ITEM_COUNT,
             IFNULL(SUM(d.INV_QTY), 0)     AS TOT_QTY
        FROM fab_do_hdr h
        LEFT JOIN fab_do_dtl d ON TRIM(d.INV_NO) = TRIM(h.INV_NO)
       WHERE IFNULL(h.INV_CANCELLED, '') <> 'Y' `;

    if (excludeLinked) {
      sql += ` AND NOT EXISTS (
                 SELECT 1 FROM inv_do_link l
                  WHERE TRIM(l.DO_NO) = TRIM(h.INV_NO)
                    AND TRIM(IFNULL(l.INV_NO, '')) <> ? ) `;
      params.push(invNo); // in EDIT the invoice's own links stay visible
    }
    if (custCode) {
      sql += " AND TRIM(h.CUST_CODE) = ? ";
      params.push(custCode);
    }
    if (search) {
      sql += ` AND (h.INV_NO LIKE ?
                 OR IFNULL(h.DO_NO, '')  LIKE ?
                 OR IFNULL(h.LPO_NO, '') LIKE ?
                 OR IFNULL(h.JOB_NO, '') LIKE ?) `;
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    sql += `
       GROUP BY h.INV_NO, h.INV_DATE, h.DO_NO, h.CUST_CODE, h.LPO_NO, h.JOB_NO
       ORDER BY h.INV_DATE DESC, h.INV_NO DESC
       LIMIT 500`;

    connection.getConnection((err, conn) => {
      if (err) return res.status(500).json({ error: err.message });
      conn.query(sql, params, (e, rows) => {
        conn.release();
        if (e) return res.status(500).json({ error: e.message });
        res.json(rows);
      });
    });
  });

  /* --------------------------------------------------------- single D/O */
  // GET /api/fabinv-do-hdr/0000000004
  router.get("/fabinv-do-hdr/:doNo", (req, res) => {
    const sql = `
      SELECT h.INV_NO             AS DO_NO,
             h.INV_DATE           AS DO_DATE,
             h.DO_NO              AS DO_SHORT_NO,
             h.CUST_CODE,
             IFNULL(h.LPO_NO,'')  AS LPO_NO,
             IFNULL(h.JOB_NO,'')  AS JOB_NO
        FROM fab_do_hdr h
       WHERE TRIM(h.INV_NO) = ?
          OR TRIM(IFNULL(h.DO_NO,'')) = ?
       LIMIT 1`;
    const v = String(req.params.doNo).trim();
    connection.getConnection((err, conn) => {
      if (err) return res.status(500).json({ error: err.message });
      conn.query(sql, [v, v], (e, rows) => {
        conn.release();
        if (e) return res.status(500).json({ error: e.message });
        res.json(rows && rows[0] ? rows[0] : null);
      });
    });
  });

  /* --------------------------------------------------------- D/O items */
  // POST /api/fabinv-do-items   { doNos: ["0000000004","0000000007"] }
  router.post("/fabinv-do-items", (req, res) => {
    const doNos = (req.body && req.body.doNos ? req.body.doNos : [])
      .map((d) => String(d).trim())
      .filter(Boolean);

    if (!doNos.length) return res.json([]);

    const marks = doNos.map(() => "?").join(",");
    const sql = `
      SELECT d.SR_NO,
             d.INV_NO                     AS DO_NO,
             h.INV_DATE                   AS DO_DATE,
             h.CUST_CODE,
             IFNULL(d.ITEM_CODE, '')      AS ITEM_CODE,
             d.INV_ITEM_DESC              AS ITEM_DES1,
             IFNULL(d.INV_UNIT, '')       AS UNIT,
             IFNULL(d.INV_QTY, 0)         AS QTY,
             0                            AS QTY_INVOICED,
             IFNULL(d.INV_RATE, 0)        AS RATE,
             IFNULL(d.PANEL_NO, '')       AS PANEL_NO,
             d.MAIN_SR_NO
        FROM fab_do_dtl d
        JOIN fab_do_hdr h ON TRIM(h.INV_NO) = TRIM(d.INV_NO)
       WHERE TRIM(d.INV_NO) IN (${marks})
       ORDER BY FIELD(TRIM(d.INV_NO), ${marks}),
                CAST(d.SR_NO AS UNSIGNED),
                d.srno_row_id`;

    connection.getConnection((err, conn) => {
      if (err) return res.status(500).json({ error: err.message });
      conn.query(sql, [...doNos, ...doNos], (e, rows) => {
        conn.release();
        if (e) return res.status(500).json({ error: e.message });
        res.json(rows);
      });
    });
  });

  /* ------------------------------------------------------- inv_do_link */
  // GET /api/fabinv-do-link/0000004028
  router.get("/fabinv-do-link/:invNo", (req, res) => {
    const sql = `SELECT INV_NO, DO_NO, DO_DATE
                   FROM inv_do_link
                  WHERE TRIM(INV_NO) = ?
                  ORDER BY DO_DATE, DO_NO`;
    connection.getConnection((err, conn) => {
      if (err) return res.status(500).json({ error: err.message });
      conn.query(sql, [String(req.params.invNo).trim()], (e, rows) => {
        conn.release();
        if (e) return res.status(500).json({ error: e.message });
        res.json(rows);
      });
    });
  });

  // POST /api/fabinv-do-link   { invNo, links: [{ DO_NO, DO_DATE }] }
  router.post("/fabinv-do-link", (req, res) => {
    const invNo = String((req.body && req.body.invNo) || "").trim();
    const links = (req.body && req.body.links) || [];
    if (!invNo) return res.status(400).json({ error: "invNo is required" });

    const toDb = (v) => {
      if (!v) return null;
      const s = String(v).trim();
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : s.slice(0, 10);
    };

    const values = links
      .map((l) => [invNo, String(l.DO_NO || "").trim(), toDb(l.DO_DATE)])
      .filter((v) => v[1]);

    connection.getConnection((err, conn) => {
      if (err) return res.status(500).json({ error: err.message });
      conn.beginTransaction((tErr) => {
        if (tErr) {
          conn.release();
          return res.status(500).json({ error: tErr.message });
        }
        conn.query("DELETE FROM inv_do_link WHERE TRIM(INV_NO) = ?", [invNo], (dErr) => {
          if (dErr) {
            return conn.rollback(() => {
              conn.release();
              res.status(500).json({ error: dErr.message });
            });
          }
          if (!values.length) {
            return conn.commit((cErr) => {
              conn.release();
              if (cErr) return res.status(500).json({ error: cErr.message });
              res.json({ ok: true, count: 0 });
            });
          }
          conn.query(
            "INSERT INTO inv_do_link (INV_NO, DO_NO, DO_DATE) VALUES ?",
            [values],
            (iErr) => {
              if (iErr) {
                return conn.rollback(() => {
                  conn.release();
                  res.status(500).json({ error: iErr.message });
                });
              }
              conn.commit((cErr) => {
                conn.release();
                if (cErr) return res.status(500).json({ error: cErr.message });
                res.json({ ok: true, count: values.length });
              });
            }
          );
        });
      });
    });
  });

  return router;
};
