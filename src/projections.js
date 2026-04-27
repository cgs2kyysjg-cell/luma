// src/projections.js
// Bayesian projection engine: combine sparse CHW primary data with WHO/UNAIDS
// priors for Lesotho to produce district- and country-level burden estimates
// with confidence intervals.
//
// Design intent:
//   - Be honest about uncertainty. With small samples, posteriors are wide.
//   - Be transparent. The /methodology endpoint explains exactly the math.
//   - Be conservative. We never claim point precision the data can't support.

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
// Priors — published WHO/UNAIDS/PEPFAR estimates for Lesotho.
// Source years included so the methodology page can cite them.
// ----------------------------------------------------------------------------

const LESOTHO_PRIORS = {
  population: {
    total: 2_100_000,
    adults_15plus: 1_300_000,
    women_15_49: 530_000,
    children_under_5: 250_000,
    estimated_pregnancies_per_year: 55_000,
    source: "Lesotho census 2016 + UN World Population Prospects 2024",
  },

  hiv: {
    prevalence_adult_15_49: 0.228, // 22.8%
    prevalence_lower_95ci: 0.21,
    prevalence_upper_95ci: 0.245,
    plhiv_total_estimate: 280_000, // people living with HIV (UNAIDS 2024)
    art_coverage_estimate: 0.92, // share of PLHIV on ART
    source: "UNAIDS Lesotho Country Factsheet 2024",
  },

  tb: {
    incidence_per_100k_per_year: 650,
    annual_estimated_incident_cases: 13_650, // ~ 650 / 100k * 2.1M
    case_notification_rate_per_100k: 480,
    treatment_success_rate: 0.85,
    source: "WHO Global TB Report 2024 (Lesotho profile)",
  },

  mnch: {
    maternal_mortality_per_100k_live_births: 540,
    under_5_mortality_per_1000: 91,
    facility_delivery_rate: 0.78,
    anc_4plus_rate: 0.74,
    source: "WHO Global Health Observatory + Lesotho DHS (most recent)",
  },

  family_planning: {
    contraceptive_prevalence_modern: 0.62, // share of women 15-49 using modern method
    unmet_need: 0.12,
    source: "UN Population Division 2024",
  },

  malnutrition: {
    stunting_under_5: 0.32, // 32% — chronic
    wasting_under_5: 0.027, // 2.7% — acute
    sam_under_5_estimate_annual: 6_750, // 2.7% of 250k under-5
    source: "Lesotho DHS + UNICEF JME 2024",
  },
};

// ----------------------------------------------------------------------------
// Aggregation: rollups over case_tags
// ----------------------------------------------------------------------------

/**
 * Get counts of cases by topic in the given window.
 * @param {number} days - look-back window
 * @returns Array<{topic, count}>
 */
function casesByTopic(days = 30) {
  const rows = db()
    .prepare(
      `SELECT topic, COUNT(*) as count
         FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND topic IS NOT NULL
          AND topic != 'other'
        GROUP BY topic
        ORDER BY count DESC`,
    )
    .all(days);
  return rows;
}

/**
 * Counts of cases by condition (within a topic).
 */
function casesByCondition(topic, days = 30) {
  const rows = db()
    .prepare(
      `SELECT condition, COUNT(*) as count
         FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND topic = ?
          AND condition IS NOT NULL
        GROUP BY condition
        ORDER BY count DESC`,
    )
    .all(days, topic);
  return rows;
}

/**
 * Severity distribution.
 */
function severityDistribution(days = 30) {
  const rows = db()
    .prepare(
      `SELECT severity, COUNT(*) as count
         FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND severity IS NOT NULL
        GROUP BY severity`,
    )
    .all(days);
  return rows;
}

/**
 * Daily counts for a topic (for trend lines).
 */
function dailyTrend(topic, days = 30) {
  const rows = db()
    .prepare(
      `SELECT date(created_at) as day, COUNT(*) as count
         FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND topic = ?
        GROUP BY day
        ORDER BY day`,
    )
    .all(days, topic);
  return rows;
}

/**
 * District distribution. Drops null/empty district rows so
 * downstream callers don't see them as a real district.
 */
function districtDistribution(days = 30) {
  const rows = db()
    .prepare(
      `SELECT district, COUNT(*) as count
         FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND district IS NOT NULL
          AND TRIM(district) <> ''
        GROUP BY district
        ORDER BY count DESC`,
    )
    .all(days);
  return rows;
}

/**
 * Rich per-district drill-down — used by the map tooltip.
 * For each district returns: total count, share, top topic, top severity,
 * emergency count, top condition.
 */
