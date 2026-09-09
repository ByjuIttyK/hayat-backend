// routes/stmtRun.js
// Statement runs — build a month's list of customers with a balance, age it
// into five buckets, then track preview/send per customer.
//
// Register in HayatDb.js:
//   const stmtRunRoutes = require("./routes/stmtRun");
//   app.use("/api", authMiddleware, stmtRunRoutes(connection));

const express = require("express");

// cus_mst column names, confirmed against the table.
const EMAIL_COL = "EMAIL";

// Segment cut-offs by cumulative share of the total receivable.
// Still written to SEGMENT_AUTO / SEGMENT for the older reports, but the
// statement screen no longer reads them — it derives A-D from the ageing
// buckets below, so the letter follows how old the money is, not how big it is.
const SEG_A = 80;
const SEG_B = 95;

// Ageing buckets in days: 0-30, 30-60, 60-90, 90-120, over 120.
// The open amount is DR_AMT - CR_AMT per row; BALANCE on the view is a running
// total and must never be summed. Spelled once so the buckets and the
// outstanding total can never drift apart.
const OPEN = "(v.DR_AMT - v.CR_AMT)";
const AGE = "DATEDIFF(x.as_on, v.DATTE)";

const AGE_COLS = `
       ROUND(SUM(CASE WHEN ${AGE} <=  30 THEN ${OPEN} ELSE 0 END), 2) AS age_0_30,
       ROUND(SUM(CASE WHEN ${AGE} >   30
                       AND ${AGE} <=  60 THEN ${OPEN} ELSE 0 END), 2) AS age_30_60,
       ROUND(SUM(CASE WHEN ${AGE} >   60
                       AND ${AGE} <=  90 THEN ${OPEN} ELSE 0 END), 2) AS age_60_90,
       ROUND(SUM(CASE WHEN ${AGE} >   90
                       AND ${AGE} <= 120 THEN ${OPEN} ELSE 0 END), 2) AS age_90_120,
       ROUND(SUM(CASE WHEN ${AGE} >  120 THEN ${OPEN} ELSE 0 END), 2) AS age_120_plus,
       MAX(${AGE})                                                    AS oldest_days`;

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const fail = (res, err, where) => {
    console.error(`[stmtRun] ${where}:`, err);
    res.status(500).json({ error: `${where} failed`, detail: err.message });
  };

  // --- 1. list runs ----------------------------------------------------------
  router.get("/stmt-run", async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT RUN_ID, RUN_PERIOD, RUN_SEQ, RUN_TYPE,
                DATE_FORMAT(AS_ON_DATE, '%d/%m/%Y') AS asOnDate,
                AS_ON_DATE                          AS asOnRaw,
                DATE_FORMAT(RUN_DATE,  '%d/%m/%Y %H:%i') AS runDate,
                CREATED_BY, CUST_COUNT, TOTAL_OUTSTANDING, RUN_STATUS, REMARKS
           FROM stmt_run
       ORDER BY RUN_ID DESC
          LIMIT 60`
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "run list");
    }
  });

  // --- 2. create a run -------------------------------------------------------
  // body: { asOnDate: 'YYYY-MM-DD', runType?, createdBy?, includeZero? }
  router.post("/stmt-run", async (req, res) => {
    const {
      asOnDate,
      runType = "MONTHLY",
      createdBy = null,
      includeZero = false,
    } = req.body || {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOnDate || ""))) {
      return res.status(400).json({ error: "asOnDate must be YYYY-MM-DD" });
    }
    const period = String(asOnDate).slice(0, 7);

    let conn;
    try {
      conn = await connection.promise().getConnection();
      await conn.query("START TRANSACTION");

      // Customers with a balance as at the cut-off, aged into the five buckets.
      // The cut-off is carried in a derived table so it is named once instead
      // of repeated as a placeholder in every CASE — which is also why this
      // one uses query() rather than execute().
      const [rows] = await conn.query(
        `SELECT v.CUST_CODE                              AS custCode,
                MAX(c.CUST_NAME)                         AS custName,
                MAX(c.${EMAIL_COL})                      AS email,
                ROUND(SUM(${OPEN}), 2)                   AS outstanding,
                ${AGE_COLS}
           FROM v_cust_outstanding_bill v
     CROSS JOIN (SELECT ? AS as_on) x
      LEFT JOIN cus_mst c ON c.CUST_CODE = v.CUST_CODE
          WHERE v.DATTE < x.as_on
       GROUP BY v.CUST_CODE
         HAVING ${includeZero ? `ROUND(SUM(${OPEN}), 2) <> 0` : `ROUND(SUM(${OPEN}), 2) > 0`}
       ORDER BY outstanding DESC`,
        [asOnDate]
      );

      if (!rows.length) {
        await conn.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: `No customer has a balance as on ${asOnDate}` });
      }

      const total = rows.reduce((t, r) => t + Number(r.outstanding || 0), 0);

      // next sequence within the month
      const [seqRows] = await conn.execute(
        `SELECT COALESCE(MAX(RUN_SEQ), 0) + 1 AS nextSeq
           FROM stmt_run WHERE RUN_PERIOD = ?`,
        [period]
      );
      const runSeq = seqRows[0].nextSeq;

      const [ins] = await conn.execute(
        `INSERT INTO stmt_run
           (RUN_PERIOD, RUN_SEQ, RUN_TYPE, AS_ON_DATE, RUN_DATE,
            CREATED_BY, CUST_COUNT, TOTAL_OUTSTANDING, RUN_STATUS)
         VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, 'OPEN')`,
        [period, runSeq, runType, asOnDate, createdBy, rows.length, total.toFixed(2)]
      );
      const runId = ins.insertId;

      // Segment on cumulative share, descending — so A is the handful of
      // customers who account for most of what is owed.
      let running = 0;
      const values = [];
      for (const r of rows) {
        const amt = Number(r.outstanding || 0);
        running += amt;
        const cum = total ? (running / total) * 100 : 0;
        const seg = cum <= SEG_A ? "A" : cum <= SEG_B ? "B" : "C";
        const email = (r.email || "").trim();
        values.push([
          runId,
          r.custCode,
          r.custName || null,
          email || null,
          amt.toFixed(2),
          Number(r.age_0_30 || 0).toFixed(2),
          Number(r.age_30_60 || 0).toFixed(2),
          Number(r.age_60_90 || 0).toFixed(2),
          Number(r.age_90_120 || 0).toFixed(2),
          Number(r.age_120_plus || 0).toFixed(2),
          r.oldest_days === null || r.oldest_days === undefined
            ? null
            : Number(r.oldest_days),
          cum.toFixed(2),
          seg,
          seg,
          email ? "PENDING" : "NO_EMAIL",
        ]);
      }

      await conn.query(
        `INSERT INTO stmt_run_dtl
           (RUN_ID, CUST_CODE, CUST_NAME, EMAIL_ID, OUTSTANDING,
            age_0_30, age_30_60, age_60_90, age_90_120, age_120_plus,
            oldest_days, CUM_PERCENT, SEGMENT_AUTO, SEGMENT, ROW_STATUS)
         VALUES ?`,
        [values]
      );

      await conn.query("COMMIT");
      res.json({
        ok: true,
        runId,
        period,
        runSeq,
        custCount: rows.length,
        total: Number(total.toFixed(2)),
      });
    } catch (err) {
      if (conn) {
        try {
          await conn.query("ROLLBACK");
        } catch (e) {
          console.error("[stmtRun] rollback:", e);
        }
      }
      if (err && err.code === "ER_DUP_ENTRY") {
        return res
          .status(409)
          .json({ error: `A run already exists for ${period} — refresh the list` });
      }
      fail(res, err, "run create");
    } finally {
      if (conn) conn.release();
    }
  });

  // --- 3. one run's rows -----------------------------------------------------
  router.get("/stmt-run/:runId/rows", async (req, res) => {
    const { runId } = req.params;
    const seg = (req.query.segment || "").trim().toUpperCase();
    try {
      const [rows] = await db.execute(
        `SELECT CUST_CODE     AS custCode,
                CUST_NAME     AS custName,
                EMAIL_ID      AS email,
                OUTSTANDING   AS outstanding,
                age_0_30      AS AGE_0_30,
                age_30_60     AS AGE_30_60,
                age_60_90     AS AGE_60_90,
                age_90_120    AS AGE_90_120,
                age_120_plus  AS AGE_120_PLUS,
                oldest_days   AS oldestDays,
                CUM_PERCENT   AS cumPercent,
                SEGMENT_AUTO  AS segmentAuto,
                SEGMENT       AS segment,
                ROW_STATUS    AS status,
                DATE_FORMAT(SENT_AT, '%d/%m/%Y %H:%i') AS sentAt,
                SENT_BY       AS sentBy,
                ERROR_TEXT    AS errorText
           FROM stmt_run_dtl
          WHERE RUN_ID = ?${seg && seg !== "ALL" ? " AND SEGMENT = ?" : ""}
       ORDER BY age_120_plus DESC, age_90_120 DESC, OUTSTANDING DESC`,
        seg && seg !== "ALL" ? [runId, seg] : [runId]
      );
      res.json(rows);
    } catch (err) {
      fail(res, err, "run rows");
    }
  });

  // --- 4. edit a row (segment or email) --------------------------------------
  router.patch("/stmt-run/:runId/row/:custCode", async (req, res) => {
    const { runId, custCode } = req.params;
    const { segment, email } = req.body || {};

    const sets = [];
    const params = [];
    if (segment !== undefined) {
      const seg = String(segment || "").trim().toUpperCase();
      if (!/^[A-Z]$/.test(seg)) {
        return res.status(400).json({ error: "Segment must be a single letter" });
      }
      sets.push("SEGMENT = ?");
      params.push(seg);
    }
    if (email !== undefined) {
      const e = String(email || "").trim();
      sets.push("EMAIL_ID = ?");
      params.push(e || null);
      // an address arriving on a row that had none clears the NO_EMAIL state
      sets.push("ROW_STATUS = CASE WHEN ? = '' THEN 'NO_EMAIL' " +
                "WHEN ROW_STATUS = 'NO_EMAIL' THEN 'PENDING' ELSE ROW_STATUS END");
      params.push(e);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

    params.push(runId, custCode);
    try {
      await db.execute(
        `UPDATE stmt_run_dtl SET ${sets.join(", ")}
          WHERE RUN_ID = ? AND CUST_CODE = ?`,
        params
      );
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "row update");
    }
  });

  // --- 5. status transitions -------------------------------------------------
  // body: { custCodes: [], status: 'PREVIEWED'|'SENT'|'FAILED'|'PENDING',
  //         sentBy?, emailUsed?, errorText? }
  router.patch("/stmt-run/:runId/status", async (req, res) => {
    const { runId } = req.params;
    const {
      custCodes = [],
      status,
      sentBy = null,
      emailUsed = null,
      errorText = null,
    } = req.body || {};

    const allowed = ["PENDING", "PREVIEWED", "SENT", "FAILED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
    }
    if (!Array.isArray(custCodes) || !custCodes.length) {
      return res.status(400).json({ error: "custCodes is required" });
    }

    const marks = custCodes.map(() => "?").join(",");
    try {
      if (status === "SENT") {
        await db.execute(
          `UPDATE stmt_run_dtl
              SET ROW_STATUS = 'SENT', SENT_AT = NOW(), SENT_BY = ?,
                  EMAIL_USED = COALESCE(?, EMAIL_ID), ERROR_TEXT = NULL
            WHERE RUN_ID = ? AND CUST_CODE IN (${marks})`,
          [sentBy, emailUsed, runId, ...custCodes]
        );
      } else if (status === "FAILED") {
        await db.execute(
          `UPDATE stmt_run_dtl
              SET ROW_STATUS = 'FAILED', ERROR_TEXT = ?
            WHERE RUN_ID = ? AND CUST_CODE IN (${marks})`,
          [String(errorText || "").slice(0, 255), runId, ...custCodes]
        );
      } else {
        // never downgrade a row that has already gone out
        await db.execute(
          `UPDATE stmt_run_dtl SET ROW_STATUS = ?
            WHERE RUN_ID = ? AND CUST_CODE IN (${marks})
              AND ROW_STATUS NOT IN ('SENT', 'NO_EMAIL')`,
          [status, runId, ...custCodes]
        );
      }
      res.json({ ok: true, updated: custCodes.length });
    } catch (err) {
      fail(res, err, "status update");
    }
  });

  // --- 6. run summary --------------------------------------------------------
  router.get("/stmt-run/:runId", async (req, res) => {
    const { runId } = req.params;
    try {
      const [[hdr]] = await db.execute(
        `SELECT RUN_ID, RUN_PERIOD, RUN_SEQ, RUN_TYPE,
                DATE_FORMAT(AS_ON_DATE, '%d/%m/%Y')      AS asOnDate,
                DATE_FORMAT(AS_ON_DATE, '%Y-%m-%d')      AS asOnRaw,
                DATE_FORMAT(RUN_DATE, '%d/%m/%Y %H:%i')  AS runDate,
                CREATED_BY, CUST_COUNT, TOTAL_OUTSTANDING, RUN_STATUS
           FROM stmt_run WHERE RUN_ID = ?`,
        [runId]
      );
      if (!hdr) return res.status(404).json({ error: `No run ${runId}` });

      const [counts] = await db.execute(
        `SELECT SEGMENT AS segment, ROW_STATUS AS status,
                COUNT(*) AS n, SUM(OUTSTANDING) AS amount
           FROM stmt_run_dtl WHERE RUN_ID = ?
       GROUP BY SEGMENT, ROW_STATUS`,
        [runId]
      );

      const [[ageing]] = await db.execute(
        `SELECT SUM(age_0_30)     AS b0_30,
                SUM(age_30_60)    AS b30_60,
                SUM(age_60_90)    AS b60_90,
                SUM(age_90_120)   AS b90_120,
                SUM(age_120_plus) AS b120_plus
           FROM stmt_run_dtl WHERE RUN_ID = ?`,
        [runId]
      );
      res.json({ ...hdr, counts, ageing });
    } catch (err) {
      fail(res, err, "run summary");
    }
  });

  return router;
};
