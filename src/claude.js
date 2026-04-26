// src/claude.js
// Anthropic Claude integration. One function: generateResponse().

const Anthropic = require("@anthropic-ai/sdk");
const {
  buildSystemPrompt,
  buildFallbackSystemPrompt,
  buildUserMessage,
} = require("./prompts");

let _client = null;

function client() {
  if (_client) return _client;
  if (process.env.USE_MOCK_APIS === "true") return null;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Set it in .env, or set USE_MOCK_APIS=true for tests.",
    );
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 600;

/**
 * Generate a grounded response. Returns string (the response text).
 *
 * @param {string} userText  - the worker's question (transcribed if voice)
 * @param {string} retrievedContext - chunks from RAG, formatted as a string
 * @param {object} [opts] - { isVoice, facility, workerName, mode: "grounded" | "fallback" }
 */
async function generateResponse(userText, retrievedContext, opts = {}) {
  const mode = opts.mode || "grounded";

  // Mock mode for tests / local-first dev.
  if (process.env.USE_MOCK_APIS === "true") {
    return mockResponse(userText, retrievedContext, mode);
  }

  const systemPrompt =
    mode === "fallback"
      ? buildFallbackSystemPrompt(retrievedContext)
      : buildSystemPrompt(retrievedContext, {
          facility: opts.facility,
          workerName: opts.workerName,
        });
  const userMessage = buildUserMessage(userText, opts.isVoice || false);

  const r = await client().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  // Concatenate all text blocks (Claude returns content as an array).
  const text = r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return text;
}

/**
 * Deterministic fake response so tests can run without an API key.
 */
function mockResponse(userText, retrievedContext, mode = "grounded") {
  const ctxPreview =
    retrievedContext && retrievedContext.length > 200
      ? retrievedContext.slice(0, 200) + "…"
      : retrievedContext;

  if (mode === "fallback") {
    return [
      "⚠️ Not from your ministry protocols — general public-health information.",
      "",
      `[MOCK fallback] You asked: "${userText.slice(0, 60)}"`,
      "Per WHO general guidance, this would be the answer.",
      "",
      "Want me to flag this as a question your ministry should add a protocol for?",
    ].join("\n");
  }

  return [
    `[MOCK] You asked: "${userText.slice(0, 60)}"`,
    "",
    `Per the corpus excerpt I retrieved (preview): ${ctxPreview}`,
    "",
    "ART Defaulter Pathway § 4.2 — Home visit at day 14 if the patient remains unreached.",
    "",
    "Want to log this as a defaulter case for your supervisor?",
  ].join("\n");
}

module.exports = { generateResponse };
