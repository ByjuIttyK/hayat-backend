// routes/auditApi.js – reads audit_log for the AuditViewer screen
// Register in HayatDb.js:  app.use("/api", require("./routes/auditApi")(connection));
const express = require("express");
const { buildEvents } = require("../auditFormat");

const MAX_ROWS = 2000;
const isMonth = (m) => typeof m === "string" && /^\d{4}_\d{2}$/.test(m);
const parseJ = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (_) {
    return { value: v };
  }
};

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  function where(qs) {
    const [y, m] = qs.month.split("_").map(Number);
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const w = ["ts >= ?", "ts < ?"];
    const p = [from, to];
    if (qs.op) (w.push("op = ?"), p.push(String(qs.op).toUpperCase()));
    if (qs.user) (w.push("user_name LIKE ?"), p.push(`%${qs.user}%`));
    if (qs.tran_type) (w.push("tran_type = ?"), p.push(qs.tran_type));
    if (qs.vchr_no) (w.push("vchr_no LIKE ?"), p.push(`%${qs.vchr_no}%`));
    if (qs.tbl) (w.push("tbl = ?"), p.push(qs.tbl));
    return { sql: w.join(" AND "), p };
  }

  /* months that have log rows, newest first – "2026_11" */
  router.get("/audit-trail/months", async (req, res) => {
    try {
      const [rows] = await db.query(
        "SELECT DISTINCT DATE_FORMAT(ts, '%Y_%m') AS m FROM audit_log ORDER BY m DESC"
      );
      res.json(rows.map((r) => r.m));
    } catch (e) {
      console.error("audit/months", e);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  /* tables present in the log (for the Table filter) */
  router.get("/audit-trail/tables", async (req, res) => {
    try {
      const [rows] = await db.query("SELECT DISTINCT tbl FROM audit_log ORDER BY tbl");
      res.json(rows.map((r) => r.tbl));
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  /* log rows of one month, newest first */
  router.get("/audit-trail/logs", async (req, res) => {
    if (!isMonth(req.query.month)) return res.status(400).json({ success: false, message: "month must be YYYY_MM" });
    try {
      const w = where(req.query);
      const [rows] = await db.query(
        `SELECT id, DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%s') AS ts, user_name, op, tbl, key_val, tran_type, vchr_no,
                DATE_FORMAT(datte, '%d/%m/%Y') AS datte, old_data, new_data
           FROM audit_log WHERE ${w.sql}
          ORDER BY ts DESC, id DESC LIMIT ${MAX_ROWS + 1}`,
        w.p
      );
      res.setHeader("X-Audit-More", rows.length > MAX_ROWS ? "1" : "0");
      res.json(
        rows.slice(0, MAX_ROWS).map((r) => ({
          id: r.id,
          ts: r.ts,
          user: r.user_name,
          op: r.op,
          table: r.tbl,
          key: r.key_val,
          tran_type: r.tran_type,
          vchr_no: r.vchr_no,
          datte: r.datte,
          old: parseJ(r.old_data),
          new: parseJ(r.new_data),
        }))
      );
    } catch (e) {
      console.error("audit/logs", e);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  /* whole month as CSV (opens in Excel) */
  router.get("/audit-trail/archive", async (req, res) => {
    if (!isMonth(req.query.month)) return res.status(400).json({ success: false, message: "month must be YYYY_MM" });
    try {
      const w = where(req.query);
      const [rows] = await db.query(
        `SELECT DATE_FORMAT(ts, '%d/%m/%Y %H:%i:%s') AS ts, user_name, op, tbl, key_val, tran_type, vchr_no,
                DATE_FORMAT(datte, '%d/%m/%Y') AS datte, old_data, new_data
           FROM audit_log WHERE ${w.sql} ORDER BY ts, id`,
        w.p
      );
      const esc = (v) => {
        if (v === null || v === undefined) return "";
        const t = typeof v === "object" ? JSON.stringify(v) : String(v);
        return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const head = "Date Time,User,Operation,Table,Key,Tran Type,Vchr No,Vchr Date,Before,After";
      const body = rows.map((r) =>
        [r.ts, r.user_name, r.op, r.tbl, r.key_val, r.tran_type, r.vchr_no, r.datte, r.old_data, r.new_data].map(esc).join(",")
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="audit_${req.query.month}.csv"`);
      res.send("﻿" + [head, ...body].join("\r\n"));
    } catch (e) {
      console.error("audit/archive", e);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  /* name lookups for the readable report: account heads and voucher type names */
  async function lookups(rows) {
    const codes = new Set();
    const grab = (o) =>
      o && Object.keys(o).forEach((k) => {
        if (/^(ACC_CODE|AC_CODE|CUST_CODE|SUP_CODE|PARTY_CODE|BANK_CODE|.*_AC)$/i.test(k) && o[k]) codes.add(String(o[k]));
      });
    rows.forEach((r) => (grab(r.old), grab(r.new)));
    const acHead = {};
    if (codes.size) {
      try {
        const [a] = await db.query("SELECT AC_CODE, AC_HEAD FROM ac_list WHERE AC_CODE IN (?)", [[...codes]]);
        a.forEach((x) => (acHead[x.AC_CODE] = x.AC_HEAD));
      } catch (_) {
        /* ac_list not available – codes shown alone */
      }
    }
    const tranTypeName = {};
    try {
      const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tran_type' AND DATA_TYPE IN ('varchar','char')
          ORDER BY ORDINAL_POSITION`
      );
      const names = cols.map((c) => c.COLUMN_NAME);
      const pick =
        names.find((n) => /^(TRAN_DESC|DESCRIPTION|TRAN_NAME|TYPE_NAME|DESCR|NAME|TRAN_TYPE_NAME)$/i.test(n)) ||
        names.find((n) => /DESC|NAME/i.test(n));
      if (pick) {
        const [t] = await db.query(`SELECT TRAN_TYPE, \`${pick}\` AS NM FROM tran_type`);
        t.forEach((x) => (tranTypeName[x.TRAN_TYPE] = x.NM));
      }
    } catch (_) {
      /* no names – "Type 03" is shown */
    }
    return { acHead, tranTypeName };
  }

  /* readable report as Excel: one heading line per save, then only what changed */
  router.get("/audit-trail/excel", async (req, res) => {
    if (!isMonth(req.query.month)) return res.status(400).json({ success: false, message: "month must be YYYY_MM" });
    let ExcelJS;
    try {
      ExcelJS = require("exceljs");
    } catch (_) {
      return res.status(500).json({ success: false, message: "exceljs is not installed – run: npm install exceljs" });
    }
    try {
      const w = where(req.query);
      const [raw] = await db.query(
        `SELECT id, ts, DATE_FORMAT(ts, '%d/%m/%Y %H:%i:%s') AS ts_txt, user_name, op, tbl, key_val, tran_type, vchr_no,
                DATE_FORMAT(datte, '%d/%m/%Y') AS datte, old_data, new_data
           FROM audit_log WHERE ${w.sql} ORDER BY id`,
        w.p
      );
      const rows = raw.map((r) => ({ ...r, old: parseJ(r.old_data), new: parseJ(r.new_data) }));
      const events = buildEvents(rows, await lookups(rows));
      let company = "";
      try {
        const [[c]] = await db.query("SELECT NAME FROM company LIMIT 1");
        company = (c && c.NAME) || "";
      } catch (_) {}

      const [y, m] = req.query.month.split("_");
      const monthName = new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
      const filt = [
        req.query.tbl && `Table: ${req.query.tbl}`,
        req.query.op && `Operation: ${req.query.op}`,
        req.query.tran_type && `Type: ${req.query.tran_type}`,
        req.query.vchr_no && `Voucher: ${req.query.vchr_no}`,
        req.query.user && `User: ${req.query.user}`,
      ].filter(Boolean).join("   ");

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Audit trail", {
        pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
        views: [{ state: "frozen", ySplit: 5 }],
      });
      ws.columns = [
        { key: "ts", width: 17 },
        { key: "user", width: 12 },
        { key: "action", width: 13 },
        { key: "doc", width: 30 },
        { key: "docDate", width: 11 },
        { key: "section", width: 22 },
        { key: "line", width: 8 },
        { key: "field", width: 26 },
        { key: "before", width: 34 },
        { key: "after", width: 34 },
      ];
      const thin = { style: "thin", color: { argb: "FFC9D1DC" } };
      const border = { top: thin, bottom: thin, left: thin, right: thin };

      ws.getCell("A1").value = company;
      ws.getCell("A1").font = { bold: true, size: 13 };
      ws.getCell("A2").value = `Audit trail – ${monthName}`;
      ws.getCell("A2").font = { bold: true, size: 12 };
      ws.getCell("A3").value =
        `${events.length} saves, printed ${new Date().toLocaleString("en-GB")}` + (filt ? `   ·   ${filt}` : "");
      ws.getCell("A3").font = { size: 9, color: { argb: "FF5F6B7A" } };

      const head = ws.getRow(5);
      head.values = ["Date & time", "User", "Action", "Document", "Doc date", "Section", "Line", "What changed", "Before", "After"];
      head.eachCell((c) => {
        c.font = { bold: true, color: { argb: "FF1F3A5F" } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EEF5" } }; // light fill on the column header row only
        c.border = border;
        c.alignment = { vertical: "middle", wrapText: true };
      });
      head.height = 20;

      const ACTION_COLOR = { Created: "FF1F4E8C", Edited: "FFB45309", Deleted: "FFB71C1C" };
      for (const ev of events) {
        const r = ws.addRow({
          ts: ev.tsText,
          user: ev.user,
          action: ev.action,
          doc: ev.document,
          docDate: ev.docDate,
        });
        r.font = { bold: true };
        r.getCell("action").font = { bold: true, color: { argb: ACTION_COLOR[ev.action] || "FF5F6B7A" } };
        r.eachCell({ includeEmpty: true }, (c) => {
          c.border = { ...border, top: { style: "medium", color: { argb: "FF7F93AE" } } };
          c.alignment = { vertical: "top", wrapText: true };
        });
        for (const ln of ev.lines) {
          const d = ws.addRow({ section: ln.section, line: ln.line, field: ln.field, before: ln.before, after: ln.after });
          d.eachCell({ includeEmpty: true }, (c) => {
            c.border = border;
            c.alignment = { vertical: "top", wrapText: true };
          });
          d.getCell("before").font = { color: { argb: "FFB71C1C" } };
          d.getCell("after").font = { color: { argb: "FF1F4E8C" } };
          if (ln.note) d.getCell("field").font = { italic: true, color: { argb: "FF5F6B7A" } };
        }
      }
      ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: 10 } };
      ws.headerFooter.oddFooter = "&L&8Telltron ERP – audit trail&R&8Page &P of &N";

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Audit_Trail_${req.query.month}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      console.error("audit-trail/excel", e);
      if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
    }
  });

  return router;
};
