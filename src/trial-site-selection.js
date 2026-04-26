// src/trial-site-selection.js
// Pharma RWE killer feature: given a study design + demographic filters,
// return a ranked list of candidate Lesotho districts with cohort size
// estimates and confidence intervals.
//
// Math (intentionally simple and transparent for the prototype):
//   1. Observed match count per district from case_tags filtered by criteria
//   2. District eligible-population estimate =
//        district_population × topic_prevalence_prior × eligibility_rate
//   3. Match share = observed_matches_district / total_observed_matches
//   4. Cohort estimate = eligible_population × (match_share × scaling_factor)
//   5. CI from a beta-binomial on the match share
//
// Honest caveats are returned in the response so consumers (or the UI) can
// surface them. Production version would replace constants with proper
// programmatic estimates from CHW catchment surveys.

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "luma.db");
let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  return _db;
}

// ----------------------------------------------------------------------------
// District populations (rough estimates from Lesotho 2016 census + UN extrapolation)
// ----------------------------------------------------------------------------
const DISTRICT_POPULATIONS = {
  "Maseru":         525_000,
  "Berea":          273_000,
  "Leribe":         315_000,
  "Mafeteng":       189_000,
  "Mohale's Hoek":  189_000,
  "Quthing":        126_000,
  "Qacha's Nek":    105_000,
  "Mokhotlong":     105_000,
  "Thaba-Tseka":    147_000,
  "Butha-Buthe":    126_000,
};
const TOTAL_POPULATION = Object.values(DISTRICT_POPULATIONS).reduce((a, b) => a + b, 0);

// ----------------------------------------------------------------------------
// Study design templates
// ----------------------------------------------------------------------------
const STUDY_DESIGNS = {
  hiv_art_switch: {
    label: "HIV ART switch trial (existing patients on first-line)",
    topic: "HIV",
    condition_match: ["initiation", "defaulter", "ART"],
    eligibility_rate: 0.92 * 0.65, // share of PLHIV on ART * share suitable for switch
    prevalence_field: "hiv",
    description:
      "Adults 18-65, HIV-positive, on first-line dolutegravir-based ART for 6+ months, virally suppressed. Excludes pregnant women, recent regimen changes.",
  },
  hiv_prevention_prep: {
    label: "PrEP rollout impact study",
    topic: "HIV",
    condition_match: ["PrEP", "testing", "negative"],
    eligibility_rate: 0.30, // share of population at substantial HIV risk
    prevalence_field: "prep_eligible",
    description:
      "Adults 18-49, HIV-negative, with substantial exposure risk markers. PrEP-eligible per WHO guidelines.",
  },
  tb_drug_resistant: {
    label: "MDR-TB regimen study (drug-resistant TB)",
    topic: "TB",
    condition_match: ["MDR", "resistant", "treatment failure"],
    eligibility_rate: 0.05, // ~5% of TB cases are MDR in this context
    prevalence_field: "tb",
    description:
      "Adults with rifampicin-resistant or multi-drug-resistant TB confirmed by GeneXpert. New diagnosis or treatment failure.",
  },
  mnch_anc_outcomes: {
    label: "Antenatal outcomes study",
    topic: "MNCH",
    condition_match: ["antenatal", "danger sign", "ANC"],
    eligibility_rate: 0.80, // share of pregnancies with completed ANC
    prevalence_field: "pregnancy",
    description:
      "Pregnant women receiving ANC, all gestational ages. Stratified by danger-sign incidence.",
  },
  pmtct_outcomes: {
    label: "PMTCT cascade study",
    topic: "MNCH",
    condition_match: ["PMTCT", "pregnant", "vertical"],
    eligibility_rate: 0.95, // PMTCT coverage among HIV+ pregnancies
    prevalence_field: "pmtct_eligible",
    description:
      "HIV-positive pregnant women on ART, with HIV-exposed infant follow-up through 18 months.",
  },
  fp_method_uptake: {
    label: "Family planning method-uptake study",
    topic: "FP",
    condition_match: ["family planning", "contraceptive"],
    eligibility_rate: 0.62, // women using modern contraception
    prevalence_field: "fp_eligible",
    description:
      "Women 15-49, sexually active, using or eligible for modern contraception.",
  },
  sti_syphilis_pregnancy: {
    label: "Maternal syphilis screening study",
    topic: "STI",
    condition_match: ["syphilis", "STI", "pregnan"],
    eligibility_rate: 0.05, // syphilis prevalence in pregnancy
    prevalence_field: "syphilis",
    description:
      "Pregnant women screened for syphilis at first ANC. Positive cases linked to treatment.",
  },
  sam_outcomes: {
    label: "Severe acute malnutrition outcomes",
    topic: "Nutrition",
    condition_match: ["malnutrition", "SAM", "MUAC"],
    eligibility_rate: 0.027, // wasting under-5
    prevalence_field: "sam",
    description:
      "Children under 5 with severe acute malnutrition (MUAC < 115mm or bilateral pitting edema). Discharge outcome tracking.",
  },
};

