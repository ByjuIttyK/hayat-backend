// routes/tranAccQueryRoutes.js
// Transaction Query on tran_acc — any field, quick filters + advanced condition builder + grouping.
// Register in HayatDb.js:
//   app.use("/api", require("./routes/tranAccQueryRoutes")(connection));

const express = require("express");

// Whitelist of searchable fields → SQL column + type (s = string, n = number, d = date)
const FIELDS = {
  TRAN_TYPE:   { col: "t.TRAN_TYPE",   type: "s" },
  VCHR_NO:     { col: "t.VCHR_NO",     type: "s" },
  SR_NO:       { col: "t.SR_NO",       type: "s" },
  MAIN_SR_NO:  { col: "t.MAIN_SR_NO",  type: "n" },
  DATTE:       { col: "t.DATTE",       type: "d" },
  ACC_CODE:    { col: "t.ACC_CODE",    type: "s" },
  AC_HEAD:     { col: "a.AC_HEAD",     type: "s" },
  DB_CR:       { col: "t.DB_CR",       type: "s" },
  AMOUNT:      { col: "t.AMOUNT",      type: "n" },
  AMOUNT_FC:   { col: "t.AMOUNT_FC",   type: "n" },
  AMT_SETTLED: { col: "t.AMT_SETTLED", type: "n" },
  NARRATION1:  { col: "t.NARRATION1",  type: "s" },
  NARRATION2:  { col: "t.NARRATION2",  type: "s" },
  JOB_NO:      { col: "t.JOB_NO",      type: "s" },
  PANEL_NO:    { col: "t.PANEL_NO",    type: "s" },
  DIV_CODE:    { col: "t.DIV_CODE",    type: "s" },
  REF_NO:      { col: "t.REF_NO",      type: "s" },
  USERNAME:    { col: "t.USERNAME",    type: "s" },
  TRANS_DATE:  { col: "t.TRANS_DATE",  type: "d" },
  TRANS_TIME:  { col: "t.TRANS_TIME",  type: "s" },
  SRNO_ROW_ID: { col: "t.srno_row_id", type: "n" },
};

// Columns scanned by the "Any text" box
const TEXT_SEARCH_COLS = [
  "t.VCHR_NO", "t.ACC_CODE", "a.AC_HEAD", "t.NARRATION1", "t.NARRATION2",
  "t.JOB_NO", "t.REF_NO", "t.USERNAME",
];

// customer/supplier codes have a letter in the 2nd character (e.g. 1CS1547, 1S2…)
const MAIN_ORDER = "(t.ACC_CODE REGEXP '^.[A-Za-z]') DESC, t.AMOUNT DESC, t.SR_NO";

const GROUPS = {
  // Voucher: main account = party line (customer/supplier code) first, else the largest-amount line
  voucher:  { key: "t.TRAN_TYPE, t.VCHR_NO",
              sel: `t.TRAN_TYPE, t.VCHR_NO, DATE_FORMAT(MIN(t.DATTE),'%Y-%m-%d') AS DATTE,
                    SUBSTRING_INDEX(GROUP_CONCAT(t.ACC_CODE ORDER BY ${MAIN_ORDER} SEPARATOR '|'),'|',1) AS ACC_CODE,
                    SUBSTRING_INDEX(GROUP_CONCAT(IFNULL(a.AC_HEAD,'') ORDER BY ${MAIN_ORDER} SEPARATOR '|'),'|',1) AS AC_HEAD,
                    COUNT(DISTINCT t.ACC_CODE) AS ACC_CNT,
                    MAX(t.NARRATION1) AS NARRATION1, MAX(t.NARRATION2) AS NARRATION2,
                    MAX(t.JOB_NO) AS JOB_NO, MAX(t.PANEL_NO) AS PANEL_NO`,
              order: "MIN(t.DATTE), t.TRAN_TYPE, t.VCHR_NO" },
  account:  { key: "t.ACC_CODE", sel: "t.ACC_CODE, MAX(a.AC_HEAD) AS AC_HEAD", order: "t.ACC_CODE" },
  trantype: { key: "t.TRAN_TYPE", sel: "t.TRAN_TYPE", order: "t.TRAN_TYPE" },
  month:    { key: "DATE_FORMAT(t.DATTE,'%Y-%m')", sel: "DATE_FORMAT(t.DATTE,'%Y-%m') AS MONTH", order: "DATE_FORMAT(t.DATTE,'%Y-%m')" },
  job:      { key: "t.JOB_NO", sel: "t.JOB_NO", order: "t.JOB_NO" },
  user:     { key: "t.USERNAME", sel: "t.USERNAME", order: "t.USERNAME" },
};

