// scripts/seed-historical-data.js
// Generate ~5000 realistic CHW interactions distributed across 50 distinct CHWs,
// 10 Lesotho districts, 8 topics, and 26 weeks of operational history.
//
// Why this exists: the dashboards need substantial data to feel real. The
// regular `seed-demo-data.js` makes ~120 rows over 30 days for the demo;
// this seeder makes ~5000 rows over 180 days for the "this is a working system"
// experience.
//
// CHW identity: each CHW has a stable phone number (whatsapp:+DEMOXXX), a
// district, an activity level, and a topic specialty bias. This means the
// audit log shows recurring users — like a real network would.
//
// Cohort attributes: in addition to the standard case_tags fields, we pack
// pharma-trial-relevant attributes (treatment_status, viral_load_band,
// months_on_treatment, comorbidities) into raw_extraction JSON. These are
// queried via SQLite json_extract() in the cohort builder API.
//
// Run with: node scripts/seed-historical-data.js
// Re-run safely: existing historical rows are deleted before re-seeding.

require("dotenv").config();
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "luma.db");

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

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const TARGET_COUNT = 5000;
const WINDOW_DAYS = 180;       // 26 weeks ≈ 6 months
const REFUSAL_RATIO = 0.05;
const FALLBACK_RATIO = 0.07;

// 'historical' tag in from_number to distinguish from quick-demo seeded rows
const FROM_PREFIX = "whatsapp:+HIST";

// Sesotho first names (realistic — culturally grounded, not synthesized)
const SESOTHO_NAMES = [
  "Mpho", "Lerato", "Tebogo", "Refiloe", "Tumelo", "Mamello", "Thabo", "Palesa",
  "Karabo", "Nthabiseng", "Limpho", "Tshepo", "Boitumelo", "Lineo", "Khanyo",
  "Mosa", "Malefetsane", "Tsepiso", "Nthatisi", "Ratšoaa", "Realeboha",
  "Pulane", "Makhotso", "Reitumetse", "Lehlohonolo", "Mokoena", "Bohlokoa",
  "Tlali", "Tšeliso", "Hlompho", "Mmemoholo", "Liteboho", "Ntseliseng",
  "Matšeliso", "Khauhelo", "Bonolo", "Pheello", "Mafusi", "Lipalesa",
  "Itumeleng", "Khotso", "Sentšo", "Likotsi", "Tsietsi", "Selloane",
  "Ntsiuoa", "Mphonyane", "Mahlomola", "Pakiso", "Polokeho",
];

// Lesotho districts with population weights (matches existing seeder)
const DISTRICTS = [
  { name: "Maseru",         weight: 0.25, chws: 13 },
  { name: "Berea",          weight: 0.13, chws: 6  },
  { name: "Leribe",         weight: 0.15, chws: 7  },
  { name: "Mafeteng",       weight: 0.09, chws: 4  },
  { name: "Mohale's Hoek",  weight: 0.09, chws: 4  },
  { name: "Quthing",        weight: 0.06, chws: 3  },
  { name: "Qacha's Nek",    weight: 0.05, chws: 3  },
  { name: "Mokhotlong",     weight: 0.05, chws: 3  },
  { name: "Thaba-Tseka",    weight: 0.07, chws: 4  },
  { name: "Butha-Buthe",    weight: 0.06, chws: 3  },
];
// Total CHWs: 50

// Topic specialty profiles — different CHWs lean different ways
const SPECIALTY_PROFILES = {
  generalist: {
    HIV: 0.36, MNCH: 0.20, TB: 0.12, FP: 0.09, STI: 0.08,
    Nutrition: 0.06, Immunization: 0.05, other: 0.04,
  },
  hiv_focused: {
    HIV: 0.55, MNCH: 0.10, TB: 0.15, FP: 0.05, STI: 0.08,
    Nutrition: 0.02, Immunization: 0.02, other: 0.03,
  },
  mnch_focused: {
    HIV: 0.18, MNCH: 0.42, TB: 0.04, FP: 0.14, STI: 0.06,
    Nutrition: 0.08, Immunization: 0.05, other: 0.03,
  },
  tb_focused: {
    HIV: 0.30, MNCH: 0.08, TB: 0.40, FP: 0.05, STI: 0.06,
    Nutrition: 0.03, Immunization: 0.04, other: 0.04,
  },
  pediatric: {
    HIV: 0.15, MNCH: 0.30, TB: 0.08, FP: 0.06, STI: 0.04,
    Nutrition: 0.20, Immunization: 0.13, other: 0.04,
  },
};
const SPECIALTY_KEYS = Object.keys(SPECIALTY_PROFILES);

// Activity profiles control how many conversations a CHW logs per week
const ACTIVITY_PROFILES = {
  high:   { avg_per_week: 8,  variance: 0.4 },
  medium: { avg_per_week: 4,  variance: 0.5 },
  low:    { avg_per_week: 1.5, variance: 0.7 },
};

