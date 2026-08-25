/**
 * Despatch Note PDF Route
 * File: E:\hayatApi\routes\despatchNoteRoutes.js
 *
 * Endpoint:
 *   GET /api/despatch-note/:jobNumber
 *
 * Generates an A4 PDF with 2 despatch note sections per page.
 * Each section matches the Oracle report layout:
 *   - Company header
 *   - FROM field
 *   - JOB NO / PROJECT / PANEL REF
 *   - "This side up" arrows + HANDLE WITH CARE
 *
 * Data pulled from existing API endpoints:
 *   GET /api/jobcard/:jobNumber   → job header (project, customer etc.)
 *   GET /api/jobpanels/:jobNumber → array of panels
 *
 * Registration in HayatDb.js:
 *   const despatchNote = require('./routes/despatchNoteRoutes');
 *   app.use('/api', despatchNote(connection));
 */

const express  = require('express');
const PDFDocument = require('pdfkit');
// Uses native fetch (Node.js 18+) — no extra dependency needed

// ── Self-call base URL (backend calls its own API to reuse existing routes) ──
// Uses same port the Express server is running on.
const SELF = process.env.SELF_URL || 'http://127.0.0.1:3001';

module.exports = function (connection) {
  const router = express.Router();

  // ── GET /api/despatch-note/:jobNumber ──────────────────────────────────────
  router.get('/despatch-note/:jobNumber', async (req, res) => {
    const { jobNumber } = req.params;
    const token = req.headers.authorization || '';

    try {
      // Fetch job card + panels in parallel from existing routes
      const fetchJson = async (url) => {
        const r = await fetch(url, { headers: { Authorization: token } });
        if (!r.ok) {
          const err = new Error(`Upstream ${url} returned ${r.status}`);
          err.status = r.status;
          throw err;
        }
        return r.json();
      };

      const [jobRaw, panels] = await Promise.all([
        fetchJson(`${SELF}/api/jobcard/${jobNumber}`),
        fetchJson(`${SELF}/api/jobpanels/${jobNumber}`),
      ]);
      // jobcard route returns array — take first element
      const job = Array.isArray(jobRaw) ? jobRaw[0] : jobRaw;

      if (!panels || panels.length === 0) {
        return res.status(404).json({ error: 'No panels found for this job.' });
      }

      // Stream PDF directly to the response
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `attachment; filename="DespatchNote_${jobNumber}.pdf"`);

      const theme = req.query.theme || 'white';
      const pdf = buildDespatchPdf(job, panels, theme);
      pdf.pipe(res);

    } catch (err) {
      console.error('[despatch-note]', err.message);
      // If the error is an axios 404 from upstream, surface it cleanly
      if (err.status === 404) {
        return res.status(404).json({ error: `Job ${jobNumber} not found.` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// ─────────────────────────────────────────────────────────────────────────────
// PDF BUILDER
// A4 portrait: 595.28 × 841.89 pt
// Two despatch note sections per page, stacked vertically.
// Each section = half the page height minus a small gutter.
// ─────────────────────────────────────────────────────────────────────────────

function buildDespatchPdf(job, panels, theme = 'white') {
  const PAGE_W  = 595.28;
  const PAGE_H  = 841.89;
  const MARGIN  = 28;           // page margin (pt)
  const GUTTER  = 14;           // gap between the two sections
  const SECT_H  = (PAGE_H - MARGIN * 2 - GUTTER) / 2;  // height of one note
  const SECT_W  = PAGE_W - MARGIN * 2;

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    autoFirstPage: true,
    info: { Title: `Despatch Note — Job ${job.job_no || job.JOB_NO || ''}` },
  });

  // ── Draw two panels per page ──────────────────────────────────────────────
  panels.forEach((panel, idx) => {
    if (idx > 0 && idx % 2 === 0) {
      doc.addPage();
    }
    const slotIndex = idx % 2;          // 0 = top half, 1 = bottom half
    const originY   = MARGIN + slotIndex * (SECT_H + GUTTER);

    drawDespatchNote(doc, job, panel, MARGIN, originY, SECT_W, SECT_H, theme);

    // Dashed divider between the two sections on same page
    if (slotIndex === 0 && idx + 1 < panels.length) {
      const divY = MARGIN + SECT_H + GUTTER / 2;
      doc.save()
         .dash(4, { space: 4 })
         .moveTo(MARGIN, divY)
         .lineTo(MARGIN + SECT_W, divY)
         .lineWidth(0.5)
         .strokeColor('#AAAAAA')
         .stroke()
         .undash()
         .restore();
    }
  });

  // Odd panel count — second slot on last page intentionally left blank (no frame)

  doc.end();
  return doc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Draw one despatch note section
//   x, y = top-left origin of the section
//   w, h = width and height of the section
// ─────────────────────────────────────────────────────────────────────────────


// ─── Theme palettes ───────────────────────────────────────────────────────────
const THEMES = {
  white: {
    ACCENT : '#000000', RULE   : '#000000', TITLE  : '#000000',
    HDR_BG : '#FFFFFF', LABEL_BG: '#FFFFFF', PANEL_TINT: '#FFFFFF',
  },
  white: {
    ACCENT : '#000000', RULE   : '#000000', TITLE  : '#000000',
    HDR_BG : '#FFFFFF', LABEL_BG: '#FFFFFF', PANEL_TINT: '#FFFFFF',
  },
  plain: {
    ACCENT : '#555555', RULE   : '#777777', TITLE  : '#000000',
    HDR_BG : '#F5F5F5', LABEL_BG: '#EEEEEE', PANEL_TINT: '#F0F0F0',
  },
  'navy-gold': {
    ACCENT : '#C9A84C', RULE   : '#C9A84C', TITLE  : '#C9A84C',
    HDR_BG : '#E8EFF5', LABEL_BG: '#EEF2F6', PANEL_TINT: '#EBF0F7',
  },
  'steel-blue': {
    ACCENT : '#1D4ED8', RULE   : '#1D4ED8', TITLE  : '#0F6E84',
    HDR_BG : '#EBF0F7', LABEL_BG: '#EEF2F6', PANEL_TINT: '#EBF4FF',
  },
  'amber-red': {
    ACCENT : '#D97706', RULE   : '#EA580C', TITLE  : '#C41E3A',
    HDR_BG : '#E8EFF5', LABEL_BG: '#EEF2F6', PANEL_TINT: '#EBF0F7',
  },
  'teal-green': {
    ACCENT : '#0F766E', RULE   : '#0D9488', TITLE  : '#15803D',
    HDR_BG : '#F0FAFA', LABEL_BG: '#ECFAF8', PANEL_TINT: '#F0FFF4',
  },
};


function drawDespatchNote(doc, job, panel, x, y, w, h, theme = 'white') {
  const g = (obj, ...keys) => {
    if (!obj) return '---';
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return String(obj[k]).trim();
      const u = k.toUpperCase(); if (obj[u] != null && obj[u] !== '') return String(obj[u]).trim();
      const l = k.toLowerCase(); if (obj[l] != null && obj[l] !== '') return String(obj[l]).trim();
    }
    return '---';
  };

  const jobNo    = g(job,   'JOB_NO','job_no','JobNo');
  const project  = g(job,   'PROJ_NAME','proj_name','PROJECT','project','PROJ_NO','proj_no');
  const panelRef = g(panel, 'PANEL_REF','panel_ref','PANEL_DESCRIPTION','panel_description','PANEL_TAG','panel_tag');

  // ── Design tokens — resolved from chosen theme ────────────────────────────
  const NAVY     = '#0D1B2A';              // outer border + text — always navy
  const LABEL_FG = '#1B3A5C';             // label text — always dark blue
  const BORDER   = 1.8;
  const THIN     = 0.5;
  const PAD      = 10;
  const pal       = THEMES[theme] || THEMES['amber-red'];
  const ACCENT    = pal.ACCENT;            // top stripe colour
  const LABEL_BG  = pal.LABEL_BG;         // label column background
  const HDR_BG    = pal.HDR_BG;           // header background
  const RULE_COL  = pal.RULE;             // accent rule lines
  const TITLE_COL = pal.TITLE;            // DESPATCH PARTICULARS text
  const PANEL_TINT= pal.PANEL_TINT;       // PANEL REF value cell tint

  // ── Integer section heights — keeps ALL horizontal lines pixel-sharp ───────
  const hdrH     = Math.round(h * 0.285);
  const fromH    = Math.round(h * 0.095);
  const detLineH = Math.round(h * 0.095);  // each of 3 detail rows
  const detailH  = detLineH * 3;
  const careH    = h - hdrH - fromH - detailH;  // remainder — no rounding error

  // Outer border
  doc.save().rect(x, y, w, h).lineWidth(BORDER).strokeColor(NAVY).stroke().restore();

  let cy = Math.round(y);

  // ── 1. HEADER ─────────────────────────────────────────────────────────────
  const hdrY = cy; cy += hdrH;

  doc.save().rect(x, hdrY, w, hdrH).fill(HDR_BG).restore();
  // Decorative stripes — skipped for pure white theme
  if (theme !== 'white') {
    doc.save().rect(x, hdrY, w, 4).fill(NAVY).restore();
    doc.save().rect(x, hdrY + 4, w, 2.5).fill(ACCENT).restore();
  }
  // Bottom border (exact integer y)
  doc.save().moveTo(x, cy).lineTo(x + w, cy).lineWidth(BORDER).strokeColor(NAVY).stroke().restore();

  doc.font('Helvetica-Bold').fontSize(17).fillColor(NAVY);
  doc.text('AL HAYAT ELECT. SWITCHGEAR IND. LLC.', x, hdrY + 14, { width: w, align: 'center' });

  const acX = x + w * 0.12, acW = w * 0.76;
  doc.save().moveTo(acX, hdrY + hdrH * 0.43).lineTo(acX + acW, hdrY + hdrH * 0.43)
     .lineWidth(1.2).strokeColor(RULE_COL).stroke().restore();

  doc.font('Helvetica').fontSize(9).fillColor('#555');
  doc.text('SHARJAH, U.A.E     Tel: +971 6 553 5805     www.alhayatswitchgear.com',
    x, hdrY + hdrH * 0.47, { width: w, align: 'center' });

  doc.save().moveTo(acX, hdrY + hdrH * 0.66).lineTo(acX + acW, hdrY + hdrH * 0.66)
     .lineWidth(0.8).strokeColor(RULE_COL).stroke().restore();

  doc.font('Helvetica-Bold').fontSize(13).fillColor(TITLE_COL);
  doc.text('DESPATCH PARTICULARS', x, hdrY + hdrH * 0.70, { width: w, align: 'center' });

  // ── 2. FROM ROW ───────────────────────────────────────────────────────────
  const fromY = cy; cy += fromH;

  // Bottom of FROM row (exact integer)
  doc.save().moveTo(x, cy).lineTo(x + w, cy).lineWidth(THIN).strokeColor('#BBBBBB').stroke().restore();

  const fLW = 110;
  doc.save().rect(x, fromY, fLW, fromH).fill(LABEL_BG).restore();
  doc.save().moveTo(x + fLW, fromY).lineTo(x + fLW, fromY + fromH)
     .lineWidth(THIN).strokeColor('#BBBBBB').stroke().restore();

  const fMY = fromY + (fromH - 10) / 2;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(LABEL_FG).text('FROM', x + PAD, fMY, { width: fLW - PAD });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
     .text('AL HAYAT ELECT. SWITCHGEAR IND. LLC.', x + fLW + PAD, fMY, { width: w - fLW - PAD, lineBreak: false });

  // ── 3. JOB DETAILS (3 equal-height rows) ─────────────────────────────────
  const detY = cy; cy += detailH;

  // Bottom border of details block
  doc.save().moveTo(x, cy).lineTo(x + w, cy).lineWidth(BORDER).strokeColor(NAVY).stroke().restore();

  const dLW = 110;
  doc.save().rect(x, detY, dLW, detailH).fill(LABEL_BG).restore();
  doc.save().moveTo(x + dLW, detY).lineTo(x + dLW, detY + detailH)
     .lineWidth(THIN).strokeColor('#BBBBBB').stroke().restore();

  [
    ['JOB NO:',    jobNo,    false],
    ['PROJECT:',   project,  false],
    ['PANEL REF:', panelRef, true ],
  ].forEach(([lbl, val, big], i) => {
    const rowY = detY + i * detLineH;  // always integer — no drift

    if (i > 0) {
      doc.save().moveTo(x, rowY).lineTo(x + w, rowY)
         .lineWidth(THIN).strokeColor('#CCCCCC').stroke().restore();
    }
    if (big) {
      doc.save().rect(x + dLW, rowY, w - dLW, detLineH).fill(PANEL_TINT).restore();
    }

    const tY = rowY + (detLineH - (big ? 13 : 11)) / 2;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(LABEL_FG)
       .text(lbl, x + PAD, tY + 1, { width: dLW - PAD });
    doc.font('Helvetica-Bold').fontSize(big ? 13 : 12).fillColor(big ? NAVY : '#222')
       .text(val, x + dLW + PAD, tY, { width: w - dLW - PAD * 2, lineBreak: false });
  });

  // ── 4. ARROWS + HANDLE WITH CARE ─────────────────────────────────────────
  const careY  = cy;
  const arrowW = Math.round(w * 0.42);
  const careW  = w - arrowW;

  doc.save().moveTo(x + arrowW, careY).lineTo(x + arrowW, careY + careH)
     .lineWidth(THIN).strokeColor('#BBBBBB').stroke().restore();

  // Two upward arrows
  const aMX = x + arrowW / 2, aTop = careY + careH * 0.10, aBot = careY + careH * 0.72;
  const aAH = aBot - aTop, hH = aAH * 0.26, sW = 7, hW = 20, sp = 30;
  [-sp / 2, sp / 2].forEach(off => {
    const ax = aMX + off;
    doc.save().rect(ax - sW/2, aTop + hH, sW, aAH - hH).fill(NAVY).restore();
    doc.save().moveTo(ax, aTop).lineTo(ax + hW/2, aTop + hH)
       .lineTo(ax - hW/2, aTop + hH).closePath().fill(NAVY).restore();
  });

  const lY = aBot + 8;
  doc.save().moveTo(x + 20, lY).lineTo(x + arrowW - 20, lY)
     .lineWidth(1).strokeColor(NAVY).stroke().restore();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY)
     .text('This side up', x, lY + 5, { width: arrowW, align: 'center' });

  // HANDLE WITH CARE — no fill (saves toner)
  const fS = 24, lG = 6, tH = fS * 3 + lG * 2, hwY = careY + (careH - tH) / 2;
  doc.font('Helvetica-Bold').fontSize(fS).fillColor(NAVY);
  doc.text('HANDLE\nWITH\nCARE', x + arrowW + PAD, hwY,
    { width: careW - PAD * 2, align: 'center', lineGap: lG });
}
