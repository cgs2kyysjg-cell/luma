// src/whisper.js
// OpenAI Whisper integration for voice-memo transcription.
// Twilio sends a media URL; we download the audio and pass it to Whisper.

const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");
const os = require("os");

let _client = null;
function client() {
  if (_client) return _client;
  if (process.env.USE_MOCK_APIS === "true") return null;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY required for Whisper. Set in .env or use USE_MOCK_APIS=true.",
    );
  }
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Download a Twilio media URL to a local temp file.
 * Twilio media URLs require Basic auth with the account SID + auth token.
 */
async function downloadTwilioMedia(mediaUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

  const res = await fetch(mediaUrl, { headers: { Authorization: auth } });
  if (!res.ok) {
    throw new Error(`Twilio media download failed: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // Twilio voice memos come as audio/ogg by default.
  const tmpPath = path.join(
    os.tmpdir(),
    `luma-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`,
  );
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

/**
 * Transcribe a voice memo from a Twilio media URL.
 *
 * @param {string} mediaUrl - the URL Twilio gave us in MediaUrl0
 * @param {string} [language] - ISO-639-1 hint (e.g. "en", "st" for Sesotho)
 * @returns {Promise<string>} transcribed text
 */
async function transcribeFromTwilio(mediaUrl, language) {
  if (process.env.USE_MOCK_APIS === "true") {
    return `[MOCK transcription of voice memo at ${mediaUrl}]`;
  }

  const tmpPath = await downloadTwilioMedia(mediaUrl);
  try {
    const stream = fs.createReadStream(tmpPath);
    const r = await client().audio.transcriptions.create({
      file: stream,
      model: "whisper-1",
      language: language || undefined,
    });
    return r.text || "";
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { transcribeFromTwilio };