// Question bank — same as the existing demo seeder, expanded slightly with
// more variety of phrasing per condition. This makes the audit log feel less
// repetitive across 5000 rows.
const QUESTION_BANK = {
  HIV: [
    {
      condition: "ART defaulter tracing",
      severity_weights: { routine: 0.55, urgent: 0.4, emergency: 0.05 },
      questions: [
        "My ART patient missed her refill last month. What do I do?",
        "Patient hasn't picked up ART in 3 weeks, advice?",
        "ART defaulter — refusing to come back. Next step?",
        "Mother on ART, missed appointment, no answer on phone. Help.",
        "Patient stopped ART because of stigma at work. What now?",
      ],
      response: "Per ART Defaulter Pathway § 4.2: home visit between days 14 and 28, leave a discreet note if not reached, escalate to facility supervisor if refusing re-engagement. Want to log this as a defaulter case for your supervisor?",
      sources: [{ source: "ART Missed-Dose & Defaulter Tracing Pathway", section: "§ 4", score: 0.62 }],
    },
    {
      condition: "HIV testing",
      severity_weights: { routine: 0.85, urgent: 0.15, emergency: 0 },
      questions: [
        "How do I test for HIV in a community setting?",
        "Patient wants HIV test — what's the procedure here?",
        "Couple wants testing together, can I do that?",
        "Index testing — household contact, where do I start?",
      ],
      response: "Per HIV Testing & Counseling § 5: rapid finger-prick test, read at 15-20 min. Follow national algorithm with second confirmatory test if reactive. Want me to send the full pre-test counseling checklist?",
      sources: [{ source: "HIV Testing & Counseling (HTS)", section: "§ 5", score: 0.71 }],
    },
    {
      condition: "ART initiation",
      severity_weights: { routine: 0.5, urgent: 0.5, emergency: 0 },
      questions: [
        "Can I start this patient on ART today after positive test?",
        "Newly diagnosed, when does ART start?",
        "Same-day ART for someone with TB symptoms — safe?",
        "Test was reactive yesterday. Initiation today?",
      ],
      response: "Per ART Initiation Protocol § 3.1: same-day initiation is preferred when patient is clinically stable, has no active TB symptoms, and consents. CHWs do not prescribe; refer to facility nurse for prescription. Want me to log this referral?",
      sources: [{ source: "ART Initiation Protocol", section: "§ 3", score: 0.68 }],
    },
    {
      condition: "PrEP eligibility",
      severity_weights: { routine: 0.9, urgent: 0.1, emergency: 0 },
      questions: [
        "Should I recommend PrEP to a HIV-negative patient with positive partner?",
        "Sex worker asking about PrEP — eligible?",
        "Adolescent girl, multiple partners, PrEP a fit?",
        "Discordant couple wants PrEP. Path?",
      ],
      response: "Per PrEP Protocol § 3: sero-discordant partners are a priority eligibility group, particularly when the positive partner is not yet virally suppressed. Refer for facility eligibility assessment. Want to log this for follow-up?",
      sources: [{ source: "PrEP — Pre-Exposure Prophylaxis", section: "§ 3", score: 0.66 }],
    },
    {
      condition: "PMTCT defaulter",
      severity_weights: { routine: 0.1, urgent: 0.55, emergency: 0.35 },
      questions: [
        "Pregnant woman is HIV+ but missed her last appointment",
        "PMTCT mother defaulted at 28 weeks, options?",
        "HIV+ pregnant patient stopped ART. Vertical transmission risk?",
      ],
      response: "Per PMTCT Protocol § 4.3: home visit at day 7 (expedited timeline). Vertical transmission risk drives urgency. Refer to facility PMTCT focal person same-day. Want to log this as a PMTCT defaulter case?",
      sources: [{ source: "PMTCT", section: "§ 4", score: 0.74 }],
    },
    {
      condition: "ART side effect",
      severity_weights: { routine: 0, urgent: 0.4, emergency: 0.6 },
      questions: [
        "Patient on ART is reporting jaundice at month 2",
        "Severe rash on TLD regimen — referral needed?",
        "Patient vomiting daily on ART — drug toxicity?",
      ],
      response: "Per ART Initiation Protocol § 8: severe rash, jaundice, or persistent vomiting after starting ART — refer to facility same-day. Suspected drug toxicity requires clinician review. Logging this referral.",
      sources: [{ source: "ART Initiation Protocol", section: "§ 8", score: 0.69 }],
    },
    {
      condition: "viral load suppression",
      severity_weights: { routine: 0.7, urgent: 0.3, emergency: 0 },
      questions: [
        "Patient's last VL was 2000, what now?",
        "Viral load not suppressed at 6 months, what's the protocol?",
        "Adherence counseling for unsuppressed VL — checklist?",
      ],
      response: "Per ART Protocol § 6: unsuppressed VL (>1000 copies/mL) triggers enhanced adherence counseling for 3 months, then repeat VL. Switch to second-line if persistent. Logging this case for the facility ART team.",
      sources: [{ source: "ART Switching & VL Monitoring Protocol", section: "§ 6", score: 0.71 }],
    },
  ],
  MNCH: [
    {
      condition: "antenatal danger sign",
      severity_weights: { routine: 0, urgent: 0.2, emergency: 0.8 },
      questions: [
        "Pregnant woman has severe headache and blurred vision",
        "Antenatal patient with swelling and high BP, urgent?",
        "Mother at 36 weeks with epigastric pain — concern?",
        "Pregnant, sudden severe headache, looks unwell — what to do?",
      ],
      response: "Per MNCH Referral Pathway § 1: severe headache with blurred vision is a danger sign for pre-eclampsia. Arrange immediate transport to the nearest CEmOC facility. Logging this as an emergency referral.",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 1", score: 0.78 }],
    },
    {
      condition: "neonatal danger sign",
      severity_weights: { routine: 0, urgent: 0.3, emergency: 0.7 },
      questions: [
        "Newborn has fast breathing and chest indrawing",
        "3-day-old not feeding and floppy. Help?",
        "Newborn with fever and yellow skin — urgent?",
      ],
      response: "Per MNCH § 4.2 + IMCI: chest indrawing in a newborn = severe pneumonia signs. Refer immediately. Logging this referral.",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 4", score: 0.72 }],
    },
    {
      condition: "antenatal default",
      severity_weights: { routine: 0.6, urgent: 0.4, emergency: 0 },
      questions: [
        "Mother missed her first antenatal visit at 12 weeks",
        "Pregnant woman at 22 weeks, no ANC visits yet",
        "ANC patient missed last 2 appointments. Outreach?",
      ],
      response: "Per MNCH § 2: 8 antenatal contacts is the standard, with first contact before 12 weeks. Schedule home visit, screen for danger signs, link to first ANC. Want to log this follow-up?",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 2", score: 0.65 }],
    },
    {
      condition: "child IMCI danger sign",
      severity_weights: { routine: 0.1, urgent: 0.4, emergency: 0.5 },
      questions: [
        "Child under 5 with diarrhea and lethargy",
        "Toddler with high fever for 3 days, not playing — concern?",
        "Child convulsion at home, what next?",
      ],
      response: "Per MNCH § 5.1: lethargy is an IMCI danger sign. Severe dehydration with diarrhea also requires immediate referral. Logging this referral.",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 5", score: 0.70 }],
    },
    {
      condition: "postpartum follow-up",
      severity_weights: { routine: 0.65, urgent: 0.3, emergency: 0.05 },
      questions: [
        "Mother 2 weeks postpartum, when do I check on her?",
        "Postpartum visit schedule — what to assess?",
        "New mother feeling sad and anxious. Postnatal depression?",
      ],
      response: "Per MNCH § 6: postnatal contacts at day 1, day 3, day 7, week 6. Screen for danger signs (heavy bleeding, fever, severe headache) and breastfeeding support. Mental health screening at week 6. Logging follow-up.",
      sources: [{ source: "Maternal, Newborn & Child Health Referral Pathway", section: "§ 6", score: 0.66 }],
    },
  ],
  TB: [
    {
      condition: "TB suspect screening",
      severity_weights: { routine: 0.5, urgent: 0.45, emergency: 0.05 },
      questions: [
        "Patient has cough for 3 weeks, what should I do?",
        "Adult with night sweats and weight loss — TB?",
        "Coughing up blood, screening required?",
        "Persistent cough in HIV+ patient — sputum?",
      ],
      response: "Per TB Treatment Protocol § 3.1: cough lasting ≥ 2 weeks is a presumptive TB indicator. Refer for sputum collection and GeneXpert testing at facility. Want to log this referral?",
      sources: [{ source: "TB Treatment & Case Management Protocol", section: "§ 3", score: 0.67 }],
    },
    {
      condition: "TB contact tracing",
      severity_weights: { routine: 0.7, urgent: 0.3, emergency: 0 },
      questions: [
        "TB contact in household, what do I check for?",
        "5 household contacts — who needs TPT?",
        "Index TB case — children also need testing?",
      ],
      response: "Per TB Protocol § 6: screen each household contact for symptoms within 7 days of index case diagnosis. Children under 5 and HIV-positive contacts: refer for TB preventive therapy regardless of symptoms. Logging?",
      sources: [{ source: "TB Treatment & Case Management Protocol", section: "§ 6", score: 0.69 }],
    },
    {
      condition: "TB treatment side effect",
      severity_weights: { routine: 0, urgent: 0.4, emergency: 0.6 },
      questions: [
        "Patient on TB treatment is yellow-eyed at month 2",
        "TB patient with severe nausea and yellowing — drug toxicity?",
        "Numbness and tingling on TB regimen — concern?",
      ],
      response: "Per TB Protocol § 7: jaundice on first-line TB treatment may indicate hepatotoxicity. Escalate to district TB coordinator same-day. Logging emergency referral.",
      sources: [{ source: "TB Treatment & Case Management Protocol", section: "§ 7", score: 0.73 }],
    },
    {
      condition: "MDR TB suspect",
      severity_weights: { routine: 0, urgent: 0.7, emergency: 0.3 },
      questions: [
        "Patient failed first-line TB treatment, MDR concern?",
        "GeneXpert showed rifampicin resistance — next steps?",
        "TB treatment failure at month 5 — referral?",
      ],
      response: "Per TB Protocol § 9: rifampicin-resistant or treatment-failure cases require referral to the MDR-TB initiation site. Don't delay — drug resistance amplifies fast. Logging urgent referral.",
      sources: [{ source: "TB Treatment & Case Management Protocol", section: "§ 9", score: 0.78 }],
    },
  ],
  FP: [
    {
      condition: "family planning counseling",
      severity_weights: { routine: 1, urgent: 0, emergency: 0 },
      questions: [
        "How do I counsel about contraceptive options?",
        "Patient asking about implant vs injection",
        "Couple wants spacing, what's the process?",
      ],
      response: "Per Family Planning § 4: use the GATHER framework — Greet, Ask, Tell, Help (choose), Explain, Return. Discuss method effectiveness, side effects, and dual protection (condoms + another method) for STI/HIV protection. Want me to send the method comparison table?",
      sources: [{ source: "Family Planning & Contraception Counseling", section: "§ 4", score: 0.64 }],
    },
    {
      condition: "adolescent FP",
      severity_weights: { routine: 0.85, urgent: 0.15, emergency: 0 },
      questions: [
        "Adolescent asking for confidential family planning",
        "16-year-old wants implant, parental consent needed?",
        "Adolescent girl on her own — confidentiality?",
      ],
      response: "Per Family Planning § 7.1: all methods are medically eligible for adolescents. Counsel confidentially, no parental notification required. Long-acting methods (implants, IUDs) particularly suitable. Want to log this consultation?",
      sources: [{ source: "Family Planning & Contraception Counseling", section: "§ 7", score: 0.66 }],
    },
    {
      condition: "method discontinuation",
      severity_weights: { routine: 0.85, urgent: 0.15, emergency: 0 },
      questions: [
        "Patient wants to stop her implant — process?",
        "Side effects from injectable, switch?",
        "Wants to conceive — when can she stop pill?",
      ],
      response: "Per Family Planning § 8: removal counseling, switch options, fertility return windows by method. Want me to send the method-switch reference card?",
      sources: [{ source: "Family Planning & Contraception Counseling", section: "§ 8", score: 0.62 }],
    },
  ],
  STI: [
    {
      condition: "STI urethral discharge",
      severity_weights: { routine: 0.7, urgent: 0.3, emergency: 0 },
      questions: [
        "Patient with urethral discharge, male, sexually active",
        "Painful urination and discharge — STI?",
        "Patient with dysuria for a week — workup?",
      ],
      response: "Per STI Screening § 3: urethral discharge in men is most likely gonorrhea or chlamydia. Refer to facility for syndromic management. Partner notification should follow. Want me to log this referral?",
      sources: [{ source: "STI Screening & Syndromic Management", section: "§ 3", score: 0.68 }],
    },
    {
      condition: "syphilis in pregnancy",
      severity_weights: { routine: 0, urgent: 0.6, emergency: 0.4 },
      questions: [
        "Pregnant woman with positive syphilis screening",
        "ANC patient RPR reactive — urgency?",
        "Syphilis-positive at 30 weeks — congenital risk?",
      ],
      response: "Per STI § 7.1: pregnant woman with positive syphilis MUST be treated within 48 hours. Congenital syphilis causes stillbirth and severe infant disease. Refer same-day to facility. Logging emergency.",
      sources: [{ source: "STI Screening & Syndromic Management", section: "§ 7", score: 0.74 }],
    },
    {
      condition: "genital ulcer",
      severity_weights: { routine: 0.5, urgent: 0.45, emergency: 0.05 },
      questions: [
        "Patient with painful genital ulcer — treatment?",
        "Genital sore, possible HSV?",
        "Painless ulcer in a young man, work up for syphilis?",
      ],
      response: "Per STI § 4: syndromic management for genital ulcer disease — treat for both syphilis and chancroid empirically. Refer for HIV testing if status unknown. Logging treatment plan.",
      sources: [{ source: "STI Screening & Syndromic Management", section: "§ 4", score: 0.67 }],
    },
  ],
  Nutrition: [
    {
      condition: "severe acute malnutrition",
      severity_weights: { routine: 0, urgent: 0.5, emergency: 0.5 },
      questions: [
        "Child with MUAC 110mm, what now?",
        "Toddler with bilateral pitting edema — SAM?",
        "Severely wasted infant, where to refer?",
      ],
      response: "Per SAM § 3.1: MUAC < 115mm = SAM. Same-day facility referral required. Facility will perform appetite test and complications screen. Logging this referral.",
      sources: [{ source: "Severe Acute Malnutrition (SAM) Management", section: "§ 3", score: 0.76 }],
    },
    {
      condition: "feeding concern",
      severity_weights: { routine: 0.4, urgent: 0.5, emergency: 0.1 },
      questions: [
        "Mother says child won't eat for 2 days",
        "Infant refusing breast — concern?",
        "Toddler with poor weight gain — investigation?",
      ],
      response: "Per SAM § 3.3 + IMCI: refusal to eat is an IMCI danger sign in any child under 5. Conduct MUAC measurement and edema check. Refer if any acute malnutrition criteria met. Logging assessment.",
      sources: [{ source: "Severe Acute Malnutrition (SAM) Management", section: "§ 3", score: 0.65 }],
    },
  ],
  Immunization: [
    {
      condition: "missed immunization",
      severity_weights: { routine: 0.95, urgent: 0.05, emergency: 0 },
      questions: [
        "Child missed pentavalent dose at 10 weeks",
        "Catch-up schedule for 8-month-old who missed BCG?",
        "Defaulted on measles dose — restart?",
      ],
      response: "Per Immunization § 5: don't restart the series — continue from where the child left off. Maintain 4-week minimum interval between doses. Refer to facility for catch-up. Logging follow-up.",
      sources: [{ source: "Childhood Immunization Schedule (EPI)", section: "§ 5", score: 0.69 }],
    },
    {
      condition: "suspected measles cluster",
      severity_weights: { routine: 0, urgent: 0.4, emergency: 0.6 },
      questions: [
        "Cluster of 3 children with rash and fever in one village",
        "Several kids with fever and red spots — outbreak?",
        "School with multiple absent children, fever and rash — measles?",
      ],
      response: "Per Immunization § 8: cluster of children with rash + fever = suspected measles. Report immediately to district EPI coordinator for outbreak response. Logging this report.",
      sources: [{ source: "Childhood Immunization Schedule (EPI)", section: "§ 8", score: 0.78 }],
    },
  ],
  other: [
    {
      condition: "out_of_scope",
      severity_weights: { routine: 1, urgent: 0, emergency: 0 },
      questions: [
        "What's a good lunch recipe?",
        "How do I top up airtime?",
        "Where can I find the supervisor's number?",
      ],
      response: "I help with patient care questions from your ministry's protocols. For other things — phone, supplies, or admin — please reach your supervisor directly.",
      sources: [],
      outcome: "out_of_scope_topic",
    },
    {
      condition: "general health knowledge",
      severity_weights: { routine: 1, urgent: 0, emergency: 0 },
      questions: [
        "How long does HIV testing take to give a result?",
        "What's the incubation period for measles?",
        "How long does TB treatment last?",
      ],
      response: "⚠️ Not from your ministry protocols — general public-health information.\n\nWHO-recommended estimate. For your facility's protocol on this, please consult your supervisor.",
      sources: [],
      outcome: "fallback_general_knowledge",
    },
  ],
};

