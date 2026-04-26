// server.js
// luma — WhatsApp workflow assistant for community health workers.
// Express server. Single endpoint for the Twilio webhook + dashboard endpoints.

require("dotenv").config();
const express = require("express");
const path = require("path");

const { transcribeFromTwilio } = require("./src/whisper");
const { retrieve, formatContext } = require("./src/rag");
const { generateResponse } = require("./src/claude");
const { checkSafety, postCheckResponse } = require("./src/safety");
const { sendWhatsApp, verifyTwilioSignature } = require("./src/twilio");
const { buildRefusalMessage } = require("./src/prompts");
const {
  logConversation,
  getRecentConversations,
  getSummary,
} = require("./src/db");
const { extractAndPersist } = require("./src/extractor");
const {
  pharmaView,
  whoView,
  ministryView,
} = require("./src/projections");
const {
  runTrialSiteSelection,
  listStudyDesigns,
} = require("./src/trial-site-selection");

// Cosine similarity threshold below which we route to the fallback path
// instead of the grounded path. Tuned empirically — 0.45 catches questions
// that are clearly off-corpus while still allowing reasonable matches.
const RAG_GROUNDED_THRESHOLD = 0.45;

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// When deployed behind Render/Fly/etc., trust the proxy so req.ip reads
// the real client IP from X-Forwarded-For instead of the load-balancer's.
app.set("trust proxy", 1);

// Twilio sends form-encoded POSTs; Express needs the urlencoded parser.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------------------------------------------------------------
// Health check
// ----------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "luma",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// Twilio WhatsApp inbound webhook
// ----------------------------------------------------------------------------
app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  const start = Date.now();

  // Verify signature
  const fullUrl = `${PUBLIC_BASE_URL}/webhooks/twilio/whatsapp`;
  if (!verifyTwilioSignature(req, fullUrl)) {
    console.warn("[webhook] Twilio signature verification failed");
    return res.status(403).send("Forbidden");
  }

  // Acknowledge receipt — Twilio's TwiML response can be empty since we send
  // the actual message via the REST API below. Returning 200 OK quickly
  // avoids Twilio retries.
  res.set("Content-Type", "text/xml").send("<Response/>");

  // Process asynchronously so we don't block on the LLM round-trip.
  handleIncomingMessage(req.body, start).catch((err) => {
    console.error("[webhook] Async handler crashed:", err);
  });
});

