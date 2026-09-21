/* ── routes/sinvRoutes.js — Sales Invoice (NET_SALES) ──────────────────────
   Every route the Sales Invoice screen (Invoice.tsx) owns, in one file.

     GET  /api/invhdr/:id        header for EDIT / VIEW (all fields the save writes)
     GET  /api/sinvitems/:id     lines for EDIT / VIEW, in the grid's row shape
     GET  /api/dolst             delivery orders   ?cust=1CS0001&days=365
     GET  /api/outletlst         delivery places   ?q=jeb
     PUT  /api/save-sinv         header + lines + G/L in ONE transaction
                                 body: { mode: "ADD" | "EDIT", header, items }
     PUT  /api/sinvacc           re-post G/L for a saved invoice  body: { invNo }

   Register once in HayatDb.js:
     app.use("/api", require("./routes/sinvRoutes")(connection));

   Shared routes the screen also calls stay where they are, because other
   screens use them: /items/:code, /customer/:code, /smanmst/:code,
   /getMaxDoc, /catlst, /cmpdetails, and the AI /sinv-suggest.

   Tables (lowercase — the VPS is Linux, lower_case_table_names=0):
     net_sales   header, PK INV_NO
     invoice     lines, needs UNIQUE (INV_NO, SR_NO) for the upsert:
                   ALTER TABLE invoice ADD UNIQUE KEY uq_invoice_line (INV_NO, SR_NO);
                 VAT and line discount are stored once these exist:
                   ALTER TABLE invoice
                     ADD COLUMN VAT_PERC DECIMAL(5,2)  NOT NULL DEFAULT 0 AFTER INV_RATE,
                     ADD COLUMN DISC_AMT DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER DISC_PER;
     tran_acc    G/L, TRAN_TYPE '06', single AMOUNT + DB_CR flag

   Column discovery: the route reads each table's real column list once and
   writes only the columns that exist, so a resync from Oracle that drops a
   MySQL-only column degrades (with a console warning) instead of failing.  */

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  /* ── promise wrappers over the callback pool ─────────────────────────── */
  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn)))
    );
  // `db` is either the pool (read-only GETs) or one connection (transactions).
  // Inside a transaction every statement must go through the SAME connection.
  const run = (db, sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)))
    );
  const begin = (conn) =>
    new Promise((resolve, reject) => conn.beginTransaction((e) => (e ? reject(e) : resolve())));
  const commit = (conn) =>
    new Promise((resolve, reject) => conn.commit((e) => (e ? reject(e) : resolve())));
  const rollback = (conn) => new Promise((resolve) => conn.rollback(() => resolve()));

  /* ── value helpers ───────────────────────────────────────────────────── */
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const dec = (v, places) => {
    const f = Math.pow(10, places);
    return Math.round(num(v) * f) / f;
  };
  const str = (v, max) => {
    const t = String(v ?? "").trim();
    return t === "" ? null : t.slice(0, max);
  };
  // dd/MM/yyyy (screen) or yyyy-MM-dd… (ISO) → DATETIME literal; else NULL
  const toDbDate = (v) => {
    const t = String(v ?? "").trim();
    if (!t) return null;
    let m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")} 00:00:00`;
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")} 00:00:00`;
    return null;
  };
  const fail = (message, status) => Object.assign(new Error(message), { status });

  /* ── column discovery (cached per table, cleared after any failure) ──── */
  const colCache = {};
  const colsOf = async (db, table) => {
    if (colCache[table]) return colCache[table];
    const rows = await run(db, `SHOW COLUMNS FROM ${table}`);
    colCache[table] = new Set(rows.map((r) => String(r.Field).toUpperCase()));
    return colCache[table];
  };
  const clearCols = () => Object.keys(colCache).forEach((k) => delete colCache[k]);

  const warned = new Set();
  const present = (table, have, wanted) => {
    const missing = wanted.filter((c) => !have.has(c));
    const key = table + ":" + missing.join(",");
    if (missing.length && !warned.has(key)) {
      warned.add(key);
      console.warn(`sinvRoutes: ${table} has no ${missing.join(", ")} — those values are not stored`);
    }
    return wanted.filter((c) => have.has(c));
  };

  /* ══ READ ══════════════════════════════════════════════════════════════ */

  /* Header. a.* so every column the save writes comes back — EDIT must load
     all of them, or the next save writes blanks over what is in net_sales
     (and G/L posting refuses a blank CR_CODE). Still returns every column
     the old route did, under the same names, for any other caller. */
  router.get("/invhdr/:id", async function (req, res) {
    try {
      const rows = await run(
        connection,
        `SELECT a.*, c.CUST_NAME, b.SMAN_NAME, m.ACC_HEAD AS CR_NAME
           FROM net_sales a
           LEFT JOIN sman_mst b ON b.SMAN_CODE = a.SMAN_CODE
           LEFT JOIN cus_mst  c ON c.CUST_CODE = a.CUST_CODE
           LEFT JOIN acc_mst  m ON m.ACC_CODE  = a.CR_CODE
          WHERE a.INV_NO = ?`,
        [req.params.id]
      );
      res.json(rows);
    } catch (error) {
      console.error("invhdr failed:", error.message);
      res.status(500).json({ ok: false, message: "Invoice header load failed" });
    }
  });

  /* Lines, shaped as the grid's RowDataType with the amounts recomputed the
     same way the screen and the save compute them. If the invoice table has
     no VAT_PERC / DISC_AMT yet, the header's effective VAT% and the stored
     DISC_PER stand in, so a re-save does not drop the VAT. */
  router.get("/sinvitems/:id", async function (req, res) {
    try {
      const lineCols = await colsOf(connection, "invoice");
      const hdrCols = await colsOf(connection, "net_sales");
      const sel = [
        "i.SR_NO", "i.CATG_CODE", "i.ITEM_CODE", "i.ITEM_DES1", "i.INV_UNIT",
        "i.INV_QTY", "i.INV_RATE", "i.DISC_PER",
        lineCols.has("DISC_AMT") ? "i.DISC_AMT" : "NULL AS DISC_AMT",
        lineCols.has("VAT_PERC") ? "i.VAT_PERC" : "NULL AS VAT_PERC",
        hdrCols.has("VAT_PERC") ? "n.VAT_PERC AS HDR_VAT_PERC" : "NULL AS HDR_VAT_PERC",
      ];
      const rows = await run(
        connection,
        `SELECT ${sel.join(", ")}
           FROM invoice i
           LEFT JOIN net_sales n ON n.INV_NO = i.INV_NO
          WHERE i.INV_NO = ?
          ORDER BY CAST(i.SR_NO AS UNSIGNED), i.SR_NO`,
        [req.params.id]
      );

      res.json(
        rows.map((r) => {
          const qty = num(r.INV_QTY);
          const rate = num(r.INV_RATE);
          const gross = dec(qty * rate, 2);
          const disc = r.DISC_AMT != null ? dec(r.DISC_AMT, 2) : dec((gross * num(r.DISC_PER)) / 100, 2);
          const net = dec(gross - disc, 2);
          const vatPerc = r.VAT_PERC != null ? num(r.VAT_PERC) : num(r.HDR_VAT_PERC);
          const vat = dec((net * vatPerc) / 100, 2);
          return {
            SR_NO: String(r.SR_NO ?? ""),
            CATG_CODE: r.CATG_CODE ?? "",
            ITEM_CODE: r.ITEM_CODE ?? "",
            ITEM_DES1: r.ITEM_DES1 ?? "",
            INV_UNIT: r.INV_UNIT ?? "",
            INV_QTY: qty,
            INV_RATE: rate,
            GROSS_AMT: gross,
            DISC_AMT: disc,
            NET_AMT: net,
            VAT_PERC: vatPerc,
            VAT_AMT: vat,
            AMOUNT: dec(net + vat, 2),
            isNew: false,
          };
        })
      );
    } catch (error) {
      clearCols();
      console.error("sinvitems failed:", error.message);
      res.status(500).json({ ok: false, message: "Invoice lines load failed" });
    }
  });

  /* D.O. list, scoped to the invoice's customer when one is passed.
     Assumes do_hdr has DO_NO, DO_DATE, CUST_CODE, LPO_NO. */
  router.get("/dolst", async function (req, res) {
    const cust = String(req.query.cust ?? "").trim();
    const days = Number(req.query.days) > 0 ? Number(req.query.days) : 730;
    const where = ["d.DO_DATE >= DATE_SUB(CURDATE(), INTERVAL ? DAY)"];
    const params = [days];
    if (cust) {
      where.push("d.CUST_CODE = ?");
      params.push(cust);
    }
    try {
      const rows = await run(
        connection,
        `SELECT d.DO_NO, d.DO_DATE, d.CUST_CODE, d.LPO_NO, c.CUST_NAME
           FROM do_hdr d
           LEFT JOIN cus_mst c ON c.CUST_CODE = d.CUST_CODE
          WHERE ${where.join(" AND ")}
          ORDER BY d.DO_DATE DESC, d.DO_NO DESC
          LIMIT 500`,
        params
      );
      res.json(rows);
    } catch (error) {
      console.error("dolst failed:", error.message);
      res.status(500).json({ ok: false, message: "Delivery order list failed" });
    }
  });

  /* Delivery places already keyed on past invoices (there is no outlet master). */
  router.get("/outletlst", async function (req, res) {
    const q = String(req.query.q ?? "").trim();
    const params = [];
    let filter = "";
    if (q) {
      filter = " AND OUTLET LIKE ?";
      params.push(`%${q}%`);
    }
    try {
      const rows = await run(
        connection,
        `SELECT OUTLET,
                MAX(OUTLET_ADR1) AS OUTLET_ADR1,
                COUNT(*)         AS USED_COUNT,
                MAX(INV_DATE)    AS LAST_USED
           FROM net_sales
          WHERE OUTLET IS NOT NULL AND TRIM(OUTLET) <> ''${filter}
          GROUP BY OUTLET
          ORDER BY LAST_USED DESC
          LIMIT 300`,
        params
      );
      res.json(rows);
    } catch (error) {
      console.error("outletlst failed:", error.message);
      res.status(500).json({ ok: false, message: "Delivery place list failed" });
    }
  });

  /* ══ SAVE ══════════════════════════════════════════════════════════════ */

  /* ── Lines → invoice ──────────────────────────────────────────────────
     Upsert, not delete-and-reinsert: LOC_CODE, STD_COST, ACT_QTY, DO_NO,
     ITEM_DES2/3 and INV_CTN belong to other processes and must survive. */
  const LINE_WRITERS = {
    INV_DATE:  (c) => c.invDate,
    CUST_CODE: (c) => str(c.custCd, 9),
    CATG_CODE: (c) => str(c.r.CATG_CODE, 5),
    ITEM_CODE: (c) => str(c.r.ITEM_CODE, 24),
    ITEM_DES1: (c) => str(c.r.ITEM_DES1, 1000),
    INV_QTY:   (c) => dec(c.qty, 3),
    INV_UNIT:  (c) => str(c.r.INV_UNIT, 5),
    INV_RATE:  (c) => dec(c.rate, 3),
    DISC_PER:  (c) => dec(c.gross > 0 ? (c.disc / c.gross) * 100 : 0, 2), // kept for older readers
    DISC_AMT:  (c) => dec(c.disc, 2),
    VAT_PERC:  (c) => dec(c.vatPerc, 2),
    GROSS_AMT: (c) => dec(c.gross, 2),
    NET_AMT:   (c) => dec(c.net, 2),
    VAT_AMT:   (c) => dec(c.vat, 2),
    AMOUNT:    (c) => dec(c.net + c.vat, 2),
  };

  const saveLines = async (conn, invNo, invDate, custCd, rows) => {
    const lines = rows.filter((r) => r && String(r.SR_NO ?? "").trim() !== "");
    const cols = present("invoice", await colsOf(conn, "invoice"), Object.keys(LINE_WRITERS));
    let saved = 0;
    if (lines.length > 0) {
      const values = lines.map((r) => {
        const qty = num(r.INV_QTY);
        const rate = num(r.INV_RATE);
        const gross = qty * rate;
        const disc = num(r.DISC_AMT);
        const net = gross - disc;
        const vatPerc = num(r.VAT_PERC);
        const vat = dec((net * vatPerc) / 100, 2);
        const ctx = { r, qty, rate, gross, disc, net, vatPerc, vat, invDate, custCd };
        return [invNo, str(r.SR_NO, 10), ...cols.map((c) => LINE_WRITERS[c](ctx))];
      });
      const insertCols = ["INV_NO", "SR_NO"].concat(cols);
      const updates = cols.map((c) => `${c} = VALUES(${c})`).join(", ");
      await run(
        conn,
        `INSERT INTO invoice (${insertCols.join(", ")}) VALUES ?
         ON DUPLICATE KEY UPDATE ${updates}`,
        [values]
      );
      saved = lines.length;
    }
    // Lines no longer on screen were deleted there.
    const keep = lines.map((r) => str(r.SR_NO, 10));
    const del = keep.length
      ? await run(conn, "DELETE FROM invoice WHERE INV_NO = ? AND SR_NO NOT IN (?)", [invNo, keep])
      : await run(conn, "DELETE FROM invoice WHERE INV_NO = ?", [invNo]);
    return { lines, saved, deleted: del.affectedRows };
  };

  /* ── Header → net_sales ───────────────────────────────────────────────
     Money columns are summed from the lines in the same request, never taken
     from the client, so the header always ties to its own detail.
     FC_AMOUNT = document currency; AMOUNT / DISCOUNT / VAT_AMOUNT = dirhams
     (× EXCHG_RATE). Set HEADER_MONEY_IS_LOCAL = false if the ledger expects
     document-currency figures there. Untouched on update (other processes):
     PRINT_DATE, CAN_CEL, DIV_CODE, OUTLET_ADR1, ROUND_OFF, NOTES, REMARKS2. */
  const HEADER_MONEY_IS_LOCAL = true;

  const HDR_WRITERS = {
    INV_DATE:       (h) => toDbDate(h.invDt),
    INV_TYPE:       (h) => str(h.invType, 1) || "S",
    REF_NO:         (h) => str(h.CustRef, 10),
    CUST_CODE:      (h) => str(h.CustCd, 9),
    ADDL_CUST_NAME: (h) => str(h.AddlCustDtl, 30),
    CR_CODE:        (h) => str(h.CrCode, 20),
    DO_NO:          (h) => str(h.DoNo, 30),
    DO_DATE:        (h) => toDbDate(h.DoDate),
    LPO_NO:         (h) => str(h.LpoNo, 15),
    LPO_DATE:       (h) => toDbDate(h.LpoDate),
    SMAN_CODE:      (h) => str(h.Smancd, 2),
    OUTLET:         (h) => str(h.Outlet, 20),
    CURR_ENCY:      (h) => str(h.CurrEncy, 3) || "DHS",
    EXCHG_RATE:     (h) => dec(h.rate, 5),
    FC_AMOUNT:      (h) => dec(h.t.net + h.t.vat, 2),
    AMOUNT:         (h) => dec((h.t.net + h.t.vat) * h.money, 2),
    DISCOUNT:       (h) => dec(h.t.disc * h.money, 2),
    // effective rates across the invoice (VAT is charged per line)
    DISC_PER:       (h) => dec(h.t.gross > 0 ? (h.t.disc / h.t.gross) * 100 : 0, 2),
    VAT_PERC:       (h) => dec(h.t.net > 0 ? (h.t.vat / h.t.net) * 100 : 0, 2),
    VAT_AMOUNT:     (h) => dec(h.t.vat * h.money, 2),
    REMARKS1:       (h) => str(h.CusTel, 40),
    USER_NAME:      (h) => str(h.userName, 30),
  };

  const totalsOf = (lines) =>
    lines.reduce(
      (t, r) => {
        const gross = num(r.INV_QTY) * num(r.INV_RATE);
        const disc = num(r.DISC_AMT);
        const net = gross - disc;
        t.gross += gross;
        t.disc += disc;
        t.net += net;
        t.vat += dec((net * num(r.VAT_PERC)) / 100, 2); // same per-line rounding as the lines
        return t;
      },
      { gross: 0, disc: 0, net: 0, vat: 0 }
    );

  const upsertHeader = async (conn, invNo, body, lines) => {
    const cols = present("net_sales", await colsOf(conn, "net_sales"), Object.keys(HDR_WRITERS));
    // A zero / absent rate means 1:1, never "worth nothing".
    const rate = num(body.ExchgRate) > 0 ? num(body.ExchgRate) : 1;
    const h = { ...body, rate, money: HEADER_MONEY_IS_LOCAL ? rate : 1, t: totalsOf(lines) };
    const values = [invNo, ...cols.map((c) => HDR_WRITERS[c](h))];
    const updates = cols.map((c) => `${c} = VALUES(${c})`).join(", ");
    await run(
      conn,
      `INSERT INTO net_sales (INV_NO, ${cols.join(", ")}) VALUES (${values.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE ${updates}`,
      values
    );
  };

  /* ── G/L → tran_acc (TRAN_TYPE '06') ──────────────────────────────────
     Posted from the net_sales row as saved, inside the caller's transaction:
       Dr  customer (CUST_CODE)   AMOUNT
       Cr  sales    (CR_CODE)     AMOUNT - VAT_AMOUNT
       Cr  VAT      20007         VAT_AMOUNT
     Credits derive from the debit, so the voucher always balances.
     Zero-value entries are skipped. */
  const SINV_TRAN_TYPE = "06";
  const VAT_OUTPUT_ACC = "20007";

  const postSinvAcc = async (conn, invNo) => {
    const rows = await run(
      conn,
      `SELECT n.INV_DATE, n.CUST_CODE, n.CR_CODE, n.ADDL_CUST_NAME,
              n.AMOUNT, n.VAT_AMOUNT, c.CUST_NAME
         FROM net_sales n
         LEFT JOIN cus_mst c ON c.CUST_CODE = n.CUST_CODE
        WHERE n.INV_NO = ?`,
      [invNo]
    );
    if (!rows.length) throw fail(`Invoice ${invNo} not found for posting`, 404);
    const h = rows[0];
    if (!h.CUST_CODE) throw fail("Customer code missing — cannot post", 400);
    if (!h.CR_CODE) throw fail("Sales account (Cr.Code) missing — cannot post", 400);

    const total = dec(h.AMOUNT, 2);
    const vat = dec(h.VAT_AMOUNT, 2);
    const sales = dec(total - vat, 2);
    const custName = h.CUST_NAME || "";
    const addl = h.ADDL_CUST_NAME || null;

    await run(conn, "DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?", [SINV_TRAN_TYPE, invNo]);

    const entries = [
      [h.CUST_CODE, custName, total, "D"],
      [h.CR_CODE, custName, sales, "C"],
      [VAT_OUTPUT_ACC, ("V.A.T " + custName).trim(), vat, "C"],
    ].filter((e) => e[2] !== 0);

    if (entries.length) {
      await run(
        conn,
        `INSERT INTO tran_acc (TRAN_TYPE, VCHR_NO, SR_NO, DATTE, ACC_CODE, NARRATION1, NARRATION2, AMOUNT, DB_CR)
         VALUES ?`,
        [entries.map(([acc, nar1, amt, dc], i) => [SINV_TRAN_TYPE, invNo, i + 1, h.INV_DATE, acc, nar1, addl, amt, dc])]
      );
    }
    return entries.length;
  };

  /* PUT /api/save-sinv — header, lines and G/L together or not at all.
     ADD refuses an existing number (another user may have taken it);
     the screen sends EDIT for every save after the first. */
  router.put("/save-sinv", async function (req, res) {
    const { mode, header, items } = req.body || {};
    if (mode !== "ADD" && mode !== "EDIT") return res.status(400).json({ ok: false, error: "Invalid mode" });
    const invNo = String(header?.invNo ?? "").trim();
    if (!invNo) return res.status(400).json({ ok: false, error: "Invoice number missing" });
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ ok: false, error: "No invoice lines" });

    let conn;
    try {
      conn = await getConn();
      await begin(conn);

      const existing = await run(conn, "SELECT INV_NO FROM net_sales WHERE INV_NO = ? FOR UPDATE", [invNo]);
      if (mode === "ADD" && existing.length > 0)
        throw fail(`Invoice ${invNo} already exists — it may have been saved by another user`, 409);
      if (mode === "EDIT" && existing.length === 0) throw fail(`Invoice ${invNo} not found`, 404);

      const { lines, saved, deleted } = await saveLines(conn, invNo, toDbDate(header.invDt), header.CustCd, items);
      const userName = req.user?.USER_NAME || req.user?.username || null; // from JWT middleware
      await upsertHeader(conn, invNo, { ...header, userName }, lines);
      const posted = await postSinvAcc(conn, invNo);

      await commit(conn);
      console.log("save-sinv:", mode, invNo, "lines:", saved, "deleted:", deleted, "G/L entries:", posted);
      res.json({ ok: true, invNo, saved, deleted, posted });
    } catch (error) {
      if (conn) await rollback(conn);
      clearCols();
      console.error("save-sinv failed:", error);
      res.status(error.status || 500).json({ ok: false, error: error.sqlMessage || error.message });
    } finally {
      if (conn) conn.release();
    }
  });

  /* PUT /api/sinvacc — re-post G/L for an invoice already saved.
     save-sinv posts on every save; this is for repairs only. */
  router.put("/sinvacc", async function (req, res) {
    const invNo = String(req.body?.invNo ?? "").trim();
    if (!invNo) return res.status(400).json({ ok: false, error: "Invoice number missing" });
    let conn;
    try {
      conn = await getConn();
      await begin(conn);
      const posted = await postSinvAcc(conn, invNo);
      await commit(conn);
      res.json({ ok: true, invNo, posted });
    } catch (error) {
      if (conn) await rollback(conn);
      console.error("sinvacc failed:", error);
      res.status(error.status || 500).json({ ok: false, error: error.sqlMessage || error.message });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
