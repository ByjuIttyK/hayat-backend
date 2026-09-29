// routes/cusVarTrace.js
// ─────────────────────────────────────────────────────────────────────
// Ledger Variance Trace — customer ledger + its adj_dtl settlements
//
//   GET  /api/cus-var-trace/ledger?acc=&as_on=
//        ledger lines up to the as-on date, the customer's debit documents
//        (for the invoice list), and every adj_dtl line of the customer
//   POST /api/cus-var-trace/save       { acc, src: "03|0000002528", lines: [...] }
//        replaces the adj_dtl lines of ONE credit voucher (like InvSettle)
//   POST /api/cus-var-trace/fix-dates  { acc }
//        sets adj_dtl STLD_DATE (and SOURCE_DATE) to the tran_acc.DATTE of
//        the documents they point at, for this customer's lines
//
// Lines are written like InvSettle: STLD_DBCR 'D' unless given, MAIN_SR_NO
// = line serial within the source voucher, DIV_CODE (when it fits adj_dtl's
// 2 chars) and REF_NO from the source voucher, STLD_DATE from the settled
// document. tran_acc.AMT_SETTLED is re-synced after a save.
// Needs no srno_row_id on adj_dtl.
//
// Register in HayatDb.js:
//   const cusVarTraceRoutes = require("./routes/cusVarTrace");
//   app.use("/api", authMiddleware, cusVarTraceRoutes(connection));
// ─────────────────────────────────────────────────────────────────────
const express = require("express");

