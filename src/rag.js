// src/rag.js
// In-memory RAG over the corpus/ markdown files.
// At startup, load embeddings from data/embeddings.json (built by ingest.js).
// At query time, embed the query, do cosine similarity, return top-K chunks.

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const EMBED_MODEL = "text-embedding-3-small";
const EMBEDDINGS_PATH = path.join(__dirname, "..", "data", "embeddings.json");

let _index = null;
let _openai = null;

function openai() {
  if (!_openai) {
    if (process.env.USE_MOCK_APIS === "true") {
      _openai = null; // we'll mock embed below
    } else if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is required for RAG. Set it in .env, or set USE_MOCK_APIS=true for tests.",
      );
    } else {
      _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }
  return _openai;
}

/**
 * Lazy-load the embeddings index from disk.
 */
function loadIndex() {
  if (_index !== null) return _index;
  if (!fs.existsSync(EMBEDDINGS_PATH)) {
    console.warn(
      `[rag] No embeddings file at ${EMBEDDINGS_PATH}. Run "npm run ingest" first.`,
    );
    _index = [];
    return _index;
  }
  const raw = fs.readFileSync(EMBEDDINGS_PATH, "utf-8");
  _index = JSON.parse(raw);
  console.log(`[rag] Loaded ${_index.length} chunks from disk.`);
  return _index;
}

/**
 * Cosine similarity between two equal-length vectors.
 */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

/**
 * Mock embedding for tests — deterministic but useless for similarity.
 * Used only when USE_MOCK_APIS=true.
 */
function mockEmbed(text) {
  // Hash-based stub so behavior is deterministic in tests.
  const v = new Array(64).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % 64] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / (norm + 1e-10));
}

/**
 * Embed a query. Uses OpenAI in production, mock in tests.
 */
async function embedQuery(text) {
  if (process.env.USE_MOCK_APIS === "true") {
    return mockEmbed(text);
  }
  const r = await openai().embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return r.data[0].embedding;
}

/**
 * Retrieve the top-K most similar chunks for a query.
 *
 * @param {string} query
 * @param {number} k - default 3
 * @returns {Promise<Array<{source, section, text, score}>>}
 */
async function retrieve(query, k = 3) {
  const index = loadIndex();
  if (index.length === 0) return [];

  // In mock mode, embeddings are useless for similarity, so just return the
  // first k chunks. Tests don't care about retrieval quality.
  if (process.env.USE_MOCK_APIS === "true") {
    return index.slice(0, k).map((c) => ({
      source: c.source,
      section: c.section,
      text: c.text,
      score: 1.0,
    }));
  }

  const qVec = await embedQuery(query);
  const scored = index.map((c) => ({
    source: c.source,
    section: c.section,
    text: c.text,
    score: cosine(qVec, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Format retrieval results as a string for the system prompt.
 */
function formatContext(chunks) {
  if (!chunks || chunks.length === 0) {
    return "(No matching protocol content found in corpus.)";
  }
  return chunks
    .map(
      (c, i) =>
        `--- Source ${i + 1}: ${c.source} ${c.section} ---\n${c.text}`,
    )
    .join("\n\n");
}

module.exports = {
  retrieve,
  formatContext,
  loadIndex, // exposed for tests
  embedQuery, // exposed for tests
};
