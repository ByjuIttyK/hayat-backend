// routes/voiceGemini.js
//
// The one place audio becomes text. Both the desktop endpoint and the phone
// pairing endpoint call this, so there is a single prompt to maintain.
//
// Input is 16 kHz mono WAV (the browser produces it — no ffmpeg anywhere).

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_AUDIO_MODEL || "gemini-3.6-flash";

function buildPrompt() {
  const d = new Date();
  const today =
    String(d.getDate()).padStart(2, "0") + "/" +
    String(d.getMonth() + 1).padStart(2, "0") + "/" +
    d.getFullYear();

  return `Transcribe this spoken accounting instruction from a UAE switchgear manufacturer.
The speaker is an accountant. English, often with an Indian or Arabic accent. Amounts are AED.
Party names are UAE company names.

Today is ${today}. Resolve "today", "yesterday" and similar to a dd/MM/yyyy date.

Return ONLY JSON: { "transcript": "<one line>", "warnings": ["<if anything was unclear>"] }

Write the transcript as a single clean narration line, in this house style:
  Received from AIKA TRADING against Inv 2381, Chq 03211 Dt 21/06/2026-1250

Rules:
- Never invent a party name, an amount or a number. Transcribe only what was said.
- Write amounts as digits: "two thousand five hundred" -> 2500. Fils are decimals: 2450.50.
- Write invoice and cheque numbers as digits, and label them Inv and Chq.
- Keep dates as dd/MM/yyyy.
- Keep the party name exactly as spoken, in capitals.
- If the speaker corrects themselves, transcribe the corrected version only and
  note the correction in warnings.
- If something was inaudible, transcribe what you heard and say so in warnings.
  Never guess a digit.`;
}

/** @returns {Promise<{transcript: string, warnings: string[], ms: number}>} */
async function transcribeWav(wavBuffer) {
  if (!GEMINI_KEY) throw Object.assign(new Error("GEMINI_API_KEY is not configured."), { status: 500 });

  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: buildPrompt() },
        { inline_data: { mime_type: "audio/wav", data: wavBuffer.toString("base64") } },
      ]}],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });

  const raw = await r.text();
  if (!r.ok) {
    console.error("[voiceGemini]", r.status, raw.slice(0, 300));
    throw Object.assign(new Error("Speech service unavailable."), { status: 502 });
  }

  const data = JSON.parse(raw);
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "").join("").replace(/```json|```/g, "").trim();

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { transcript: text, warnings: [] }; }

  const transcript = String(parsed.transcript || "").trim().slice(0, 500);
  if (!transcript) throw Object.assign(new Error("Nothing could be heard in that clip."), { status: 422 });

  return { transcript, warnings: parsed.warnings || [], ms: Date.now() - t0 };
}

module.exports = { transcribeWav, GEMINI_MODEL };