const TOL = 0.005;
const SYNC_AMT_SETTLED = true;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const okDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/* One row per document and side, with its date and first line's div/ref. */
async function docsOf(q, acc, dbCr) {
  const [rows] = await q.query(
    `SELECT t.TRAN_TYPE AS tranType, t.vchr_no AS vchrNo,
            DATE_FORMAT(MIN(t.DATTE), '%Y-%m-%d') AS datte,
            SUM(t.AMOUNT) AS amount, MAX(t.NARRATION1) AS narration,
            MAX(t.DIV_CODE) AS divCode, MAX(t.REF_NO) AS refNo,
            MAX(tt.TYPE_ABBR) AS typeAbbr
       FROM tran_acc t
  LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
      WHERE t.ACC_CODE = ? AND t.DB_CR = ?
   GROUP BY t.TRAN_TYPE, t.vchr_no`, [acc, dbCr]);
  return rows.map((d) => ({ ...d, key: `${d.tranType}|${d.vchrNo}`, amount: r2(d.amount), typeAbbr: d.typeAbbr || d.tranType }));
}

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const fail = (res, err, where) => {
    console.error(`[cusVarTrace] ${where}:`, err);
    res.status(500).json({ error: `${where} failed`, detail: err.message });
  };

  // ── Ledger, debit documents and adj_dtl lines of one customer ──────
  router.get("/cus-var-trace/ledger", async (req, res) => {
    const acc = String(req.query.acc || "").trim();
    const asOn = okDate(req.query.as_on) ? req.query.as_on : today();
    if (!acc) return res.status(400).json({ error: "acc is required" });
    try {
      const [[cus]] = await db.query("SELECT CUST_NAME AS name FROM cus_mst WHERE CUST_CODE = ?", [acc]);
      const [ledger] = await db.query(
        `SELECT t.srno_row_id AS id, DATE_FORMAT(t.DATTE, '%Y-%m-%d') AS datte,
                t.TRAN_TYPE AS tranType, COALESCE(tt.TYPE_ABBR, t.TRAN_TYPE) AS typeAbbr,
                t.vchr_no AS vchrNo, t.NARRATION1 AS narration, t.NARRATION2 AS narration2,
                t.DB_CR AS dbCr, t.AMOUNT AS amount
           FROM tran_acc t
      LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
          WHERE t.ACC_CODE = ? AND t.DATTE <= ?
       ORDER BY t.DATTE, t.TRAN_TYPE, t.vchr_no, t.srno_row_id`, [acc, asOn]);
      const debits = await docsOf(db, acc, "D");
      const [adj] = await db.query(
        `SELECT SOURCE_TYPE AS srcType, SOURCE_DOC AS srcDoc,
                DATE_FORMAT(SOURCE_DATE, '%Y-%m-%d') AS srcDate,
                STLD_TYPE AS stldType, STLD_DOC AS stldDoc,
                DATE_FORMAT(STLD_DATE, '%Y-%m-%d') AS stldDate,
                STLD_AMT AS amt, STLD_DBCR AS dbcr, MAIN_SR_NO AS mainSrNo
           FROM adj_dtl
          WHERE ACC_CODE = ?
       ORDER BY SOURCE_TYPE, SOURCE_DOC, MAIN_SR_NO`, [acc]);
      res.json({
        acc, name: cus?.name ?? "", asOn,
        ledger: ledger.map((l) => ({ ...l, amount: r2(l.amount) })),
        debits,
        adj: adj.map((a) => ({ ...a, amt: r2(a.amt), mainSrNo: Number(a.mainSrNo) || 0 })),
      });
    } catch (err) { fail(res, err, "ledger"); }
  });

  // ── Save the settlements of one credit voucher ──────────────────────
  router.post("/cus-var-trace/save", async (req, res) => {
    const acc = String(req.body?.acc || "").trim();
    const [srcType, srcDoc] = String(req.body?.src || "").split("|");
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).map((l) => ({
      key: `${String(l.stldType || "").trim()}|${String(l.stldDoc || "").trim()}`,
      amt: r2(l.amt), dbcr: String(l.dbcr || "D").trim().toUpperCase().slice(0, 1) || "D",
    }));
    if (!acc || !srcType || !srcDoc) return res.status(400).json({ error: "acc and src are required" });
    for (let i = 0; i < lines.length; i++) {
      if (!(lines[i].amt > 0)) return res.status(400).json({ error: `Line ${i + 1}: enter an amount greater than zero` });
    }
    const dup = lines.map((l) => l.key).find((k, i, a) => a.indexOf(k) !== i);
    if (dup) return res.status(400).json({ error: `${dup.split("|")[1]} appears twice` });

    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();
      const bad = async (msg) => { await conn.rollback(); res.status(400).json({ error: msg }); };

      const credits = await docsOf(conn, acc, "C");
      const src = credits.find((d) => d.tranType === srcType && d.vchrNo === srcDoc);
      if (!src) return bad(`${srcDoc} is not a credit entry of ${acc}`);
      const total = r2(lines.reduce((s, l) => s + l.amt, 0));
      if (total - src.amount > TOL) return bad(`Settled ${total.toFixed(2)} is more than the voucher amount ${src.amount.toFixed(2)}`);

      // Open amount of each debit, leaving out this voucher's own old lines
      const debits = new Map((await docsOf(conn, acc, "D")).map((d) => [d.key, d]));
      const [used] = await conn.query(
        `SELECT STLD_TYPE AS t, STLD_DOC AS d, SUM(STLD_AMT) AS s FROM adj_dtl
          WHERE ACC_CODE = ? AND NOT (SOURCE_TYPE = ? AND SOURCE_DOC = ?)
       GROUP BY STLD_TYPE, STLD_DOC`, [acc, srcType, srcDoc]);
      const usedBy = new Map(used.map((u) => [`${u.t}|${u.d}`, r2(u.s)]));
      for (const l of lines) {
        const d = debits.get(l.key);
        if (!d) return bad(`${l.key.split("|")[1]} is not a debit entry of ${acc}`);
        const open = r2(d.amount - (usedBy.get(l.key) || 0));
        if (l.amt - open > TOL) return bad(`${d.vchrNo}: ${l.amt.toFixed(2)} is more than its open ${open.toFixed(2)}`);
      }

      const [old] = await conn.query(
        `SELECT DISTINCT STLD_TYPE AS t, STLD_DOC AS d FROM adj_dtl
          WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ? AND ACC_CODE = ?`, [srcType, srcDoc, acc]);
      await conn.query("DELETE FROM adj_dtl WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ? AND ACC_CODE = ?", [srcType, srcDoc, acc]);
      // lines of the same voucher under other accounts (a JV) keep their serials
      const [[mx]] = await conn.query(
        "SELECT COALESCE(MAX(MAIN_SR_NO), 0) AS m FROM adj_dtl WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?", [srcType, srcDoc]);
      let sr = Number(mx.m) || 0;
      for (const l of lines) {
        const d = debits.get(l.key);
        await conn.query(
          `INSERT INTO adj_dtl
             (SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE, ACC_CODE,
              STLD_DOC, STLD_TYPE, STLD_AMT, STLD_DBCR, STLD_DATE,
              DIV_CODE, MAIN_SR_NO, REF_NO)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [srcDoc, srcType, src.datte, acc, d.vchrNo, d.tranType, l.amt, l.dbcr, d.datte,
           // adj_dtl.DIV_CODE is varchar(2): keep the voucher's code only if it fits
           src.divCode != null && String(src.divCode).trim().length <= 2 ? String(src.divCode).trim() : null,
           ++sr, src.refNo ?? null]);
      }

      if (SYNC_AMT_SETTLED) {
        await conn.query(
          `UPDATE tran_acc SET AMT_SETTLED = ? WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ? AND DB_CR = 'C'`,
          [total, srcType, srcDoc, acc]);
        const touched = new Set([...old.map((o) => `${o.t}|${o.d}`), ...lines.map((l) => l.key)]);
        for (const k of touched) {
          const [t, d] = k.split("|");
          await conn.query(
            `UPDATE tran_acc SET AMT_SETTLED = (
                SELECT COALESCE(SUM(STLD_AMT), 0) FROM adj_dtl WHERE STLD_TYPE = ? AND STLD_DOC = ? AND ACC_CODE = ?)
              WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ? AND DB_CR = 'D'`, [t, d, acc, t, d, acc]);
        }
      }
      await conn.commit();
      res.json({ ok: true, saved: lines.length, total });
    } catch (err) {
      if (conn) { try { await conn.rollback(); } catch (e) { console.error(e); } }
      fail(res, err, "save settlements");
    } finally {
      if (conn) conn.release();
    }
  });

  // ── Fix adj_dtl dates of this customer ──────────────────────────────
  router.post("/cus-var-trace/fix-dates", async (req, res) => {
    const acc = String(req.body?.acc || "").trim();
    if (!acc) return res.status(400).json({ error: "acc is required" });
    const docDates = `(SELECT TRAN_TYPE, vchr_no, MIN(DATTE) AS d FROM tran_acc WHERE ACC_CODE = ? GROUP BY TRAN_TYPE, vchr_no)`;
    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();
      const [s] = await conn.query(
        `UPDATE adj_dtl a JOIN ${docDates} t ON t.TRAN_TYPE = a.STLD_TYPE AND t.vchr_no = a.STLD_DOC
            SET a.STLD_DATE = t.d
          WHERE a.ACC_CODE = ? AND (a.STLD_DATE IS NULL OR a.STLD_DATE <> t.d)`, [acc, acc]);
      const [o] = await conn.query(
        `UPDATE adj_dtl a JOIN ${docDates} t ON t.TRAN_TYPE = a.SOURCE_TYPE AND t.vchr_no = a.SOURCE_DOC
            SET a.SOURCE_DATE = t.d
          WHERE a.ACC_CODE = ? AND (a.SOURCE_DATE IS NULL OR a.SOURCE_DATE <> t.d)`, [acc, acc]);
      await conn.commit();
      res.json({ ok: true, stldFixed: s.affectedRows, sourceFixed: o.affectedRows });
    } catch (err) {
      if (conn) { try { await conn.rollback(); } catch (e) { console.error(e); } }
      fail(res, err, "fix dates");
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
