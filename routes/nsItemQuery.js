// E:\hayatApi\routes\nsItemQuery.js
// Non-Stock Purchase Item Query — purchase_items_ns (items first) + purchase_hdr_ns
//
// Register in HayatDb.js:
//   const nsItemQuery = require("./routes/nsItemQuery");
//   app.use("/api", nsItemQuery(connection));
//
// POST /api/ns-item-query   body: { filters: { FIELD: "criterion", ... } }
//
// Criterion syntax (Oracle Forms style):
//   text      ABC          exact match
//             %CABLE%      LIKE (case-insensitive), % = any chars, _ = one char
//             <>%CABLE%    NOT LIKE
//   number    500  >500  <=500  <>0  100..500 (between)
//   date      01/10/2026  >=01/10/2026  01/09/2026..30/09/2026
//             (dd/mm/yyyy, dd/mm/yy, dd-mm-yyyy or yyyy-mm-dd)
//   any       NULL  /  !NULL

const express = require("express");

const MAX_ROWS = 5000;

// key -> [SQL expression, type]   T = text, N = number, D = date
const F = {
  // ---- item details (purchase_items_ns) ----
  SUP_ITEM_DESC: ["i.SUP_ITEM_DESC", "T"],
  PART_NO: ["i.PART_NO", "T"],
  ITEM_CODE: ["i.ITEM_CODE", "T"],
  QTY: ["i.QTY", "N"],
  ITEM_UNIT: ["i.ITEM_UNIT", "T"],
  UNIT_COST: ["i.UNIT_COST", "N"],
  ITEM_AMT: ["ROUND(IFNULL(i.QTY,0) * IFNULL(i.UNIT_COST,0), 2)", "N"],
  DISCOUNT: ["i.DISCOUNT", "N"],
  VAT_PERC: ["i.VAT_PERC", "N"],
  JOB_NO: ["i.JOB_NO", "T"],
  PANEL_NO: ["i.PANEL_NO", "T"],
  LOC_CODE: ["i.LOC_CODE", "T"],
  DR_CODE: ["i.DR_CODE", "T"],
  SR_NO: ["i.SR_NO", "T"],
  // ---- header (purchase_hdr_ns) ----
  PJV_NO: ["i.PJV_NO", "T"],
  PJV_DATE: ["h.PJV_DATE", "D"],
  SUP_CODE: ["h.SUP_CODE", "T"],
  SUP_NAME: ["s.SUP_NAME", "T"],
  INV_NO: ["h.INV_NO", "T"],
  INV_DATE: ["h.INV_DATE", "D"],
  SRV_NO: ["h.SRV_NO", "T"],
  LPO_NO: ["h.LPO_NO", "T"],
  HDR_DR_CODE: ["h.DR_CODE", "T"],
  NARRATION: ["h.NARRATION", "T"],
  INV_NET_AMT: ["h.INV_NET_AMT", "N"],
  CAN_CEL: ["h.CAN_CEL", "T"],
};

class CriteriaError extends Error {}

const pad2 = (n) => String(n).padStart(2, "0");

function parseDate(s) {
  const t = String(s).trim();
  let y, m, d;
  let r = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (r) {
    [, d, m, y] = r;
    if (y.length === 2) y = "20" + y;
  } else if ((r = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [, y, m, d] = r;
  } else return null;
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(m) - 1 || dt.getDate() !== Number(d)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function conv(type, raw, key) {
  const v = String(raw ?? "").trim();
  if (!v) throw new CriteriaError(`${key}: value missing`);
  if (type === "N") {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isNaN(n)) throw new CriteriaError(`${key}: "${v}" is not a number`);
    return n;
  }
  if (type === "D") {
    const d = parseDate(v);
    if (!d) throw new CriteriaError(`${key}: "${v}" is not a valid date (dd/mm/yyyy)`);
    return d;
  }
  return v;
}

function buildCond(key, raw, params) {
  const [expr, type] = F[key];
  const v = String(raw ?? "").trim();
  if (!v) return null;

  const U = v.toUpperCase();
  if (U === "NULL" || U === "IS NULL") return `${expr} IS NULL`;
  if (U === "!NULL" || U === "NOT NULL" || U === "IS NOT NULL") return `${expr} IS NOT NULL`;

  // range  a..b  (numbers and dates)
  if (type !== "T" && v.includes("..")) {
    const [a, b] = v.split("..");
    params.push(conv(type, a, key), conv(type, b, key));
    return `${expr} BETWEEN ? AND ?`;
  }

  const m = v.match(/^(>=|<=|<>|!=|=|>|<)\s*(.*)$/s);
  let op = m ? m[1] : "=";
  const val = m ? m[2].trim() : v;
  if (op === "!=") op = "<>";

  // Oracle-style wildcard search on text
  if (type === "T" && val.includes("%") && (op === "=" || op === "<>")) {
    params.push(val.toUpperCase());
    return `UPPER(${expr}) ${op === "=" ? "LIKE" : "NOT LIKE"} ?`;
  }

  params.push(conv(type, val, key));
  return `${expr} ${op} ?`;
}

const SELECT_LIST = Object.entries(F)
  .map(([k, [expr, t]]) => (t === "D" ? `DATE_FORMAT(${expr}, '%Y-%m-%d') AS ${k}` : `${expr} AS ${k}`))
  .join(",\n       ");

const NUM_KEYS = Object.keys(F).filter((k) => F[k][1] === "N");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  router.post("/ns-item-query", async (req, res) => {
    try {
      const filters = (req.body && req.body.filters) || {};
      const where = [];
      const params = [];

      for (const [k, v] of Object.entries(filters)) {
        if (!F[k]) continue; // whitelist only
        const c = buildCond(k, v, params);
        if (c) where.push(c);
      }

      const sql = `
SELECT ${SELECT_LIST}
  FROM purchase_items_ns i
  JOIN purchase_hdr_ns h ON h.PJV_NO = i.PJV_NO
  LEFT JOIN sup_mst s    ON s.SUP_CODE = h.SUP_CODE
 ${where.length ? "WHERE " + where.join("\n   AND ") : ""}
 ORDER BY h.PJV_DATE DESC, i.PJV_NO DESC, CAST(i.SR_NO AS UNSIGNED)
 LIMIT ${MAX_ROWS + 1}`;

      const rows = await q(sql, params);
      const truncated = rows.length > MAX_ROWS;
      if (truncated) rows.length = MAX_ROWS;

      // mysql2 returns DECIMAL as string — convert so grid sorting/export is numeric
      for (const r of rows) for (const k of NUM_KEYS) if (r[k] != null) r[k] = Number(r[k]);

      res.json({ rows, truncated, maxRows: MAX_ROWS });
    } catch (e) {
      if (e instanceof CriteriaError) return res.status(400).json({ error: e.message });
      console.error("ns-item-query:", e);
      res.status(500).json({ error: "Query failed" });
    }
  });

  return router;
};