// Rough prevalence priors for cohort sizing
const PREVALENCE_PRIORS = {
  hiv:             0.228,   // adult prevalence
  tb:              0.0065,  // ~650/100k = 0.65%
  pregnancy:       55_000 / 2_100_000, // ~ 2.6% of population pregnant at any time
  pmtct_eligible:  0.228 * 55_000 / 2_100_000, // PLHIV * pregnancy rate
  fp_eligible:     530_000 / 2_100_000, // women 15-49
  syphilis:        0.05,
  sam:             0.027,
  prep_eligible:   0.05, // adults at substantial HIV risk
};

/**
 * Estimate cohort size for a single district given match counts and study design.
 *
 * Combines:
 *   - District population
 *   - Topic prevalence prior
 *   - Eligibility rate (fraction of prevalent population that fits study criteria)
 *   - District match share (CHW signal as a noisy estimator of true distribution)
 *
 * Uses a beta-binomial on the match share to compute a CI.
 */
function estimateCohort({
  districtName,
  observedMatches,
  totalObservedMatches,
  designConfig,
}) {
  const districtPop = DISTRICT_POPULATIONS[districtName] || 0;
  const prevalence = PREVALENCE_PRIORS[designConfig.prevalence_field] || 0.05;
  const eligibilityRate = designConfig.eligibility_rate;

  // Population-based estimate (without CHW signal)
  const populationBased =
    districtPop * prevalence * eligibilityRate;

  // CHW signal contribution: match share of district / national share of population
  // If CHW data shows the disease is more concentrated here than population would predict,
  // we adjust upward; less, adjust downward.
  const populationShare = districtPop / TOTAL_POPULATION;
  const matchShare =
    totalObservedMatches > 0 ? observedMatches / totalObservedMatches : populationShare;
  const concentrationFactor = matchShare / Math.max(populationShare, 0.001);

  // Blended estimate, capped to avoid runaway when sample is tiny
  const blendWeight = Math.min(0.5, totalObservedMatches / 200); // max 50% weight to CHW signal
  const blendFactor = (1 - blendWeight) * 1.0 + blendWeight * concentrationFactor;
  const cappedBlend = Math.max(0.5, Math.min(2.0, blendFactor)); // cap at 2x or 0.5x

  const meanEstimate = Math.round(populationBased * cappedBlend);

  // CI: assume Poisson-like uncertainty on the count side, plus prior uncertainty.
  // For simplicity: meanEstimate ± 1.96 * sqrt(meanEstimate) for the count component,
  // plus 15% relative uncertainty for the prior.
  const countSE = Math.sqrt(Math.max(meanEstimate, 1));
  const priorSE = meanEstimate * 0.15;
  const totalSE = Math.sqrt(countSE * countSE + priorSE * priorSE);
  const lower = Math.max(0, Math.round(meanEstimate - 1.96 * totalSE));
  const upper = Math.round(meanEstimate + 1.96 * totalSE);

  return {
    district: districtName,
    district_population: districtPop,
    observed_matches: observedMatches,
    match_share: matchShare,
    population_share: populationShare,
    concentration_factor: Math.round(concentrationFactor * 100) / 100,
    estimated_eligible_population: {
      mean: meanEstimate,
      lower_95ci: lower,
      upper_95ci: upper,
    },
  };
}

/**
 * Run a trial-site-selection query.
 *
 * @param {object} criteria
 * @param {string} criteria.study_design - key into STUDY_DESIGNS
 * @param {string} [criteria.age_band]   - filter on patient_age_band
 * @param {string} [criteria.severity]   - filter on severity
 * @param {string} [criteria.pregnancy]  - filter on patient_pregnancy_status
 * @param {string} [criteria.hiv_status] - filter on patient_hiv_status
 * @param {number} [criteria.min_cohort_size] - sites below this are flagged
 * @param {number} [criteria.window_days]     - look-back window, default 30
 */