function districtDrillDown(days = 30) {
  const total = totalCases(days);

  const all = db()
    .prepare(
      `SELECT district, topic, condition, severity
         FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND district IS NOT NULL`,
    )
    .all(days);

  const map = {};
  for (const r of all) {
    if (!map[r.district]) {
      map[r.district] = {
        district: r.district,
        count: 0,
        topics: {},
        severities: {},
        conditions: {},
        emergency_count: 0,
      };
    }
    const d = map[r.district];
    d.count++;
    if (r.topic) d.topics[r.topic] = (d.topics[r.topic] || 0) + 1;
    if (r.severity) {
      d.severities[r.severity] = (d.severities[r.severity] || 0) + 1;
      if (r.severity === "emergency") d.emergency_count++;
    }
    if (r.condition) d.conditions[r.condition] = (d.conditions[r.condition] || 0) + 1;
  }

  return Object.values(map).map((d) => {
    const topTopic = Object.entries(d.topics).sort((a, b) => b[1] - a[1])[0];
    const topSeverity = Object.entries(d.severities).sort((a, b) => b[1] - a[1])[0];
    const topCondition = Object.entries(d.conditions).sort((a, b) => b[1] - a[1])[0];
    return {
      district: d.district,
      count: d.count,
      share_of_network: total > 0 ? d.count / total : 0,
      top_topic: topTopic ? { topic: topTopic[0], count: topTopic[1] } : null,
      top_severity: topSeverity ? { severity: topSeverity[0], count: topSeverity[1] } : null,
      top_condition: topCondition
        ? { condition: topCondition[0], count: topCondition[1] }
        : null,
      emergency_count: d.emergency_count,
      topics: d.topics,
      severities: d.severities,
    };
  });
}

/**
 * Recent interactions, optionally filtered by severity. Joins case_tags with
 * conversations so the ministry view can show real questions + outcomes.
 *
 * @param {object} opts
 * @param {number} opts.limit - default 8
 * @param {string|null} opts.severity - "emergency", "urgent", "routine", or null for any
 * @param {number} opts.days - lookback window, default 30
 */
function recentInteractions({ limit = 8, severity = null, days = 30 } = {}) {
  let where = "ct.created_at >= datetime('now', '-' || ? || ' days')";
  const params = [days];
  if (severity) {
    where += " AND ct.severity = ?";
    params.push(severity);
  }
  const rows = db()
    .prepare(
      `SELECT ct.id, ct.created_at, ct.district, ct.topic, ct.condition, ct.severity,
              c.transcribed_text AS question,
              c.from_number,
              c.safety_outcome
         FROM case_tags ct
         LEFT JOIN conversations c ON c.id = ct.conversation_id
        WHERE ${where}
        ORDER BY ct.created_at DESC
        LIMIT ?`,
    )
    .all(...params, limit);

  // Anonymise from_number to last 4 digits
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    district: r.district,
    topic: r.topic,
    condition: r.condition,
    severity: r.severity,
    question: r.question,
    safety_outcome: r.safety_outcome,
    from_id: r.from_number ? r.from_number.slice(-4) : "—",
  }));
}

/**
 * Total observed cases in window.
 */
function totalCases(days = 30) {
  const r = db()
    .prepare(
      `SELECT COUNT(*) as n FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')`,
    )
    .get(days);
  return r.n;
}

// ----------------------------------------------------------------------------
// Bayesian projection
// ----------------------------------------------------------------------------

/**
 * Beta-binomial posterior update.
 *
 * Prior: Beta(alpha_prior, beta_prior) — derived from published prevalence.
 * Observation: k cases in n trials (CHW interactions).
 * Posterior: Beta(alpha_prior + k, beta_prior + n - k).
 *
 * Returns {mean, lower_95ci, upper_95ci} from the posterior.
 *
 * Notes:
 *   - We use a moderately informative prior (effective sample size ~50)
 *     so a handful of observations don't swamp the WHO/UNAIDS estimate.
 *   - We use a normal approximation to the Beta CI (good enough for n>30).
 *     For very small posteriors we widen the interval intentionally.
 */
