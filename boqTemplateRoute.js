"use strict";
/**
 * boqTemplateRoute.js
 * ExcelJS BOQ Template builder — mirrors build_rv_excel.js exactly.
 *
 * Install:  npm install exceljs   (once, in E:\hayatApi)
 * Mount in HayatDb.js:
 *   const boqTplRoute = require('./boqTemplateRoute')(connection);
 *   app.use('/api', boqTplRoute);
 */

const ExcelJS = require("exceljs");
const express = require("express");

const SEP = "   |   ";   // separator used in combined dropdown display values

// ── Colour palette (same style as build_rv_excel.js) ─────────────────────────
const C = {
  NAV:     "0D2440",   WHT:     "FFFFFF",
  HDR_BG:  "2C5282",   HDR_FG:  "FFFFFF",
  LOCK_BG: "EDF2FB",   LOCK_FG: "4A5568",
  EDIT_BG: "FFFFFF",   EDIT_FG: "1A202C",
  TOT_BG:  "DBEAFE",   TOT_FG:  "1D4ED8",
  WARN_BG: "FFFDE7",
  BORDER:  "CBD5E0",
  NAVY_TXT:"1A365D",   GREEN_TXT:"166534",  BLUE_TXT: "2C5282",
};

// ── Style helpers (identical pattern to build_rv_excel.js) ───────────────────
const asARGB = (hex) => {
  if (!hex) return "FF000000";
  const s = String(hex).replace(/^#/, "");
  return s.length === 6 ? "FF" + s : s;
};

const solid  = (hex) => ({ type:"pattern", pattern:"solid", fgColor:{ argb: asARGB(hex) } });
const border = (hex = C.BORDER) => {
  const s = { style:"thin", color:{ argb: asARGB(hex) } };
  return { top:s, bottom:s, left:s, right:s };
};
const font = (opts = {}) => ({
  name:"Calibri", size: opts.sz || 10,
  bold: !!opts.bold, italic: !!opts.italic,
  color:{ argb: asARGB(opts.color || C.EDIT_FG) },
});
const align = (h = "left", v = "middle", wrap = false) =>
  ({ horizontal:h, vertical:v, wrapText:wrap });

// Column header cell — dark blue bg, white bold text
function colHdr(cell, text) {
  cell.value     = text;
  cell.fill      = solid(C.HDR_BG);
  cell.font      = font({ sz:10, bold:true, color:C.HDR_FG });
  cell.alignment = align("center", "middle", true);
  cell.border    = border();
}

// Locked/auto-filled cell — light blue bg, italic grey text
function locked(cell, value, opts = {}) {
  cell.value     = value ?? null;
  cell.fill      = solid(C.LOCK_BG);
  cell.font      = font({ sz:10, italic:true, color: opts.color || C.LOCK_FG, bold: !!opts.bold });
  cell.alignment = align(opts.align || "left");
  cell.border    = border();
  if (opts.nf) cell.numFmt = opts.nf;
}

// User-editable cell — white bg (protection.locked:false allows editing)
function editable(cell, value, opts = {}) {
  cell.value      = value ?? null;
  cell.fill       = solid(C.EDIT_BG);
  cell.font       = font({ sz:10, bold: !!opts.bold, color: opts.color || C.EDIT_FG });
  cell.alignment  = align(opts.align || "left");
  cell.border     = border();
  cell.protection = { locked: false };   // ← unlocked when sheet is protected
  if (opts.nf) cell.numFmt = opts.nf;
}

// ── Main workbook builder ─────────────────────────────────────────────────────
async function buildWorkbook(jobNo, panels, items) {
  const COST_TYPES = [
    { code:"COMP", label:"Component"  },
    { code:"BUSB", label:"Bus-bar"    },
    { code:"CONS", label:"Consumable" },
    { code:"LABR", label:"Labour"     },
    { code:"OTHR", label:"Other"      },
  ];
  const DATA_ROWS = 100;

  const wb = new ExcelJS.Workbook();
  wb.creator = "HayatERP";
  wb.created = new Date();

  // ════════════════════════════════════════════════════════════════
  // Sheet 1: BOQ Template  (main data-entry sheet)
  // ════════════════════════════════════════════════════════════════
  const ws = wb.addWorksheet("BOQ Template", {
    views: [{ state:"frozen", xSplit:2, ySplit:2, topLeftCell:"C3",
              showGridLines:true }],
  });

  // Column widths: A=JobNo B=PanelNo C=PanelRef D=# E=CostType
  //               F=ItemCode G=Desc H=Unit I=Qty J=UnitCost K=Total L=Remarks
  [10, 22, 34, 5, 22, 50, 30, 8, 10, 12, 13, 28].forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  // ── Row 1: Title ────────────────────────────────────────────────
  ws.getRow(1).height = 22;
  ws.mergeCells(1, 1, 1, 12);
  const title = ws.getCell(1, 1);
  title.value     = `BILL OF QUANTITIES (BOQ) — Job No: ${jobNo}  |  Generated: ${new Date().toLocaleString("en-GB")}  |  Fill ONLY white cells`;
  title.fill      = solid(C.NAV);
  title.font      = font({ sz:11, bold:true, color:C.HDR_FG });
  title.alignment = align("center");

  // ── Row 2: Column headers ────────────────────────────────────────
  ws.getRow(2).height = 26;
  const HEADERS = ["Job No","Panel No","Panel Ref","#","Cost Type",
                   "Item Code","Description","Unit","Qty","Unit Cost","Total Cost","Remarks"];
  HEADERS.forEach((h, ci) => colHdr(ws.getCell(2, ci + 1), h));

  // ── Rows 3 → DATA_ROWS+2: Data rows ─────────────────────────────
  // Helper: extract code before the SEP separator
  const S  = SEP;
  const SL = SEP.length;
  const fc = (ref) => `IFERROR(LEFT(${ref},FIND("${S}",${ref})-1),${ref})`;
  const fd = (ref) => `IFERROR(MID(${ref},FIND("${S}",${ref})+${SL},LEN(${ref})),${ref})`;

  for (let ri = 3; ri <= DATA_ROWS + 2; ri++) {
    const row = ws.getRow(ri);
    row.height = 18;

    // A: Job No — locked, pre-filled
    locked(ws.getCell(ri, 1), String(jobNo), { align:"center", bold:true, color:C.NAVY_TXT });

    // B: Panel No — editable, dropdown applied below
    editable(ws.getCell(ri, 2), null, { align:"left", color:C.NAVY_TXT, bold:true });

    // C: Panel Ref — auto-filled via VLOOKUP on extracted Panel No
    const cC = ws.getCell(ri, 3);
    cC.value     = { formula:`IF(B${ri}="","",IFERROR(VLOOKUP(${fc(`B${ri}`)},Panels!$A:$B,2,0),${fd(`B${ri}`)}))` };
    cC.fill      = solid(C.LOCK_BG);
    cC.font      = font({ sz:10, italic:true, color:C.LOCK_FG });
    cC.alignment = align("left");
    cC.border    = border();

    // D: Sequence # within panel
    const cD = ws.getCell(ri, 4);
    cD.value     = { formula:`IF(B${ri}="","",IFERROR(COUNTIF(B$3:B${ri},${fc(`B${ri}`)}),1))` };
    cD.fill      = solid(C.LOCK_BG);
    cD.font      = font({ sz:10, italic:true, color:C.LOCK_FG });
    cD.alignment = align("center");
    cD.border    = border();

    // E: Cost Type — editable, dropdown applied below
    editable(ws.getCell(ri, 5), null, { align:"center", color:C.GREEN_TXT, bold:true });

    // F: Item Code — editable, dropdown applied below
    editable(ws.getCell(ri, 6), null, { align:"left", color:C.BLUE_TXT, bold:true });

    // G: Description — auto-filled via VLOOKUP on extracted Item Code
    const cG = ws.getCell(ri, 7);
    cG.value     = { formula:`IF(F${ri}="","",IFERROR(VLOOKUP(${fc(`F${ri}`)},Items!$A:$B,2,0),${fd(`F${ri}`)}))` };
    cG.fill      = solid(C.LOCK_BG);
    cG.font      = font({ sz:10, italic:true, color:C.LOCK_FG });
    cG.alignment = align("left");
    cG.border    = border();

    // H: Unit — auto-filled via VLOOKUP on extracted Item Code
    const cH = ws.getCell(ri, 8);
    cH.value     = { formula:`IF(F${ri}="","",IFERROR(VLOOKUP(${fc(`F${ri}`)},Items!$A:$C,3,0),"NOS"))` };
    cH.fill      = solid(C.LOCK_BG);
    cH.font      = font({ sz:10, italic:true, color:C.LOCK_FG });
    cH.alignment = align("center");
    cH.border    = border();

    // I: Qty — editable
    editable(ws.getCell(ri,  9), null, { align:"right", nf:"#,##0.00" });

    // J: Unit Cost — editable
    editable(ws.getCell(ri, 10), null, { align:"right", nf:"#,##0.00" });

    // K: Total Cost — auto-calculated, never #VALUE
    const cK = ws.getCell(ri, 11);
    cK.value     = { formula:`IFERROR(IF(AND(OR(I${ri}="",I${ri}=0),OR(J${ri}="",J${ri}=0)),0,IF(ISNUMBER(I${ri}),I${ri},0)*IF(ISNUMBER(J${ri}),J${ri},0)),0)` };
    cK.fill      = solid(C.TOT_BG);
    cK.font      = font({ sz:10, bold:true, color:C.TOT_FG });
    cK.numFmt    = "#,##0.00";
    cK.alignment = align("right");
    cK.border    = border();

    // L: Remarks — editable
    editable(ws.getCell(ri, 12), null, { align:"left" });
  }

  // ── Grand Total row ──────────────────────────────────────────────
  const TR = DATA_ROWS + 3;
  ws.getRow(TR).height = 20;
  ws.mergeCells(TR, 1, TR, 10);
  const tl = ws.getCell(TR, 1);
  tl.value     = "GRAND TOTAL";
  tl.fill      = solid(C.HDR_BG);
  tl.font      = font({ sz:11, bold:true, color:C.HDR_FG });
  tl.alignment = align("right");
  tl.border    = border();

  const tK = ws.getCell(TR, 11);
  tK.value     = { formula:`SUM(K3:K${DATA_ROWS + 2})` };
  tK.fill      = solid(C.HDR_BG);
  tK.font      = font({ sz:12, bold:true, color:"FFFBBF24" });   // gold total
  tK.numFmt    = "#,##0.00";
  tK.alignment = align("right");
  tK.border    = border();

  const tL = ws.getCell(TR, 12);
  tL.fill   = solid(C.HDR_BG);
  tL.border = border();

  // ── Data Validations ────────────────────────────────────────────
  const pc = panels.length;
  const ic = items.length;
  const cc = COST_TYPES.length;

  // B: Panel No — Panels sheet col D (combined "SrNo | PanelRef")
  ws.dataValidations.add(`B3:B${DATA_ROWS + 2}`, {
    type:     "list",
    allowBlank: true,
    formulae: [`Panels!$D$2:$D$${pc + 1}`],
    showDropDown: false,
    showErrorMessage: false,
  });

  // E: Cost Type — Cost Types sheet col C (combined "CODE | Label")
  ws.dataValidations.add(`E3:E${DATA_ROWS + 2}`, {
    type:     "list",
    allowBlank: true,
    formulae: [`'Cost Types'!$C$2:$C$${cc + 1}`],
    showDropDown: false,
    showErrorMessage: false,
  });

  // F: Item Code — Items sheet col D (combined "ItemCode | ItemName")
  ws.dataValidations.add(`F3:F${DATA_ROWS + 2}`, {
    type:     "list",
    allowBlank: true,
    formulae: [`Items!$D$2:$D$${ic + 1}`],
    showDropDown: false,
    showErrorMessage: false,
  });

  // ── Sheet protection: lock all except editable() cells ──────────
  await ws.protect("hayat", {
    selectLockedCells:   true,
    selectUnlockedCells: true,
    formatCells:         false,
    formatColumns:       false,
    formatRows:          false,
    insertRows:          false,
    deleteRows:          false,
    sort:                false,
    autoFilter:          false,
  });

  // ════════════════════════════════════════════════════════════════
  // Sheet 2: Panels  (lookup data for col B dropdown)
  // ════════════════════════════════════════════════════════════════
  const wsP = wb.addWorksheet("Panels");
  wsP.columns = [
    { width:12 }, { width:40 }, { width:8 }, { width:52 },
  ];
  wsP.getRow(1).height = 22;
  ["Panel No","Panel Ref","Qty","Select Panel (Dropdown)"].forEach((h, ci) =>
    colHdr(wsP.getRow(1).getCell(ci + 1), h)
  );
  panels.forEach((p, ri) => {
    const row = wsP.getRow(ri + 2);
    row.height = 16;
    locked(row.getCell(1), p.SrNo,          { align:"center" });
    locked(row.getCell(2), p.panelRef,       { align:"left"   });
    locked(row.getCell(3), Number(p.qty)||1, { align:"right", nf:"0.00" });
    // col D: hardcoded combined string — NO formula, so Excel never needs to repair
    locked(row.getCell(4), `${p.SrNo}${SEP}${p.panelRef}`, { align:"left" });
  });

  // ════════════════════════════════════════════════════════════════
  // Sheet 3: Items  (lookup data for col F dropdown)
  // ════════════════════════════════════════════════════════════════
  const wsI = wb.addWorksheet("Items");
  wsI.columns = [
    { width:14 }, { width:50 }, { width:8 }, { width:66 },
  ];
  wsI.getRow(1).height = 22;
  ["Item Code","Description","Unit","Select Item (Dropdown)"].forEach((h, ci) =>
    colHdr(wsI.getRow(1).getCell(ci + 1), h)
  );
  items.forEach((itm, ri) => {
    const row = wsI.getRow(ri + 2);
    row.height = 16;
    locked(row.getCell(1), itm.code, { align:"center" });
    locked(row.getCell(2), itm.name, { align:"left"   });
    locked(row.getCell(3), itm.unit, { align:"center" });
    // col D: hardcoded combined string
    locked(row.getCell(4), `${itm.code}${SEP}${itm.name}`, { align:"left" });
  });

  // ════════════════════════════════════════════════════════════════
  // Sheet 4: Cost Types  (lookup data for col E dropdown)
  // ════════════════════════════════════════════════════════════════
  const wsC = wb.addWorksheet("Cost Types");
  wsC.columns = [{ width:8 }, { width:16 }, { width:30 }];
  wsC.getRow(1).height = 22;
  ["Code","Description","Select Type (Dropdown)"].forEach((h, ci) =>
    colHdr(wsC.getRow(1).getCell(ci + 1), h)
  );
  COST_TYPES.forEach((ct, ri) => {
    const row = wsC.getRow(ri + 2);
    row.height = 16;
    locked(row.getCell(1), ct.code,  { align:"center" });
    locked(row.getCell(2), ct.label, { align:"left"   });
    locked(row.getCell(3), `${ct.code}${SEP}${ct.label}`, { align:"left" });
  });

  // ════════════════════════════════════════════════════════════════
  // Sheet 5: Instructions  (same pattern as build_rv_excel.js)
  // ════════════════════════════════════════════════════════════════
  const wsInstr = wb.addWorksheet("Instructions");
  wsInstr.getColumn(1).width = 90;
  [
    { text:`BOQ TEMPLATE — JOB: ${jobNo}`,                                          bold:true,  sz:12, bg:C.NAV,     fg:"FFFFFF" },
    { text:"",                                                                       bold:false, sz:9,  bg:"FFFFFF",  fg:"000000" },
    { text:"HOW TO USE THIS TEMPLATE",                                               bold:true,  sz:11, bg:C.HDR_BG,  fg:"FFFFFF" },
    { text:`1. Col B (Panel No): click the cell — select from dropdown list.`,       bold:false, sz:10, bg:"F0F5FF",  fg:C.NAVY_TXT },
    { text:"2. Col C (Panel Ref): auto-fills when you select Panel No. Do not edit.",bold:false, sz:10, bg:"FFFFFF",  fg:"000000" },
    { text:`3. Col E (Cost Type): click cell — select COMP/BUSB/CONS/LABR/OTHR.`,    bold:false, sz:10, bg:"F0F5FF",  fg:C.NAVY_TXT },
    { text:`4. Col F (Item Code): click cell — select from item dropdown.`,          bold:false, sz:10, bg:"FFFFFF",  fg:"000000" },
    { text:"5. Col G (Description) and H (Unit): auto-fill from Item Code. Do not edit.", bold:false, sz:10, bg:"F0F5FF", fg:C.NAVY_TXT },
    { text:"6. Col I (Qty) and J (Unit Cost): enter values — Total Cost (K) is calculated.", bold:false, sz:10, bg:"FFFFFF", fg:"000000" },
    { text:"7. Fill one row per BOQ item. You can enter items for multiple panels.",  bold:false, sz:10, bg:"F0F5FF",  fg:C.NAVY_TXT },
    { text:"8. Save the file and use the Import Excel button in the ERP to load data.", bold:false, sz:10, bg:"FFFFFF", fg:"000000" },
    { text:"9. Sheet is protected. Only white cells (B, E, F, I, J, L) are editable. Password: hayat", bold:false, sz:10, bg:"FFFDE7", fg:"92400E" },
  ].forEach((r, i) => {
    const cell = wsInstr.getCell(i + 1, 1);
    cell.value     = r.text;
    cell.font      = { name:"Calibri", size:r.sz, bold:r.bold, color:{ argb: asARGB(r.fg) } };
    cell.fill      = { type:"pattern", pattern:"solid", fgColor:{ argb: asARGB(r.bg) } };
    cell.alignment = { horizontal:"left", vertical:"middle", wrapText:true };
    wsInstr.getRow(i + 1).height = r.bold ? 22 : 18;
  });

  return wb;
}

// ── Module export: factory function receives the shared MySQL connection ──────
// Usage in HayatDb.js:
//   const boqTplRoute = require('./boqTemplateRoute')(connection);
//   app.use('/api', boqTplRoute);

module.exports = function (connection) {
  const router = express.Router();

  // Helper: promisify connection.query
  const dbQuery = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, results) =>
        err ? reject(err) : resolve(results)
      )
    );

  // ── POST /api/job-boq-template ──────────────────────────────────────────────
  router.post("/job-boq-template", async (req, res) => {
    const { jobNo, panels = [] } = req.body;
    if (!jobNo) return res.status(400).json({ error: "jobNo is required" });

    try {
      // Fetch items directly from DB — no axios, no HTTP round-trip
      let items = [];
      try {
        const rows = await dbQuery(
          "SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT FROM item_mst ORDER BY cat_code, sub_cat, item_code"
        );
        items = rows.map(r => ({
          code: String(r.ITEM_CODE  || "").trim(),
          name: String(r.ITEM_NAME1 || "").trim(),
          unit: String(r.ITEM_UNIT  || "NOS").trim(),
        }));
      } catch (e) {
        console.warn("[boq-template] DB items fetch failed:", e.message);
      }

      const wb       = await buildWorkbook(String(jobNo), panels, items);
      const filename = `BOQ_Template_Job${jobNo}.xlsx`;

      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      await wb.xlsx.write(res);
      res.end();
      console.log(`[boq-template] Sent ${filename} — ${panels.length} panels, ${items.length} items`);
    } catch (err) {
      console.error("[boq-template] Error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  return router;
};
