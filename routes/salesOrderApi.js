/* ─────────────────────────────────────────────────────────────────────────────
   Sales Order (SLSORD) routes — slsord_hdr / slsord_item
   Register in HayatDb.js:
       const salesOrderApi = require("./routes/salesOrderApi");
       app.use("/api", salesOrderApi(connection));

     GET  /api/slsord-next-no             → { nextNo }
     GET  /api/slsord-list?q=             → recent orders (Find list, F9 on Order No)
     GET  /api/slsord/:no                 → { header, items }
     GET  /api/slsord-last-price?item=&cust=&excl=&limit=
                                          → previous rates for an item
     PUT  /api/save-slsord                → { ordNo }   header + lines, one transaction
     PUT  /api/slsord-cancel/:no          → marks CANCELLED = 'Y'

   Table names are lower case throughout — the VPS runs lower_case_table_names=0.
   Sales orders do not post to the G/L.
   ───────────────────────────────────────────────────────────────────────────── */
const express = require("express");

// Order numbers are PREFIX + zero-padded running number, 10 characters in all
// (SLSORD_NO is varchar(10)).  Change the prefix here if the client wants one.
const ORDER_PREFIX = "SO";
const ORDER_LEN = 10;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const str = (v, max) => {
  const s = v == null ? "" : String(v).trim();
  return max ? s.slice(0, max) : s;
};
const nz = (v, max) => {
  const s = str(v, max);
  return s === "" ? null : s;
};

// dd/MM/yyyy (as keyed on screen) → 'yyyy-MM-dd' for MySQL. Anything else → null.
const dmyToDb = (v) => {
  const t = str(v);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return null;
};

/* Line arithmetic — the same rules as the screen, recomputed here so the
   database never depends on what the browser sent.
     gross  = qty × rate
     disc   = gross × disc% / 100
     amount = gross − disc          (taxable)
     vat    = amount × vat% / 100
     net    = amount + vat                                                  */
const calcLine = (l) => {
  const qty = num(l.QTY);
  const rate = num(l.RATE);
  const discPer = num(l.DISC_PER);
  const vatPer = num(l.VAT_PERC);
  const gross = r2(qty * rate);
  const disc = r2((gross * discPer) / 100);
  const amount = r2(gross - disc);
  const vat = r2((amount * vatPer) / 100);
  return { qty, rate, discPer, vatPer, gross, disc, amount, vat, net: r2(amount + vat) };
};

const isFilled = (l) =>
  str(l.ITEM_CODE) !== "" || str(l.ITEM_NAME) !== "" || str(l.CLIENT_DESC) !== "" || num(l.QTY) > 0;