async function handleIncomingMessage(body, start) {
  const fromNumber = body.From || "";
  const numMedia = parseInt(body.NumMedia || "0", 10);
  const incomingText = (body.Body || "").trim();

  let inputType, inputRaw, transcribedText;

  if (numMedia > 0 && body.MediaContentType0?.startsWith("audio/")) {
    inputType = "voice";
    inputRaw = body.MediaUrl0;
    try {
      transcribedText = await transcribeFromTwilio(body.MediaUrl0);
      console.log(`[webhook] Transcribed: ${transcribedText.slice(0, 100)}…`);
    } catch (err) {
      console.error("[webhook] Whisper failed:", err.message);
      transcribedText = "";
      await replyAndLog({
        fromNumber,
        inputType,
        inputRaw,
        transcribedText: "",
        safetyOutcome: "transcription_failed",
        retrievedSources: [],
        responseText:
          "I couldn't transcribe that voice memo. Could you try again, or send your question as text?",
        latencyMs: Date.now() - start,
      });
      return;
    }
  } else {
    inputType = "text";
    inputRaw = incomingText;
    transcribedText = incomingText;
  }

  // Safety check (pre-LLM)
  const safety = checkSafety(transcribedText);
  if (!safety.allowed) {
    await replyAndLog({
      fromNumber,
      inputType,
      inputRaw,
      transcribedText,
      safetyOutcome: safety.reason,
      retrievedSources: [],
      responseText: safety.refusalMessage,
      latencyMs: Date.now() - start,
    });
    return;
  }

  // Retrieve relevant corpus chunks
  let chunks = [];
  try {
    chunks = await retrieve(transcribedText, 3);
  } catch (err) {
    console.error("[webhook] RAG retrieval failed:", err.message);
  }

  // Determine response mode based on top retrieval score:
  //   - top score >= threshold AND chunks present  → grounded answer
  //   - top score <  threshold OR no chunks        → soft fallback
  const topScore = chunks.length > 0 ? chunks[0].score : 0;
  const mode =
    chunks.length > 0 && topScore >= RAG_GROUNDED_THRESHOLD
      ? "grounded"
      : "fallback";

  console.log(
    `[webhook] retrieval topScore=${topScore.toFixed(3)} threshold=${RAG_GROUNDED_THRESHOLD} mode=${mode}`,
  );

  // Generate response (grounded or fallback)
  let responseText;
  try {
    const ctx = formatContext(chunks);
    responseText = await generateResponse(transcribedText, ctx, {
      isVoice: inputType === "voice",
      mode,
    });
  } catch (err) {
    console.error("[webhook] Claude failed:", err.message);
    await replyAndLog({
      fromNumber,
      inputType,
      inputRaw,
      transcribedText,
      safetyOutcome: "llm_failed",
      retrievedSources: chunks.map((c) => `${c.source} ${c.section}`),
      responseText:
        "Sorry — something went wrong on my end. Please try again, or call your district coordinator.",
      latencyMs: Date.now() - start,
    });
    return;
  }

  // Post-LLM safety check
  const post = postCheckResponse(responseText);
  let finalText, warning;
  if (post.ok === false) {
    finalText = post.scrubbedMessage;
    warning = post.reason;
  } else {
    finalText = post.message || responseText;
    warning = post.warning || null;
  }

  // Outcome tag distinguishes grounded vs fallback in the dashboard
  let outcome;
  if (mode === "fallback") {
    outcome = warning ? "fallback_with_warning" : "fallback_general_knowledge";
  } else {
    outcome = warning ? "allowed_with_warning" : "allowed";
  }

  await replyAndLog({
    fromNumber,
    inputType,
    inputRaw,
    transcribedText,
    safetyOutcome: outcome,
    retrievedSources: chunks.map((c) => ({
      source: c.source,
      section: c.section,
      score: Math.round(c.score * 1000) / 1000,
    })),
    responseText: finalText,
    responseWarning: warning,
    latencyMs: Date.now() - start,
  });
}

async function replyAndLog(args) {
  // Send the WhatsApp reply
  try {
    if (args.fromNumber) {
      await sendWhatsApp(args.fromNumber, args.responseText);
    }
  } catch (err) {
    console.error("[reply] Twilio send failed:", err.message);
  }

  // Persist
  let conversationId = null;
  try {
    conversationId = logConversation(args);
  } catch (err) {
    console.error("[reply] DB log failed:", err.message);
  }

  console.log(
    `[reply] from=${args.fromNumber} type=${args.inputType} outcome=${args.safetyOutcome} latency=${args.latencyMs}ms`,
  );

  // Async: extract structured tags for the insights pipeline.
  // Skip extraction for trivial / refused / empty interactions — no clinical content.
  const skip =
    !conversationId ||
    !args.transcribedText ||
    [
      "trivial_input",
      "empty_input",
      "input_too_long",
      "transcription_failed",
    ].includes(args.safetyOutcome);

  if (!skip) {
    extractAndPersist({
      conversationId,
      transcribedText: args.transcribedText,
      responseText: args.responseText,
      district: "unknown", // placeholder; in production from CHW registration
    }).catch((err) => {
      console.error("[extractor] Async extraction failed:", err.message);
    });
  }
}

// ----------------------------------------------------------------------------
// In-browser chatbot demo
// Runs the same safety + RAG + Claude pipeline as the Twilio path, returning
// JSON instead of sending WhatsApp. Used by the landing page chat widget.
// ----------------------------------------------------------------------------

// Simple per-IP rate limiter — fixed window, in-memory.
// Each demo query costs LLM + embedding API spend so we cap aggressively.
const DEMO_RATE_LIMIT = parseInt(process.env.DEMO_RATE_LIMIT || "8", 10);
const DEMO_RATE_WINDOW_MS = 60 * 1000;
const _rateBuckets = new Map(); // ip → { count, windowStart }

