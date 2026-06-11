// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/build-rv-excel
//  Builds a fully-formatted RV Excel template server-side using Python/openpyxl.
//  Returns the .xlsx file as a download.
//
//  Body: {
//    header:   { refNo, vchrNo, rvDate, custCode, custName, bankCode, bankName,
//                particulars, currCode, convRate, amountFc, amountLcl },
//    invoices: [ { DOC_TYPE, DOC_NO, DOC_DATE, INV_AMT }, ... ]
//  }
//
//  Place build_rv_template.py in the same directory as HayatDb.js (E:\hayatApi\)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const express  = require("express");
const router   = express.Router();
const { exec } = require("child_process");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");

// Path to the Python script — same folder as HayatDb.js
const PY_SCRIPT = path.join(__dirname, "build_rv_template.py");

router.post("/build-rv-excel", (req, res) => {
  const { header = {}, invoices = [] } = req.body;

  if (!header.refNo) {
    return res.status(400).json({ error: "header.refNo is required" });
  }

  // Write output to a temp file
  const outFile = path.join(os.tmpdir(), `${header.refNo}.xlsx`);
  const payload  = JSON.stringify({ header, invoices });

  // Escape single quotes in payload for shell safety
  const safePayload = payload.replace(/'/g, "'\\''");

  const cmd = `python3 "${PY_SCRIPT}" '${safePayload}' "${outFile}"`;

  console.log(`[build-rv-excel] Building ${header.refNo} ...`);

  exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("[build-rv-excel] ERROR:", stderr || err.message);
      return res.status(500).json({ error: "Excel build failed", detail: stderr || err.message });
    }

    if (!fs.existsSync(outFile)) {
      return res.status(500).json({ error: "Output file not created" });
    }

    const filename = `${header.refNo}.xlsx`;
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on("close", () => {
      // Clean up temp file
      fs.unlink(outFile, () => {});
      console.log(`[build-rv-excel] Sent ${filename}`);
    });
    stream.on("error", (e) => {
      console.error("[build-rv-excel] Stream error:", e.message);
      res.status(500).end();
    });
  });
});

module.exports = router;