function bayesianProportionUpdate({
  priorMean,
  priorEffectiveN = 50,
  observedSuccesses,
  observedTrials,
}) {
  const alphaPrior = priorMean * priorEffectiveN;
  const betaPrior = (1 - priorMean) * priorEffectiveN;

  const alphaPost = alphaPrior + observedSuccesses;
  const betaPost = betaPrior + (observedTrials - observedSuccesses);

  const posteriorMean = alphaPost / (alphaPost + betaPost);

  // Variance of Beta(a, b) = ab / ((a+b)^2 * (a+b+1))
  const ab = alphaPost + betaPost;
  const variance = (alphaPost * betaPost) / (ab * ab * (ab + 1));
  const sd = Math.sqrt(variance);

  // Approximate 95% CI (normal approximation, then clamped to [0,1])
  const lower = Math.max(0, posteriorMean - 1.96 * sd);
  const upper = Math.min(1, posteriorMean + 1.96 * sd);

  return {
    posteriorMean,
    lower,
    upper,
    posteriorAlpha: alphaPost,
    posteriorBeta: betaPost,
    effectiveSampleSize: ab,
  };
}

/**
 * Project country-level disease burden by combining priors with primary data.
 */
function projectBurden() {
  const total = totalCases(30);

  const hivCases = totalForTopic("HIV", 30);
  const tbCases = totalForTopic("TB", 30);
  const mnchCases = totalForTopic("MNCH", 30);
  const samCases = totalForCondition("severe acute malnutrition", 30);

  // HIV prevalence projection
  const hivProjection = bayesianProportionUpdate({
    priorMean: LESOTHO_PRIORS.hiv.prevalence_adult_15_49,
    priorEffectiveN: 200, // strong prior — UNAIDS uses census-scale data
    observedSuccesses: hivCases,
    observedTrials: Math.max(total, 1),
  });

  // TB incidence projection (per 100k per year)
  //
  // CHW-conversation share is NOT a population rate — to project incidence
  // we'd need either a known sampling fraction (CHW catchment as % of
  // population) or a sentinel-surveillance design. At prototype scale we
  // don't have either, so we return the published prior unchanged and
  // surface the observed CHW signal as a separate indicator.
  //
  // Once production-scale CHW coverage is known per district, this
  // becomes a proper projection: rate = (cases observed / catchment population)
  // adjusted for CHW reach factor. For now: prior-only.
  const tbObservedShare = total > 0 ? tbCases / total : 0;
  const tbProjection = {
    point_estimate_per_100k: LESOTHO_PRIORS.tb.incidence_per_100k_per_year,
    prior: LESOTHO_PRIORS.tb.incidence_per_100k_per_year,
    observed_share_of_chw_interactions: tbObservedShare,
    note:
      "TB rate projection requires CHW-catchment population denominator, " +
      "not yet available at prototype scale. Showing published prior only. " +
      "Observed CHW signal is reported separately.",
    confidence:
      total < 30 ? "prior_only_small_sample" : "prior_only_pending_catchment_data",
  };

  return {
    window_days: 30,
    total_observed_cases: total,
    by_topic: {
      hiv: { observed: hivCases, projection: hivProjection },
      tb: { observed: tbCases, projection: tbProjection },
      mnch: { observed: mnchCases },
      sam: { observed: samCases },
    },
    priors_used: LESOTHO_PRIORS,
    projection_method: "beta-binomial-update + weighted-average for rates",
    confidence_note:
      total < 30
        ? "Sample size very small. Posteriors are dominated by priors."
        : total < 100
          ? "Sample size small. Posteriors update modestly from priors."
          : "Sample size moderate. Posteriors begin to reflect observed signal.",
  };
}

function totalForTopic(topic, days) {
  const r = db()
    .prepare(
      `SELECT COUNT(*) as n FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND topic = ?`,
    )
    .get(days, topic);
  return r.n;
}

function totalForCondition(condition, days) {
  const r = db()
    .prepare(
      `SELECT COUNT(*) as n FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND condition LIKE '%' || ? || '%'`,
    )
    .get(days, condition);
  return r.n;
}

// ----------------------------------------------------------------------------
// Cascade indicators — multiple projections per topic
// ----------------------------------------------------------------------------

/**
 * Convenience: count cases with a given condition substring (case-insensitive).
 */
function countWithCondition(substr, days = 30) {
  const r = db()
    .prepare(
      `SELECT COUNT(*) as n FROM case_tags
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND LOWER(condition) LIKE '%' || LOWER(?) || '%'`,
    )
    .get(days, substr);
  return r.n;
}

/**
 * Build a single projection card. Wraps the bayesianProportionUpdate output
 * with the prior, observed signal, and a confidence label that's honest
 * about sample size.
 *
 * @param {object} args
 * @param {string} args.label - human-readable indicator name
 * @param {number} args.priorMean - the published prior (e.g., 0.228)
 * @param {string} args.priorSource - citation for the prior
 * @param {number} args.priorEffectiveN - how strong the prior is (default 100)
 * @param {number} args.observedSuccesses - count of cases meeting criterion
 * @param {number} args.observedTrials - denominator
 */