function runTrialSiteSelection(criteria) {
  const design = STUDY_DESIGNS[criteria.study_design];
  if (!design) {
    return {
      error: `Unknown study_design: ${criteria.study_design}. Valid: ${Object.keys(STUDY_DESIGNS).join(", ")}`,
    };
  }

  const days = criteria.window_days || 30;

  // Build the filter SQL. Match on topic + any condition substring.
  const conditionClauses = (design.condition_match || [])
    .map(() => "LOWER(condition) LIKE '%' || LOWER(?) || '%'")
    .join(" OR ");
  const conditionFilter = conditionClauses ? `AND (${conditionClauses})` : "";
  const conditionParams = design.condition_match || [];

  const ageFilter = criteria.age_band ? "AND patient_age_band = ?" : "";
  const ageParams = criteria.age_band ? [criteria.age_band] : [];

  const severityFilter = criteria.severity ? "AND severity = ?" : "";
  const severityParams = criteria.severity ? [criteria.severity] : [];

  const pregnancyFilter = criteria.pregnancy ? "AND patient_pregnancy_status = ?" : "";
  const pregnancyParams = criteria.pregnancy ? [criteria.pregnancy] : [];

  const hivFilter = criteria.hiv_status ? "AND patient_hiv_status = ?" : "";
  const hivParams = criteria.hiv_status ? [criteria.hiv_status] : [];

  const baseParams = [
    days,
    design.topic,
    ...conditionParams,
    ...ageParams,
    ...severityParams,
    ...pregnancyParams,
    ...hivParams,
  ];

  const sql = `
    SELECT district, COUNT(*) as count
      FROM case_tags
     WHERE created_at >= datetime('now', '-' || ? || ' days')
       AND topic = ?
       ${conditionFilter}
       ${ageFilter}
       ${severityFilter}
       ${pregnancyFilter}
       ${hivFilter}
       AND district IS NOT NULL
       AND district != 'unknown'
     GROUP BY district
     ORDER BY count DESC
  `;

  let observedRows;
  try {
    observedRows = db().prepare(sql).all(...baseParams);
  } catch (err) {
    return { error: `Query failed: ${err.message}` };
  }

  const totalObserved = observedRows.reduce((s, r) => s + r.count, 0);

  // Build candidate list — include ALL districts so the map shows zeros too
  const allDistricts = Object.keys(DISTRICT_POPULATIONS);
  const observedMap = Object.fromEntries(observedRows.map((r) => [r.district, r.count]));

  const candidates = allDistricts.map((districtName) =>
    estimateCohort({
      districtName,
      observedMatches: observedMap[districtName] || 0,
      totalObservedMatches: totalObserved,
      designConfig: design,
    }),
  );

  // Sort by mean cohort estimate descending
  candidates.sort(
    (a, b) =>
      b.estimated_eligible_population.mean - a.estimated_eligible_population.mean,
  );

  // Mark sites that meet the minimum cohort size threshold
  const minSize = criteria.min_cohort_size || 0;
  candidates.forEach((c) => {
    c.meets_min_cohort = c.estimated_eligible_population.mean >= minSize;
  });

  // Total estimated eligible population across all districts
  const totalMean = candidates.reduce(
    (s, c) => s + c.estimated_eligible_population.mean,
    0,
  );
  const totalLower = candidates.reduce(
    (s, c) => s + c.estimated_eligible_population.lower_95ci,
    0,
  );
  const totalUpper = candidates.reduce(
    (s, c) => s + c.estimated_eligible_population.upper_95ci,
    0,
  );

  return {
    criteria,
    study_design: {
      key: criteria.study_design,
      label: design.label,
      description: design.description,
    },
    coverage: {
      window_days: days,
      country: "Lesotho",
      total_population: TOTAL_POPULATION,
    },
    observed_signal: {
      total_matches: totalObserved,
      matches_by_district: observedMap,
    },
    candidate_districts: candidates,
    total_eligible_estimate: {
      mean: totalMean,
      lower_95ci: totalLower,
      upper_95ci: totalUpper,
    },
    methodology_note:
      "Estimate combines district population × topic prevalence prior × eligibility rate, " +
      "blended with the CHW-observed concentration factor (capped at 0.5×–2× to prevent runaway " +
      "estimates from sparse data). 95% CIs from Poisson-on-counts + 15% prior uncertainty. " +
      "Production version would replace constants with programmatic CHW catchment estimates.",
  };
}

/**
 * Public list of supported study designs (for the form dropdown).
 */
function listStudyDesigns() {
  return Object.entries(STUDY_DESIGNS).map(([key, v]) => ({
    key,
    label: v.label,
    topic: v.topic,
    description: v.description,
  }));
}

module.exports = {
  runTrialSiteSelection,
  listStudyDesigns,
  STUDY_DESIGNS,
  DISTRICT_POPULATIONS,
};
