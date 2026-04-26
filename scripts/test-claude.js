// scripts/test-claude.js
// Smoke test: send one canonical query through the full pipeline
// (RAG retrieve → Claude → safety post-check) and print the result.
//
// Usage:
//   node scripts/test-claude.js
//   USE_MOCK_APIS=true node scripts/test-claude.js   # no API keys needed

require("dotenv").config();
const { retrieve, formatContext } = require("../src/rag");
const { generateResponse } = require("../src/claude");
const { checkSafety, postCheckResponse } = require("../src/safety");

const QUERY =
  process.argv.slice(2).join(" ") ||
  "My ART patient missed her refill last month. I can't reach her by phone. What should I do?";

(async () => {
  console.log("\n=== INPUT ===");
  console.log(QUERY);

  console.log("\n=== SAFETY ===");
  const safety = checkSafety(QUERY);
  console.log(safety);
  if (!safety.allowed) {
    console.log("\n=== REFUSAL ===");
    console.log(safety.refusalMessage);
    return;
  }

  console.log("\n=== RAG RETRIEVE ===");
  let chunks = [];
  try {
    chunks = await retrieve(QUERY, 3);
  } catch (err) {
    console.error("RAG failed:", err.message);
    return;
  }
  for (const c of chunks) {
    console.log(`  ${c.source} ${c.section}  (score=${c.score.toFixed(3)})`);
  }
  if (chunks.length === 0) {
    console.warn("\nNo chunks retrieved. Did you run `npm run ingest`?");
    return;
  }

  console.log("\n=== CLAUDE ===");
  const ctx = formatContext(chunks);
  let resp;
  try {
    resp = await generateResponse(QUERY, ctx);
  } catch (err) {
    console.error("Claude failed:", err.message);
    return;
  }
  console.log(resp);

  console.log("\n=== POST-CHECK ===");
  const post = postCheckResponse(resp);
  console.log(post);
})();