function rateLimitDemo(ip) {
  const now = Date.now();
  let b = _rateBuckets.get(ip);
  if (!b || now - b.windowStart > DEMO_RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    _rateBuckets.set(ip, b);
  }
  b.count++;
  // Periodic eviction so the map doesn't grow forever
  if (_rateBuckets.size > 5000) {
    for (const [k, v] of _rateBuckets) {
      if (now - v.windowStart > DEMO_RATE_WINDOW_MS * 4) _rateBuckets.delete(k);
    }
  }
  return {
    allowed: b.count <= DEMO_RATE_LIMIT,
    remaining: Math.max(0, DEMO_RATE_LIMIT - b.count),
    resetSec: Math.ceil((DEMO_RATE_WINDOW_MS - (now - b.windowStart)) / 1000),
  };
}

app.post("/api/demo-chat", async (req, res) => {
  const start = Date.now();
  const ip = (req.ip || req.socket?.remoteAddress || "unknown").toString();
  const message = ((req.body && req.body.message) || "").toString().trim();

  if (!message) {
    return res.status(400).json({ error: "Empty message." });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "Message is too long. Keep it under 200 words." });
  }

  // Rate limit
  const rl = rateLimitDemo(ip);
  if (!rl.allowed) {
    return res.status(429).json({
      error: `Slow down — demo allows ${DEMO_RATE_LIMIT} messages per minute. Try again in ${rl.resetSec}s.`,
      retryAfter: rl.resetSec,
    });
  }

  // Anonymized "from number" so demo entries don't pollute the audit log
  // and can be filtered out of the operational view if needed.
  const ipHash = require("crypto").createHash("sha256").update(ip).digest("hex").slice(0, 8);
  const fromNumber = `demo:${ipHash}`;

  // 1. Pre-LLM safety
  const safety = checkSafety(message);
  if (!safety.allowed) {
    let conversationId = null;
    try {
      conversationId = logConversation({
        fromNumber,
        inputType: "text",
        inputRaw: message,
        transcribedText: message,
        safetyOutcome: safety.reason,
        retrievedSources: [],
        responseText: safety.refusalMessage,
        latencyMs: Date.now() - start,
      });
    } catch (_) {}
    return res.json({
      response: safety.refusalMessage,
      sources: [],
      mode: "refused",
      safetyOutcome: safety.reason,
      latencyMs: Date.now() - start,
      conversationId,
      remaining: rl.remaining,
    });
  }

  // 2. RAG retrieval
  let chunks = [];
  try {
    chunks = await retrieve(message, 3);
  } catch (err) {
    console.error("[demo] RAG retrieval failed:", err.message);
  }
  const topScore = chunks.length > 0 ? chunks[0].score : 0;
  const mode = chunks.length > 0 && topScore >= RAG_GROUNDED_THRESHOLD ? "grounded" : "fallback";

  // 3. Generate response (grounded or fallback)
  let responseText;
  try {
    const ctx = formatContext(chunks);
    responseText = await generateResponse(message, ctx, { isVoice: false, mode });
  } catch (err) {
    console.error("[demo] Claude failed:", err.message);
    return res.status(502).json({
      error: "The model didn't respond — please try again.",
      details: process.env.NODE_ENV !== "production" ? err.message : undefined,
    });
  }

  // 4. Post-LLM safety
  const post = postCheckResponse(responseText);
  let finalText, warning;
  if (post.ok === false) {
    finalText = post.scrubbedMessage;
    warning = post.reason;
  } else {
    finalText = post.message || responseText;
    warning = post.warning || null;
  }

  let outcome;
  if (mode === "fallback") outcome = warning ? "fallback_with_warning" : "fallback_general_knowledge";
  else outcome = warning ? "allowed_with_warning" : "allowed";

  // 5. Log
  let conversationId = null;
  try {
    conversationId = logConversation({
      fromNumber,
      inputType: "text",
      inputRaw: message,
      transcribedText: message,
      safetyOutcome: outcome,
      retrievedSources: chunks.map((c) => ({
        source: c.source,
        section: c.section,
        score: Math.round(c.score * 1000) / 1000,
      })),
      responseText: finalText,
      responseWarning: warning,
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    console.error("[demo] DB log failed:", err.message);
  }

  // 6. Async tag extraction (so it shows up in the ministry/insights views)
  if (conversationId && !["trivial_input", "empty_input", "input_too_long"].includes(outcome)) {
    extractAndPersist({
      conversationId,
      transcribedText: message,
      responseText: finalText,
      district: "demo",
    }).catch((err) => console.error("[demo] extractor failed:", err.message));
  }

  res.json({
    response: finalText,
    sources: chunks.map((c) => ({
      source: c.source,
      section: c.section,
      score: Math.round(c.score * 1000) / 1000,
    })),
    mode,
    safetyOutcome: outcome,
    latencyMs: Date.now() - start,
    conversationId,
    remaining: rl.remaining,
  });
});

