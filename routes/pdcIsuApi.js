// E:\hayatApi\routes\pdcIsuApi.js — PDC Issued: edit one cheque row (pdc_isu)
//
//   GET  /api/pdc-isu?tt=&vno=&chq=    one cheque row by TRAN_TYPE + VCHR_NO + CHQ_NO
//   GET  /api/pdc-isu/:id              one cheque row by ID
//   GET  /api/pdc-isu-head/:code       head/name for a GL, customer or supplier code
//   POST /api/save-pdc-isu             { ID, ...fields } → UPDATE pdc_isu WHERE ID
//
// Register in HayatDb.js after authMiddleware, like the other screens:
//   const pdcIsuApi = require("./routes/pdcIsuApi");
//   app.use("/api", pdcIsuApi(connection));
//
// Not touched by this screen: ID, MAIN_SR_NO, BATCH_NO, JV_TYPE,
// and the voucher identity TRAN_TYPE / VCHR_NO / VCHR_DATE (shown read-only).

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  // dd/mm/yyyy | yyyy-mm-dd | '' → 'yyyy-mm-dd' or null
  const toDbDate = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return null;
  };
  const str = (v, max) => {
    const s = v == null ? "" : String(v).trim();
    return s ? s.slice(0, max) : null;
  };
  const dec = (v) => {
    if (v === "" || v == null) return null;
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? +n.toFixed(2) : null;
  };

  // Heads looked up by bound value — avoids collation clashes with the ac_list view
  async function headsFor(codes) {
    const list = [...new Set(codes.filter(Boolean).map(String))];
    if (!list.length) return {};
    const [rows] = await db.query("SELECT AC_CODE, AC_HEAD FROM ac_list WHERE AC_CODE IN (?)", [list]);
    return Object.fromEntries(rows.map((r) => [String(r.AC_CODE), r.AC_HEAD]));
  }

  router.get("/pdc-isu-head/:code", async (req, res) => {
    try {
      const h = await headsFor([req.params.code]);
      const head = h[req.params.code];
      if (head == null) return res.status(404).json({ error: "Code not found" });
      res.json({ code: req.params.code, head });
    } catch (e) {
      res.status(500).json({ error: e.sqlMessage || e.message });
    }
  });

  const ROW_SQL = `SELECT ID, TRAN_TYPE, VCHR_NO,
                DATE_FORMAT(VCHR_DATE,   '%d/%m/%Y') AS VCHR_DATE,
                CHQ_NO,
                DATE_FORMAT(CHQ_DATE,    '%d/%m/%Y') AS CHQ_DATE,
                CHQ_BANK, PDC_CODE, SUP_CODE, AMOUNT, NARRATION,
                JV_NO_RLZ,
                DATE_FORMAT(JV_DATE_RLZ, '%d/%m/%Y') AS JV_DATE_RLZ,
                REALISED
           FROM pdc_isu`;

  async function sendRow(res, rows, notFound) {
    if (!rows.length) return res.status(404).json({ error: notFound });
    const r = rows[0];
    let heads = {};
    try { heads = await headsFor([r.CHQ_BANK, r.PDC_CODE, r.SUP_CODE]); }
    catch (e) { console.warn("pdc-isu heads:", e.message); }
    res.json({
      ...r,
      CHQ_BANK_HEAD: heads[r.CHQ_BANK] || "",
      PDC_HEAD: heads[r.PDC_CODE] || "",
      SUP_NAME: heads[r.SUP_CODE] || "",
      // same cheque no. entered twice on one voucher — the screen warns
      DUPLICATES: rows.length,
    });
  }

  // Exact record from the InfoGrid row: TRAN_TYPE + VCHR_NO + CHQ_NO
  router.get("/pdc-isu", async (req, res) => {
    const tt = String(req.query.tt || "").trim();
    const vno = String(req.query.vno || "").trim();
    const chq = String(req.query.chq || "").trim();
    if (!tt || !vno || !chq) return res.status(400).json({ error: "Tran Type, Voucher No and Cheque No are required" });
    try {
      const [rows] = await db.query(
        `${ROW_SQL} WHERE TRAN_TYPE = ? AND VCHR_NO = ? AND CHQ_NO = ? ORDER BY ID`,
        [tt, vno, chq]
      );
      await sendRow(res, rows, `Cheque ${chq} not found on voucher ${tt}/${vno}`);
    } catch (e) {
      console.error("GET /pdc-isu:", e);
      res.status(500).json({ error: e.sqlMessage || e.message });
    }
  });

  router.get("/pdc-isu/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid cheque ID" });
    try {
      const [rows] = await db.query(`${ROW_SQL} WHERE ID = ?`, [id]);
      await sendRow(res, rows, `Cheque record ${id} not found`);
    } catch (e) {
      console.error("GET /pdc-isu/:id:", e);
      res.status(500).json({ error: e.sqlMessage || e.message });
    }
  });

  router.post("/save-pdc-isu", async (req, res) => {
    const b = req.body || {};
    const id = Number(b.ID);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid cheque ID" });
    const chqNo = str(b.CHQ_NO, 20);
    if (!chqNo) return res.status(400).json({ error: "Cheque No is required" });
    const realised = String(b.REALISED || "").toUpperCase() === "Y" ? "Y" : "N";

    try {
      const [r] = await db.query(
        `UPDATE pdc_isu SET
            CHQ_NO = ?, CHQ_DATE = ?, CHQ_BANK = ?, PDC_CODE = ?, SUP_CODE = ?,
            AMOUNT = ?, NARRATION = ?,
            REALISED = ?, JV_NO_RLZ = ?, JV_DATE_RLZ = ?
          WHERE ID = ?`,
        [
          chqNo, toDbDate(b.CHQ_DATE), str(b.CHQ_BANK, 100), str(b.PDC_CODE, 20), str(b.SUP_CODE, 20),
          dec(b.AMOUNT), str(b.NARRATION, 255),
          realised, str(b.JV_NO_RLZ, 10), toDbDate(b.JV_DATE_RLZ),
          id,
        ]
      );
      if (!r.affectedRows) return res.status(404).json({ error: `Cheque record ${id} not found` });
      res.json({ ok: true, ID: id });
    } catch (e) {
      console.error("save-pdc-isu:", e);
      res.status(500).json({ error: e.sqlMessage || e.message });
    }
  });

  return router;
};
