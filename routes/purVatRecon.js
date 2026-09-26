/**
 * routes/purVatRecon.js — Purchase VAT Register vs G/L (VAT ON PURCHASE 142-004-0-002)
 * Register side = same sources as Purchase Register (PUR_REG):
 *   LOC : purchase_hdr    + purchase_items    (gross = QTY x COST, header DISCOUNT / VAT_PERC)
 *   NS  : purchase_hdr_ns + purchase_items_ns (line QTY x UNIT_COST, line DISCOUNT / VAT_PERC)
 * G/L side = tran_acc on the VAT account, matched on VCHR_NO = PJV_NO.
 * Input VAT is a debit balance, so G/L VAT = Dr − Cr and Variance = Register VAT − G/L VAT.
 *
 * Register in HayatDb.js:
 *   app.use("/api", require("./routes/purVatRecon")(connection));
 */
const express = require("express");
const ExcelJS = require("exceljs");

// ── settings (check these against salesRegisterVat.js) ──────────────────
const VAT_AC = "142-004-0-001";   // VAT on purchases (same account NGP posts to)
const T_DATE = "DATTE";       // tran_acc date column
const T_AMT = "AMOUNT";           // tran_acc amount column (DB_CR gives the side)

const GROUPS = [
  { grp: "LOC", label: "Stock Purchases (Local)" },
  { grp: "NS", label: "Non-Stock Purchases" },
  { grp: "GL", label: "G/L only entries" },
];

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, p = []) =>
    new Promise((res, rej) => connection.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const pad = (n) => String(n).padStart(2, "0");
  const dmy = (d) => {
    if (!d) return "";
    if (d instanceof Date) return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const [y, m, dd] = String(d).slice(0, 10).split("-");
    return y && m && dd ? `${dd}/${m}/${y}` : "";
  };
  const isoToDmy = (s) => { const [y, m, d] = String(s).split("-"); return `${d}/${m}/${y}`; };

  async function build(from, to) {
    const signed = `CASE WHEN DB_CR='D' THEN ${T_AMT} ELSE -${T_AMT} END`;

    const [loc, ns, gl, opn, byType, head] = await Promise.all([
      // Stock (local) purchases — one row per PJV
      q(`SELECT h.PJV_NO pjv_no, h.PJV_DATE pjv_date, h.SUP_CODE sup_code, s.SUP_NAME sup_name,
                h.INV_NO inv_no, h.INV_DATE inv_date,
                IFNULL(g.gross,0) - IFNULL(h.DISCOUNT,0) taxable, IFNULL(h.VAT_PERC,0) vat_perc
           FROM purchase_hdr h
           LEFT JOIN (SELECT PJV_NO, SUM(QTY*COST) gross FROM purchase_items
                       WHERE PJV_NO IN (SELECT PJV_NO FROM purchase_hdr WHERE PJV_DATE BETWEEN ? AND ?)
                       GROUP BY PJV_NO) g ON g.PJV_NO = h.PJV_NO
           LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
          WHERE h.PJV_DATE BETWEEN ? AND ?
          ORDER BY h.PJV_NO`, [from, to, from, to]),

      // Non-stock purchases — discount and VAT % are on the lines
      q(`SELECT h.PJV_NO pjv_no, h.PJV_DATE pjv_date, h.SUP_CODE sup_code, s.SUP_NAME sup_name,
                h.INV_NO inv_no, h.INV_DATE inv_date, x.taxable, x.vat
           FROM purchase_hdr_ns h
           JOIN (SELECT PJV_NO,
                        SUM(QTY*UNIT_COST - IFNULL(DISCOUNT,0)) taxable,
                        SUM((QTY*UNIT_COST - IFNULL(DISCOUNT,0)) * IFNULL(VAT_PERC,0) / 100) vat
                   FROM purchase_items_ns
                  WHERE PJV_NO IN (SELECT PJV_NO FROM purchase_hdr_ns WHERE PJV_DATE BETWEEN ? AND ?)
                  GROUP BY PJV_NO) x ON x.PJV_NO = h.PJV_NO
           LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
          WHERE h.PJV_DATE BETWEEN ? AND ?
          ORDER BY h.PJV_NO`, [from, to, from, to]),

      // G/L VAT per voucher in the period
      q(`SELECT VCHR_NO vchr_no, MIN(TRAN_TYPE) tran_type, MIN(${T_DATE}) vchr_date,
                SUM(${signed}) gl_vat
           FROM tran_acc
          WHERE TRAN_TYPE ='07' and ACC_CODE = ? AND ${T_DATE} BETWEEN ? AND ?
          GROUP BY VCHR_NO`, [VAT_AC, from, to]),

      // VAT A/c statement (all tran types)
      q(`SELECT IFNULL(SUM(${signed}),0) bal FROM tran_acc WHERE ACC_CODE = ? AND ${T_DATE} < ?`, [VAT_AC, from]),
      q(`SELECT TRAN_TYPE tran_type,
                IFNULL(SUM(CASE WHEN DB_CR='D' THEN ${T_AMT} ELSE 0 END),0) dr,
                IFNULL(SUM(CASE WHEN DB_CR='C' THEN ${T_AMT} ELSE 0 END),0) cr
           FROM tran_acc WHERE  ACC_CODE = ? AND ${T_DATE} BETWEEN ? AND ?
          GROUP BY TRAN_TYPE ORDER BY TRAN_TYPE`, [VAT_AC, from, to]),
      q(`SELECT ACC_HEAD acc_head FROM acc_mst WHERE ACC_CODE = ?`, [VAT_AC]),
    ]);

    // G/L lookup by voucher no.
    const glMap = new Map(gl.map((g) => [String(g.vchr_no).trim(), g]));
    const used = new Set();

    const toRow = (grp, r, vat) => {
      const key = String(r.pjv_no).trim();
      const g = glMap.get(key);
      if (g) used.add(key);
      const glVat = g ? r2(g.gl_vat) : 0;
      return {
        grp, pjv_no: key, pjv_date: dmy(r.pjv_date), sup_code: r.sup_code || "",
        sup_name: r.sup_name || "", inv_no: r.inv_no || "", inv_date: dmy(r.inv_date),
        taxable: r2(r.taxable), vat: r2(vat), gl_vat: glVat, variance: r2(vat - glVat),
        note: g ? "" : "Not in G/L",
      };
    };

    const rows = [
      ...loc.map((r) => toRow("LOC", r, r2((Number(r.taxable) || 0) * (Number(r.vat_perc) || 0) / 100))),
      ...ns.map((r) => toRow("NS", r, r2(r.vat))),
    ];

    // Vouchers on the VAT a/c that are not in the register
    gl.filter((g) => !used.has(String(g.vchr_no).trim()))
      .sort((a, b) => String(a.vchr_no).localeCompare(String(b.vchr_no)))
      .forEach((g) => rows.push({
        grp: "GL", pjv_no: String(g.vchr_no).trim(), pjv_date: dmy(g.vchr_date), sup_code: "",
        sup_name: "", inv_no: "", inv_date: "", taxable: 0, vat: 0,
        gl_vat: r2(g.gl_vat), variance: r2(-g.gl_vat), note: `G/L only · Type ${g.tran_type}`,
      }));

    const sum = (list, f) => r2(list.reduce((s, x) => s + (Number(x[f]) || 0), 0));
    const groups = GROUPS.map((G) => {
      const list = rows.filter((r) => r.grp === G.grp);
      return { ...G, count: list.length, taxable: sum(list, "taxable"), vat: sum(list, "vat"),
               gl_vat: sum(list, "gl_vat"), variance: sum(list, "variance") };
    });

    const totals = {
      count: rows.length,
      taxable: sum(rows, "taxable"), vat: sum(rows, "vat"),
      gl_vat: sum(rows, "gl_vat"), variance: sum(rows, "variance"),
      mismatches: rows.filter((r) => Math.abs(r.variance) >= 0.005).length,
    };

    const bt = byType.map((b) => ({ tran_type: b.tran_type, dr: r2(b.dr), cr: r2(b.cr) }));
    const opening = r2(opn[0]?.bal);
    const totDr = sum(bt, "dr"), totCr = sum(bt, "cr");
    const vatAc = {
      acc_code: VAT_AC, acc_head: head[0]?.acc_head || "VAT ON PURCHASE",
      opening, totDr, totCr, closing: r2(opening + totDr - totCr), byType: bt,
    };

    return { rows, groups, totals, vatAc };
  }

  const okDates = (req, res) => {
    const { from, to } = req.query;
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(from || "") || !re.test(to || "")) {
      res.status(400).json({ error: "from and to must be yyyy-mm-dd" });
      return null;
    }
    return { from, to };
  };

  // ── JSON ────────────────────────────────────────────────────────────────────
  router.get("/pur-vat-recon", async (req, res) => {
    const d = okDates(req, res); if (!d) return;
    try { res.json(await build(d.from, d.to)); }
    catch (e) { console.error("pur-vat-recon:", e); res.status(500).json({ error: e.message }); }
  });

  // ── Excel ───────────────────────────────────────────────────────────────────
  router.get("/pur-vat-recon/excel", async (req, res) => {
    const d = okDates(req, res); if (!d) return;
    try {
      const data = await build(d.from, d.to);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Purchase VAT Recon", {
        pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
      });

      const NUM = "#,##0.00;[Red]-#,##0.00";
      const thin = { style: "thin", color: { argb: "FFB8C4D6" } };
      const hdrFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF6" } }; // light, header row only

      ws.columns = [
        { width: 14 }, { width: 11 }, { width: 11 }, { width: 38 }, { width: 18 }, { width: 11 },
        { width: 15 }, { width: 15 }, { width: 15 }, { width: 14 }, { width: 22 },
      ];

      // Title lines — bold text, no fill
      ws.addRow(["Al Hayat Elect. Switchgear Ind. LLC"]).font = { bold: true, size: 14 };
      ws.addRow([`Purchase VAT Reconciliation — Register vs G/L (${VAT_AC} ${data.vatAc.acc_head})`]).font = { bold: true, size: 12 };
      ws.addRow([`Period: ${isoToDmy(d.from)} to ${isoToDmy(d.to)}`]).font = { italic: true };
      ws.addRow([]);

      const hdr = ws.addRow(["PJV No", "PJV Date", "Supp. Code", "Supplier Name", "Invoice No", "Inv. Date",
        "Taxable (AED)", "VAT Register", "VAT per G/L", "Variance", "Remarks"]);
      hdr.eachCell((c, i) => {
        c.font = { bold: true }; c.fill = hdrFill;
        c.border = { top: thin, bottom: thin, left: thin, right: thin };
        c.alignment = { horizontal: i >= 7 && i <= 10 ? "right" : "left", vertical: "middle" };
      });
      ws.views = [{ state: "frozen", ySplit: 5 }];

      const setNums = (row) => { [7, 8, 9, 10].forEach((i) => (row.getCell(i).numFmt = NUM)); };

      for (const g of data.groups) {
        const list = data.rows.filter((r) => r.grp === g.grp);
        if (!list.length) continue;
        for (const r of list) {
          const row = ws.addRow([r.pjv_no, r.pjv_date, r.sup_code, r.sup_name, r.inv_no, r.inv_date,
            r.taxable, r.vat, r.gl_vat, r.variance, r.note]);
          setNums(row);
          if (Math.abs(r.variance) >= 0.005) row.getCell(10).font = { bold: true, color: { argb: "FFC0392B" } };
          if (r.note) row.getCell(11).font = { color: { argb: "FFD35400" } };
        }
        const sub = ws.addRow(["", "", "", `Subtotal — ${g.label} (${g.count})`, "", "",
          g.taxable, g.vat, g.gl_vat, g.variance, ""]);
        setNums(sub);
        sub.font = { bold: true };
        sub.eachCell({ includeEmpty: true }, (c) => (c.border = { top: thin }));
        ws.addRow([]);
      }

      const t = data.totals;
      const gt = ws.addRow(["", "", "", `GRAND TOTAL — ${t.count} vouchers`, "", "",
        t.taxable, t.vat, t.gl_vat, t.variance, `${t.mismatches} mismatch(es)`]);
      setNums(gt);
      gt.font = { bold: true, size: 11 };
      gt.eachCell({ includeEmpty: true }, (c) => (c.border = { top: { style: "double" }, bottom: thin }));

      // VAT A/c statement
      const ac = data.vatAc;
      const side = (n) => (n >= 0 ? "Dr" : "Cr");
      ws.addRow([]); ws.addRow([]);
      ws.addRow([`${ac.acc_code} — ${ac.acc_head}`]).font = { bold: true, size: 12 };
      const line = (label, v, sfx, bold) => {
        const r = ws.addRow(["", "", "", label, "", "", v, sfx]);
        r.getCell(7).numFmt = "#,##0.00";
        if (bold) r.font = { bold: true };
        return r;
      };
      line(`Opening Balance (before ${isoToDmy(d.from)})`, Math.abs(ac.opening), side(ac.opening), true);
      line("Add: Debits in period", ac.totDr, "");
      line("Less: Credits in period", ac.totCr, "");
      const cl = line(`Closing Balance (as on ${isoToDmy(d.to)})`, Math.abs(ac.closing), side(ac.closing), true);
      cl.getCell(7).border = { top: thin, bottom: { style: "double" } };

      ws.addRow([]);
      ws.addRow(["", "", "", "Period movement by Tran Type"]).font = { bold: true };
      const th = ws.addRow(["", "", "", "Tran Type", "", "", "Debits", "Credits", "Net (Dr − Cr)"]);
      [4, 7, 8, 9].forEach((i) => {
        const c = th.getCell(i);
        c.font = { bold: true }; c.fill = hdrFill;
        c.border = { top: thin, bottom: thin, left: thin, right: thin };
        c.alignment = { horizontal: i === 4 ? "center" : "right" };
      });
      for (const m of ac.byType) {
        const r = ws.addRow(["", "", "", m.tran_type, "", "", m.dr, m.cr, r2(m.dr - m.cr)]);
        r.getCell(4).alignment = { horizontal: "center" };
        [7, 8, 9].forEach((i) => (r.getCell(i).numFmt = NUM));
      }
      const tr = ws.addRow(["", "", "", "Total", "", "", ac.totDr, ac.totCr, r2(ac.totDr - ac.totCr)]);
      tr.font = { bold: true };
      tr.getCell(4).alignment = { horizontal: "center" };
      [7, 8, 9].forEach((i) => { tr.getCell(i).numFmt = NUM; tr.getCell(i).border = { top: thin }; });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="PurVatRecon_${d.from}_${d.to}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      console.error("pur-vat-recon/excel:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  return router;
};