// ----------------------------------------------------------------------------
// Dashboard
// ----------------------------------------------------------------------------
app.get("/log", (req, res) => {
  // Render the dashboard page; it fetches /log.json via JS.
  res.sendFile(path.join(__dirname, "public", "log.html"));
});

app.get("/log.json", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const conversations = getRecentConversations(limit);
  const summary = getSummary();
  res.json({ summary, conversations });
});

// ----------------------------------------------------------------------------
// Insights dashboards (HTML) + API (JSON)
// ----------------------------------------------------------------------------

app.get("/methodology", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "methodology.html"));
});

// /pharma — BETA pitch page for pharma RWE buyers
app.get("/pharma", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pharma.html"));
});

// /api/docs — formal API reference for pharma + public-health consumers
app.get("/api/docs", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "api-docs.html"));
});

// /api/study-designs — list of supported designs (for the form dropdown)
app.get("/api/study-designs", (req, res) => {
  res.json({ designs: listStudyDesigns() });
});

// /api/trial-site-selection — pharma RWE killer feature
//   query params:
//     study_design (required)
//     age_band, severity, pregnancy, hiv_status (optional filters)
//     min_cohort_size (optional, default 0)
//     window_days (optional, default 30)
app.get("/api/trial-site-selection", (req, res) => {
  try {
    const result = runTrialSiteSelection({
      study_design: req.query.study_design,
      age_band: req.query.age_band || null,
      severity: req.query.severity || null,
      pregnancy: req.query.pregnancy || null,
      hiv_status: req.query.hiv_status || null,
      min_cohort_size: req.query.min_cohort_size
        ? parseInt(req.query.min_cohort_size, 10)
        : 0,
      window_days: req.query.window_days
        ? parseInt(req.query.window_days, 10)
        : 30,
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error("[api] trial-site-selection failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/insights", (req, res) => {
  // Default to pharma data view
  res.redirect("/insights/pharma");
});

app.get("/insights/:view", (req, res) => {
  // "who" kept as alias for backward-compat; "public-health" is the canonical name
  const allowed = ["pharma", "who", "public-health", "ministry"];
  if (!allowed.includes(req.params.view)) {
    return res.status(404).send("Unknown view");
  }
  res.sendFile(path.join(__dirname, "public", "insights.html"));
});

// JSON API (this is what pharma RWE / public-health programmes consume)
app.get("/api/insights/:view", (req, res) => {
  try {
    let data;
    switch (req.params.view) {
      case "pharma":         data = pharmaView();   break;
      case "who":            data = whoView();      break;  // backward-compat alias
      case "public-health":  data = whoView();      break;  // canonical
      case "ministry":       data = ministryView(); break;
      default: return res.status(404).json({ error: "Unknown view" });
    }
    res.json(data);
  } catch (err) {
    console.error("[api] insights failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`luma listening on http://localhost:${PORT}`);
  console.log(`  Twilio webhook: ${PUBLIC_BASE_URL}/webhooks/twilio/whatsapp`);
  console.log(`  Dashboard:      ${PUBLIC_BASE_URL}/log`);
  console.log(`  Health:         ${PUBLIC_BASE_URL}/health`);
});
