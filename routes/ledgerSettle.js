// routes/ledgerSettle.js — settle from the Ledger of A/c (10-Nov-2026)
//
// Register in HayatDb.js like the other ledger routes:
//   app.use("/api", authMiddleware, require("./routes/ledgerSettle")(connection));
//
//   GET  /api/ledger-open-items/:acc?side=C|S
//        Every document on the party's account with what is still open:
//          open = party line amount (tran_acc) − what adj_dtl already settles.
//        The invoice side (Dr for a customer, Cr for a supplier) is matched on adj_dtl STLD_TYPE/STLD_DOC,
//        the other side (receipts, payments, JVs, returns) on SOURCE_TYPE/SOURCE_DOC — the same
//        direction the Ledger's Invoice Settlements panel and InvSettle use.
//
//   POST /api/ledger-settle
//        { acc, side: "C"|"S", anchor: { tranType, vchrNo }, lines: [{ tranType, vchrNo, amount }], user }
//        Writes one adj_dtl row per line, in one transaction. Every open amount is re-checked under a
//        per-party lock, so two users cannot settle the same invoice twice.

const express = require("express");

// tran_acc.AMT_SETTLED — set true if other screens / reports read that column and it should follow adj_dtl.
// Left off until it is confirmed how InvSettle treats it.
const UPDATE_AMT_SETTLED = false;

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const OPEN_SQL = `
SELECT x.TRAN_TYPE, x.VCHR_NO, x.DC, x.DB_CR, x.DATE_ISO, x.NARR, x.AMT, x.DIV_CODE, x.MAIN_SR_NO, x.REF_NO,
       x.TYPE_ABBR,
       ROUND(x.AMT - COALESCE(IF(x.DC = ?, s.SETTLED, a.SETTLED), 0), 2) AS OPEN_AMT
FROM (
  SELECT t.TRAN_TYPE, t.vchr_no AS VCHR_NO,
         UPPER(LEFT(TRIM(t.DB_CR), 1)) AS DC, MAX(t.DB_CR) AS DB_CR,
         DATE_FORMAT(MIN(t.DATTE), '%Y-%m-%d') AS DATE_ISO,
         TRIM(CONCAT_WS(' ', MAX(t.NARRATION1), MAX(t.NARRATION2))) AS NARR,
         SUM(t.AMOUNT) AS AMT,
         MAX(t.DIV_CODE) AS DIV_CODE, MAX(t.MAIN_SR_NO) AS MAIN_SR_NO, MAX(t.REF_NO) AS REF_NO,
         MAX(tt.TYPE_ABBR) AS TYPE_ABBR
  FROM tran_acc t
  LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
  WHERE t.ACC_CODE = ?
  GROUP BY t.TRAN_TYPE, t.vchr_no, UPPER(LEFT(TRIM(t.DB_CR), 1))
) x
LEFT JOIN (SELECT STLD_TYPE, STLD_DOC, SUM(STLD_AMT) AS SETTLED
             FROM adj_dtl WHERE ACC_CODE = ? GROUP BY STLD_TYPE, STLD_DOC) s
       ON s.STLD_TYPE = x.TRAN_TYPE AND s.STLD_DOC = x.VCHR_NO
LEFT JOIN (SELECT SOURCE_TYPE, SOURCE_DOC, SUM(STLD_AMT) AS SETTLED
             FROM adj_dtl WHERE ACC_CODE = ? GROUP BY SOURCE_TYPE, SOURCE_DOC) a
       ON a.SOURCE_TYPE = x.TRAN_TYPE AND a.SOURCE_DOC = x.VCHR_NO
ORDER BY x.DATE_ISO, x.TRAN_TYPE, x.VCHR_NO`;

