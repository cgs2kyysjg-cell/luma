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
  // Historical / scale
  weeklyVolume,
  weeklyDistrictBreakdown,
  weeklySeverityBreakdown,
  ciEvolutionByWeek,
  topCHWs,
  buildCohort,
  operationalSummary,
  // For the scale projector + multi-country
  bayesianProportionUpdate,
  LESOTHO_PRIORS,
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

// /try — interactive demo of the WhatsApp chat experience
app.get("/try", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "try.html"));
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
// /why-now — the post-USAID thesis page
// ----------------------------------------------------------------------------
app.get("/why-now", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "why-now.html"));
});

// ----------------------------------------------------------------------------
// /scale — operational reality dashboard (powered by historical seed)
// ----------------------------------------------------------------------------

app.get("/scale", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "scale.html"));
});

app.get("/api/scale/summary", (req, res) => {
  try {
    res.json(operationalSummary());
  } catch (err) {
    console.error("[api] scale/summary failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/scale/trends", (req, res) => {
  try {
    const topic = req.query.topic || null;
    res.json({
      weekly_volume_total: weeklyVolume(null),
      weekly_volume_topic: topic ? weeklyVolume(topic) : null,
      weekly_severity: weeklySeverityBreakdown(),
      weekly_district: weeklyDistrictBreakdown(),
    });
  } catch (err) {
    console.error("[api] scale/trends failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/scale/ci-evolution", (req, res) => {
  try {
    // HIV prevalence as the showcase indicator (it's the most-discussed Lesotho number)
    const evol = ciEvolutionByWeek({
      priorMean: LESOTHO_PRIORS.hiv.prevalence_adult_15_49,
      priorEffectiveN: 200,
      topicForSuccess: "HIV",
    });
    res.json({
      indicator: "HIV prevalence among adults 15-49",
      prior: LESOTHO_PRIORS.hiv.prevalence_adult_15_49,
      prior_source: LESOTHO_PRIORS.hiv.source,
      prior_effective_n: 200,
      weekly: evol,
    });
  } catch (err) {
    console.error("[api] scale/ci-evolution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/scale/chws", (req, res) => {
  try {
    res.json({ chws: topCHWs(50) });
  } catch (err) {
    console.error("[api] scale/chws failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * /api/scale/projection — given a hypothetical CHW count and weeks-of-data,
 * project what the HIV-prevalence Bayesian CI would look like at that scale.
 * Math: extrapolate trials linearly with CHW count × weeks, holding success
 * rate at the currently-observed rate. Compute Beta-Binomial CI.
 */
app.get("/api/scale/projection", (req, res) => {
  try {
    const chws = parseInt(req.query.chws || "100", 10);
    const weeks = parseInt(req.query.weeks || "26", 10);
    const indicator = req.query.indicator || "hiv_prevalence";

    // Current observed rate from the seeded data
    const dbRef = require("./src/db");
    const Database = require("better-sqlite3");
    const path2 = require("path");
    const localDb = new Database(path2.join(__dirname, "data", "luma.db"));
    localDb.pragma("journal_mode = WAL");

    const totalRows = localDb.prepare(`SELECT COUNT(*) as n FROM case_tags`).get().n;
    const hivRows = localDb.prepare(`SELECT COUNT(*) as n FROM case_tags WHERE topic = 'HIV'`).get().n;
    const observedRate = totalRows > 0 ? hivRows / totalRows : 0.36;

    // Current network: 50 CHWs over ~26 weeks → totalRows trials
    const currentChws = 50;
    const currentWeeks = 26;
    const trialsPerChwPerWeek = totalRows / (currentChws * currentWeeks);
    const projectedTrials = Math.round(chws * weeks * trialsPerChwPerWeek);
    const projectedSuccesses = Math.round(projectedTrials * observedRate);

    let priorMean, priorEffectiveN, label;
    if (indicator === "hiv_prevalence") {
      priorMean = LESOTHO_PRIORS.hiv.prevalence_adult_15_49;
      priorEffectiveN = 200;
      label = "HIV prevalence among adults 15-49";
    } else {
      priorMean = 0.10;
      priorEffectiveN = 50;
      label = indicator;
    }

    const post = bayesianProportionUpdate({
      priorMean,
      priorEffectiveN,
      observedSuccesses: projectedSuccesses,
      observedTrials: Math.max(projectedTrials, 1),
    });

    localDb.close();

    res.json({
      inputs: { chws, weeks, indicator },
      derived: {
        observed_rate_now: observedRate,
        trials_per_chw_per_week: trialsPerChwPerWeek,
        projected_trials: projectedTrials,
        projected_successes: projectedSuccesses,
      },
      prior: { mean: priorMean, effective_n: priorEffectiveN, label },
      posterior: {
        mean: post.posteriorMean,
        lower_95ci: post.lower,
        upper_95ci: post.upper,
        ci_width: post.upper - post.lower,
        effective_sample_size: Math.round(post.effectiveSampleSize),
      },
      note:
        "Extrapolation assumes the current per-CHW-per-week interaction rate holds " +
        "and the observed topic-share rate stays constant. The CI tightens because " +
        "the Beta posterior accumulates more effective sample size — purely a function " +
        "of n, not a model of network composition shifts at scale.",
    });
  } catch (err) {
    console.error("[api] scale/projection failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// /api/cohort — pharma cohort builder
// ----------------------------------------------------------------------------

app.get("/api/cohort", (req, res) => {
  try {
    const filter = {};
    const passthrough = [
      "topic", "condition_substr", "severity", "age_band", "pregnancy",
      "hiv_status", "district", "treatment_status", "viral_load_band",
      "regimen", "adherence", "comorbidity",
    ];
    for (const k of passthrough) {
      if (req.query[k]) filter[k] = req.query[k];
    }
    if (req.query.min_months_on_treatment) {
      filter.min_months_on_treatment = parseInt(req.query.min_months_on_treatment, 10);
    }
    if (req.query.max_months_on_treatment) {
      filter.max_months_on_treatment = parseInt(req.query.max_months_on_treatment, 10);
    }
    if (req.query.tb_hiv_coinfected != null && req.query.tb_hiv_coinfected !== "") {
      filter.tb_hiv_coinfected = req.query.tb_hiv_coinfected === "true";
    }
    res.json(buildCohort(filter));
  } catch (err) {
    console.error("[api] cohort failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * /api/cohort.csv — same query as /api/cohort but downloads as CSV.
 */
app.get("/api/cohort.csv", (req, res) => {
  try {
    const filter = {};
    const passthrough = [
      "topic", "condition_substr", "severity", "age_band", "pregnancy",
      "hiv_status", "district", "treatment_status", "viral_load_band",
      "regimen", "adherence", "comorbidity",
    ];
    for (const k of passthrough) {
      if (req.query[k]) filter[k] = req.query[k];
    }
    if (req.query.min_months_on_treatment) {
      filter.min_months_on_treatment = parseInt(req.query.min_months_on_treatment, 10);
    }
    if (req.query.max_months_on_treatment) {
      filter.max_months_on_treatment = parseInt(req.query.max_months_on_treatment, 10);
    }
    if (req.query.tb_hiv_coinfected != null && req.query.tb_hiv_coinfected !== "") {
      filter.tb_hiv_coinfected = req.query.tb_hiv_coinfected === "true";
    }
    const cohort = buildCohort(filter);
    const cols = [
      "patient_id", "created_at", "district", "topic", "condition", "severity",
      "age_band", "pregnancy", "hiv_status", "treatment_status",
      "viral_load_band", "months_on_treatment", "regimen", "adherence",
      "comorbidities",
    ];
    const lines = [cols.join(",")];
    for (const r of cohort.samples) {
      const row = cols.map((c) => {
        let v = r[c];
        if (Array.isArray(v)) v = v.join("|");
        if (v == null) v = "";
        v = String(v).replace(/"/g, '""');
        return /[",\n]/.test(v) ? '"' + v + '"' : v;
      });
      lines.push(row.join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="luma-cohort-preview.csv"`,
    );
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("[api] cohort.csv failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// /global — multi-country Bayesian comparison
// ----------------------------------------------------------------------------

const COUNTRY_PRIORS = {
  Lesotho: {
    population: 2_337_423,
    hiv_prevalence: 0.185,        // UNAIDS 2023
    hiv_prevalence_label: "18.5%",
    tb_incidence_per_100k: 664,   // WHO 2023
    mmr_per_100k: 566,            // WHO 2020
    u5_mortality_per_1000: 72.2,  // World Bank 2022
    contraceptive_prevalence: 0.598,
    chws_in_network: 11000,
    chw_label: "Village Health Workers (VHWs)",
    languages: ["Sesotho", "English"],
    sources: {
      hiv: "Lesotho NAC State of AIDS Response 2024",
      tb: "WHO Global TB Report 2024",
      mmr: "World Bank/WHO 2020",
      u5: "World Bank 2022",
      cpr: "Lesotho DHS",
      chw: "Ministry of Health/UNDP 2024",
    },
  },
  Botswana: {
    population: 2_521_139,
    hiv_prevalence: 0.197,        // UNAIDS 2024
    hiv_prevalence_label: "19.7%",
    tb_incidence_per_100k: 235,
    mmr_per_100k: 160,
    u5_mortality_per_1000: 43.5,
    contraceptive_prevalence: 0.804,
    chws_in_network: null,
    chw_label: "Family Welfare Educators",
    languages: ["Setswana", "English"],
    sources: {
      hiv: "UNAIDS 2024",
      tb: "WHO Global TB Report 2021",
      mmr: "World Bank/WHO 2007–2011",
      u5: "World Bank 2023",
      cpr: "Botswana Demographic Survey",
      chw: "Ministry of Health (figure not public)",
    },
  },
  Eswatini: {
    population: 1_242_822,
    hiv_prevalence: 0.270,        // UNAIDS 2024 — highest in the world
    hiv_prevalence_label: "27.0%",
    tb_incidence_per_100k: 319,
    mmr_per_100k: 590,
    u5_mortality_per_1000: 45,
    contraceptive_prevalence: 0.66,
    chws_in_network: null,
    chw_label: "Rural Health Motivators",
    languages: ["siSwati", "English"],
    sources: {
      hiv: "UNAIDS 2024",
      tb: "WHO/CDC Country Profile 2024",
      mmr: "WHO/UNAIDS 2023",
      u5: "World Bank 2023",
      cpr: "DHS",
      chw: "AU 2-million-CHW initiative",
    },
  },
  Malawi: {
    population: 21_655_286,
    hiv_prevalence: 0.071,        // National AIDS Commission 2022
    hiv_prevalence_label: "7.1%",
    tb_incidence_per_100k: 132,   // WHO 2021
    mmr_per_100k: 381,
    u5_mortality_per_1000: 38.3,
    contraceptive_prevalence: 0.66,
    chws_in_network: 11000,
    chw_label: "Health Surveillance Assistants (HSAs)",
    languages: ["Chichewa", "English"],
    sources: {
      hiv: "Malawi National AIDS Commission 2022",
      tb: "WHO Global TB Report 2021",
      mmr: "World Bank/WHO 2020",
      u5: "World Bank 2023",
      cpr: "Malawi NSO 2024",
      chw: "Malawi Community Health Strategy",
    },
  },
};

app.get("/global", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "global.html"));
});

app.get("/api/global/countries", (req, res) => {
  // For each country, compute a Bayesian projection using the published
  // prior + (illustrative) hypothetical CHW signal. For the prototype,
  // Lesotho uses real seeded data; other countries show prior-only
  // projections (no CHW network deployed yet).
  try {
    const out = {};
    for (const [country, p] of Object.entries(COUNTRY_PRIORS)) {
      let posterior = null;
      if (country === "Lesotho") {
        // Real seeded data
        const Database = require("better-sqlite3");
        const path2 = require("path");
        const localDb = new Database(path2.join(__dirname, "data", "luma.db"));
        localDb.pragma("journal_mode = WAL");
        const total = localDb.prepare(`SELECT COUNT(*) as n FROM case_tags`).get().n;
        const hiv = localDb.prepare(`SELECT COUNT(*) as n FROM case_tags WHERE topic = 'HIV'`).get().n;
        localDb.close();
        const post = bayesianProportionUpdate({
          priorMean: p.hiv_prevalence,
          priorEffectiveN: 200,
          observedSuccesses: hiv,
          observedTrials: Math.max(total, 1),
        });
        posterior = {
          mean: post.posteriorMean,
          lower_95ci: post.lower,
          upper_95ci: post.upper,
          observed_trials: total,
          observed_successes: hiv,
          effective_sample_size: Math.round(post.effectiveSampleSize),
          status: "data_dominated",
        };
      } else {
        // Prior-only (no deployment yet) — posterior = prior with prior-only width
        const post = bayesianProportionUpdate({
          priorMean: p.hiv_prevalence,
          priorEffectiveN: 200,
          observedSuccesses: 0,
          observedTrials: 0,
        });
        posterior = {
          mean: post.posteriorMean,
          lower_95ci: post.lower,
          upper_95ci: post.upper,
          observed_trials: 0,
          observed_successes: 0,
          effective_sample_size: 200,
          status: "prior_only",
        };
      }
      out[country] = { ...p, hiv_posterior: posterior };
    }
    res.json({ countries: out });
  } catch (err) {
    console.error("[api] global/countries failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// /investors — data room
// ----------------------------------------------------------------------------

app.get("/investors", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "investors.html"));
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
