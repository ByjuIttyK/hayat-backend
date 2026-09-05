// routes/voiceRoutes.js
//
// Two route groups, mounted separately because they have different auth:
//
//   voiceRoutes.secure()  -> /api/voice/*      needs a normal ERP login.
//                            Desktop mic, session create, session poll.
//
//   voiceRoutes.pairing() -> /api/voicepair/*  NO ERP login. The phone has
//                            never logged in; it carries only the one-time
//                            pair token from the QR, which these routes
//                            validate themselves.
//
// Register:
//     const voiceRoutes = require("./routes/voiceRoutes");
//     app.use("/api/voicepair", voiceRoutes.pairing());   // BEFORE your JWT middleware
//     // ... your JWT middleware ...
//     app.use("/api", voiceRoutes.secure());              // after it
//
// npm i multer qrcode
//
// Sessions live in memory: they last minutes, hold nothing that needs auditing
// (the transcript ends up in the voucher), and this keeps the feature out of
// MySQL and off the migrate.py restore list entirely.
// NOTE: if you ever run Node clustered / multiple PM2 instances, move the Map
// to a table or Redis — otherwise the poll can hit a different process than
// the one the phone posted to.

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { transcribeWav } = require("./voiceGemini");

const PAIR_WINDOW_MS = 5 * 60 * 1000;    // time to scan the QR
const LIVE_WINDOW_MS = 30 * 60 * 1000;   // rolling window once the phone is in use
const PUBLIC_BASE = process.env.VOICE_PUBLIC_BASE || "https://hayaterp.cloud";

/** code -> session */
const sessions = new Map();

const sweeper = setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, code) => { if (s.expiresAt < now) sessions.delete(code); });
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(1000, 9999));
    if (!sessions.has(c)) return c;
  }
  return String(crypto.randomInt(100000, 999999));
}

const userIdOf = (req) =>
  req.user?.user_id || req.user?.userId || req.user?.username || req.user?.id || "unknown";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

/** Validates the pair token and returns the session, or throws. */
function sessionFrom(req) {
  const token = String(req.headers["x-pair-token"] || "").trim();
  const code = String(req.query.code || (req.body && req.body.code) || "").trim();
  if (!token || !code) throw Object.assign(new Error("Not paired."), { status: 401 });

  const s = sessions.get(code);
  if (!s || s.expiresAt < Date.now()) {
    sessions.delete(code);
    throw Object.assign(new Error("This code has expired. Scan again."), { status: 410 });
  }
  const a = Buffer.from(token), b = Buffer.from(s.pairToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Not paired."), { status: 401 });
  }
  return s;
}

// ───────────────────────── authenticated (desktop) ─────────────────────────
function secure() {
  const router = express.Router();

  // Desktop microphone: straight through, no session involved.
  router.post("/voice/transcribe", upload.single("audio"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No audio received." });
      const out = await transcribeWav(req.file.buffer);
      console.log(`[voice/transcribe] ${out.ms}ms "${out.transcript.slice(0, 80)}"`);
      res.json(out);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || "Transcription failed." });
    }
  });

  // Open a pairing session and hand back a QR for the phone to scan.
  router.post("/voice/session", async (req, res) => {
    try {
      const code = newCode();
      const pairToken = crypto.randomBytes(24).toString("hex");
      const now = Date.now();

      const s = {
        code,
        pairToken,
        userId: userIdOf(req),
        screen: String((req.body && req.body.screen) || "").slice(0, 40),
        status: "WAITING",       // WAITING -> PAIRED -> PARSED (repeats)
        transcript: null,
        warnings: [],
        seq: 0,
        createdAt: now,
        expiresAt: now + PAIR_WINDOW_MS,
      };
      sessions.set(code, s);

      const url = `${PUBLIC_BASE}/m/voice#c=${code}&t=${pairToken}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" });

      res.json({ code, qr, expiresAt: s.expiresAt });
    } catch (e) {
      console.error("[voice/session]", e);
      res.status(500).json({ error: "Could not start a phone session." });
    }
  });

  // Desktop polls this. A transcript is handed over once, then cleared.
  router.get("/voice/session/:code", (req, res) => {
    const s = sessions.get(String(req.params.code));
    if (!s) return res.status(410).json({ error: "Session expired." });
    if (s.userId !== userIdOf(req)) return res.status(403).json({ error: "Not your session." });

    const payload = {
      status: s.status,
      seq: s.seq,
      transcript: s.transcript,
      warnings: s.warnings,
      expiresAt: s.expiresAt,
    };
    if (s.transcript) { s.transcript = null; s.warnings = []; s.status = "PAIRED"; }
    res.json(payload);
  });

  router.delete("/voice/session/:code", (req, res) => {
    const s = sessions.get(String(req.params.code));
    if (s && s.userId === userIdOf(req)) sessions.delete(String(req.params.code));
    res.json({ ok: true });
  });

  return router;
}

// ───────────────────────── unauthenticated (phone) ─────────────────────────
// Protected by the pair token, which exists only inside the QR the logged-in
// desktop just displayed, and which dies within minutes.
function pairing() {
  const router = express.Router();

  router.get("/hello", (req, res) => {
    try {
      const s = sessionFrom(req);
      if (s.status === "WAITING") s.status = "PAIRED";
      s.expiresAt = Date.now() + LIVE_WINDOW_MS;
      res.json({ ok: true, code: s.code, screen: s.screen, expiresAt: s.expiresAt });
    } catch (e) {
      res.status(e.status || 401).json({ error: e.message });
    }
  });

  router.post("/transcribe", upload.single("audio"), async (req, res) => {
    try {
      const s = sessionFrom(req);
      if (!req.file) return res.status(400).json({ error: "No audio received." });

      const out = await transcribeWav(req.file.buffer);

      s.transcript = out.transcript;
      s.warnings = out.warnings;
      s.status = "PARSED";
      s.seq += 1;
      s.expiresAt = Date.now() + LIVE_WINDOW_MS;   // rolling: keep dictating

      console.log(`[voicepair] ${s.code} ${out.ms}ms "${out.transcript.slice(0, 80)}"`);
      res.json({ transcript: out.transcript, warnings: out.warnings, seq: s.seq });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || "Transcription failed." });
    }
  });

  return router;
}

module.exports = { secure, pairing };
