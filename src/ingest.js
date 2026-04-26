// src/ingest.js
// Build embeddings for everything in corpus/ and write to data/embeddings.json.
// Run with: npm run ingest

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const EMBED_MODEL = "text-embedding-3-small";
const CORPUS_DIR = path.join(__dirname, "..", "corpus");
const OUT_PATH = path.join(__dirname, "..", "data", "embeddings.json");

function ensureDataDir() {
  const dir = path.dirname(OUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Strip YAML frontmatter and return { meta, body }.
 */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2] };
}

/**
 * Chunk a markdown body at "## Section N" boundaries.
 * Returns Array<{ section, text }>.
 */
function chunkBySection(body) {
  const lines = body.split("\n");
  const chunks = [];
  let current = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+Section\s+(\d+)\s*[—-]?\s*(.*)$/);
    if (sectionMatch) {
      if (current) chunks.push(current);
      current = {
        section: `§ ${sectionMatch[1]}`,
        title: sectionMatch[2].trim(),
        lines: [line],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) chunks.push(current);

  return chunks.map((c) => ({
    section: c.section,
    text: c.lines.join("\n").trim(),
  }));
}

// Deterministic mock embedding (matches src/rag.js mockEmbed)
function mockEmbed(text) {
  const v = new Array(64).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 64] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / (norm + 1e-10));
}

async function main() {
  ensureDataDir();

  const useMock = process.env.USE_MOCK_APIS === "true";

  if (!useMock && !process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY not set. Cannot build embeddings.\n" +
        "Set it in .env or export it in your shell, OR use USE_MOCK_APIS=true for tests.",
    );
    process.exit(1);
  }

  const openai = useMock
    ? null
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const files = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md");

  console.log(`[ingest] Found ${files.length} corpus files.`);

  const allChunks = [];

  for (const file of files) {
    const fullPath = path.join(CORPUS_DIR, file);
    const raw = fs.readFileSync(fullPath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const chunks = chunkBySection(body);

    console.log(
      `[ingest] ${file}: ${chunks.length} sections (title: ${meta.title || "—"}).`,
    );

    for (const c of chunks) {
      allChunks.push({
        source: meta.title || file.replace(".md", ""),
        section: c.section,
        text: c.text,
      });
    }
  }

  console.log(`[ingest] Embedding ${allChunks.length} chunks…`);

  const out = [];

  if (useMock) {
    console.log("[ingest] USE_MOCK_APIS=true — using deterministic mock embeddings.");
    for (const c of allChunks) {
      out.push({ ...c, embedding: mockEmbed(c.text) });
    }
  } else {
    // Batch into groups of 50 for the embeddings API.
    const BATCH = 50;
    for (let i = 0; i < allChunks.length; i += BATCH) {
      const batch = allChunks.slice(i, i + BATCH);
      const r = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: batch.map((c) => c.text),
      });
      for (let j = 0; j < batch.length; j++) {
        out.push({
          ...batch[j],
          embedding: r.data[j].embedding,
        });
      }
      console.log(`[ingest] Embedded ${Math.min(i + BATCH, allChunks.length)} / ${allChunks.length}`);
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`[ingest] Wrote ${out.length} embeddings to ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[ingest] FAILED:", err);
    process.exit(1);
  });
}