// Refusal samples
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
  {
    q: "Can you diagnose this for me?",
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

function pickFromObject(obj) {
  // {key: weight, ...} → key
  const total = Object.values(obj).reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of Object.entries(obj)) {
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(obj)[0];
}

function pickSeverity(weights) {
  const total = weights.routine + weights.urgent + weights.emergency;
  const r = Math.random() * total;
  if (r < weights.routine) return "routine";
  if (r < weights.routine + weights.urgent) return "urgent";
  return "emergency";
}

function gaussian(mean, stddev) {
  // Box-Muller transform
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

// ----------------------------------------------------------------------------
// Build CHW roster
// ----------------------------------------------------------------------------

function buildCHWRoster() {
  const chws = [];
  let idCounter = 1000;
  for (const district of DISTRICTS) {
    for (let i = 0; i < district.chws; i++) {
      const phoneId = String(idCounter++);
      const specialty = SPECIALTY_KEYS[Math.floor(Math.random() * SPECIALTY_KEYS.length)];
      // Activity distribution within a district: ~20% high, 50% medium, 30% low
      const r = Math.random();
      const activity = r < 0.2 ? "high" : r < 0.7 ? "medium" : "low";
      chws.push({
        id: phoneId,
        from_number: `${FROM_PREFIX}${phoneId}`,
        name: SESOTHO_NAMES[(idCounter * 7) % SESOTHO_NAMES.length],
        district: district.name,
        specialty,
        activity,
        text_voice_ratio: 0.5 + Math.random() * 0.4, // 0.5–0.9 share of text
      });
    }
  }
  return chws;
}

// ----------------------------------------------------------------------------
// Schedule conversations: distribute target count across CHWs and weeks
// ----------------------------------------------------------------------------

function scheduleConversations(chws) {
  // Compute relative volume per CHW based on activity
  const weights = chws.map((c) => ACTIVITY_PROFILES[c.activity].avg_per_week);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // Total weeks
  const weeks = Math.ceil(WINDOW_DAYS / 7);
  // Total activity-weighted weeks of capacity
  const totalCapacity = totalWeight * weeks;
  // Scale factor to hit TARGET_COUNT
  const scaleFactor = TARGET_COUNT / totalCapacity;

  const schedule = []; // {chw, timestamp_iso}
  for (let cIdx = 0; cIdx < chws.length; cIdx++) {
    const chw = chws[cIdx];
    const profile = ACTIVITY_PROFILES[chw.activity];
    for (let week = 0; week < weeks; week++) {
      // Volume this week ~ Gaussian(scaled_avg, scaled_avg * variance)
      const expected = profile.avg_per_week * scaleFactor;
      const stddev = expected * profile.variance;
      // Add weekly seasonality: gentle ramp up over time (network maturing)
      // 0.6× at week 0, 1.4× at week 25
      const maturityFactor = 0.6 + (week / weeks) * 0.8;
      const volume = Math.max(0, Math.round(gaussian(expected * maturityFactor, stddev)));
      for (let i = 0; i < volume; i++) {
        // Pick a day-of-week (Mon=1 most common, weekend lower)
        const dowWeights = [0.5, 1.2, 1.2, 1.1, 1.1, 1.0, 0.7]; // Sun..Sat
        let dow = 0;
        const r = Math.random() * dowWeights.reduce((a, b) => a + b, 0);
        let cum = 0;
        for (let d = 0; d < 7; d++) {
          cum += dowWeights[d];
          if (r < cum) { dow = d; break; }
        }
        // Pick hour (8am–6pm bias, with some after-hours)
        const hourBuckets = [
          ...Array(6).fill(0.05),  // 0–5 night, very rare
          0.3, 0.7, 1.0, 1.3, 1.4, 1.5, 1.4, 1.3, 1.1, 1.0, 0.8, 0.6, // 6–17 work hours
          0.5, 0.4, 0.3, 0.2, 0.15, 0.1, // 18–23 evening tail
        ];
        const r2 = Math.random() * hourBuckets.reduce((a, b) => a + b, 0);
        let hour = 12;
        let cum2 = 0;
        for (let h = 0; h < 24; h++) {
          cum2 += hourBuckets[h];
          if (r2 < cum2) { hour = h; break; }
        }
        const minute = Math.floor(Math.random() * 60);
        // Compute date: weeks ago, then offset by dow
        const daysAgoStartOfWeek = (weeks - 1 - week) * 7;
        const daysAgo = daysAgoStartOfWeek + (6 - dow); // dow 0=Sun, work backward
        const baseTs = Date.now() - daysAgo * 86400_000;
        const dt = new Date(baseTs);
        dt.setHours(hour, minute, Math.floor(Math.random() * 60), 0);
        schedule.push({ chw, ts: dt });
      }
    }
  }
  return schedule;
}

// ----------------------------------------------------------------------------
// Cohort attribute generator (packed into raw_extraction JSON)
// ----------------------------------------------------------------------------

function cohortAttributes(topic, condition, severity, ageBand, hivStatus) {
  const out = {};

  // Treatment status (HIV/TB)
  if (topic === "HIV") {
    if (/initiation|testing/i.test(condition)) {
      out.treatment_status = Math.random() < 0.3 ? "naive" : "pre_art";
    } else if (/defaulter/i.test(condition)) {
      out.treatment_status = "defaulted";
      out.months_on_treatment = Math.floor(Math.random() * 36) + 6;
    } else if (/PrEP/i.test(condition)) {
      out.treatment_status = "prep_eligible";
    } else {
      out.treatment_status = "on_art";
      out.months_on_treatment = Math.floor(Math.random() * 60) + 1;
    }
    // Viral load band (only if on ART for 6+ months)
    if (out.treatment_status === "on_art" && (out.months_on_treatment || 0) >= 6) {
      const r = Math.random();
      out.viral_load_band = r < 0.78 ? "suppressed" : r < 0.92 ? "low_detectable" : "high";
    } else if (out.treatment_status === "defaulted") {
      out.viral_load_band = Math.random() < 0.3 ? "low_detectable" : "high";
    } else {
      out.viral_load_band = "unknown";
    }
    // Regimen (TLD is now standard first-line in Lesotho)
    if (out.treatment_status === "on_art") {
      out.regimen = Math.random() < 0.85 ? "TLD" : Math.random() < 0.7 ? "TLE" : "second_line";
    }
  } else if (topic === "TB") {
    if (/MDR|resistant/i.test(condition)) {
      out.treatment_status = "mdr_treatment";
      out.drug_resistance = "rifampicin_resistant";
    } else if (/screening|suspect/i.test(condition)) {
      out.treatment_status = "screening_only";
    } else if (/contact/i.test(condition)) {
      out.treatment_status = "contact_tracing";
    } else {
      out.treatment_status = "on_treatment";
      out.months_on_treatment = Math.floor(Math.random() * 6) + 1;
    }
    if (hivStatus === "positive") {
      out.tb_hiv_coinfected = true;
    }
  } else if (topic === "MNCH") {
    if (/antenatal|ANC|pregnan|danger/i.test(condition)) {
      const ga = Math.floor(Math.random() * 35) + 6;
      out.gestational_age_weeks = ga;
      out.parity = Math.floor(Math.random() * 5);
    } else if (/postpartum|postnatal/i.test(condition)) {
      out.weeks_postpartum = Math.floor(Math.random() * 6) + 1;
    } else if (/child|IMCI|neonatal|newborn/i.test(condition)) {
      out.child_age_months = ageBand === "under_5"
        ? Math.floor(Math.random() * 60)
        : null;
    }
  } else if (topic === "Nutrition") {
    if (/SAM|severe acute/i.test(condition)) {
      out.muac_mm = Math.floor(Math.random() * 25) + 95; // 95–120
      out.bilateral_edema = Math.random() < 0.2;
    }
  }

  // Comorbidities (small share)
  if (topic === "HIV" && Math.random() < 0.18) {
    out.comorbidities = ["TB"];
  } else if (topic === "TB" && Math.random() < 0.55) {
    out.comorbidities = ["HIV"];
  }

  // Adherence (HIV/TB on treatment)
  if (out.treatment_status === "on_art" || out.treatment_status === "on_treatment") {
    out.adherence = Math.random() < 0.78 ? "good" : Math.random() < 0.6 ? "fair" : "poor";
  }

  return out;
}

function ageBandFromCondition(condition) {
  if (/pediatric|child|under\s*5|infant|newborn|baby|neonatal/i.test(condition)) return "under_5";
  if (/adolescent/i.test(condition)) return "adolescent_15_19";
  if (/older|elder/i.test(condition)) return "older_adult_50plus";
  return "adult_20_49";
}

function pregnancyFromCondition(condition) {
  if (/pregnan|antenatal|pmtct|ANC/i.test(condition)) return "pregnant";
  if (/postnatal|postpartum/i.test(condition)) return "postpartum";
  if (/breastfeeding/i.test(condition)) return "breastfeeding";
  return "unknown";
}

function hivFromTopic(topic, condition) {
  if (topic === "HIV") return Math.random() < 0.85 ? "positive" : "negative";
  if (/PMTCT|pmtct/i.test(condition || "")) return "positive";
  if (topic === "TB") return Math.random() < 0.5 ? "positive" : "negative";
  return "unknown";
}

// ----------------------------------------------------------------------------
// Wipe + seed
// ----------------------------------------------------------------------------

function wipeHistoricalRows() {
  const tx = db.transaction(() => {
    const ids = db
      .prepare(`SELECT id FROM conversations WHERE from_number LIKE '${FROM_PREFIX}%'`)
      .all()
      .map((r) => r.id);
    if (ids.length === 0) return;
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const placeholders = slice.map(() => "?").join(",");
      db.prepare(`DELETE FROM case_tags WHERE conversation_id IN (${placeholders})`).run(...slice);
      db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...slice);
    }
    console.log(`[hist] Wiped ${ids.length} existing historical rows.`);
  });
  tx();
}