const AGG = `COUNT(*) AS LINES_CNT,
  SUM(CASE WHEN t.DB_CR='D' THEN t.AMOUNT ELSE 0 END) AS TOT_DR,
  SUM(CASE WHEN t.DB_CR='C' THEN t.AMOUNT ELSE 0 END) AS TOT_CR,
  SUM(CASE WHEN t.DB_CR='D' THEN t.AMOUNT ELSE -t.AMOUNT END) AS NET`;

const NUM_OUT = ["MAIN_SR_NO", "AMOUNT", "DEBIT", "CREDIT", "AMOUNT_FC", "AMT_SETTLED",
  "LINES_CNT", "ACC_CNT", "TOT_DR", "TOT_CR", "NET", "SRNO_ROW_ID"];

const likeEsc = (s) => String(s).replace(/[\\%_]/g, (m) => "\\" + m);

function castVal(type, v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  if (type === "n") {
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (type === "d") return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null;
  return String(v).trim();
}

// One condition → SQL fragment (values pushed into params). Returns null if invalid/empty.
function condSql(c, params) {
  const f = FIELDS[String(c.field || "").toUpperCase()];
  if (!f) return null;
  const col = f.col;
  const asText = f.type === "s" ? col : `CAST(${col} AS CHAR)`; // lets "contains 132.3" work on amounts
  const op = c.op;

  if (op === "empty")    return f.type === "s" ? `(${col} IS NULL OR ${col} = '')` : `${col} IS NULL`;
  if (op === "notempty") return f.type === "s" ? `(${col} IS NOT NULL AND ${col} <> '')` : `${col} IS NOT NULL`;

  if (["contains", "notcontains", "starts", "ends"].includes(op)) {
    const raw = c.value == null ? "" : String(c.value).trim();
    if (!raw) return null;
    const v = likeEsc(raw);
    params.push(op === "starts" ? `${v}%` : op === "ends" ? `%${v}` : `%${v}%`);
    return op === "notcontains" ? `(${asText} IS NULL OR ${asText} NOT LIKE ?)` : `${asText} LIKE ?`;
  }

  if (op === "in" || op === "notin") {
    const list = String(c.value || "").split(",").map((x) => castVal(f.type, x)).filter((x) => x !== null);
    if (!list.length) return null;
    params.push(...list);
    return `${col} ${op === "notin" ? "NOT IN" : "IN"} (${list.map(() => "?").join(",")})`;
  }

  const v1 = castVal(f.type, c.value);
  if (op === "between") {
    const v2 = castVal(f.type, c.value2);
    if (v1 === null && v2 === null) return null;
    if (v1 !== null && v2 !== null) { params.push(v1, v2); return `${col} BETWEEN ? AND ?`; }
    if (v1 !== null) { params.push(v1); return `${col} >= ?`; }
    params.push(v2); return `${col} <= ?`;
  }

  const SYM = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=" };
  if (!SYM[op] || v1 === null) return null;
  params.push(v1);
  return op === "ne" ? `(${col} IS NULL OR ${col} <> ?)` : `${col} ${SYM[op]} ?`;
}

function buildWhere(body, params, { skipAmount }) {
  const q = body.quick || {};
  const parts = [];
  const add = (c) => { const s = condSql(c, params); if (s) parts.push(s); };

  if (Array.isArray(q.tranTypes) && q.tranTypes.length)
    add({ field: "TRAN_TYPE", op: "in", value: q.tranTypes.join(",") });
  if (q.dateFrom) add({ field: "DATTE", op: "ge", value: q.dateFrom });
  if (q.dateTo)   add({ field: "DATTE", op: "le", value: q.dateTo });
  if (q.vchrNo)   add({ field: "VCHR_NO", op: "eq", value: q.vchrNo });
  if (q.accCode)  add({ field: "ACC_CODE", op: "starts", value: q.accCode });
  if (q.accName)  add({ field: "AC_HEAD", op: "contains", value: q.accName });
  if (q.dbCr)     add({ field: "DB_CR", op: "eq", value: q.dbCr });
  if (q.jobNo)    add({ field: "JOB_NO", op: "eq", value: q.jobNo });
  if (q.refNo)    add({ field: "REF_NO", op: "contains", value: q.refNo });
  if (q.username) add({ field: "USERNAME", op: "eq", value: q.username });
  if (q.divCode)  add({ field: "DIV_CODE", op: "eq", value: q.divCode });
  if (q.panelNo)  add({ field: "PANEL_NO", op: "eq", value: q.panelNo });
  if (!skipAmount) {
    if (q.amtFrom !== "" && q.amtFrom != null) add({ field: "AMOUNT", op: "ge", value: q.amtFrom });
    if (q.amtTo !== "" && q.amtTo != null)     add({ field: "AMOUNT", op: "le", value: q.amtTo });
  }
  if (q.narration && String(q.narration).trim()) {
    const v = `%${likeEsc(String(q.narration).trim())}%`;
    params.push(v, v);
    parts.push("(t.NARRATION1 LIKE ? OR t.NARRATION2 LIKE ?)");
  }
  if (q.anyText && String(q.anyText).trim()) {
    const v = `%${likeEsc(String(q.anyText).trim())}%`;
    parts.push("(" + TEXT_SEARCH_COLS.map((c) => { params.push(v); return `${c} LIKE ?`; }).join(" OR ") + ")");
  }

  // Advanced builder: its own group joined with AND / OR
  const adv = [];
  for (const c of Array.isArray(body.conditions) ? body.conditions : []) {
    const s = condSql(c, params);
    if (s) adv.push(s);
  }
  if (adv.length) parts.push("(" + adv.join(body.match === "OR" ? " OR " : " AND ") + ")");

  return parts.length ? "WHERE " + parts.join(" AND ") : "";
}

const numify = (rows) => rows.map((r) => {
  for (const k of NUM_OUT) if (r[k] != null) r[k] = Number(r[k]);
  return r;
});

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;

  // Dropdown data: distinct tran types + current accounting period
  router.get("/tran-acc-query/meta", async (req, res) => {
    try {
      const [tt] = await db.query("SELECT DISTINCT TRAN_TYPE FROM tran_acc WHERE TRAN_TYPE IS NOT NULL ORDER BY TRAN_TYPE");
      const [us] = await db.query("SELECT DISTINCT USERNAME FROM tran_acc WHERE USERNAME IS NOT NULL AND USERNAME <> '' ORDER BY USERNAME");
      const [dv] = await db.query("SELECT DISTINCT DIV_CODE FROM tran_acc WHERE DIV_CODE IS NOT NULL AND DIV_CODE <> '' ORDER BY DIV_CODE");
      const [pr] = await db.query(
        "SELECT DATE_FORMAT(START_DATE,'%Y-%m-%d') AS START_DATE, DATE_FORMAT(END_DATE,'%Y-%m-%d') AS END_DATE FROM ac_period LIMIT 1"
      );
      res.json({
        tranTypes: tt.map((r) => r.TRAN_TYPE),
        users: us.map((r) => r.USERNAME),
        divCodes: dv.map((r) => r.DIV_CODE),
        period: pr[0] || null,
      });
    } catch (err) {
      console.error("tran-acc-query/meta", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Searchable-dropdown lookups: ?field=ACC_CODE|VCHR_NO|JOB_NO|PANEL_NO|REF_NO&q=...
  // optional context: tranTypes=03,07  dateFrom/dateTo=yyyy-mm-dd  jobNo (narrows Panel No)
  router.get("/tran-acc-query/lookup", async (req, res) => {
    try {
      const field = String(req.query.field || "").toUpperCase();
      const q = String(req.query.q || "").trim();
      const LIMIT = 50;

      if (field === "ACC_CODE") {
        const params = [];
        let where = "";
        if (q) {
          where = "WHERE AC_CODE LIKE ? OR AC_HEAD LIKE ?";
          params.push(`${likeEsc(q)}%`, `%${likeEsc(q)}%`);
        }
        const [r] = await db.query(
          `SELECT AC_CODE AS value, AC_HEAD AS label FROM ac_list ${where} ORDER BY AC_CODE LIMIT ?`,
          [...params, LIMIT]
        );
        return res.json(r);
      }

      const COLS = { VCHR_NO: "t.VCHR_NO", JOB_NO: "t.JOB_NO", PANEL_NO: "t.PANEL_NO", REF_NO: "t.REF_NO" };
      const col = COLS[field];
      if (!col) return res.status(400).json({ error: "Invalid lookup field" });

      const parts = [`${col} IS NOT NULL`, `${col} <> ''`];
      const params = [];
      if (q) { parts.push(`${col} LIKE ?`); params.push(`%${likeEsc(q)}%`); }
      const tt = String(req.query.tranTypes || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (tt.length) { parts.push(`t.TRAN_TYPE IN (${tt.map(() => "?").join(",")})`); params.push(...tt); }
      const df = castVal("d", req.query.dateFrom), dt = castVal("d", req.query.dateTo);
      if (df) { parts.push("t.DATTE >= ?"); params.push(df); }
      if (dt) { parts.push("t.DATTE <= ?"); params.push(dt); }
      if (field === "PANEL_NO" && req.query.jobNo) { parts.push("t.JOB_NO = ?"); params.push(String(req.query.jobNo)); }
      const where = "WHERE " + parts.join(" AND ");

      let sql;
      if (field === "VCHR_NO") {
        sql = `SELECT t.VCHR_NO AS value,
                      CONCAT('Type ', GROUP_CONCAT(DISTINCT t.TRAN_TYPE ORDER BY t.TRAN_TYPE), '  ·  ',
                             DATE_FORMAT(MIN(t.DATTE),'%d/%m/%Y')) AS label
               FROM tran_acc t ${where} GROUP BY t.VCHR_NO ORDER BY MAX(t.DATTE) DESC, t.VCHR_NO DESC LIMIT ?`;
      } else if (field === "JOB_NO") {
        sql = `SELECT t.JOB_NO AS value, CONCAT(COUNT(*), ' lines') AS label
               FROM tran_acc t ${where} GROUP BY t.JOB_NO ORDER BY t.JOB_NO DESC LIMIT ?`;
      } else if (field === "PANEL_NO") {
        sql = `SELECT t.PANEL_NO AS value, GROUP_CONCAT(DISTINCT t.JOB_NO ORDER BY t.JOB_NO SEPARATOR ', ') AS label
               FROM tran_acc t ${where} GROUP BY t.PANEL_NO ORDER BY t.PANEL_NO LIMIT ?`;
      } else {
        sql = `SELECT t.REF_NO AS value, DATE_FORMAT(MAX(t.DATTE),'%d/%m/%Y') AS label
               FROM tran_acc t ${where} GROUP BY t.REF_NO ORDER BY MAX(t.DATTE) DESC LIMIT ?`;
      }
      const [r] = await db.query(sql, [...params, LIMIT]);
      res.json(r);
    } catch (err) {
      console.error("tran-acc-query/lookup", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/tran-acc-query", async (req, res) => {
    try {
      const body = req.body || {};
      const q = body.quick || {};
      const maxRows = Math.min(Math.max(parseInt(body.maxRows, 10) || 2000, 1), 50000);
      const group = GROUPS[body.groupBy];
      const amtOnTotal = !!group && body.amtApply === "total";
      const FROM = "FROM tran_acc t LEFT JOIN ac_list a ON a.AC_CODE = t.ACC_CODE";

      const params = [];
      const where = buildWhere(body, params, { skipAmount: amtOnTotal });

      if (!group) {
        const sql = `
          SELECT t.srno_row_id AS SRNO_ROW_ID, t.TRAN_TYPE, t.VCHR_NO, t.SR_NO, t.MAIN_SR_NO,
                 DATE_FORMAT(t.DATTE,'%Y-%m-%d') AS DATTE, t.ACC_CODE, a.AC_HEAD, t.DB_CR, t.AMOUNT,
                 CASE WHEN t.DB_CR='D' THEN t.AMOUNT END AS DEBIT,
                 CASE WHEN t.DB_CR='C' THEN t.AMOUNT END AS CREDIT,
                 t.AMOUNT_FC, t.AMT_SETTLED, t.NARRATION1, t.NARRATION2, t.JOB_NO, t.PANEL_NO,
                 t.DIV_CODE, t.REF_NO, t.USERNAME, DATE_FORMAT(t.TRANS_DATE,'%Y-%m-%d') AS TRANS_DATE, t.TRANS_TIME
          ${FROM} ${where}
          ORDER BY t.DATTE, t.TRAN_TYPE, t.VCHR_NO, CAST(t.SR_NO AS UNSIGNED)
          LIMIT ?`;
        const [rows] = await db.query(sql, [...params, maxRows + 1]);
        const truncated = rows.length > maxRows;
        if (truncated) rows.pop();

        // Totals over the WHOLE result (not just the rows returned)
        const [sum] = await db.query(
          `SELECT COUNT(*) AS CNT,
                  SUM(CASE WHEN t.DB_CR='D' THEN t.AMOUNT ELSE 0 END) AS DR,
                  SUM(CASE WHEN t.DB_CR='C' THEN t.AMOUNT ELSE 0 END) AS CR
           ${FROM} ${where}`, params);
        return res.json({
          mode: "line",
          rows: numify(rows),
          truncated,
          summary: { count: Number(sum[0].CNT || 0), totDr: Number(sum[0].DR || 0), totCr: Number(sum[0].CR || 0) },
        });
      }

      // Grouped mode
      let having = "";
      const hParams = [];
      if (amtOnTotal) {
        const lo = castVal("n", q.amtFrom), hi = castVal("n", q.amtTo);
        if (lo !== null || hi !== null) {
          const a = lo ?? -1e15, b = hi ?? 1e15;
          having = "HAVING (TOT_DR BETWEEN ? AND ? OR TOT_CR BETWEEN ? AND ?)";
          hParams.push(a, b, a, b);
        }
      }
      const sql = `SELECT ${group.sel}, ${AGG} ${FROM} ${where}
                   GROUP BY ${group.key} ${having}
                   ORDER BY ${group.order} LIMIT ?`;
      const [rows] = await db.query(sql, [...params, ...hParams, maxRows + 1]);
      const truncated = rows.length > maxRows;
      if (truncated) rows.pop();
      const out = numify(rows);
      const summary = out.reduce(
        (s, r) => ({ count: s.count + r.LINES_CNT, totDr: s.totDr + r.TOT_DR, totCr: s.totCr + r.TOT_CR }),
        { count: 0, totDr: 0, totCr: 0 }
      );
      res.json({ mode: body.groupBy, rows: out, truncated, summary });
    } catch (err) {
      console.error("tran-acc-query", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