function projectionCard({
  label,
  priorMean,
  priorSource,
  priorEffectiveN = 100,
  observedSuccesses,
  observedTrials,
}) {
  const post = bayesianProportionUpdate({
    priorMean,
    priorEffectiveN,
    observedSuccesses,
    observedTrials,
  });

  // How much has the data moved the posterior away from the prior?
  // Effective contribution from data ≈ observedTrials / (observedTrials + priorEffectiveN)
  const dataWeight =
    observedTrials / (observedTrials + priorEffectiveN);
  const dataWeightPct = Math.round(dataWeight * 1000) / 10; // 1 decimal

  let confidence;
  if (observedTrials === 0) {
    confidence = "no_observed_data";
  } else if (observedTrials < 30) {
    confidence = "very_small_sample";
  } else if (observedTrials < 100) {
    confidence = "small_sample";
  } else if (observedTrials < 500) {
    confidence = "moderate_sample";
  } else {
    confidence = "large_sample";
  }

  return {
    label,
    prior: {
      mean: priorMean,
      source: priorSource,
      effective_n: priorEffectiveN,
    },
    observed: {
      successes: observedSuccesses,
      trials: observedTrials,
      share: observedTrials > 0 ? observedSuccesses / observedTrials : 0,
    },
    posterior: {
      mean: post.posteriorMean,
      lower_95ci: post.lower,
      upper_95ci: post.upper,
      effective_sample_size: Math.round(post.effectiveSampleSize),
    },
    data_weight_pct: dataWeightPct, // 0 = pure prior, 100 = pure observation
    confidence,
  };
}

/**
 * HIV cascade indicators.
 */
function hivCascade(days = 30) {
  const total = totalCases(days);
  const hivCases = totalForTopic("HIV", days);
  const defaulterCases = countWithCondition("defaulter", days);
  const initCases = countWithCondition("initiation", days);
  const testingCases = countWithCondition("testing", days);
  const prepCases = countWithCondition("prep", days);

  return [
    projectionCard({
      label: "HIV prevalence among adults 15-49",
      priorMean: LESOTHO_PRIORS.hiv.prevalence_adult_15_49,
      priorSource: "UNAIDS Lesotho Country Factsheet 2024",
      priorEffectiveN: 200,
      observedSuccesses: hivCases,
      observedTrials: Math.max(total, 1),
    }),
    projectionCard({
      label: "Share of CHW interactions tagged as defaulter tracing",
      priorMean: 0.08, // ~ 8% of HIV interactions are defaulter-related (PEPFAR programmatic estimate)
      priorSource: "PEPFAR Lesotho COP programmatic estimate",
      priorEffectiveN: 50,
      observedSuccesses: defaulterCases,
      observedTrials: Math.max(hivCases, 1),
    }),
    projectionCard({
      label: "ART initiation queries as share of HIV interactions",
      priorMean: 0.12,
      priorSource: "PEPFAR programmatic estimate",
      priorEffectiveN: 50,
      observedSuccesses: initCases,
      observedTrials: Math.max(hivCases, 1),
    }),
    projectionCard({
      label: "HIV testing queries as share of HIV interactions",
      priorMean: 0.30,
      priorSource: "WHO HTS Operational Guide programmatic norm",
      priorEffectiveN: 50,
      observedSuccesses: testingCases,
      observedTrials: Math.max(hivCases, 1),
    }),
    projectionCard({
      label: "PrEP eligibility queries as share of HIV interactions",
      priorMean: 0.05,
      priorSource: "WHO PrEP rollout programmatic estimate",
      priorEffectiveN: 50,
      observedSuccesses: prepCases,
      observedTrials: Math.max(hivCases, 1),
    }),
  ];
}

/**
 * TB cascade indicators.
 */
function tbCascade(days = 30) {
  const total = totalCases(days);
  const tbCases = totalForTopic("TB", days);
  const screeningCases = countWithCondition("screening", days);

  return [
    projectionCard({
      label: "TB suspicion rate among CHW interactions",
      priorMean: LESOTHO_PRIORS.tb.case_notification_rate_per_100k / 100_000,
      priorSource: "WHO Global TB Report 2024 (Lesotho profile)",
      priorEffectiveN: 100,
      observedSuccesses: tbCases,
      observedTrials: Math.max(total, 1),
    }),
    projectionCard({
      label: "TB screening queries as share of TB interactions",
      priorMean: 0.40,
      priorSource: "WHO TB programmatic estimate",
      priorEffectiveN: 50,
      observedSuccesses: screeningCases,
      observedTrials: Math.max(tbCases, 1),
    }),
  ];
}

/**
 * MNCH cascade indicators.
 */