function seed() {
  wipeHistoricalRows();

  const chws = buildCHWRoster();
  console.log(`[hist] CHW roster: ${chws.length} workers across ${DISTRICTS.length} districts.`);

  const schedule = scheduleConversations(chws);
  console.log(`[hist] Scheduled ${schedule.length} conversations across ${WINDOW_DAYS} days.`);

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
    let refused = 0;
    let fallbacks = 0;

    for (const item of schedule) {
      const { chw, ts } = item;
      const tsString = ts.toISOString().replace("T", " ").slice(0, 19);
      const inputType = Math.random() < chw.text_voice_ratio ? "text" : "voice";

      // Refusal?
      if (Math.random() < REFUSAL_RATIO) {
        const r = REFUSAL_SAMPLES[Math.floor(Math.random() * REFUSAL_SAMPLES.length)];
        insertConv.run(
          tsString, chw.from_number, inputType, r.q, r.q, r.outcome,
          null, r.response, null, Math.floor(Math.random() * 50) + 5,
        );
        inserted++;
        refused++;
        continue;
      }

      // Topic per CHW specialty
      const profile = SPECIALTY_PROFILES[chw.specialty];
      const topic = pickFromObject(profile);
      const pool = QUESTION_BANK[topic] || QUESTION_BANK.other;
      const sample = pool[Math.floor(Math.random() * pool.length)];
      const question = sample.questions[Math.floor(Math.random() * sample.questions.length)];
      const severity = pickSeverity(sample.severity_weights);

      const isFallback = sample.outcome === "fallback_general_knowledge";
      const isOutOfScope = sample.outcome === "out_of_scope_topic";
      let outcome = "allowed";
      if (isFallback) { outcome = "fallback_general_knowledge"; fallbacks++; }
      else if (isOutOfScope) { outcome = "out_of_scope_topic"; }

      const sources = sample.sources && sample.sources.length > 0
        ? JSON.stringify(sample.sources)
        : null;

      const result = insertConv.run(
        tsString,
        chw.from_number,
        inputType,
        question,
        question,
        outcome,
        sources,
        sample.response,
        null,
        Math.floor(Math.random() * 1500) + 1500,
      );
      const conversationId = result.lastInsertRowid;

      // Skip case_tags for out-of-scope/fallback (matches existing pipeline behaviour)
      if (isFallback || isOutOfScope) {
        inserted++;
        continue;
      }

      const ageBand = ageBandFromCondition(sample.condition);
      const pregnancy = pregnancyFromCondition(sample.condition);
      const hivStatus = hivFromTopic(topic, sample.condition);
      const cohortAttrs = cohortAttributes(topic, sample.condition, severity, ageBand, hivStatus);

      const extraction = {
        topic,
        condition: sample.condition,
        action_type: "protocol_surfaced",
        severity,
        patient_age_band: ageBand,
        patient_pregnancy_status: pregnancy,
        patient_hiv_status: hivStatus,
        chw_id: chw.id,
        chw_name: chw.name,
        chw_specialty: chw.specialty,
        ...cohortAttrs,
        _historical: true,
      };

      insertTag.run(
        conversationId,
        tsString,
        topic,
        sample.condition,
        extraction.action_type,
        severity,
        chw.district,
        ageBand,
        pregnancy,
        hivStatus,
        JSON.stringify(extraction),
      );
      inserted++;
    }

    console.log(`[hist] Inserted ${inserted} conversations (${refused} refused, ${fallbacks} fallbacks).`);
  });

  tx();
}

