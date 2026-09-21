/* ── PDC Received Reversal — JV review and correction ───────────────────────
   GET /api/pdc-rcd-reversal/jv-batches?from=&to=&batchNo=   master
   GET /api/pdc-rcd-reversal/jv-lines?batchNo=               detail
   GET /api/pdc-rcd-reversal/jv-cheques?batchNo=             cheques in a batch
   GET /api/pdc-rcd-reversal/acc-name?code=                  A/c lookup
   PUT /api/pdc-rcd-reversal/jv-lines                        save edits

   Register alongside the other pdc-rcd-reversal routes:
     app.use("/api", require("./routes/pdcRcdJvLines")(connection));

   A batch is identified by tran_acc.REF_NO, which the reversal posting
   stamps with the batch number (PRR000018 …) on both legs of every JV. So
   both grids read tran_acc alone — no join to pdc_rcd is needed to find a
   batch's lines, and none can fail to match.

   The save writes to tran_acc by vchr_no + TRAN_TYPE 24 — and by the row's
   own srno_row_id, so an edit lands on exactly the line that was shown and
   nowhere else. It is refused outright unless every JV it touches balances,
   checked here on the server against the complete set of each JV's lines,
   whatever the screen claimed.

   Account names come from acc_mst (ACC_CODE, ACC_HEAD). */

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  /* ── promise wrappers ── */
  const q = (sql, params) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );
  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, c) => (err ? reject(err) : resolve(c)))
    );
  const run = (conn, sql, params) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (err, r) => (err ? reject(err) : resolve(r)))
    );
  const begin = (c) => new Promise((res, rej) => c.beginTransaction((e) => (e ? rej(e) : res())));
  const commit = (c) => new Promise((res, rej) => c.commit((e) => (e ? rej(e) : res())));
  const rollback = (c) => new Promise((res) => c.rollback(() => res()));

  const isoDate = (v) => {
    const t = String(v ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  };
  const cents = (n) => Math.round((Number(n) || 0) * 100);
  const isDr = (v) => String(v ?? "").trim().toUpperCase().startsWith("D");

  /* ── master: batches ── */
  router.get("/pdc-rcd-reversal/jv-batches", async (req, res) => {
    const to = isoDate(req.query.to) || new Date().toISOString().slice(0, 10);
    const from = isoDate(req.query.from) ||
      new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const batchNo = String(req.query.batchNo ?? "").trim();

    const where = [
      "t.TRAN_TYPE = '24'",
      "t.REF_NO IS NOT NULL", "TRIM(t.REF_NO) <> ''",
      "t.DATTE BETWEEN ? AND ?",
    ];
    const params = [from, to];
    if (batchNo) { where.push("t.REF_NO LIKE ?"); params.push(`%${batchNo}%`); }

    try {
      const rows = await q(
        `SELECT t.REF_NO                                                  AS BATCH_NO,
                -- formatted in SQL: a DATE sent as a JS Date shifts a day
                -- across the timezone boundary on the way to the browser
                DATE_FORMAT(MIN(t.DATTE), '%Y-%m-%d')                    AS JV_DATE,
                COUNT(DISTINCT t.vchr_no)                                 AS JV_COUNT,
                SUM(CASE WHEN UPPER(t.DB_CR) LIKE 'D%' THEN t.AMOUNT ELSE 0 END) AS DR_TOTAL,
                SUM(CASE WHEN UPPER(t.DB_CR) LIKE 'D%' THEN 0 ELSE t.AMOUNT END) AS CR_TOTAL
           FROM tran_acc t
          WHERE ${where.join(" AND ")}
          GROUP BY t.REF_NO
          ORDER BY t.REF_NO DESC
          LIMIT 1000`,
        params
      );
      res.json(rows.map((r) => ({
        ...r,
        JV_COUNT: Number(r.JV_COUNT) || 0,
        DR_TOTAL: Number(r.DR_TOTAL) || 0,
        CR_TOTAL: Number(r.CR_TOTAL) || 0,
      })));
    } catch (error) {
      console.error("jv-batches failed:", error.message);
      res.status(500).json({ ok: false, message: "Reversal batches could not be loaded" });
    }
  });

  /* ── detail: every line of every JV in one batch ── */
  router.get("/pdc-rcd-reversal/jv-lines", async (req, res) => {
    const batchNo = String(req.query.batchNo ?? "").trim();
    if (!batchNo) return res.status(400).json({ ok: false, message: "Batch No missing" });

    try {
      const rows = await q(
        `SELECT t.srno_row_id                          AS ROW_ID,
                t.TRAN_TYPE,
                t.vchr_no                              AS VCHR_NO,
                DATE_FORMAT(t.DATTE, '%Y-%m-%d')       AS DATTE,
                t.SR_NO,
                t.ACC_CODE,
                a.ACC_HEAD                             AS ACC_HEAD,
                t.DB_CR,
                t.AMOUNT,
                t.NARRATION1,
                t.REF_NO
           FROM tran_acc t
           LEFT JOIN acc_mst a ON a.ACC_CODE = t.ACC_CODE
          WHERE t.TRAN_TYPE = '24' AND t.REF_NO = ?
          -- Dr before Cr within each JV, serials numerically
          ORDER BY t.vchr_no, UPPER(t.DB_CR) DESC, CAST(t.SR_NO AS UNSIGNED), t.srno_row_id`,
        [batchNo]
      );
      res.json(rows);
    } catch (error) {
      console.error("jv-lines failed:", error.message);
      // The SQL message goes back to the screen: an empty grid with no reason
      // is what made this hard to diagnose the first time.
      res.status(500).json({ ok: false, message: `JV lines could not be loaded — ${error.sqlMessage || error.message}` });
    }
  });

  /* ── the cheques behind a batch (pdc_rcd) ─────────────────────────────────
     Read-only, shown beside the batch list. The party name is taken from
     cus_mst; if that table or its CUST_NAME column is not there, the query
     falls back to the ledger name in acc_mst rather than failing — a missing
     name is better than an empty grid. */
  let partyFromCusMst = true;

  const chequeSql = (withCusMst) => `
    SELECT p.VCHR_NO,
           p.CHQ_NO,
           DATE_FORMAT(p.CHQ_DATE, '%Y-%m-%d')  AS CHQ_DATE,
           p.CHQ_BANK,
           bk.ACC_HEAD                          AS BANK_HEAD,
           ${withCusMst ? "COALESCE(c.CUST_NAME, pa.ACC_HEAD, p.CUST_CODE)" : "COALESCE(pa.ACC_HEAD, p.CUST_CODE)"} AS PARTY,
           p.AMOUNT,
           p.JV_NO_RLZ
      FROM pdc_rcd p
      LEFT JOIN acc_mst bk ON bk.ACC_CODE = p.CHQ_BANK
      LEFT JOIN acc_mst pa ON pa.ACC_CODE = p.CUST_CODE
      ${withCusMst ? "LEFT JOIN cus_mst c ON c.CUST_CODE = p.CUST_CODE" : ""}
     WHERE p.BATCH_NO = ?
     ORDER BY CAST(p.JV_NO_RLZ AS UNSIGNED), p.VCHR_NO, p.CHQ_NO`;

  router.get("/pdc-rcd-reversal/jv-cheques", async (req, res) => {
    const batchNo = String(req.query.batchNo ?? "").trim();
    if (!batchNo) return res.status(400).json({ ok: false, message: "Batch No missing" });
    try {
      let rows;
      try {
        rows = await q(chequeSql(partyFromCusMst), [batchNo]);
      } catch (err) {
        if (partyFromCusMst && (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_FIELD_ERROR")) {
          console.warn("jv-cheques: cus_mst not usable (", err.sqlMessage, ") — party from acc_mst");
          partyFromCusMst = false;
          rows = await q(chequeSql(false), [batchNo]);
        } else {
          throw err;
        }
      }
      res.json(rows);
    } catch (error) {
      console.error("jv-cheques failed:", error.message);
      res.status(500).json({
        ok: false,
        message: `Cheques could not be loaded — ${error.sqlMessage || error.message}`,
      });
    }
  });

  /* ── account name, for an A/c code edited in the grid ── */
  router.get("/pdc-rcd-reversal/acc-name", async (req, res) => {
    const code = String(req.query.code ?? "").trim();
    if (!code) return res.json({ ACC_HEAD: null });
    try {
      const rows = await q("SELECT ACC_HEAD FROM acc_mst WHERE ACC_CODE = ? LIMIT 1", [code]);
      // An account that exists but has no head recorded still counts as found.
      res.json({ ACC_HEAD: rows[0] ? (rows[0].ACC_HEAD || code) : null });
    } catch (error) {
      console.error("acc-name failed:", error.message);
      res.status(500).json({ ACC_HEAD: null });
    }
  });

  /* ── save ──────────────────────────────────────────────────────────────── */
  router.put("/pdc-rcd-reversal/jv-lines", async (req, res) => {
    const batchNo = String(req.body?.batchNo ?? "").trim();
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!batchNo) return res.status(400).json({ ok: false, message: "Batch No missing" });
    if (!lines.length) return res.status(400).json({ ok: false, message: "Nothing to save" });

    // Shape checks first — cheap, and they give the operator a precise reason.
    for (const l of lines) {
      if (!Number.isInteger(Number(l.ROW_ID))) {
        return res.status(400).json({ ok: false, message: "A line has no row id" });
      }
      if (!isoDate(l.DATTE)) {
        return res.status(400).json({ ok: false, message: `JV ${l.VCHR_NO}: invalid date` });
      }
      if (!(Number(l.AMOUNT) > 0)) {
        return res.status(400).json({ ok: false, message: `JV ${l.VCHR_NO}: amount must be above zero` });
      }
      if (!["D", "C"].includes(String(l.DB_CR ?? "").trim().toUpperCase())) {
        return res.status(400).json({ ok: false, message: `JV ${l.VCHR_NO}: Dr/Cr must be D or C` });
      }
    }

    let conn;
    try {
      conn = await getConn();
      await begin(conn);

      // 1. Every row posted must be a type-24 line belonging to THIS batch.
      //    Locked for the transaction, so nothing moves under the check.
      const jvNos = [...new Set(lines.map((l) => String(l.VCHR_NO).trim()))];
      const dbRows = await run(conn,
        `SELECT t.srno_row_id AS ROW_ID, t.vchr_no AS VCHR_NO
           FROM tran_acc t
          WHERE t.TRAN_TYPE = '24' AND t.REF_NO = ? AND t.vchr_no IN (?)
          FOR UPDATE`,
        [batchNo, jvNos]);

      const byJv = new Map();
      dbRows.forEach((r) => {
        if (!byJv.has(r.VCHR_NO)) byJv.set(r.VCHR_NO, new Set());
        byJv.get(r.VCHR_NO).add(Number(r.ROW_ID));
      });
      const known = new Set(dbRows.map((r) => Number(r.ROW_ID)));
      const foreign = lines.find((l) => !known.has(Number(l.ROW_ID)));
      if (foreign) {
        await rollback(conn);
        return res.status(400).json({
          ok: false,
          message: `JV ${foreign.VCHR_NO}: a line does not belong to batch ${batchNo}`,
        });
      }

      // 2. Each JV must arrive complete — a balance check on half a voucher
      //    proves nothing.
      const sentByJv = new Map();
      lines.forEach((l) => {
        const v = String(l.VCHR_NO).trim();
        if (!sentByJv.has(v)) sentByJv.set(v, []);
        sentByJv.get(v).push(l);
      });
      for (const [v, ids] of byJv) {
        const sent = new Set((sentByJv.get(v) || []).map((l) => Number(l.ROW_ID)));
        if (sent.size !== ids.size || [...ids].some((id) => !sent.has(id))) {
          await rollback(conn);
          return res.status(400).json({
            ok: false,
            message: `JV ${v}: not all of its lines were sent — reload the batch and retry`,
          });
        }
      }

      // 3. Dr = Cr, per JV, on the figures about to be written.
      for (const [v, ls] of sentByJv) {
        const dr = ls.filter((l) => isDr(l.DB_CR)).reduce((s, l) => s + cents(l.AMOUNT), 0);
        const cr = ls.filter((l) => !isDr(l.DB_CR)).reduce((s, l) => s + cents(l.AMOUNT), 0);
        if (dr !== cr) {
          await rollback(conn);
          return res.status(400).json({
            ok: false,
            message: `JV ${v} does not balance: Dr ${(dr / 100).toFixed(2)} vs Cr ${(cr / 100).toFixed(2)}`,
          });
        }
        // one date per JV
        const dates = new Set(ls.map((l) => l.DATTE));
        if (dates.size > 1) {
          await rollback(conn);
          return res.status(400).json({ ok: false, message: `JV ${v}: its lines carry different dates` });
        }
      }

      // 4. Every account must exist.
      const codes = [...new Set(lines.map((l) => String(l.ACC_CODE ?? "").trim()))];
      const found = await run(conn, "SELECT ACC_CODE FROM acc_mst WHERE ACC_CODE IN (?)", [codes]);
      const have = new Set(found.map((r) => String(r.ACC_CODE)));
      const missing = codes.filter((c) => !have.has(c));
      if (missing.length) {
        await rollback(conn);
        return res.status(400).json({ ok: false, message: `Unknown account: ${missing.join(", ")}` });
      }

      // 5. Write. Keyed on the row id AND on vchr_no + TRAN_TYPE 24, so a
      //    mismatched id can never touch another voucher's line.
      let updated = 0;
      for (const l of lines) {
        const r = await run(conn,
          `UPDATE tran_acc
              SET DATTE = ?, ACC_CODE = ?, DB_CR = ?, AMOUNT = ?,
                  NARRATION1 = ?
            -- REF_NO is the batch number and part of the address, so it is
            -- matched here and never written
            WHERE srno_row_id = ? AND TRAN_TYPE = '24' AND vchr_no = ? AND REF_NO = ?`,
          [
            l.DATTE,
            String(l.ACC_CODE).trim().slice(0, 20),
            String(l.DB_CR).trim().toUpperCase(),
            Math.round(Number(l.AMOUNT) * 100) / 100,
            String(l.NARRATION1 ?? "").slice(0, 80) || null,
            Number(l.ROW_ID),
            String(l.VCHR_NO).trim(),
            batchNo,
          ]);
        if (r.affectedRows !== 1) {
          await rollback(conn);
          return res.status(409).json({
            ok: false, message: `JV ${l.VCHR_NO}: a line changed underneath — reload and retry`,
          });
        }
        updated += r.changedRows ?? 1;
      }

      // 6. Keep pdc_rcd's record of the JV date in step with the ledger.
      for (const [v, ls] of sentByJv) {
        await run(conn,
          `UPDATE pdc_rcd SET JV_DATE_RLZ = ?
            WHERE BATCH_NO = ?
              AND (JV_NO_RLZ = ? OR LPAD(JV_NO_RLZ, 10, '0') = ?)`,
          [ls[0].DATTE, batchNo, v, v]);
      }

      await commit(conn);
      console.log("jv-lines save:", batchNo, "JVs:", sentByJv.size, "lines updated:", updated);
      res.json({ ok: true, batchNo, jvs: sentByJv.size, updated });
    } catch (error) {
      if (conn) await rollback(conn);
      console.error("jv-lines save failed:", error.message);
      res.status(500).json({ ok: false, message: "Save failed — nothing was changed" });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
