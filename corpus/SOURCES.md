# Source provenance

Every protocol in this corpus is **scaffold content** synthesized from publicly available global health guidelines. None of them are direct copies or full quotes from any specific Lesotho Ministry of Health PDF.

This document lists every source the scaffolds draw on. For real CHW deployment, scaffolds must be replaced with current, ministry-approved Lesotho versions.

---

## Primary sources

### World Health Organization (WHO)

These are the foundational global guidelines that most national programmes — including Lesotho's — adopt and adapt.

| Publication | Year | Used for | URL |
|---|---|---|---|
| Consolidated Guidelines on HIV Prevention, Testing, Treatment, Service Delivery and Monitoring | 2021 (with 2024 updates) | HIV testing, ART initiation, defaulter tracing, PrEP | [who.int/publications/i/item/9789240031593](https://www.who.int/publications/i/item/9789240031593) |
| Consolidated Guidelines on the Use of Antiretroviral Drugs for Treating and Preventing HIV Infection | 2016 (foundational), 2021 update | ART initiation thresholds, regimen choice framing | [who.int/publications/i/item/9789241549684](https://www.who.int/publications/i/item/9789241549684) |
| Operational Guide for HIV Testing Services | 2020 | HTS protocol structure, pre/post-test counseling | [who.int/publications/i/item/9789240010512](https://www.who.int/publications/i/item/9789240010512) |
| Guidelines for the Treatment of Drug-Susceptible Tuberculosis and Patient Care | 2017 update | TB first-line regimens, monitoring smears | [who.int/publications/i/item/9789241550000](https://www.who.int/publications/i/item/9789241550000) |
| Consolidated Guidelines on Drug-Resistant Tuberculosis Treatment | 2022 | MDR-TB referral pathway framing | [who.int/publications/i/item/9789240007048](https://www.who.int/publications/i/item/9789240007048) |
| Integrated Management of Childhood Illness (IMCI) chart booklet | 2014 (still current) | Child danger signs, fast-breathing thresholds, severe pneumonia signs | [who.int/publications/i/item/9789241506823](https://www.who.int/publications/i/item/9789241506823) |
| WHO Recommendations on Antenatal Care for a Positive Pregnancy Experience | 2016 | 8 ANC contacts model, danger sign list | [who.int/publications/i/item/9789241549912](https://www.who.int/publications/i/item/9789241549912) |
| Consolidated Guidelines on Use of Antiretroviral Drugs for HIV in Pregnancy and Breastfeeding | 2010 (multiple updates) | PMTCT pathway, infant prophylaxis framing | [who.int/publications/i/item/9789241599818](https://www.who.int/publications/i/item/9789241599818) |
| Family Planning: A Global Handbook for Providers | 2022 update | Family planning counseling, method-by-method guidance | [fphandbook.org](https://fphandbook.org) |
| Guideline: Updates on the Management of Severe Acute Malnutrition in Infants and Children | 2013 (still current) | SAM identification, RUTF protocols | [who.int/publications/i/item/9789241506328](https://www.who.int/publications/i/item/9789241506328) |
| Guidelines for the Management of Symptomatic Sexually Transmitted Infections | 2021 | Syndromic STI management | [who.int/publications/i/item/9789240024168](https://www.who.int/publications/i/item/9789240024168) |
| WHO Recommendations for Routine Immunization | continuously updated | EPI schedule | [who.int/teams/immunization-vaccines-and-biologicals/policies/who-recommendations-for-routine-immunization](https://www.who.int/teams/immunization-vaccines-and-biologicals/policies/who-recommendations-for-routine-immunization) |
| WHO TB Preventive Therapy Guidelines | 2020 | TPT for contacts and HIV-positive | [who.int/publications/i/item/9789240001503](https://www.who.int/publications/i/item/9789240001503) |

### PEPFAR

Programmatic context only; the protocols themselves are clinical, but PEPFAR documentation informs how programmes are organized in Lesotho.

| Publication | Notes |
|---|---|
| PEPFAR Lesotho Country Operational Plan (COP) | Annual; informs CHW network structures, defaulter-tracing programmatic patterns |
| PEPFAR Monitoring, Evaluation, and Reporting (MER) indicators | Informs reporting categories used in protocols' "Data and reporting" sections |

### Lesotho-specific (publicly known programme structure, not direct quotes)

Lesotho-specific guidelines are not all publicly accessible online. The corpus uses publicly-known programme **structure** (e.g., the existence of a National TB Programme, district health teams, facility nurses) but **not** specific Lesotho clinical thresholds — those need direct ministry verification.

| Publication | Notes |
|---|---|
| Lesotho National Guidelines for the Use of ARVs | Programme structure (HTS → ART initiation → continuity) |
| Lesotho National TB Programme Manual | Programme structure; CHW referral pathways |
| Lesotho MNCH Service Delivery Standards | Programme structure; district MNCH coordinator role |

---

## How sourcing is recorded in each protocol

Every `corpus/*.md` file has YAML frontmatter that names its specific source. Example:

```yaml
---
title: HIV Testing & Counseling
source_organization: WHO
source_publication: Operational Guide for HIV Testing Services
source_year: 2020
source_url: https://www.who.int/publications/i/item/9789240010512
scaffold_version: 0.1
scope: HIV testing services for CHWs
---
```

The AI is instructed to mention the source organization in responses where relevant — e.g., *"Per WHO Operational Guide for HIV Testing Services (2020), § 3 — Pre-test counseling..."*

---

## What's NOT in the corpus, intentionally

To keep the prototype scope honest:

- **Specific drug doses** are not in any protocol. The protocols describe regimens generically (e.g., "first-line HRZE for 2 months"). CHWs don't dose; clinicians do. The safety layer hard-refuses any dose-specific question.
- **Diagnostic algorithms beyond IMCI** — luma is decision-support for known-protocol situations, not a diagnostic tool.
- **Pediatric pharmacology** — the safety layer hard-refuses pediatric dosing questions.
- **Mental health treatment specifics** — the corpus mentions screening and referral but not pharmacological treatment.
- **Surgical or hospital-based procedures** — out of scope for community health workers.

These are deliberate scope constraints, not oversights.

---

## Replacement timeline (for real deployment)

Before any CHW or ministry uses luma in production:

1. **Lesotho MoH partnership formalized** — a memorandum of understanding covering data ownership, content review, and update cadence.
2. **Replace each scaffold with the current ministry-approved version**, including section numbering and contact details.
3. **Clinical advisory review** — at minimum one practicing Lesotho clinician (ART/TB/MNCH specialist) reviews each protocol document.
4. **Re-run `npm run ingest`** to rebuild the embeddings index from the new source documents.
5. **Quarterly re-ingestion cadence** — protocols update; the corpus must update with them.

This is what the YC funding pays for: not the scaffold corpus (free), but the partnership, review, and operational cadence to keep the corpus current.
