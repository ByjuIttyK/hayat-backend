#!/usr/bin/env node
/* =====================================================================
   tools/genAuditTriggers.js  –  audit-trail triggers for Telltron ERP

   Builds AFTER INSERT / UPDATE / DELETE triggers that copy each changed row
   (all columns, as JSON) into audit_log, plus a BEFORE INSERT "stamp" trigger
   that fills USERNAME / TRANS_DATE / TRANS_TIME (or CREATED_BY) when a route
   leaves them empty.  Column lists are read from the database, so the triggers
   always match the real tables – re-run after adding columns to a table.

   Run from the backend folder (E:\hayatApi or the VPS backend folder):

     1) see which tables carry vouchers:
        node tools/genAuditTriggers.js --discover

     2) write the SQL to a file to read it first (nothing is changed):
        node tools/genAuditTriggers.js --tables tran_acc,adj_dtl,...

     3) create the triggers:
        node tools/genAuditTriggers.js --tables tran_acc,adj_dtl,... --apply

     4) remove them again (if ever needed):
        node tools/genAuditTriggers.js --tables tran_acc,... --drop --apply

   Connection: --host --port --user --password --db, or the env variables
   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD (or DB_PASS), DB_NAME (from .env).
   ===================================================================== */
const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
} catch (_) {
  /* dotenv not installed – use env variables / flags */
}
const mysql = require("mysql2/promise");