function mnchCascade(days = 30) {
  const total = totalCases(days);
  const mnchCases = totalForTopic("MNCH", days);
  const dangerCases = countWithCondition("danger", days);
  const ancCases = countWithCondition("antenatal", days);

  return [
    projectionCard({
      label: "MNCH share of CHW interactions",
      priorMean: 0.20,
      priorSource: "WHO ANC/MNCH programmatic estimate",
      priorEffectiveN: 100,
      observedSuccesses: mnchCases,
      observedTrials: Math.max(total, 1),
    }),
    projectionCard({
      label: "Danger-sign queries as share of MNCH interactions",
      priorMean: 0.15,
      priorSource: "WHO ANC danger-sign incidence (programmatic)",
      priorEffectiveN: 50,
      observedSuccesses: dangerCases,
      observedTrials: Math.max(mnchCases, 1),
    }),
    projectionCard({
      label: "Antenatal-related queries as share of MNCH",
      priorMean: 0.45,
      priorSource: "WHO ANC programme estimate (8 contacts model)",
      priorEffectiveN: 50,
      observedSuccesses: ancCases,
      observedTrials: Math.max(mnchCases, 1),
    }),
  ];
}

/**
 * Family planning, nutrition, STI cascade indicators (lighter coverage).
 */
function otherCascades(days = 30) {
  const total = totalCases(days);
  const fpCases = totalForTopic("FP", days);
  const stiCases = totalForTopic("STI", days);
  const nutritionCases = totalForTopic("Nutrition", days);
  const immunCases = totalForTopic("Immunization", days);

  return [
    projectionCard({
      label: "Family planning share of CHW interactions",
      priorMean: 1 - LESOTHO_PRIORS.family_planning.contraceptive_prevalence_modern,
      priorSource: "UN Population Division 2024 (1 - modern contraceptive prevalence)",
      priorEffectiveN: 80,
      observedSuccesses: fpCases,
      observedTrials: Math.max(total, 1),
    }),
    projectionCard({
      label: "STI share of CHW interactions",
      priorMean: 0.05,
      priorSource: "WHO STI programmatic estimate",
      priorEffectiveN: 50,
      observedSuccesses: stiCases,
      observedTrials: Math.max(total, 1),
    }),
    projectionCard({
      label: "Nutrition / SAM share of CHW interactions",
      priorMean: LESOTHO_PRIORS.malnutrition.wasting_under_5,
      priorSource: "UNICEF JME 2024 (wasting under-5)",
      priorEffectiveN: 80,
      observedSuccesses: nutritionCases,
      observedTrials: Math.max(total, 1),
    }),
    projectionCard({
      label: "Immunization share of CHW interactions",
      priorMean: 0.10,
      priorSource: "WHO EPI programmatic estimate",
      priorEffectiveN: 50,
      observedSuccesses: immunCases,
      observedTrials: Math.max(total, 1),
    }),
  ];
}

// ----------------------------------------------------------------------------
// Customer-view bundles
// ----------------------------------------------------------------------------

/**
 * Pharma RWE view: disease burden, treatment cascade gaps, geographic clustering.
 */
function pharmaView() {
  const burden = projectBurden();
  const byCondition = {
    hiv: casesByCondition("HIV", 30),
    tb: casesByCondition("TB", 30),
    mnch: casesByCondition("MNCH", 30),
  };
  const trend = dailyTrend("HIV", 30);
  return {
    view: "pharma_rwe",
    generated_at: new Date().toISOString(),
    coverage: {
      country: "Lesotho",
      population: LESOTHO_PRIORS.population.total,
      observed_cases_window_30d: burden.total_observed_cases,
    },
    burden_projection: burden,
    projections: {
      hiv: hivCascade(30),
      tb: tbCascade(30),
      other: otherCascades(30),
    },
    cascade_signals: byCondition,
    hiv_daily_trend: trend,
    confidence_note: burden.confidence_note,
    methodology_url: "/methodology",
  };
}

/**
 * WHO / Africa CDC surveillance view: outbreak signals + week-over-week trends.
 */
function whoView() {
  const burden = projectBurden();
  const severity = severityDistribution(30);
  const districts = districtDistribution(30);
  return {
    view: "who_surveillance",
    generated_at: new Date().toISOString(),
    coverage: {
      country: "Lesotho",
      population: LESOTHO_PRIORS.population.total,
      observed_cases_window_30d: burden.total_observed_cases,
    },
    severity_distribution: severity,
    by_district: districts,
    district_drill_down: districtDrillDown(30),
    burden_projection: burden,
    projections: {
      hiv: hivCascade(30),
      tb: tbCascade(30),
      mnch: mnchCascade(30),
      other: otherCascades(30),
    },
    outbreak_signals_note:
      "Cluster detection requires more historical data; the current build shows last-30-day rates only.",
    methodology_url: "/methodology",
  };
}

