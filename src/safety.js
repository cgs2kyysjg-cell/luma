// src/safety.js
// First-pass safety filters applied BEFORE the LLM is called.
// These are coarse — Claude's system prompt is the second line.

/**
 * Patterns that indicate a freeform clinical-advice request that should be refused
 * before the LLM is invoked. These exist because we don't want a single bad
 * system-prompt regression to leak unsafe advice — we want a hard floor.
 */
const HARD_REFUSAL_PATTERNS = [
  // Direct dose questions
  /\bwhat\s+dose\b/i,
  /\bhow\s+(many|much)\s+(mg|tablet|pill|drop|ml)\b/i,
  /\bhow\s+(many|much)\s+\w+\s+(for|to|do)\b/i, // catches "how much amoxicillin for", "how many tablets to give"
  /\bdosage\s+(for|of)\b/i,

  // Diagnostic asks
  /\bdiagnose\b/i,
  /\bwhat\s+(disease|illness|condition)\s+(is|does)\b/i,
  /\bwhat'?s?\s+wrong\s+with\b/i, // "what's wrong with my patient"
  /\bdoes\s+(this|he|she|the\s+patient)\s+have\b/i,

  // Drug interactions / safety reasoning
  /\b(safe|okay|ok)\s+to\s+(take|give|combine)\b/i,
  /\bdrug\s+interaction\b/i,
  /\bcontraindicated\b/i,

  // Pediatric pharmacology (extra caution — not in scope for v0)
  /\bpediatric\s+dos/i,
  /\bbaby\s+dose\b/i,
  /\bchild\s+dose\b/i,
  /\bweight[-\s]*based\s+dos/i,
  /\bfor\s+a\s+\d+[-\s]*(month|year|week|day)[-\s]*old\b/i, // "for a 6-month-old"

  // Anything that looks like "should I prescribe"
  /\b(should|can)\s+(i|we)\s+(prescribe|give|administer)\b/i,
];

/**
 * Topics the prototype corpus does not cover. Trigger an out-of-scope refusal.
 */
const OUT_OF_SCOPE_PATTERNS = [
  /\bdiabetes\b/i,
  /\bhypertension\b/i,
  /\bblood\s+pressure\b/i,
  /\bcancer\b/i,
  /\bmental\s+health\s+treatment\b/i,
  /\bdepression\s+(treatment|medication)\b/i,
  /\bcardio(vascular)?\b/i,
  /\bsurgery\b/i,
  /\bcovid\b/i,
  /\bvaccin/i,
  /\binsulin\b/i,
];

/**
 * Greetings, ack messages, and other no-op input that shouldn't trigger LLM calls.
 */
const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|hola|dumela)\.?$/i,
  /^(thanks|thank\s+you|ok|okay|got\s+it|cheers)\.?$/i,
  /^(yes|no|sure|maybe)\.?$/i,
];

/**
 * Run the input through hard-coded filters. Returns either:
 *   { allowed: true } — proceed to LLM
 *   { allowed: false, reason: string, refusalMessage: string }
 */
function checkSafety(text) {
  const t = (text || "").trim();

  if (!t) {
    return {
      allowed: false,
      reason: "empty_input",
      refusalMessage:
        "I didn't catch any text or voice memo. Try again with a question about ART, TB, or maternal/child health.",
    };
  }

  if (t.length > 2000) {
    return {
      allowed: false,
      reason: "input_too_long",
      refusalMessage:
        "That message is too long to handle right now. Could you keep it under 200 words?",
    };
  }

  for (const re of TRIVIAL_PATTERNS) {
    if (re.test(t)) {
      return {
        allowed: false,
        reason: "trivial_input",
        refusalMessage:
          "Hello! I'm luma. Send me a question about ART, TB, or maternal/child health protocols and I'll surface the relevant ministry guidance.",
      };
    }
  }

  for (const re of HARD_REFUSAL_PATTERNS) {
    if (re.test(t)) {
      return {
        allowed: false,
        reason: "clinical_advice_requested",
        refusalMessage:
          "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?",
      };
    }
  }

  for (const re of OUT_OF_SCOPE_PATTERNS) {
    if (re.test(t)) {
      return {
        allowed: false,
        reason: "out_of_scope_topic",
        refusalMessage:
          "That topic isn't in my current corpus (ART, TB, MNCH only). Please call your district coordinator. I'll have more topics in the next version.",
      };
    }
  }

  return { allowed: true };
}

/**
 * Post-LLM safety check — make sure the model didn't ignore its system prompt.
 * Returns either { ok: true } or { ok: false, reason, scrubbedMessage }.
 */
function postCheckResponse(response) {
  const t = (response || "").trim();

  if (!t) {
    return {
      ok: false,
      reason: "empty_response",
      scrubbedMessage:
        "Sorry — something went wrong on my end. Please try again, or call your district coordinator.",
    };
  }

  // Look for explicit dosing recommendations the model shouldn't be making.
  // (Note: protocol-quoted dose ranges like "HRZE 2 months" are fine because
  // they come from the corpus. We only flag specific milligram numbers paired
  // with patient-specific framing.)
  const unsafeDosePattern = /\b(give|prescribe|administer|take)\s+\d+\s*(mg|ml|tablet|pill)\b/i;
  if (unsafeDosePattern.test(t)) {
    return {
      ok: false,
      reason: "unsafe_dose_recommendation",
      scrubbedMessage:
        "I started to suggest a specific dose — that's not allowed. Please call your district coordinator for dosing guidance, and I can send you the protocol section if useful.",
    };
  }

  // Make sure the response includes a citation. If not, append a note.
  // Pattern matches "ART Defaulter Pathway § 4.2", "TB Treatment Protocol § 5.1", etc.
  const citationPattern = /§\s*\d+(\.\d+)?/;
  if (!citationPattern.test(t)) {
    return {
      ok: true, // allow but flag for logging
      warning: "missing_citation",
      message: t,
    };
  }

  return { ok: true, message: t };
}

module.exports = {
  checkSafety,
  postCheckResponse,
  HARD_REFUSAL_PATTERNS,
  OUT_OF_SCOPE_PATTERNS,
};
