// E:\hayatApi\routes\pcashApi.js — Petty Cash Entry (PcashEnt)
//
//   GET  /api/pcash-next-no                  provisional next voucher no.
//   GET  /api/pcash/:vchrNo                  header + lines + own settlements (TRAN_TYPE 17)
//   GET  /api/pcash-batch-next/:batchNo      next Sr.No within a batch
//   GET  /api/pcash-batch-open                the open batch (+ next batch no. / last limit for a new one)
//   GET  /api/pcash-batch/:no?vno=            limit, used by other vouchers, status, next Sr.No
//   POST /api/pcash-batch                     { batchNo, cashLimit, closeCurrent } open a new batch
//   POST /api/pcash-batch/:no/close           manual close   { remarks }
//   POST /api/pcash-batch/:no/reopen          reopen a manually closed batch
//   POST /api/save-pcash                     hdr + dtl (+ tran_acc, adj_dtl) in one transaction
//   POST /api/ai/pcash_scan                  Gemini: bill image/PDF -> lines
//
// CHECK before first run — these column lists are assumed; align them with the
// insert used by your save-rcp route if any name differs:
//   tran_acc : TRAN_TYPE, VCHR_NO, SR_NO, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1, NARRATION2, REF_NO
//   adj_dtl  : SOURCE_TYPE, SOURCE_DOC, SOURCE_DATE, STLD_TYPE, STLD_DOC, STLD_DATE, CUST_CODE, AMOUNT

const express = require("express");

