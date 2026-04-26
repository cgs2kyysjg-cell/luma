// src/extractor.js
// Run after each conversation is logged. Uses Claude to extract structured
// fields (topic, condition, action, severity, demographics) into the
// case_tags table. This is the data layer that feeds the insights
// dashboards and customer API.
//
// Runs async — does not block the WhatsApp reply.

const Anthropic = require("@anthropic-ai/sdk");
const Database = require("better-sqlite3");
const path = require("path");

let _client = null;
function client() {
  if (_client) return _client;
  if (process.env.USE_MOCK_APIS === "true") return null;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY required for extractor.");
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Use Haiku for extraction — much cheaper, fast enough, good at structured output.
const EXTRACTOR_MODEL =
  process.env.EXTRACTOR_MODEL || "claude-haiku-4-5-20251001";

const DB_PATH = path.join(__dirname, "..", "data", "luma.db");
let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS case_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      topic TEXT,
      condition TEXT,
      action_type TEXT,
      severity TEXT,
      district TEXT,
      patient_age_band TEXT,
      patient_pregnancy_status TEXT,
      patient_hiv_status TEXT,
      raw_extraction TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_case_tags_conversation
      ON case_tags(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_case_tags_topic
      ON case_tags(topic);
    CREATE INDEX IF NOT EXISTS idx_case_tags_district
      ON case_tags(district);
    CREATE INDEX IF NOT EXISTS idx_case_tags_created
      ON case_tags(created_at DESC);
  `);
  return _db;
}

const SYSTEM_PROMPT = `You extract structured tags from CHW–luma conversations for ministry health surveillance.

You will be given a conversation: the worker's question and luma's response. Output a single JSON object with the fields below. Use null for any field you cannot determine.

Schema:
{
  "topic": "HIV" | "TB" | "MNCH" | "FP" | "STI" | "Nutrition" | "Immunization" | "other",
  "condition": "<short label, e.g. 'ART defaulter tracing', 'TB suspect screening', 'antenatal danger sign', 'HIV testing', 'PrEP eligibility', 'severe acute malnutrition', 'STI presentation', 'family planning counseling', 'missed immunization', 'other'>",
  "action_type": "protocol_surfaced" | "referral_recommended" | "case_logged" | "counseling_provided" | "refusal" | "fallback_general" | "ack" | "other",
  "severity": "routine" | "urgent" | "emergency",
  "patient_age_band": "under_5" | "child_5_14" | "adolescent_15_19" | "adult_20_49" | "older_adult_50plus" | "unknown",
  "patient_pregnancy_status": "pregnant" | "postpartum" | "breastfeeding" | "not_applicable" | "unknown",
  "patient_hiv_status": "positive" | "negative" | "unknown"
}

Rules:
- Output JSON ONLY, no preamble, no markdown fence.
- Be conservative: if the conversation does not mention a patient demographic, use "unknown".
- "severity":
  - emergency = immediate referral required (eclampsia, severe pneumonia, suicidal ideation)
  - urgent = same-day or 7-day action (defaulter tracing past 14 days, ART initiation, syphilis in pregnancy)
  - routine = standard scheduled care
- If the worker's message was a greeting or out-of-scope refusal with no clinical content, set topic="other", condition="other", action_type="ack" or "refusal", severity="routine".`;

/**
 * Extract structured tags from a conversation and persist to case_tags.
 *
 * @param {object} args
 * @param {number} args.conversationId  - row id from conversations table
 * @param {string} args.transcribedText - worker's question (text or transcribed)
 * @param {string} args.responseText    - luma's response
 * @param {string} args.district        - placeholder, e.g. "unknown" or "Maseru"
 */
async function extractAndPersist({
  conversationId,
  transcribedText,
  responseText,
  district = "unknown",
}) {
  let extraction;
  try {
    extraction = await runExtraction(transcribedText, responseText);
  } catch (err) {
    console.error("[extractor] Failed:", err.message);
    extraction = {
      topic: null,
      condition: null,
      action_type: null,
      severity: null,
      patient_age_band: null,
      patient_pregnancy_status: null,
      patient_hiv_status: null,
      _error: err.message,
    };
  }

  const stmt = db().prepare(`
    INSERT INTO case_tags (
      conversation_id, topic, condition, action_type, severity,
      district, patient_age_band, patient_pregnancy_status, patient_hiv_status,
      raw_extraction
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    conversationId,
    extraction.topic || null,
    extraction.condition || null,
    extraction.action_type || null,
    extraction.severity || null,
    district || "unknown",
    extraction.patient_age_band || "unknown",
    extraction.patient_pregnancy_status || "unknown",
    extraction.patient_hiv_status || "unknown",
    JSON.stringify(extraction),
  );

  console.log(
    `[extractor] conv=${conversationId} topic=${extraction.topic} condition=${extraction.condition} severity=${extraction.severity}`,
  );

  return extraction;
}

async function runExtraction(transcribedText, responseText) {
  if (process.env.USE_MOCK_APIS === "true") {
    return mockExtraction(transcribedText);
  }

  const userMessage = `Worker's question:
"""
${transcribedText}
"""

luma's response:
"""
${responseText}
"""`;

  const r = await client().messages.create({
    model: EXTRACTOR_MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Strip optional markdown fences
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

/**
 * Deterministic mock for tests.
 */
function mockExtraction(text) {
  // Naive keyword routing for the mock
  const t = (text || "").toLowerCase();
  let topic = "other";
  let condition = "other";
  let severity = "routine";
  if (t.includes("art") || t.includes("hiv") || t.includes("refill")) {
    topic = "HIV";
    condition = "ART defaulter tracing";
  } else if (t.includes("tb") || t.includes("tuberculosis") || t.includes("cough")) {
    topic = "TB";
    condition = "TB suspect screening";
  } else if (t.includes("pregnan") || t.includes("antenatal") || t.includes("baby")) {
    topic = "MNCH";
    condition = "antenatal danger sign";
    severity = "urgent";
  }
  return {
    topic,
    condition,
    action_type: "protocol_surfaced",
    severity,
    patient_age_band: "adult_20_49",
    patient_pregnancy_status: "unknown",
    patient_hiv_status: "unknown",
    _mock: true,
  };
}

module.exports = { extractAndPersist };