/* ---------------- arguments ---------------- */
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const cfg = {
  host: opt("host", process.env.DB_HOST || "localhost"),
  port: Number(opt("port", process.env.DB_PORT || 3306)),
  user: opt("user", process.env.DB_USER || "root"),
  password: opt("password", process.env.DB_PASSWORD ?? process.env.DB_PASS ?? ""),
  database: opt("db", process.env.DB_NAME || process.env.DB_DATABASE || "hayat"),
  multipleStatements: false,
};
const tables = (opt("tables", "") || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const APPLY = flag("apply");
const DROP = flag("drop");
const NO_STAMP = flag("no-stamp");
const OUT = opt("out", "audit_triggers.sql");

const SKIP_TYPES = new Set(["blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary", "geometry"]);
const q = (id) => "`" + id.replace(/`/g, "``") + "`";
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const trgName = (tbl, sfx) => `aud_${tbl}`.slice(0, 64 - sfx.length - 1) + "_" + sfx;

/* ---------------- builders ---------------- */
function build(tbl, cols) {
  const names = cols.map((c) => c.COLUMN_NAME);
  const has = (n) => names.find((x) => x.toUpperCase() === n);
  const logCols = cols.filter((c) => !SKIP_TYPES.has(String(c.DATA_TYPE).toLowerCase()));

  let pk = cols.filter((c) => c.COLUMN_KEY === "PRI").map((c) => c.COLUMN_NAME);
  if (!pk.length && has("SRNO_ROW_ID")) pk = [has("SRNO_ROW_ID")];

  const dateCol =
    has("DATTE") ||
    (cols.find((c) => c.DATA_TYPE === "date" && /DATE|_DT$/i.test(c.COLUMN_NAME)) || {}).COLUMN_NAME;
  const tt = has("TRAN_TYPE");
  const vn = has("VCHR_NO");
  const userCol = has("USERNAME") || has("CREATED_BY");

  const obj = (p) => `JSON_OBJECT(${logCols.map((c) => `${lit(c.COLUMN_NAME)}, ${p}.${q(c.COLUMN_NAME)}`).join(", ")})`;
  const key = (p) => (pk.length ? `LEFT(CONCAT_WS('|', ${pk.map((k) => `${p}.${q(k)}`).join(", ")}), 200)` : "NULL");
  const who = (p) =>
    `LEFT(COALESCE(@app_user, ${userCol ? `NULLIF(${p}.${q(userCol)}, ''), ` : ""}SUBSTRING_INDEX(CURRENT_USER(), '@', 1)), 30)`;
  const ins = (op, p, oldJ, newJ) =>
    `INSERT INTO audit_log (user_name, op, tbl, key_val, tran_type, vchr_no, datte, old_data, new_data) VALUES (` +
    `${who(p)}, '${op}', ${lit(tbl)}, ${key(p)}, ` +
    `${tt ? `${p}.${q(tt)}` : "NULL"}, ${vn ? `LEFT(${p}.${q(vn)}, 30)` : "NULL"}, ${dateCol ? `${p}.${q(dateCol)}` : "NULL"}, ` +
    `${oldJ}, ${newJ})`;

  const T = (sfx, timing, ev, body) => ({
    name: trgName(tbl, sfx),
    sql: `CREATE TRIGGER ${q(trgName(tbl, sfx))} ${timing} ${ev} ON ${q(tbl)} FOR EACH ROW\n${body}`,
  });

  const list = [
    T("ai", "AFTER", "INSERT", `${ins("INSERT", "NEW", "NULL", obj("NEW"))}`),
    T(
      "au",
      "AFTER",
      "UPDATE",
      `BEGIN\n  DECLARE o JSON;\n  DECLARE n JSON;\n  SET o = ${obj("OLD")};\n  SET n = ${obj("NEW")};\n` +
        `  IF NOT (o <=> n) THEN\n    ${ins("UPDATE", "NEW", "o", "n")};\n  END IF;\nEND`
    ),
    T("ad", "AFTER", "DELETE", `${ins("DELETE", "OLD", obj("OLD"), "NULL")}`),
  ];

  // BEFORE INSERT stamp: who entered the row, and when
  if (!NO_STAMP) {
    const s = [];
    if (has("USERNAME")) s.push(`  IF NEW.${q(has("USERNAME"))} IS NULL OR NEW.${q(has("USERNAME"))} = '' THEN SET NEW.${q(has("USERNAME"))} = LEFT(@app_user, 30); END IF;`);
    else if (has("CREATED_BY")) s.push(`  IF NEW.${q(has("CREATED_BY"))} IS NULL OR NEW.${q(has("CREATED_BY"))} = '' THEN SET NEW.${q(has("CREATED_BY"))} = LEFT(@app_user, 20); END IF;`);
    if (has("TRANS_DATE")) s.push(`  IF NEW.${q(has("TRANS_DATE"))} IS NULL THEN SET NEW.${q(has("TRANS_DATE"))} = CURDATE(); END IF;`);
    if (has("TRANS_TIME")) s.push(`  IF NEW.${q(has("TRANS_TIME"))} IS NULL OR NEW.${q(has("TRANS_TIME"))} = '' THEN SET NEW.${q(has("TRANS_TIME"))} = DATE_FORMAT(NOW(), '%H:%i:%s'); END IF;`);
    if (s.length) list.push(T("bi", "BEFORE", "INSERT", `BEGIN\n${s.join("\n")}\nEND`));
  }

  const info = { pk: pk.join("+") || "(none)", dateCol: dateCol || "-", tranType: !!tt, vchrNo: !!vn, userCol: userCol || "-", cols: logCols.length, skipped: cols.length - logCols.length };
  return { list, info };
}

/* ---------------- main ---------------- */
(async () => {
  const db = await mysql.createConnection(cfg);
  try {
    if (flag("discover")) {
      const [rows] = await db.query(
        `SELECT c.TABLE_NAME AS tbl,
                MAX(c.COLUMN_NAME = 'TRAN_TYPE') AS has_tran_type,
                MAX(c.COLUMN_NAME = 'VCHR_NO')   AS has_vchr_no,
                MAX(c.COLUMN_NAME = 'DATTE')     AS has_datte,
                MAX(t.TABLE_ROWS)                AS approx_rows,
                (SELECT COUNT(*) FROM information_schema.TRIGGERS g
                  WHERE g.EVENT_OBJECT_SCHEMA = c.TABLE_SCHEMA AND g.EVENT_OBJECT_TABLE = c.TABLE_NAME) AS triggers
           FROM information_schema.COLUMNS c
           JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
          WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME <> 'audit_log'
          GROUP BY c.TABLE_SCHEMA, c.TABLE_NAME
         HAVING has_vchr_no = 1 OR has_tran_type = 1
          ORDER BY c.TABLE_NAME`,
        [cfg.database]
      );
      console.log(`\nTables in ${cfg.database} with VCHR_NO or TRAN_TYPE (candidates for the audit trail):\n`);
      console.table(rows.map((r) => ({ table: r.tbl, TRAN_TYPE: r.has_tran_type ? "Y" : "", VCHR_NO: r.has_vchr_no ? "Y" : "", DATTE: r.has_datte ? "Y" : "", rows: r.approx_rows, triggers_now: r.triggers })));
      console.log("\nNext:  node tools/genAuditTriggers.js --tables <comma list>          (writes SQL to read)");
      console.log("       node tools/genAuditTriggers.js --tables <comma list> --apply  (creates triggers)\n");
      return;
    }

    if (!tables.length) {
      console.log("Give --tables t1,t2,...  or  --discover   (see the header of this file)");
      process.exitCode = 1;
      return;
    }

    const [[al]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'audit_log'", [cfg.database]);
    if (!al.n && !DROP) throw new Error("Table audit_log not found – run sql/audit_log.sql first");

    const fileParts = [`-- audit triggers for ${cfg.database} – generated ${new Date().toISOString()}`, "DELIMITER $$"];
    let made = 0;
    for (const tbl of tables) {
      const [cols] = await db.query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [cfg.database, tbl]
      );
      if (tbl.toLowerCase() === "audit_log") {
        console.log("!! audit_log itself is never audited – skipped");
        continue;
      }
      if (!cols.length) {
        console.log(`!! ${tbl}: table not found – skipped`);
        continue;
      }
      const { list, info } = build(tbl, cols);
      const sfxs = ["ai", "au", "ad", "bi"];
      const drops = sfxs.map((s) => `DROP TRIGGER IF EXISTS ${q(trgName(tbl, s))}`);

      fileParts.push(`\n-- ===== ${tbl}  (key ${info.pk}, date ${info.dateCol}, user ${info.userCol}, ${info.cols} columns logged${info.skipped ? `, ${info.skipped} binary skipped` : ""})`);
      drops.forEach((d) => fileParts.push(d + "$$"));
      if (!DROP) list.forEach((t) => fileParts.push(t.sql + "$$"));

      if (APPLY) {
        for (const d of drops) await db.query(d);
        if (!DROP) for (const t of list) await db.query(t.sql);
      }
      made += DROP ? 0 : list.length;
      console.log(`${APPLY ? (DROP ? "dropped " : "created ") : "prepared"} ${tbl.padEnd(22)} key ${info.pk.padEnd(22)} date ${String(info.dateCol).padEnd(12)} ${DROP ? "" : list.map((t) => t.name).join(", ")}`);
    }
    fileParts.push("\nDELIMITER ;");
    fs.writeFileSync(OUT, fileParts.join("\n"));
    console.log(`\nSQL written to ${path.resolve(OUT)}${APPLY ? "" : "  – nothing changed in the database (add --apply to create)"}`);
    if (APPLY && !DROP) console.log(`${made} triggers in place.`);
  } catch (e) {
    console.error("ERROR:", e.sqlMessage || e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
