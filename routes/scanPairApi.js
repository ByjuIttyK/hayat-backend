// routes/scanPairApi.js
//
// Phone-as-scanner pairing. Deliberately shaped like the voice pairing route
// (/api/voice/session) so the two read the same:
//
//   POST   /api/scan/session            desktop  → { code, qr }
//   GET    /api/scan/session/:code      desktop  → { status, seq, name, mimeType }
//   GET    /api/scan/session/:code/file desktop  → { fileBase64, mimeType, name, seq }
//   DELETE /api/scan/session/:code      desktop  → ends the session
//   POST   /api/scan/session/:code/paired   phone → marks the phone arrived
//   POST   /api/scan/session/:code/upload   phone → { fileBase64, mimeType, name }
//
// The difference from the voice route is what the session carries: an image
// or PDF of a supplier invoice rather than a transcript. Hence the separate
// in-memory store, the 30 MB body limit and the shorter retention — the file
// is dropped the moment the desktop has collected it.
//
// The two phone endpoints are intentionally unauthenticated: the phone has no
// JWT, the 6-digit code IS the credential, and it dies after 15 minutes.

const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");

// Where the phone should land. Same origin the users already browse to.
// Set SCAN_APP_URL in the API's .env if the front end ever moves.
const APP_URL = process.env.SCAN_APP_URL || process.env.PUBLIC_APP_URL || "https://hayaterp.cloud";

const TTL_MS = 15 * 60 * 1000;   // session lifetime
const MAX_BYTES = 25 * 1024 * 1024;

module.exports = function (connection) {
  const router = express.Router();

  // Photos are far bigger than the 100 kb express.json default, so this
  // router gets its own parser rather than raising the limit app-wide.
  router.use("/scan", express.json({ limit: "30mb" }));

  /** code -> session */
  const sessions = new Map();

  const newCode = () => {
    let c;
    do {
      c = String(crypto.randomInt(100000, 1000000)); // 6 digits, never leading-zero
    } while (sessions.has(c));
    return c;
  };

  // Sweep expired sessions once a minute so a user who closes the browser
  // mid-pair doesn't leave a photo sitting in memory.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, s] of sessions) {
      if (now - s.createdAt > TTL_MS) sessions.delete(code);
    }
  }, 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  const live = (code) => {
    const s = sessions.get(code);
    if (!s) return null;
    if (Date.now() - s.createdAt > TTL_MS) { sessions.delete(code); return null; }
    return s;
  };

  // ── desktop: open a session and get the QR ───────────────────────────
  router.post("/scan/session", async (req, res) => {
    try {
      const code = newCode();
      const url = `${APP_URL}/scan/${code}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 460 });

      sessions.set(code, {
        code,
        url,
        screen: String(req.body?.screen || ""),
        createdAt: Date.now(),
        status: "WAITING",   // WAITING → PAIRED → SENT
        seq: 0,
        file: null,          // { base64, mimeType, name }
      });

      res.json({ code, qr, url });
    } catch (err) {
      console.error("[scan] session create failed:", err);
      res.status(500).json({ error: "Could not start a phone session" });
    }
  });

  // ── desktop: poll ────────────────────────────────────────────────────
  // Metadata only. The file itself is collected separately so a 4 MB photo
  // isn't dragged over the wire every 1.5 seconds.
  router.get("/scan/session/:code", (req, res) => {
    const s = live(req.params.code);
    if (!s) return res.status(410).json({ error: "Session expired" });
    res.json({
      status: s.status,
      seq: s.seq,
      name: s.file?.name || null,
      mimeType: s.file?.mimeType || null,
    });
  });

  // ── desktop: collect the file ────────────────────────────────────────
  // Clearing s.file here is what stops the desktop picking up the same
  // photo twice, and keeps the image out of memory once it has landed.
  router.get("/scan/session/:code/file", (req, res) => {
    const s = live(req.params.code);
    if (!s) return res.status(410).json({ error: "Session expired" });
    if (!s.file) return res.status(404).json({ error: "Nothing sent yet" });

    const { base64, mimeType, name } = s.file;
    s.file = null;
    s.status = "PAIRED";   // back to ready — the phone can send another page
    res.json({ fileBase64: base64, mimeType, name, seq: s.seq });
  });

  // ── desktop: close ───────────────────────────────────────────────────
  router.delete("/scan/session/:code", (req, res) => {
    sessions.delete(req.params.code);
    res.json({ ok: true });
  });

  // ── phone: announce arrival (no auth — the code is the credential) ───
  router.post("/scan/session/:code/paired", (req, res) => {
    const s = live(req.params.code);
    if (!s) return res.status(410).json({ error: "This code has expired — start again on the PC" });
    if (s.status === "WAITING") s.status = "PAIRED";
    res.json({ ok: true, screen: s.screen });
  });

  // ── phone: send the shot ─────────────────────────────────────────────
  router.post("/scan/session/:code/upload", (req, res) => {
    const s = live(req.params.code);
    if (!s) return res.status(410).json({ error: "This code has expired — start again on the PC" });

    const { fileBase64, mimeType, name } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: "No file received" });

    const mt = String(mimeType || "");
    if (mt !== "application/pdf" && !mt.startsWith("image/")) {
      return res.status(400).json({ error: "Only a photo or a PDF can be sent" });
    }
    // base64 inflates by ~4/3; this is the decoded size.
    if (Math.floor(fileBase64.length * 0.75) > MAX_BYTES) {
      return res.status(413).json({ error: "That file is too large — retake the photo" });
    }

    s.file = { base64: fileBase64, mimeType: mt, name: String(name || "phone-scan.jpg") };
    s.seq += 1;
    s.status = "SENT";
    res.json({ ok: true, seq: s.seq });
  });

  return router;
};