const TRAN_TYPE = "17"; // petty cash — fixed
const POST_TO_GL = true; // set false if petty cash reaches the G/L only through the reimbursement PV
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const NEXT_VCHR_SQL =
  "SELECT LPAD(COALESCE(MAX(CAST(VCHR_NO AS UNSIGNED)), 0) + 1, 10, '0') AS next FROM pcashexp_hdr";

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get("/pcash-next-no", async (_req, res) => {
    try {
      const [[r]] = await db.query(NEXT_VCHR_SQL);
      res.json({ next: r.next });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/pcash-batch-next/:batchNo", async (req, res) => {
    try {
      const [[r]] = await db.query(
        "SELECT COALESCE(MAX(BATCH_SR), 0) + 1 AS next FROM pcashexp_hdr WHERE BATCH_NO = ? AND VCHR_NO <> ?",
        [req.params.batchNo, req.query.vno || ""]
      );
      res.json({ next: r.next });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ───────── batches (pcashexp_batch) ───────── */

  // q = db or a transaction connection; vno = voucher to leave out of "used"
  async function batchInfo(q, batchNo, vno = "", lock = false) {
    const [[b]] = await q.query(
      `SELECT BATCH_NO, DATE_FORMAT(BATCH_DATE, '%d/%m/%Y') AS BATCH_DATE, CASH_LIMIT, STATUS, CLOSE_TYPE
         FROM pcashexp_batch WHERE BATCH_NO = ?${lock ? " FOR UPDATE" : ""}`,
      [batchNo]
    );
    if (!b) return null;
    const [[u]] = await q.query(
      `SELECT COALESCE(SUM(AMOUNT), 0) AS used, COALESCE(MAX(BATCH_SR), 0) + 1 AS nextSr
         FROM pcashexp_hdr WHERE BATCH_NO = ? AND VCHR_NO <> ?`,
      [batchNo, vno || ""]
    );
    return {
      batchNo: b.BATCH_NO, batchDate: b.BATCH_DATE, cashLimit: Number(b.CASH_LIMIT),
      used: Number(u.used), status: b.STATUS, closeType: b.CLOSE_TYPE || null, nextSr: Number(u.nextSr),
    };
  }

  async function nextBatchNo(q) {
    const [[last]] = await q.query(
      `SELECT BATCH_NO, CASH_LIMIT FROM pcashexp_batch
        ORDER BY CAST(BATCH_NO AS UNSIGNED) DESC, BATCH_NO DESC LIMIT 1`
    );
    if (!last) return { suggestNo: "1", lastLimit: 0 };
    const b = String(last.BATCH_NO);
    return {
      suggestNo: /^\d+$/.test(b) ? String(Number(b) + 1).padStart(b.length, "0") : "",
      lastLimit: Number(last.CASH_LIMIT),
    };
  }

  router.get("/pcash-batch-open", async (_req, res) => {
    try {
      const [[o]] = await db.query(
        `SELECT BATCH_NO FROM pcashexp_batch WHERE STATUS = 'O'
          ORDER BY BATCH_DATE DESC, CAST(BATCH_NO AS UNSIGNED) DESC LIMIT 1`
      );
      const batch = o ? await batchInfo(db, o.BATCH_NO) : null;
      res.json({ batch, ...(await nextBatchNo(db)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/pcash-batch/:no", async (req, res) => {
    try {
      const batch = await batchInfo(db, req.params.no, req.query.vno);
      if (!batch) return res.status(404).json({ error: "Batch not found" });
      res.json({ batch });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/pcash-batch", async (req, res) => {
    const { closeCurrent } = req.body || {};
    const cashLimit = +Number(req.body?.cashLimit || 0).toFixed(2);
    if (!(cashLimit > 0)) return res.status(400).json({ error: "Cash limit must be more than zero" });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [open] = await conn.query("SELECT BATCH_NO FROM pcashexp_batch WHERE STATUS = 'O' FOR UPDATE");
      if (open.length && !closeCurrent) {
        await conn.rollback();
        return res.status(409).json({ error: `Batch ${open[0].BATCH_NO} is still open — close it first` });
      }
      if (open.length) {
        await conn.query(
          `UPDATE pcashexp_batch SET STATUS = 'C', CLOSE_TYPE = 'M', CLOSED_DATE = CURDATE(),
                  CLOSE_REMARKS = 'Closed on opening a new batch'
            WHERE STATUS = 'O'`
        );
      }
      const batchNo = String(req.body?.batchNo || "").trim() || (await nextBatchNo(conn)).suggestNo;
      if (!batchNo) throw new Error("Batch number is required");
      await conn.query(
        "INSERT INTO pcashexp_batch (BATCH_NO, BATCH_DATE, CASH_LIMIT, STATUS) VALUES (?, CURDATE(), ?, 'O')",
        [batchNo, cashLimit]
      );
      const batch = await batchInfo(conn, batchNo);
      await conn.commit();
      res.json({ batch });
    } catch (e) {
      await conn.rollback().catch(() => {});
      const dup = e.code === "ER_DUP_ENTRY";
      res.status(dup ? 409 : 500).json({ error: dup ? "That batch number already exists" : e.message });
    } finally {
      conn.release();
    }
  });

  router.post("/pcash-batch/:no/close", async (req, res) => {
    try {
      const [r] = await db.query(
        `UPDATE pcashexp_batch SET STATUS = 'C', CLOSE_TYPE = 'M', CLOSED_DATE = CURDATE(), CLOSE_REMARKS = ?
          WHERE BATCH_NO = ? AND STATUS = 'O'`,
        [String(req.body?.remarks || "").slice(0, 100) || null, req.params.no]
      );
      if (!r.affectedRows) return res.status(400).json({ error: "Batch not found or already closed" });
      res.json({ batch: await batchInfo(db, req.params.no, req.body?.vno) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/pcash-batch/:no/reopen", async (req, res) => {
    try {
      const [open] = await db.query("SELECT BATCH_NO FROM pcashexp_batch WHERE STATUS = 'O' AND BATCH_NO <> ?", [req.params.no]);
      if (open.length) return res.status(409).json({ error: `Batch ${open[0].BATCH_NO} is open — close it before reopening this one` });
      const [r] = await db.query(
        `UPDATE pcashexp_batch SET STATUS = 'O', CLOSE_TYPE = NULL, CLOSED_DATE = NULL, CLOSE_REMARKS = NULL
          WHERE BATCH_NO = ? AND STATUS = 'C' AND CLOSE_TYPE = 'M'`,
        [req.params.no]
      );
      if (!r.affectedRows) return res.status(400).json({ error: "Only a manually closed batch can be reopened" });
      res.json({ batch: await batchInfo(db, req.params.no, req.body?.vno) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Account heads looked up separately: comparing against bound values avoids
  // "Illegal mix of collations" between migrated tables and the ac_list view.
  async function headsFor(codes) {
    const list = [...new Set(codes.filter(Boolean).map(String))];
    if (!list.length) return {};
    const [rows] = await db.query("SELECT AC_CODE, AC_HEAD FROM ac_list WHERE AC_CODE IN (?)", [list]);
    return Object.fromEntries(rows.map((r) => [String(r.AC_CODE), r.AC_HEAD]));
  }

  router.get("/pcash/:vchrNo", async (req, res) => {
    const vno = req.params.vchrNo;
    const tt = TRAN_TYPE;
    try {
      const [hdr] = await db.query(
        `SELECT VCHR_NO, DATE_FORMAT(VCHR_DATE, '%d/%m/%Y') AS VCHR_DATE, AMOUNT,
                ACC_CODE_CR, NARRATION, BATCH_NO, BATCH_SR
           FROM pcashexp_hdr WHERE VCHR_NO = ?`,
        [vno]
      );
      if (!hdr.length) return res.json({ hdr: null, lines: [], stl: [] });

      const [lines] = await db.query(
        `SELECT CAST(SR_NO AS UNSIGNED) AS SR_NO, DR_CODE, JOB_NO, BILL_DESC, SUPPLIER, INV_NO, AMOUNT
           FROM pcashexp_dtl WHERE VCHR_NO = ?
          ORDER BY CAST(SR_NO AS UNSIGNED), srno_row_id`,
        [vno]
      );

      // Heads are cosmetic — a lookup failure must not stop the voucher opening.
      let heads = {};
      try {
        heads = await headsFor([hdr[0].ACC_CODE_CR, ...lines.map((l) => l.DR_CODE)]);
      } catch (e) {
        console.warn("pcash heads lookup:", e.message);
      }
      hdr[0].CR_HEAD = heads[hdr[0].ACC_CODE_CR] || "";
      lines.forEach((l) => { l.ACC_HEAD = heads[l.DR_CODE] || ""; });

      // Settlements are optional too — if adj_dtl's columns differ, open without them.
      let stl = [];
      try {
        [stl] = await db.query(
          `SELECT CUST_CODE, STLD_TYPE, STLD_DOC, AMOUNT
             FROM adj_dtl WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ?`,
          [tt, vno]
        );
      } catch (e) {
        console.warn("pcash adj_dtl lookup:", e.message);
      }

      res.json({ hdr: hdr[0], lines, stl });
    } catch (e) {
      console.error("GET /pcash:", e);
      res.status(500).json({ error: e.sqlMessage || e.message });
    }
  });

  router.post("/save-pcash", async (req, res) => {
    const { mode, hdr, lines, stl } = req.body || {};
    if (!hdr || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: "Nothing to save" });
    }
    if (!hdr.CrAc) return res.status(400).json({ error: "Credit A/c is required" });
    if (lines.some((l) => !l.DrCode || !(Number(l.Amount) > 0))) {
      return res.status(400).json({ error: "Every line needs a Dr A/c and a positive amount" });
    }

    const tt = TRAN_TYPE;
    const vDate = hdr.VchrDate;
    const total = +lines.reduce((s, l) => s + Number(l.Amount), 0).toFixed(2);

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // ADD: allot the number inside the transaction so two users can't collide
      // and an existing voucher is never overwritten.
      let vno = hdr.VchrNo;
      if (mode === "ADD") {
        await conn.query("SELECT VCHR_NO FROM pcashexp_hdr ORDER BY VCHR_NO DESC LIMIT 1 FOR UPDATE");
        const [[n]] = await conn.query(NEXT_VCHR_SQL);
        vno = n.next;
      }
      if (!vno) throw new Error("Voucher number missing");

      // ── batch (cash float) rules, under a row lock on the batch ──
      if (!hdr.BatchNo) throw Object.assign(new Error("Batch No is required"), { status: 400 });
      const b = await batchInfo(conn, hdr.BatchNo, vno, true);
      if (!b) throw Object.assign(new Error(`Batch ${hdr.BatchNo} not found`), { status: 400 });
      // previous batch of this voucher (EDIT may move it to another batch)
      const [[prev]] = await conn.query("SELECT BATCH_NO FROM pcashexp_hdr WHERE VCHR_NO = ?", [vno]);
      // A batch that closed itself (cash spent) still accepts corrections to its own vouchers
      const correcting = mode !== "ADD" && prev && prev.BATCH_NO === hdr.BatchNo && b.closeType === "A";
      if (b.status !== "O" && !correcting) {
        throw Object.assign(new Error(`Batch ${hdr.BatchNo} is closed`), { status: 400 });
      }
      const balance = +(b.cashLimit - b.used).toFixed(2);
      if (total > balance + 0.005) {
        throw Object.assign(new Error(`Voucher total ${total.toFixed(2)} exceeds the batch balance ${balance.toFixed(2)}`), { status: 400 });
      }

      // ADD: Sr.No on screen is provisional — allot it here
      let batchSr = hdr.BatchSr ? Number(hdr.BatchSr) : null;
      if (mode === "ADD" || !batchSr || (prev && prev.BATCH_NO !== hdr.BatchNo)) batchSr = b.nextSr;

      await conn.query(
        `INSERT INTO pcashexp_hdr (VCHR_NO, VCHR_DATE, AMOUNT, ACC_CODE_CR, NARRATION, BATCH_NO, BATCH_SR)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE VCHR_DATE = VALUES(VCHR_DATE), AMOUNT = VALUES(AMOUNT),
           ACC_CODE_CR = VALUES(ACC_CODE_CR), NARRATION = VALUES(NARRATION),
           BATCH_NO = VALUES(BATCH_NO), BATCH_SR = VALUES(BATCH_SR)`,
        [vno, vDate, total, hdr.CrAc, hdr.Narration || null, hdr.BatchNo || null, batchSr]
      );

      // Cash fully spent → close the batch automatically; a correction that frees cash reopens it
      let batchClosed = false;
      if (b.status === "C" && balance - total > 0.005) {
        await conn.query(
          "UPDATE pcashexp_batch SET STATUS = 'O', CLOSE_TYPE = NULL, CLOSED_DATE = NULL, CLOSE_REMARKS = NULL WHERE BATCH_NO = ?",
          [hdr.BatchNo]
        );
      } else if (b.status === "O" && balance - total <= 0.005) {
        await conn.query(
          `UPDATE pcashexp_batch SET STATUS = 'C', CLOSE_TYPE = 'A', CLOSED_DATE = CURDATE(),
                  CLOSE_REMARKS = 'Cash limit fully spent' WHERE BATCH_NO = ?`,
          [hdr.BatchNo]
        );
        batchClosed = true;
      }
      // Voucher moved out of an auto-closed batch → that batch has cash again
      if (prev && prev.BATCH_NO && prev.BATCH_NO !== hdr.BatchNo) {
        const pb = await batchInfo(conn, prev.BATCH_NO, "", true);
        if (pb && pb.status === "C" && pb.closeType === "A" && pb.cashLimit - pb.used > 0.005) {
          await conn.query(
            "UPDATE pcashexp_batch SET STATUS = 'O', CLOSE_TYPE = NULL, CLOSED_DATE = NULL, CLOSE_REMARKS = NULL WHERE BATCH_NO = ?",
            [prev.BATCH_NO]
          );
        }
      }

      await conn.query("DELETE FROM pcashexp_dtl WHERE VCHR_NO = ?", [vno]);
      await conn.query(
        `INSERT INTO pcashexp_dtl (VCHR_NO, VCHR_DATE, SR_NO, BILL_DESC, SUPPLIER, INV_NO, DR_CODE, CR_CODE, AMOUNT, JOB_NO)
         VALUES ?`,
        [lines.map((l, i) => [
          vno, vDate, String(i + 1), (l.BillDesc || "").slice(0, 40), l.Supplier ? String(l.Supplier).slice(0, 40) : null,
          l.InvNo ? String(l.InvNo).slice(0, 20) : null, l.DrCode, hdr.CrAc, Number(l.Amount), l.JobNo || null,
        ])]
      );

      if (POST_TO_GL) {
        await conn.query("DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?", [tt, vno]);
        const gl = lines.map((l, i) => [
          tt, vno, i + 1, vDate, l.DrCode, Number(l.Amount), "D", l.BillDesc || null, hdr.Narration || null, l.JobNo || null,
        ]);
        gl.push([tt, vno, lines.length + 1, vDate, hdr.CrAc, total, "C", hdr.Narration || "Petty cash", null, null]);
        await conn.query(
          `INSERT INTO tran_acc (TRAN_TYPE, VCHR_NO, SR_NO, DATTE, ACC_CODE, AMOUNT, DB_CR, NARRATION1, NARRATION2, REF_NO)
           VALUES ?`,
          [gl]
        );
      }

      // Settlements: only parties the user opened in this session are replaced,
      // so untouched parties keep their existing adj_dtl rows.
      const parties = (stl && Array.isArray(stl.parties) ? stl.parties : []).filter(Boolean);
      if (parties.length) {
        await conn.query(
          "DELETE FROM adj_dtl WHERE SOURCE_TYPE = ? AND SOURCE_DOC = ? AND CUST_CODE IN (?)",
          [tt, vno, parties]
        );
        const rows = (stl.rows || []).filter((r) => Number(r.Amount) !== 0);
        if (rows.length) {
          await conn.query(
            `INSERT INTO adj_dtl (SOURCE_TYPE, SOURCE_DOC, SOURCE_DATE, STLD_TYPE, STLD_DOC, STLD_DATE, CUST_CODE, AMOUNT)
             VALUES ?`,
            [rows.map((r) => [tt, vno, vDate, r.StldType || null, r.StldDoc, r.StldDate || null, r.CustCode, Number(r.Amount)])]
          );
        }
      }

      const batchAfter = await batchInfo(conn, hdr.BatchNo, vno);
      await conn.commit();
      res.json({ ok: true, vchrNo: vno, batchSr, batch: batchAfter, batchClosed });
    } catch (e) {
      await conn.rollback().catch(() => {});
      console.error("save-pcash:", e);
      const dup = e.code === "ER_DUP_ENTRY" && /batch/i.test(e.message);
      res.status(dup ? 409 : e.status || 500).json({ error: dup ? "This Batch No / Sr.No is already used" : e.message });
    } finally {
      conn.release();
    }
  });

  router.post("/ai/pcash_scan", async (req, res) => {
    const { fileBase64, mimeType } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: "No file received" });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });

    const prompt = `You are reading petty-cash bills / receipts from a UAE company (amounts normally in AED).
The image or PDF may contain ONE or SEVERAL separate bills. Return one entry per bill.
For each bill give:
  supplier      - shop / supplier name
  invoice_no    - bill or invoice number, "" if none
  invoice_date  - dd/mm/yyyy, "" if unreadable
  description   - what was bought, short, max 40 characters (e.g. "Diesel for pickup", "Stationery - A4 paper")
  vat_amount    - VAT on the bill, 0 if none shown
  total_amount  - grand total payable INCLUDING VAT
Never invent values; use "" or 0 when unreadable. Ignore anything that is not a bill.
Reply with JSON only: {"bills":[{"supplier":"","invoice_no":"","invoice_date":"","description":"","vat_amount":0,"total_amount":0}]}`;

    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType || "image/jpeg", data: fileBase64 } }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0 },
          }),
        }
      );
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ error: j?.error?.message || "AI service error" });

      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/^```json\s*|```$/g, "").trim());
      } catch {
        return res.status(502).json({ error: "AI reply was not valid JSON" });
      }
      const bills = Array.isArray(parsed) ? parsed : parsed.bills || [];
      const n = (v) => +(parseFloat(String(v ?? "").replace(/,/g, "")) || 0).toFixed(2);
      const lines = bills.map((b) => ({
        supplier: String(b.supplier || "").trim(),
        invNo: String(b.invoice_no || "").trim(),
        invDate: String(b.invoice_date || "").trim(),
        description: String(b.description || "").trim().slice(0, 40),
        vat: n(b.vat_amount),
        amount: n(b.total_amount),
      }));
      res.json({ lines });
    } catch (e) {
      console.error("pcash_scan:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