module.exports = (connection) => {
  const router = express.Router();
  const pool = connection.promise ? connection.promise() : connection;

  // A pooled connection when there is a pool (needed for the transaction), else the shared one.
  const getConn = async () => {
    if (typeof pool.getConnection === "function") {
      const c = await pool.getConnection();
      return { c, release: () => c.release() };
    }
    return { c: pool, release: () => {} };
  };

  const loadOpen = async (db, acc, invoiceDc) => {
    const [rows] = await db.query(OPEN_SQL, [invoiceDc, acc, acc, acc]);
    return rows;
  };

  // ── open documents of a party ──
  router.get("/ledger-open-items/:acc", async (req, res) => {
    const acc = String(req.params.acc || "").trim();
    const side = String(req.query.side || "C").toUpperCase() === "S" ? "S" : "C";
    if (!acc) return res.status(400).json({ message: "Party code is required." });
    try {
      const rows = await loadOpen(pool, acc, side === "C" ? "D" : "C");
      // fully settled documents are returned too, so the panel can say the highlighted one is settled
      res.json({ items: rows });
    } catch (err) {
      console.error("ledger-open-items:", err);
      res.status(500).json({ message: "Couldn't load the open documents: " + err.message });
    }
  });

  // ── save a settlement ──
  router.post("/ledger-settle", async (req, res) => {
    const { acc: accIn, side: sideIn, anchor, lines } = req.body || {};
    const acc = String(accIn || "").trim();
    const side = String(sideIn || "C").toUpperCase() === "S" ? "S" : "C";
    const invoiceDc = side === "C" ? "D" : "C";

    if (!acc || !anchor?.tranType || !anchor?.vchrNo) {
      return res.status(400).json({ message: "Party and the highlighted document are required." });
    }
    const want = (Array.isArray(lines) ? lines : [])
      .map((l) => ({ tranType: String(l.tranType || "").trim(), vchrNo: String(l.vchrNo || "").trim(), amount: r2(l.amount) }))
      .filter((l) => l.tranType && l.vchrNo && l.amount > 0);
    if (!want.length) return res.status(400).json({ message: "Pick at least one line to settle." });

    const lockName = `adj_${acc}`.slice(0, 64);
    const { c, release } = await getConn();
    let locked = false;
    try {
      const [[lk]] = await c.query("SELECT GET_LOCK(?, 15) AS got", [lockName]);
      if (!lk || Number(lk.got) !== 1) {
        return res.status(409).json({ message: "Another settlement for this party is being saved. Try again in a moment." });
      }
      locked = true;

      await c.query("START TRANSACTION");
      const rows = await loadOpen(c, acc, invoiceDc);

      const anc = rows.find((r) => r.TRAN_TYPE === anchor.tranType && r.VCHR_NO === anchor.vchrNo && Number(r.OPEN_AMT) > 0.005)
        || rows.find((r) => r.TRAN_TYPE === anchor.tranType && r.VCHR_NO === anchor.vchrNo);
      if (!anc) throw httpErr(400, `${anchor.tranType} ${anchor.vchrNo} has no line on account ${acc}.`);

      let ancOpen = r2(anc.OPEN_AMT);
      const total = r2(want.reduce((t, l) => t + l.amount, 0));
      if (total - ancOpen > 0.005) {
        throw httpErr(409, `${anc.TYPE_ABBR || anc.TRAN_TYPE} ${anc.VCHR_NO} has only ${ancOpen.toFixed(2)} open now — someone may have settled it meanwhile. Reopen the panel.`);
      }

      const inserted = [];
      for (const l of want) {
        const doc = rows.find((r) => r.TRAN_TYPE === l.tranType && r.VCHR_NO === l.vchrNo && r.DC !== anc.DC);
        if (!doc) throw httpErr(400, `${l.tranType} ${l.vchrNo} is not on the other side of account ${acc}.`);
        const docOpen = r2(doc.OPEN_AMT);
        if (l.amount - docOpen > 0.005) {
          throw httpErr(409, `${doc.TYPE_ABBR || doc.TRAN_TYPE} ${doc.VCHR_NO} has only ${docOpen.toFixed(2)} open now. Reopen the panel.`);
        }

        // source = receipt / payment / JV / return side, stld = the invoice side
        const stld = anc.DC === invoiceDc ? anc : doc;
        const src = anc.DC === invoiceDc ? doc : anc;

        await c.query(
          `INSERT INTO adj_dtl
             (SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE, ACC_CODE, STLD_DOC, STLD_TYPE, STLD_AMT, STLD_DBCR,
              STLD_DATE, DIV_CODE, MAIN_SR_NO, REF_NO)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            src.VCHR_NO, src.TRAN_TYPE, src.DATE_ISO, acc,
            stld.VCHR_NO, stld.TRAN_TYPE, l.amount, stld.DB_CR,
            stld.DATE_ISO, src.DIV_CODE ?? stld.DIV_CODE ?? null, src.MAIN_SR_NO ?? null, src.REF_NO ?? null,
          ]
        );

        if (UPDATE_AMT_SETTLED) {
          for (const d of [src, stld]) {
            await c.query(
              "UPDATE tran_acc SET AMT_SETTLED = COALESCE(AMT_SETTLED, 0) + ? WHERE TRAN_TYPE = ? AND vchr_no = ? AND ACC_CODE = ?",
              [l.amount, d.TRAN_TYPE, d.VCHR_NO, acc]
            );
          }
        }

        doc.OPEN_AMT = r2(docOpen - l.amount);
        ancOpen = r2(ancOpen - l.amount);
        inserted.push(`${doc.TYPE_ABBR || doc.TRAN_TYPE} ${doc.VCHR_NO} ${l.amount.toFixed(2)}`);
      }

      await c.query("COMMIT");
      res.json({
        ok: true,
        inserted: inserted.length,
        open: ancOpen,
        message: `Saved — ${inserted.length} line${inserted.length > 1 ? "s" : ""} (${total.toFixed(2)}). `
          + (ancOpen > 0.005 ? `${ancOpen.toFixed(2)} still open.` : "Fully settled."),
      });
    } catch (err) {
      try { await c.query("ROLLBACK"); } catch { /* not in a transaction */ }
      if (!err.status) console.error("ledger-settle:", err);
      res.status(err.status || 500).json({ message: err.status ? err.message : "Couldn't save the settlement: " + err.message });
    } finally {
      if (locked) { try { await c.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch { /* ignore */ } }
      release();
    }
  });

  return router;
};

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
