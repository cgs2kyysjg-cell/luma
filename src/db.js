// src/db.js
// SQLite-backed persistence for conversation logs and (later) ministry-facing
// aggregates. Single file at data/luma.db; no external DB needed for v0.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "luma.db");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Schema — idempotent
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    from_number TEXT,
    input_type TEXT CHECK(input_type IN ('text', 'voice')),
    input_raw TEXT,
    transcribed_text TEXT,
    safety_outcome TEXT,
    retrieved_sources TEXT,
    response_text TEXT,
    response_warning TEXT,
    latency_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_created
    ON conversations(created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_conversations_from
    ON conversations(from_number);
`);

/**
 * Insert a conversation log entry. Returns the row ID.
 */
function logConversation({
  fromNumber,
  inputType,
  inputRaw,
  transcribedText,
  safetyOutcome,
  retrievedSources,
  responseText,
  responseWarning,
  latencyMs,
}) {
  const stmt = db.prepare(`
    INSERT INTO conversations (
      from_number, input_type, input_raw, transcribed_text,
      safety_outcome, retrieved_sources, response_text,
      response_warning, latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    fromNumber || null,
    inputType,
    inputRaw || null,
    transcribedText || null,
    safetyOutcome || null,
    retrievedSources ? JSON.stringify(retrievedSources) : null,
    responseText || null,
    responseWarning || null,
    latencyMs || null,
  );
  return result.lastInsertRowid;
}

/**
 * Fetch the most recent N conversations for the dashboard.
 */
function getRecentConversations(limit = 50) {
  const rows = db
    .prepare(
      `SELECT id, created_at, from_number, input_type,
              transcribed_text, safety_outcome,
              retrieved_sources, response_text, response_warning, latency_ms
         FROM conversations
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit);

  // Anonymize phone numbers for the public dashboard (last 4 digits only).
  return rows.map((r) => ({
    ...r,
    from_number: r.from_number
      ? "***" + r.from_number.slice(-4)
      : null,
    retrieved_sources: r.retrieved_sources
      ? JSON.parse(r.retrieved_sources)
      : null,
  }));
}

/**
 * Aggregate summary for the top of the dashboard.
 */
function getSummary() {
  const totalRow = db
    .prepare(`SELECT COUNT(*) as n FROM conversations`)
    .get();
  const last24Row = db
    .prepare(
      `SELECT COUNT(*) as n FROM conversations
        WHERE created_at >= datetime('now', '-1 day')`,
    )
    .get();
  const refusalRow = db
    .prepare(
      `SELECT COUNT(*) as n FROM conversations
        WHERE safety_outcome NOT IN (
          'allowed', 'allowed_with_warning',
          'fallback_general_knowledge', 'fallback_with_warning'
        )
           OR safety_outcome IS NULL`,
    )
    .get();

  const fallbackRow = db
    .prepare(
      `SELECT COUNT(*) as n FROM conversations
        WHERE safety_outcome IN ('fallback_general_knowledge', 'fallback_with_warning')`,
    )
    .get();

  return {
    total: totalRow.n,
    last24h: last24Row.n,
    refused: refusalRow.n,
    fallback: fallbackRow.n,
  };
}

module.exports = {
  db,
  logConversation,
  getRecentConversations,
  getSummary,
};