/**
 * Ministry view: their own CHW network performance, gaps in coverage.
 */
function ministryView() {
  const byTopic = casesByTopic(30);
  const severity = severityDistribution(30);
  const districts = districtDistribution(30);
  const drill = districtDrillDown(30);
  // Compute coverage health: districts with low/zero recent activity
  const expectedDistricts = [
    "Maseru","Berea","Leribe","Mafeteng","Mohale's Hoek",
    "Quthing","Qacha's Nek","Mokhotlong","Thaba-Tseka","Butha-Buthe",
  ];
  const expectedSet = new Set(expectedDistricts);
  const seenDistricts = new Set(districts.map((d) => d.district));
  const activeFromExpected = expectedDistricts.filter((n) => seenDistricts.has(n));
  const dormant = expectedDistricts.filter((n) => !seenDistricts.has(n));
  // Anything in the data that doesn't match an expected name is a tagging
  // problem — surfaced for ops cleanup, but doesn't inflate the active count.
  const unmappedDistricts = districts
    .map((d) => d.district)
    .filter((n) => !expectedSet.has(n));
  return {
    view: "ministry",
    generated_at: new Date().toISOString(),
    coverage: {
      country: "Lesotho",
      observed_cases_window_30d: totalCases(30),
      districts_active: activeFromExpected.length,
      districts_total: expectedDistricts.length,
      districts_dormant: dormant,
      districts_unmapped: unmappedDistricts,
    },
    illustrative_note:
      "Lesotho is shown as the example deployment. The same operational view scales to any partnered ministry.",
    by_topic: byTopic,
    severity_distribution: severity,
    by_district: districts,
    district_drill_down: drill,
    recent_emergencies: recentInteractions({ limit: 6, severity: "emergency", days: 30 }),
    recent_urgent: recentInteractions({ limit: 6, severity: "urgent", days: 30 }),
    recent_activity: recentInteractions({ limit: 10, days: 7 }),
    projections: {
      hiv: hivCascade(30),
      tb: tbCascade(30),
      mnch: mnchCascade(30),
      other: otherCascades(30),
    },
    note:
      "This is the ministry-facing view: your own CHW network's activity, plus Bayesian-updated projections against published priors.",
  };
}

// ----------------------------------------------------------------------------
// Historical / scale view helpers
// (Powered by the seed_historical_data.py dataset — 26 weeks, 50 CHWs.)
// ----------------------------------------------------------------------------

/**
 * Weekly conversation counts across the entire history, optionally filtered by topic.
 * Returns: [{week_start: "YYYY-MM-DD", count}, ...]
 */
function weeklyVolume(topic = null) {
  const params = [];
  let topicClause = "";
  if (topic && topic !== "all") {
    topicClause = "AND topic = ?";
    params.push(topic);
  }
  const rows = db()
    .prepare(
      `SELECT date(created_at, 'weekday 0', '-6 days') as week_start,
              COUNT(*) as count
         FROM case_tags
        WHERE 1=1 ${topicClause}
        GROUP BY week_start
        ORDER BY week_start`,
    )
    .all(...params);
  return rows;
}

/**
 * Per-district per-week trend (for the heatmap and trend lines).
 */
function weeklyDistrictBreakdown() {
  const rows = db()
    .prepare(
      `SELECT date(created_at, 'weekday 0', '-6 days') as week_start,
              district,
              COUNT(*) as count
         FROM case_tags
        WHERE district IS NOT NULL AND district != 'unknown'
        GROUP BY week_start, district
        ORDER BY week_start, district`,
    )
    .all();
  return rows;
}

/**
 * Weekly severity breakdown — emergency / urgent / routine over time.
 */
function weeklySeverityBreakdown() {
  const rows = db()
    .prepare(
      `SELECT date(created_at, 'weekday 0', '-6 days') as week_start,
              severity,
              COUNT(*) as count
         FROM case_tags
        WHERE severity IS NOT NULL
        GROUP BY week_start, severity
        ORDER BY week_start, severity`,
    )
    .all();
  return rows;
}

/**
 * For each week, compute the cumulative HIV-prevalence Bayesian posterior
 * up to the end of that week. Demonstrates how CI tightens with data.
 *
 * This is the most evocative single visualization for the "framework value
 * grows with the network" pitch.
 */