if (require.main === module) {
  console.log("");
  console.log(`[hist] Seeding historical operational data:`);
  console.log(`       target: ${TARGET_COUNT} conversations`);
  console.log(`       window: ${WINDOW_DAYS} days (${Math.ceil(WINDOW_DAYS / 7)} weeks)`);
  console.log(`       districts: ${DISTRICTS.length}, CHWs: 50`);
  console.log(`       refusal: ${(REFUSAL_RATIO * 100).toFixed(0)}%, fallback: ${(FALLBACK_RATIO * 100).toFixed(0)}%`);
  console.log("");

  const t0 = Date.now();
  seed();
  const t1 = Date.now();

  // Print summaries
  const totalRows = db.prepare(
    `SELECT COUNT(*) as n FROM conversations WHERE from_number LIKE '${FROM_PREFIX}%'`
  ).get().n;
  const totalTags = db.prepare(
    `SELECT COUNT(*) as n FROM case_tags WHERE raw_extraction LIKE '%_historical%'`
  ).get().n;
  console.log(`[hist] Final counts: ${totalRows} conversations, ${totalTags} case_tags.`);

  const topics = db.prepare(`
    SELECT topic, COUNT(*) as count
      FROM case_tags
     WHERE raw_extraction LIKE '%_historical%'
     GROUP BY topic ORDER BY count DESC`).all();
  console.log("[hist] Topic distribution:");
  for (const r of topics) console.log(`       ${(r.topic || "null").padEnd(14)} ${r.count}`);

  const districts = db.prepare(`
    SELECT district, COUNT(*) as count
      FROM case_tags
     WHERE raw_extraction LIKE '%_historical%'
     GROUP BY district ORDER BY count DESC`).all();
  console.log("[hist] District distribution:");
  for (const r of districts) console.log(`       ${(r.district || "null").padEnd(20)} ${r.count}`);

  const sevDist = db.prepare(`
    SELECT severity, COUNT(*) as count
      FROM case_tags
     WHERE raw_extraction LIKE '%_historical%'
     GROUP BY severity`).all();
  console.log("[hist] Severity distribution:");
  for (const r of sevDist) console.log(`       ${(r.severity || "null").padEnd(12)} ${r.count}`);

  console.log("");
  console.log(`[hist] Done in ${((t1 - t0) / 1000).toFixed(1)}s. Restart the server to see populated dashboards.`);
}
