// scripts/seed-demo-data.js
// Populate the SQLite database with ~120 realistic CHW interactions distributed
// across topics, districts, severities, and the last 30 days.
//
// Marked clearly as demo data via from_number prefix "whatsapp:+DEMO".
// Run with: node scripts/seed-demo-data.js
// Re-run safely: existing demo rows are deleted before re-seeding.

require("dotenv").config();
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "luma.db");

// Ensure the schema exists (server.js + extractor.js create these on first
// boot, but the seeder may run before the server has ever started).
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
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
  CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversations_from ON conversations(from_number);

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
  CREATE INDEX IF NOT EXISTS idx_case_tags_conversation ON case_tags(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_case_tags_topic ON case_tags(topic);
  CREATE INDEX IF NOT EXISTS idx_case_tags_district ON case_tags(district);
  CREATE INDEX IF NOT EXISTS idx_case_tags_created ON case_tags(created_at DESC);
`);

// Lesotho's 10 districts, with rough population weights (Maseru ~25%,
// then Berea / Leribe / Maseru-adjacent moderate, smaller districts smaller).
const DISTRICTS = [
  { name: "Maseru",         weight: 0.25 },
  { name: "Berea",          weight: 0.13 },
  { name: "Leribe",         weight: 0.15 },
  { name: "Mafeteng",       weight: 0.09 },
  { name: "Mohale's Hoek",  weight: 0.09 },
  { name: "Quthing",        weight: 0.06 },
  { name: "Qacha's Nek",    weight: 0.05 },
  { name: "Mokhotlong",     weight: 0.05 },
  { name: "Thaba-Tseka",    weight: 0.07 },
  { name: "Butha-Buthe",    weight: 0.06 },
];

// Topic distribution roughly aligned with Lesotho's HIV-heavy disease burden
const TOPICS = [
  { topic: "HIV",           weight: 0.36 },
  { topic: "MNCH",          weight: 0.20 },
  { topic: "TB",            weight: 0.12 },
  { topic: "FP",            weight: 0.09 },
  { topic: "STI",           weight: 0.08 },
  { topic: "Nutrition",     weight: 0.06 },
  { topic: "Immunization",  weight: 0.05 },
  { topic: "other",         weight: 0.04 },
];

// Realistic question pools per topic
const QUESTION_BANK = {
  HIV: [
    {
      q: "My ART patient missed her refill last month. What do I do?",
      condition: "ART defaulter tracing",
      severity_weights: { routine: 0.6, urgent: 0.35, emergency: 0.05 },
      response: "Per ART Defaulter Pathway § 4.2: home visit between days 14 and 28, leave a discreet note if not reached, escalate to facility supervisor if refusing re-engagement. Want to log this as a defaulter case for your supervisor?",
      sources: [{ source: "ART Missed-Dose & Defaulter Tracing Pathway", section: "§ 4", score: 0.62 }],
    },
    {
      q: "How do I test for HIV in a community setting?",
      condition: "HIV testing",
      severity_weights: { routine: 0.85, urgent: 0.15, emergency: 0 },
      response: "Per HIV Testing & Counseling § 5: rapid finger-prick test, read at 15-20 min. Follow national algorithm with second confirmatory test if reactive. Want me to send the full pre-test counseling checklist?",
      sources: [{ source: "HIV Testing & Counseling (HTS)", section: "§ 5", score: 0.71 }],
    },
    {
      q: "Can I start this patient on ART today after positive test?",
      condition: "ART initiation",
      severity_weights: { routine: 0.5, urgent: 0.5, emergency: 0 },
      response: "Per ART Initiation Protocol § 3.1: same-day initiation is preferred when patient is clinically stable, has no active TB symptoms, and consents. CHWs do not prescribe; refer to facility nurse for prescription. Want me to log this referral?",
      sources: [{ source: "ART Initiation Protocol", section: "§ 3", score: 0.68 }],
    },
    {
      q: "Should I recommend PrEP to a HIV-negative patient with positive partner?",
      condition: "PrEP eligibility",
      severity_weights: { routine: 0.9, urgent: 0.1, emergency: 0 },
      response: "Per PrEP Protocol § 3: sero-discordant partners are a priority eligibility group, particularly when the positive partner is not yet virally suppressed. Refer for facility eligibility assessment. Want to log this for follow-up?",
      sources: [{ source: "PrEP — Pre-Exposure Prophylaxis", section: "§ 3", score: 0.66 }],
    },
    {
      q: "Pregnant woman is HIV+ but missed her last appointment",
      condition: "PMTCT defaulter",
      severity_weights: { routine: 0.1, urgent: 0.6, emergency: 0.3 },
      response: "Per PMTCT Protocol § 4.3: home visit at day 7 (expedited timeline). Vertical transmission risk drives urgency. Refer to facility PMTCT focal person same-day. Want to log this as a PMTCT defaulter case?",
      sources: [{ source: "PMTCT", section: "§ 4", score: 0.74 }],
    },
    {
      q: "Patient on ART is reporting jaundice at month 2",
      condition: "ART side effect",
      severity_weights: { routine: 0, urgent: 0.4, emergency: 0.6 },
      response: "Per ART Initiation Protocol § 8: severe rash, jaundice, or persistent vomiting after starting ART — refer to facility same-day. Suspected drug toxicity requires clinician review. Logging this referral.",
      sources: [{ source: "ART Initiation Protocol", section: "§ 8", score: 0.69 }],
    },
  ],
  MNCH: [
    {
      q: "Pregnant woman has severe headache and blurred vision",
      condition: "antenatal danger sign",
      severity_weights: { routine: 0, urgent: 0.2, emergency: 0.8 },
      response: "Per MNCH Referral Pathway § 1: severe headache with blurred vision is a danger sign for pre-eclampsia. Arrange immediate transport to the nearest CEmOC facility. Logging this as an emergency referral.",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 1", score: 0.78 }],
    },
    {
      q: "Newborn has fast breathing and chest indrawing",
      condition: "neonatal danger sign",
      severity_weights: { routine: 0, urgent: 0.3, emergency: 0.7 },
      response: "Per MNCH § 4.2 + IMCI: chest indrawing in a newborn = severe pneumonia signs. Refer immediately. Logging this referral.",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 4", score: 0.72 }],
    },
    {
      q: "Mother missed her first antenatal visit at 12 weeks",
      condition: "antenatal default",
      severity_weights: { routine: 0.6, urgent: 0.4, emergency: 0 },
      response: "Per MNCH § 2: 8 antenatal contacts is the standard, with first contact before 12 weeks. Schedule home visit, screen for danger signs, link to first ANC. Want to log this follow-up?",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 2", score: 0.65 }],
    },
    {
      q: "Child under 5 with diarrhea and lethargy",
      condition: "child IMCI danger sign",
      severity_weights: { routine: 0.1, urgent: 0.4, emergency: 0.5 },
      response: "Per MNCH § 5.1: lethargy is an IMCI danger sign. Severe dehydration with diarrhea also requires immediate referral. Logging this referral.",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 5", score: 0.70 }],
    },
  ],
  TB: [
    {
      q: "Patient has cough for 3 weeks, what should I do?",
      condition: "TB suspect screening",
      severity_weights: { routine: 0.5, urgent: 0.45, emergency: 0.05 },
      response: "Per TB Treatment Protocol § 3.1: cough lasting ≥ 2 weeks is a presumptive TB indicator. Refer for sputum collection and GeneXpert testing at facility. Want to log this referral?",
      sources: [{ source: "TB Treatment & Case Management Protocol", section: "§ 3", score: 0.67 }],
    },
    {
      q: "TB contact in household, what do I check for?",
      condition: "TB contact tracing",
      severity_weights: { routine: 0.7, urgent: 0.3, emergency: 0 },
      response: "Per TB Protocol § 6: screen each household contact for symptoms within 7 days of index case diagnosis. Children under 5 and HIV-positive contacts: refer for TB preventive therapy regardless of symptoms. Logging?",
      sources: [{ source: "TB Treatment & Case Management Protocol", section: "§ 6", score: 0.69 }],
    },
    {
      q: "Patient on TB treatment is yellow-eyed at month 2",
      condition: "TB treatment side effect",
      severity_weights: { routine: 0, urgent: 0.4, emergency: 0.6 },
      response: "Per TB Protocol § 7: jaundice on first-line TB treatment may indicate hepatotoxicity. Escalate to district TB coordinator same-day. Logging emergency referral.",
      sources: [{ source: "TB Treatment & Case Management Protocol", section: "§ 7", score: 0.73 }],
    },
  ],
  FP: [
    {
      q: "How do I counsel about contraceptive options?",
      condition: "family planning counseling",
      severity_weights: { routine: 1, urgent: 0, emergency: 0 },
      response: "Per Family Planning § 4: use the GATHER framework — Greet, Ask, Tell, Help (choose), Explain, Return. Discuss method effectiveness, side effects, and dual protection (condoms + another method) for STI/HIV protection. Want me to send the method comparison table?",
      sources: [{ source: "Family Planning & Contraception Counseling", section: "§ 4", score: 0.64 }],
    },
    {
      q: "Adolescent asking for confidential family planning",
      condition: "adolescent FP",
      severity_weights: { routine: 0.85, urgent: 0.15, emergency: 0 },
      response: "Per Family Planning § 7.1: all methods are medically eligible for adolescents. Counsel confidentially, no parental notification required. Long-acting methods (implants, IUDs) particularly suitable. Want to log this consultation?",
      sources: [{ source: "Family Planning & Contraception Counseling", section: "§ 7", score: 0.66 }],
    },
  ],
  STI: [
    {
      q: "Patient with urethral discharge, male, sexually active",
      condition: "STI urethral discharge",
      severity_weights: { routine: 0.7, urgent: 0.3, emergency: 0 },
      response: "Per STI Screening § 3: urethral discharge in men is most likely gonorrhea or chlamydia. Refer to facility for syndromic management. Partner notification should follow. Want me to log this referral?",
      sources: [{ source: "STI Screening & Syndromic Management", section: "§ 3", score: 0.68 }],
    },
    {
      q: "Pregnant woman with positive syphilis screening",
      condition: "syphilis in pregnancy",
      severity_weights: { routine: 0, urgent: 0.6, emergency: 0.4 },
      response: "Per STI § 7.1: pregnant woman with positive syphilis MUST be treated within 48 hours. Congenital syphilis causes stillbirth and severe infant disease. Refer same-day to facility. Logging emergency.",
      sources: [{ source: "STI Screening & Syndromic Management", section: "§ 7", score: 0.74 }],
    },
  ],
  Nutrition: [
    {
      q: "Child with MUAC 110mm, what now?",
      condition: "severe acute malnutrition",
      severity_weights: { routine: 0, urgent: 0.5, emergency: 0.5 },
      response: "Per SAM § 3.1: MUAC < 115mm = SAM. Same-day facility referral required. Facility will perform appetite test and complications screen. Logging this referral.",
      sources: [{ source: "Severe Acute Malnutrition (SAM) Management", section: "§ 3", score: 0.76 }],
    },
    {
      q: "Mother says child won't eat for 2 days",
      condition: "feeding concern",
      severity_weights: { routine: 0.4, urgent: 0.5, emergency: 0.1 },
      response: "Per SAM § 3.3 + IMCI: refusal to eat is an IMCI danger sign in any child under 5. Conduct MUAC measurement and edema check. Refer if any acute malnutrition criteria met. Logging assessment.",
      sources: [{ source: "Severe Acute Malnutrition (SAM) Management", section: "§ 3", score: 0.65 }],
    },
  ],
  Immunization: [
    {
      q: "Child missed pentavalent dose at 10 weeks",
      condition: "missed immunization",
      severity_weights: { routine: 0.95, urgent: 0.05, emergency: 0 },
      response: "Per Immunization § 5: don't restart the series — continue from where the child left off. Maintain 4-week minimum interval between doses. Refer to facility for catch-up. Logging follow-up.",
      sources: [{ source: "Childhood Immunization Schedule (EPI)", section: "§ 5", score: 0.69 }],
    },
    {
      q: "Cluster of 3 children with rash and fever in one village",
      condition: "suspected measles cluster",
      severity_weights: { routine: 0, urgent: 0.4, emergency: 0.6 },
      response: "Per Immunization § 8: cluster of children with rash + fever = suspected measles. Report immediately to district EPI coordinator for outbreak response. Logging this report.",
      sources: [{ source: "Childhood Immunization Schedule (EPI)", section: "§ 8", score: 0.78 }],
    },
  ],
  other: [
    {
      q: "What's a good lunch recipe?",
      condition: "out_of_scope",
      severity_weights: { routine: 1, urgent: 0, emergency: 0 },
      response: "⚠️ Not from your ministry protocols — general public-health information.\n\nThat's outside what I can help with. For nutrition guidance for your patients, see the SAM management protocol or family planning counseling. Want me to flag this as a question outside scope?",
      sources: [],
      outcome: "fallback_general_knowledge",
    },
    {
      q: "How long does HIV testing take to give a result?",
      condition: "HIV testing FAQ",
      severity_weights: { routine: 1, urgent: 0, emergency: 0 },
      response: "⚠️ Not from your ministry protocols — general public-health information.\n\nWHO-recommended rapid tests give results in 15–20 minutes. The window period (when an early infection may not be detected) is up to 6 weeks. Want me to flag this as a question your ministry should add a protocol for?",
      sources: [],
      outcome: "fallback_general_knowledge",
    },
  ],
};

// Refusal samples (clinical advice / out of scope) — small share
const REFUSAL_SAMPLES = [
  {
    q: "What dose of bedaquiline should I give a 45kg patient?",
    outcome: "clinical_advice_requested",
    response: "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?",
  },
  {
    q: "Does my patient have HIV based on these symptoms?",
    outcome: "clinical_advice_requested",
    response: "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?",
  },
  {
    q: "My patient has high blood pressure, what's the protocol?",
    outcome: "out_of_scope_topic",
    response: "That topic isn't in my current corpus (ART, TB, MNCH only). Please call your district coordinator. I'll have more topics in the next version.",
  },
  {
    q: "How much amoxicillin for a 6-month-old?",
    outcome: "clinical_advice_requested",
    response: "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?",
  },
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function pickWeighted(items, weightKey = "weight") {
  const total = items.reduce((s, x) => s + x[weightKey], 0);
  let r = Math.random() * total;
  for (const x of items) {
    r -= x[weightKey];
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}

function pickSeverity(weights) {
  const total = weights.routine + weights.urgent + weights.emergency;
  const r = Math.random() * total;
  if (r < weights.routine) return "routine";
  if (r < weights.routine + weights.urgent) return "urgent";
  return "emergency";
}

function randomTimestampWithinDays(days) {
  // Distribution biased toward recent: weight = exp(-t/half_life_days)
  const halfLifeDays = 12;
  for (let attempt = 0; attempt < 50; attempt++) {
    const daysAgo = Math.random() * days;
    const acceptProb = Math.exp(-daysAgo / halfLifeDays);
    if (Math.random() < acceptProb) {
      const t = Date.now() - daysAgo * 86400_000;
      return new Date(t).toISOString().replace("T", " ").slice(0, 19);
    }
  }
  // Fallback: uniform
  const t = Date.now() - Math.random() * days * 86400_000;
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
}

function ageBandFromCondition(condition) {
  if (/pediatric|child|under\s*5|infant|newborn|baby/i.test(condition)) return "under_5";
  if (/adolescent/i.test(condition)) return "adolescent_15_19";
  if (/older|elder/i.test(condition)) return "older_adult_50plus";
  return "adult_20_49";
}

function pregnancyFromCondition(condition) {
  if (/pregnan|antenatal|pmtct/i.test(condition)) return "pregnant";
  if (/postnatal|postpartum/i.test(condition)) return "postpartum";
  if (/breastfeeding/i.test(condition)) return "breastfeeding";
  return "unknown";
}

function hivFromTopic(topic) {
  if (topic === "HIV") return Math.random() < 0.85 ? "positive" : "negative";
  if (topic === "PMTCT") return "positive";
  return "unknown";
}

// ----------------------------------------------------------------------------
// Wipe + seed
// ----------------------------------------------------------------------------

const TARGET_COUNT = 120;
const REFUSAL_RATIO = 0.08;

function wipeDemoRows() {
  const tx = db.transaction(() => {
    const ids = db
      .prepare("SELECT id FROM conversations WHERE from_number LIKE 'whatsapp:+DEMO%'")
      .all()
      .map((r) => r.id);
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM case_tags WHERE conversation_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...ids);
    console.log(`[seed] Wiped ${ids.length} existing demo rows.`);
  });
  tx();
}

function seed() {
  wipeDemoRows();

  const insertConv = db.prepare(`
    INSERT INTO conversations (
      created_at, from_number, input_type, input_raw, transcribed_text,
      safety_outcome, retrieved_sources, response_text, response_warning, latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = db.prepare(`
    INSERT INTO case_tags (
      conversation_id, created_at, topic, condition, action_type, severity,
      district, patient_age_band, patient_pregnancy_status, patient_hiv_status,
      raw_extraction
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    let inserted = 0;
    for (let i = 0; i < TARGET_COUNT; i++) {
      const isRefusal = Math.random() < REFUSAL_RATIO;
      const ts = randomTimestampWithinDays(30);
      const fromNum = `whatsapp:+DEMO${String(Math.floor(Math.random() * 900) + 100)}`;
      const inputType = Math.random() < 0.65 ? "text" : "voice";

      if (isRefusal) {
        const r = REFUSAL_SAMPLES[Math.floor(Math.random() * REFUSAL_SAMPLES.length)];
        const result = insertConv.run(
          ts, fromNum, inputType, r.q, r.q, r.outcome,
          null, r.response, null, Math.floor(Math.random() * 50) + 5,
        );
        // No case tag for refusals (per server.js skip logic)
        inserted++;
        continue;
      }

      const topicEntry = pickWeighted(TOPICS);
      const topic = topicEntry.topic;
      const district = pickWeighted(DISTRICTS).name;
      const pool = QUESTION_BANK[topic] || QUESTION_BANK.other;
      const sample = pool[Math.floor(Math.random() * pool.length)];
      const severity = pickSeverity(sample.severity_weights);

      const isFallback = sample.outcome === "fallback_general_knowledge";
      const outcome = isFallback ? "fallback_general_knowledge" : "allowed";

      const sources = sample.sources && sample.sources.length > 0
        ? JSON.stringify(sample.sources)
        : null;

      const result = insertConv.run(
        ts,
        fromNum,
        inputType,
        sample.q,
        sample.q,
        outcome,
        sources,
        sample.response,
        null,
        Math.floor(Math.random() * 1500) + 1500,
      );
      const conversationId = result.lastInsertRowid;

      const ageBand = ageBandFromCondition(sample.condition);
      const pregnancy = pregnancyFromCondition(sample.condition);
      const hivStatus = hivFromTopic(topic);

      const extraction = {
        topic,
        condition: sample.condition,
        action_type: isFallback ? "fallback_general" : "protocol_surfaced",
        severity,
        patient_age_band: ageBand,
        patient_pregnancy_status: pregnancy,
        patient_hiv_status: hivStatus,
        _seeded: true,
      };

      insertTag.run(
        conversationId,
        ts,
        topic,
        sample.condition,
        extraction.action_type,
        severity,
        district,
        ageBand,
        pregnancy,
        hivStatus,
        JSON.stringify(extraction),
      );
      inserted++;
    }
    console.log(`[seed] Inserted ${inserted} demo conversations.`);
  });

  tx();
}

if (require.main === module) {
  console.log(`[seed] Targeting ${TARGET_COUNT} conversations across`);
  console.log(`       ${DISTRICTS.length} districts, ${TOPICS.length} topics, 30 days.`);
  console.log(`       Refusal ratio: ${(REFUSAL_RATIO * 100).toFixed(0)}%`);
  console.log("");
  seed();

  // Print summary for sanity check
  const summary = db.prepare(`
    SELECT topic, COUNT(*) as count
      FROM case_tags
     WHERE created_at >= datetime('now', '-30 days')
     GROUP BY topic
     ORDER BY count DESC
  `).all();
  console.log("[seed] Topic distribution after seed:");
  for (const r of summary) {
    console.log(`       ${r.topic.padEnd(12)} ${r.count}`);
  }
  const sevDist = db.prepare(`
    SELECT severity, COUNT(*) as count
      FROM case_tags
     WHERE created_at >= datetime('now', '-30 days')
     GROUP BY severity
  `).all();
  console.log("[seed] Severity distribution:");
  for (const r of sevDist) {
    console.log(`       ${(r.severity || "null").padEnd(12)} ${r.count}`);
  }
  console.log("");
  console.log("[seed] Done. Restart the server to see populated dashboards.");
}