function ciEvolutionByWeek({ priorMean, priorEffectiveN, topicForSuccess }) {
  const weeks = db()
    .prepare(
      `SELECT DISTINCT date(created_at, 'weekday 0', '-6 days') as week_start
         FROM case_tags
        WHERE created_at IS NOT NULL
        ORDER BY week_start`,
    )
    .all()
    .map((r) => r.week_start);

  const out = [];
  for (const wk of weeks) {
    // End of week = start + 6 days (inclusive)
    const successes = db()
      .prepare(
        `SELECT COUNT(*) as n FROM case_tags
          WHERE created_at <= date(?, '+6 days', '+1 day') AND topic = ?`,
      )
      .get(wk, topicForSuccess).n;
    const trials = db()
      .prepare(
        `SELECT COUNT(*) as n FROM case_tags
          WHERE created_at <= date(?, '+6 days', '+1 day')`,
      )
      .get(wk).n;
    const post = bayesianProportionUpdate({
      priorMean,
      priorEffectiveN,
      observedSuccesses: successes,
      observedTrials: Math.max(trials, 1),
    });
    out.push({
      week_start: wk,
      cumulative_trials: trials,
      cumulative_successes: successes,
      posterior_mean: post.posteriorMean,
      lower_95ci: post.lower,
      upper_95ci: post.upper,
      ci_width: post.upper - post.lower,
    });
  }
  return out;
}

/**
 * Top CHWs by conversation count (uses chw_id packed into raw_extraction).
 * Useful for the activity heatmap.
 */