module.exports = function (connection) {
  const router = express.Router();
  // mysql2 callback pool → promise pool for transactions.
  const pool = typeof connection.promise === "function" ? connection.promise() : connection;

  // Highest running number already used for the prefix, plus one.
  // FOR UPDATE inside the save transaction so two users saving at once
  // cannot both be handed the same number.
  async function nextOrderNo(db, lock) {
    const digits = ORDER_LEN - ORDER_PREFIX.length;
    const [rows] = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(SLSORD_NO, ?) AS UNSIGNED)), 0) AS mx
         FROM slsord_hdr
        WHERE SLSORD_NO LIKE ? AND SUBSTRING(SLSORD_NO, ?) REGEXP '^[0-9]+$'
        ${lock ? "FOR UPDATE" : ""}`,
      [ORDER_PREFIX.length + 1, `${ORDER_PREFIX}%`, ORDER_PREFIX.length + 1]
    );
    const n = num(rows?.[0]?.mx) + 1;
    return ORDER_PREFIX + String(n).padStart(digits, "0");
  }

  /* ── Next number (shown on a new order; confirmed again at save) ───────── */
  router.get("/slsord-next-no", async (req, res) => {
    try {
      res.json({ nextNo: await nextOrderNo(pool, false) });
    } catch (err) {
      console.error("slsord-next-no:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /* ── Find list ─────────────────────────────────────────────────────────── */
 router.get("/slsord-list", async (req, res) => {
  const q = str(req.query.q);
  const like = `%${q}%`;
  try {
    const [rows] = await pool.query(
      `SELECT h.SLSORD_NO,
              DATE_FORMAT(h.SLSORD_DATE, '%d/%m/%Y') AS SLSORD_DATE,
              DATE_FORMAT(h.DELV_DATE,   '%d/%m/%Y') AS DELV_DATE,
              h.CUST_CODE,
              c.CUST_NAME,
              h.AMOUNT,
              h.VAT_AMOUNT,
              h.NARRATION,
              h.DISCOUNT,
              h.ROUND_OFF,
              h.NET_AMOUNT,
              COALESCE(h.CANCELLED, 'N') AS CANCELLED,
              h.DETAILS,
              h.ATTN,
              h.PAY_TERMS,
              h.CUST_REF,
              h.DISC_PER,
              h.GROSS_AMT,
              h.SMAN_CODE,
              h.USER_NAME,
              DATE_FORMAT(h.CREATED_ON, '%d/%m/%Y %H:%i') AS CREATED_ON,
              DATE_FORMAT(h.UPDATED_ON, '%d/%m/%Y %H:%i') AS UPDATED_ON
         FROM slsord_hdr h
         LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
        WHERE (? = '' OR h.SLSORD_NO LIKE ? OR h.CUST_CODE LIKE ?
               OR c.CUST_NAME LIKE ? OR h.NARRATION LIKE ?)
        ORDER BY h.SLSORD_DATE DESC, h.SLSORD_NO DESC
        LIMIT 300`,
      [q, like, like, like, like]
    );
    res.json(rows);
  } catch (err) {
    console.error("slsord-list:", err);
    res.status(500).json({ error: err.message });
  }
});

  /* ── Last prices for an item ───────────────────────────────────────────── */
  router.get("/slsord-last-price", async (req, res) => {
    const item = str(req.query.item);
    const cust = str(req.query.cust);
    const excl = str(req.query.excl);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);
    if (!item) return res.json([]);
    try {
      const [rows] = await pool.query(
        `SELECT i.SLSORD_NO,
                DATE_FORMAT(i.SLSORD_DATE, '%d/%m/%Y') AS ORD_DT,
                i.CUST_CODE,
                COALESCE(NULLIF(c.CUST_NAME, ''), h.NARRATION) AS CUST_NAME,
                i.QTY, i.UNIT, i.RATE, COALESCE(i.DISC_PER, 0) AS DISC_PER
           FROM slsord_item i
           JOIN slsord_hdr h ON h.SLSORD_NO = i.SLSORD_NO
           LEFT JOIN cus_mst c ON c.CUST_CODE = i.CUST_CODE
          WHERE i.ITEM_CODE = ?
            AND COALESCE(h.CANCELLED, 'N') <> 'Y'
            AND (? = '' OR i.CUST_CODE = ?)
            AND (? = '' OR i.SLSORD_NO <> ?)
            AND COALESCE(i.RATE, 0) > 0
          ORDER BY i.SLSORD_DATE DESC, i.srno_row_id DESC
          LIMIT ?`,
        [item, cust, cust, excl, excl, limit]
      );
      res.json(rows);
    } catch (err) {
      console.error("slsord-last-price:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /* ── Load one order ────────────────────────────────────────────────────── */
  router.get("/slsord/:no", async (req, res) => {
    const no = str(req.params.no);
    try {
      const [hdr] = await pool.query(
        `SELECT h.*,
                DATE_FORMAT(h.SLSORD_DATE, '%d/%m/%Y') AS ORD_DT,
                DATE_FORMAT(h.DELV_DATE,   '%d/%m/%Y') AS DELV_DT,
                c.CUST_NAME
           FROM slsord_hdr h
           LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
          WHERE h.SLSORD_NO = ?`,
        [no]
      );
      if (!hdr.length) return res.status(404).json({ error: `Order ${no} not found` });
      const [items] = await pool.query(
        `SELECT SR_NO, PART_NO, CLIENT_DESC, ITEM_CODE, ITEM_NAME, UNIT,
                COALESCE(QTY, 0) AS QTY, COALESCE(STAGED_QTY, 0) AS STAGED_QTY,
                COALESCE(RATE, 0) AS RATE, COALESCE(DISC_PER, 0) AS DISC_PER,
                COALESCE(VAT_PERC, 0) AS VAT_PERC, LOC_CODE
           FROM slsord_item
          WHERE SLSORD_NO = ?
          ORDER BY CAST(SR_NO AS UNSIGNED), srno_row_id`,
        [no]
      );
      res.json({ header: hdr[0], items });
    } catch (err) {
      console.error("slsord load:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /* ── Save (ADD / EDIT) ─────────────────────────────────────────────────── */
  router.put("/save-slsord", async (req, res) => {
    const { mode, header = {}, items = [] } = req.body || {};
    const userName = str(req.user?.username || req.user?.USER_NAME || req.user?.name || header.userName, 30) || null;

    const ordDate = dmyToDb(header.ordDt);
    if (!ordDate) return res.status(400).json({ error: "Order date is missing or not a valid date" });
    const custCode = str(header.CustCd, 9);
    const newParty = str(header.NewParty, 100);
    if (!custCode && !newParty) {
      return res.status(400).json({ error: "Enter a customer code or the new party's name" });
    }

    const lines = (Array.isArray(items) ? items : []).filter(isFilled);
    if (!lines.length) return res.status(400).json({ error: "The order has no lines" });

    // Totals from the recomputed lines.
    let gross = 0, disc = 0, amount = 0, vat = 0;
    const calc = lines.map((l) => {
      const c = calcLine(l);
      gross += c.gross; disc += c.disc; amount += c.amount; vat += c.vat;
      return c;
    });
    gross = r2(gross); disc = r2(disc); amount = r2(amount); vat = r2(vat);
    const roundOff = r2(num(header.RoundOff));
    const net = r2(amount + vat + roundOff);

    const db = await pool.getConnection();
    try {
      await db.beginTransaction();

      let ordNo = str(header.ordNo, ORDER_LEN).toUpperCase();
      const isEdit = mode === "EDIT";

      if (isEdit) {
        const [ex] = await db.query(
          "SELECT COALESCE(CANCELLED,'N') AS CANCELLED FROM slsord_hdr WHERE SLSORD_NO = ? FOR UPDATE",
          [ordNo]
        );
        if (!ex.length) throw Object.assign(new Error(`Order ${ordNo} no longer exists`), { status: 404 });
        if (ex[0].CANCELLED === "Y") {
          throw Object.assign(new Error(`Order ${ordNo} is cancelled and cannot be changed`), { status: 409 });
        }
      } else {
        // A new order keeps the number on screen unless someone has taken it.
        let taken = !ordNo;
        if (ordNo) {
          const [ex] = await db.query("SELECT 1 FROM slsord_hdr WHERE SLSORD_NO = ? FOR UPDATE", [ordNo]);
          taken = ex.length > 0;
        }
        if (taken) ordNo = await nextOrderNo(db, true);
      }

      const hdrCols = {
        SLSORD_DATE: ordDate,
        DELV_DATE: dmyToDb(header.DelvDt),
        CUST_CODE: custCode || null,
        NARRATION: newParty || null,
        ATTN: nz(header.OrderedBy, 40),
        SMAN_CODE: nz(header.Smancd, 2),
        PAY_TERMS: nz(header.PayTerms, 60),
        CUST_REF: nz(header.CustRef, 30),
        DISC_PER: r2(num(header.DiscPer)),
        GROSS_AMT: gross,
        DISCOUNT: disc,
        AMOUNT: amount,
        VAT_AMOUNT: vat,
        ROUND_OFF: roundOff,
        NET_AMOUNT: net,
        DETAILS: nz(header.Notes, 200),
        USER_NAME: userName,
      };

      if (isEdit) {
        await db.query(
          "UPDATE slsord_hdr SET ?, UPDATED_ON = NOW() WHERE SLSORD_NO = ?",
          [hdrCols, ordNo]
        );
      } else {
        await db.query(
          "INSERT INTO slsord_hdr SET ?, CANCELLED = 'N', CREATED_ON = NOW()",
          [{ SLSORD_NO: ordNo, ...hdrCols }]
        );
      }

      await db.query("DELETE FROM slsord_item WHERE SLSORD_NO = ?", [ordNo]);

      // Lines are renumbered 001, 002 … in the order they appear on screen,
      // so a deleted line never leaves a gap in the serials.
      const values = lines.map((l, i) => {
        const c = calc[i];
        return [
          ordNo, ordDate, custCode || null,
          String(i + 1).padStart(3, "0"), nz(l.LOC_CODE, 2),
          nz(l.ITEM_CODE, 20), nz(l.PART_NO, 40), nz(l.CLIENT_DESC, 254), nz(l.ITEM_NAME, 254),
          c.qty, r2(num(l.STAGED_QTY)), nz(l.UNIT, 5), c.rate,
          c.discPer, c.disc, c.amount, c.vatPer, c.vat, c.net,
          i + 1,
        ];
      });
      await db.query(
        `INSERT INTO slsord_item
           (SLSORD_NO, SLSORD_DATE, CUST_CODE, SR_NO, LOC_CODE,
            ITEM_CODE, PART_NO, CLIENT_DESC, ITEM_NAME,
            QTY, STAGED_QTY, UNIT, RATE,
            DISC_PER, DISC_AMT, AMOUNT, VAT_PERC, VAT_AMOUNT, NET_AMOUNT,
            MAIN_SR_NO)
         VALUES ?`,
        [values]
      );

      await db.commit();
      res.json({ ok: true, ordNo, totals: { gross, disc, amount, vat, roundOff, net } });
    } catch (err) {
      try { await db.rollback(); } catch (_) { /* already gone */ }
      console.error("save-slsord:", err);
      const status = err.status || (err.code === "ER_DUP_ENTRY" ? 409 : 500);
      const msg = err.code === "ER_DUP_ENTRY"
        ? "That order number was just used by someone else — save again for a new number"
        : err.message;
      res.status(status).json({ error: msg });
    } finally {
      db.release();
    }
  });

  /* ── Cancel ────────────────────────────────────────────────────────────── */
  router.put("/slsord-cancel/:no", async (req, res) => {
    const no = str(req.params.no);
    try {
      const [r] = await pool.query(
        `UPDATE slsord_hdr SET CANCELLED = 'Y', UPDATED_ON = NOW()
          WHERE SLSORD_NO = ? AND COALESCE(CANCELLED,'N') <> 'Y'`,
        [no]
      );
      if (!r.affectedRows) return res.status(404).json({ error: `Order ${no} not found or already cancelled` });
      res.json({ ok: true });
    } catch (err) {
      console.error("slsord-cancel:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