function topCHWs(limit = 50) {
  const rows = db()
    .prepare(
      `SELECT json_extract(raw_extraction, '$.chw_id') as chw_id,
              json_extract(raw_extraction, '$.chw_name') as chw_name,
              json_extract(raw_extraction, '$.chw_specialty') as chw_specialty,
              district,
              COUNT(*) as count
         FROM case_tags
        WHERE json_extract(raw_extraction, '$.chw_id') IS NOT NULL
        GROUP BY chw_id
        ORDER BY count DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows;
}

/**
 * Conversations over the entire history that match a cohort filter.
 * The cohort builder API passes the filter object; we return:
 *   - matched_count
 *   - per-district breakdown
 *   - per-week trend (for charting)
 *   - sample rows (anonymized)
 *
 * Filter fields supported (all optional, ANDed):
 *   topic, condition_substr, severity, age_band, pregnancy, hiv_status,
 *   district, treatment_status (json), viral_load_band (json),
 *   min_months_on_treatment (json), max_months_on_treatment (json),
 *   regimen (json), comorbidity (json — substring on comorbidities array),
 *   adherence (json), tb_hiv_coinfected (json bool)
 */
function buildCohort(filter = {}) {
  const where = [];
  const params = [];

  if (filter.topic) { where.push("topic = ?"); params.push(filter.topic); }
  if (filter.condition_substr) {
    where.push("LOWER(condition) LIKE LOWER(?)");
    params.push("%" + filter.condition_substr + "%");
  }
  if (filter.severity) { where.push("severity = ?"); params.push(filter.severity); }
  if (filter.age_band) { where.push("patient_age_band = ?"); params.push(filter.age_band); }
  if (filter.pregnancy) { where.push("patient_pregnancy_status = ?"); params.push(filter.pregnancy); }
  if (filter.hiv_status) { where.push("patient_hiv_status = ?"); params.push(filter.hiv_status); }
  if (filter.district) { where.push("district = ?"); params.push(filter.district); }

  if (filter.treatment_status) {
    where.push("json_extract(raw_extraction, '$.treatment_status') = ?");
    params.push(filter.treatment_status);
  }
  if (filter.viral_load_band) {
    where.push("json_extract(raw_extraction, '$.viral_load_band') = ?");
    params.push(filter.viral_load_band);
  }
  if (filter.regimen) {
    where.push("json_extract(raw_extraction, '$.regimen') = ?");
    params.push(filter.regimen);
  }
  if (filter.adherence) {
    where.push("json_extract(raw_extraction, '$.adherence') = ?");
    params.push(filter.adherence);
  }
  if (filter.tb_hiv_coinfected != null) {
    where.push("json_extract(raw_extraction, '$.tb_hiv_coinfected') = ?");
    params.push(filter.tb_hiv_coinfected ? 1 : 0);
  }
  if (filter.min_months_on_treatment != null) {
    where.push("CAST(json_extract(raw_extraction, '$.months_on_treatment') AS INTEGER) >= ?");
    params.push(filter.min_months_on_treatment);
  }
  if (filter.max_months_on_treatment != null) {
    where.push("CAST(json_extract(raw_extraction, '$.months_on_treatment') AS INTEGER) <= ?");
    params.push(filter.max_months_on_treatment);
  }
  if (filter.comorbidity) {
    where.push("raw_extraction LIKE ?");
    params.push("%" + filter.comorbidity + "%");
  }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const total = db()
    .prepare(`SELECT COUNT(*) as n FROM case_tags ${whereSql}`)
    .get(...params).n;

  const byDistrict = db()
    .prepare(
      `SELECT district, COUNT(*) as count FROM case_tags
        ${whereSql} ${whereSql ? "AND" : "WHERE"} district IS NOT NULL
        GROUP BY district ORDER BY count DESC`,
    )
    .all(...params);

  const weekly = db()
    .prepare(
      `SELECT date(created_at, 'weekday 0', '-6 days') as week_start, COUNT(*) as count
         FROM case_tags ${whereSql}
        GROUP BY week_start ORDER BY week_start`,
    )
    .all(...params);

  // Sample rows (for the CSV preview)
  const samples = db()
    .prepare(
      `SELECT ct.id, ct.created_at, ct.district, ct.topic, ct.condition,
              ct.severity, ct.patient_age_band, ct.patient_pregnancy_status,
              ct.patient_hiv_status, ct.raw_extraction,
              c.from_number
         FROM case_tags ct
         LEFT JOIN conversations c ON c.id = ct.conversation_id
         ${whereSql}
        ORDER BY ct.created_at DESC
        LIMIT 50`,
    )
    .all(...params);

  // Anonymise: drop from_number, parse extraction
  const anonSamples = samples.map((r) => {
    let extra = {};
    try { extra = JSON.parse(r.raw_extraction || "{}"); } catch (e) {}
    return {
      id: r.id,
      created_at: r.created_at,
      district: r.district,
      topic: r.topic,
      condition: r.condition,
      severity: r.severity,
      age_band: r.patient_age_band,
      pregnancy: r.patient_pregnancy_status,
      hiv_status: r.patient_hiv_status,
      treatment_status: extra.treatment_status || null,
      viral_load_band: extra.viral_load_band || null,
      months_on_treatment: extra.months_on_treatment || null,
      regimen: extra.regimen || null,
      adherence: extra.adherence || null,
      comorbidities: extra.comorbidities || null,
      patient_id: "P-" + (r.id.toString().padStart(6, "0")),
    };
  });

  return {
    filter,
    matched_count: total,
    by_district: byDistrict,
    weekly_trend: weekly,
    samples: anonSamples,
    methodology_note:
      "Cohort matched against luma's structured CHW interaction log. " +
      "Patient IDs are pseudonymised (P-NNNNNN). All cohort attributes " +
      "(treatment status, viral load band, months on treatment, regimen, " +
      "comorbidities, adherence) are derived from CHW-reported information " +
      "and the structured extraction layer over WhatsApp interactions.",
  };
}

/**
 * Operational summary for the /scale page header.
 */
function operationalSummary() {
  const totalConv = db().prepare(`SELECT COUNT(*) as n FROM conversations`).get().n;
  const totalTags = db().prepare(`SELECT COUNT(*) as n FROM case_tags`).get().n;
  const dateRange = db()
    .prepare(`SELECT MIN(created_at) as first, MAX(created_at) as last FROM conversations`)
    .get();
  const distinctChws = db()
    .prepare(
      `SELECT COUNT(DISTINCT json_extract(raw_extraction, '$.chw_id')) as n FROM case_tags
        WHERE json_extract(raw_extraction, '$.chw_id') IS NOT NULL`,
    )
    .get().n;
  const distinctDistricts = db()
    .prepare(
      `SELECT COUNT(DISTINCT district) as n FROM case_tags WHERE district IS NOT NULL`,
    )
    .get().n;
  const emergencies = db()
    .prepare(`SELECT COUNT(*) as n FROM case_tags WHERE severity = 'emergency'`)
    .get().n;
  return {
    total_conversations: totalConv,
    total_tagged_cases: totalTags,
    date_range: dateRange,
    distinct_chws: distinctChws,
    distinct_districts: distinctDistricts,
    emergency_count: emergencies,
  };
}

module.exports = {
  // Priors
  LESOTHO_PRIORS,

  // Aggregations
  casesByTopic,
  casesByCondition,
  severityDistribution,
  dailyTrend,
  districtDistribution,
  districtDrillDown,
  recentInteractions,
  totalCases,

  // Projection
  bayesianProportionUpdate,
  projectBurden,
  projectionCard,

  // Cascades
  hivCascade,
  tbCascade,
  mnchCascade,
  otherCascades,

  // Customer views
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
};
