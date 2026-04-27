#!/usr/bin/env python3
"""
Python equivalent of seed-historical-data.js.

Reason this exists: the JS version uses better-sqlite3 which is compiled
per-platform; the Linux sandbox can't load the macOS .node binary. Python's
built-in sqlite3 has no such dependency, and writes to the same SQLite file
the Node server reads (SQLite is single-file regardless of language).

Behaviour mirrors the JS seeder:
  - 5000 conversations
  - 50 CHWs across 10 districts
  - 26 weeks of history
  - Topic distribution, severity, refusal/fallback all match
  - Cohort attributes packed into raw_extraction JSON

Re-run safely: existing rows with from_number LIKE 'whatsapp:+HIST%' are
deleted before re-seeding.
"""
import sqlite3
import json
import math
import random
import os
from datetime import datetime, timedelta

# Paths
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "..", "data", "luma.db")

TARGET_COUNT = 5000
WINDOW_DAYS = 180
REFUSAL_RATIO = 0.05
FALLBACK_RATIO = 0.07  # captured inside QUESTION_BANK 'other' samples
FROM_PREFIX = "whatsapp:+HIST"

# Fix the seed for reproducibility (helps debug)
random.seed(42)


SESOTHO_NAMES = [
    "Mpho", "Lerato", "Tebogo", "Refiloe", "Tumelo", "Mamello", "Thabo", "Palesa",
    "Karabo", "Nthabiseng", "Limpho", "Tshepo", "Boitumelo", "Lineo", "Khanyo",
    "Mosa", "Malefetsane", "Tsepiso", "Nthatisi", "Ratsoaa", "Realeboha",
    "Pulane", "Makhotso", "Reitumetse", "Lehlohonolo", "Mokoena", "Bohlokoa",
    "Tlali", "Tseliso", "Hlompho", "Mmemoholo", "Liteboho", "Ntseliseng",
    "Matseliso", "Khauhelo", "Bonolo", "Pheello", "Mafusi", "Lipalesa",
    "Itumeleng", "Khotso", "Sentso", "Likotsi", "Tsietsi", "Selloane",
    "Ntsiuoa", "Mphonyane", "Mahlomola", "Pakiso", "Polokeho",
]

DISTRICTS = [
    {"name": "Maseru",        "weight": 0.25, "chws": 13},
    {"name": "Berea",         "weight": 0.13, "chws": 6 },
    {"name": "Leribe",        "weight": 0.15, "chws": 7 },
    {"name": "Mafeteng",      "weight": 0.09, "chws": 4 },
    {"name": "Mohale's Hoek", "weight": 0.09, "chws": 4 },
    {"name": "Quthing",       "weight": 0.06, "chws": 3 },
    {"name": "Qacha's Nek",   "weight": 0.05, "chws": 3 },
    {"name": "Mokhotlong",    "weight": 0.05, "chws": 3 },
    {"name": "Thaba-Tseka",   "weight": 0.07, "chws": 4 },
    {"name": "Butha-Buthe",   "weight": 0.06, "chws": 3 },
]

SPECIALTY_PROFILES = {
    "generalist":   {"HIV": 0.36, "MNCH": 0.20, "TB": 0.12, "FP": 0.09, "STI": 0.08, "Nutrition": 0.06, "Immunization": 0.05, "other": 0.04},
    "hiv_focused":  {"HIV": 0.55, "MNCH": 0.10, "TB": 0.15, "FP": 0.05, "STI": 0.08, "Nutrition": 0.02, "Immunization": 0.02, "other": 0.03},
    "mnch_focused": {"HIV": 0.18, "MNCH": 0.42, "TB": 0.04, "FP": 0.14, "STI": 0.06, "Nutrition": 0.08, "Immunization": 0.05, "other": 0.03},
    "tb_focused":   {"HIV": 0.30, "MNCH": 0.08, "TB": 0.40, "FP": 0.05, "STI": 0.06, "Nutrition": 0.03, "Immunization": 0.04, "other": 0.04},
    "pediatric":    {"HIV": 0.15, "MNCH": 0.30, "TB": 0.08, "FP": 0.06, "STI": 0.04, "Nutrition": 0.20, "Immunization": 0.13, "other": 0.04},
}
SPECIALTY_KEYS = list(SPECIALTY_PROFILES.keys())

ACTIVITY_PROFILES = {
    "high":   {"avg_per_week": 8,    "variance": 0.4},
    "medium": {"avg_per_week": 4,    "variance": 0.5},
    "low":    {"avg_per_week": 1.5,  "variance": 0.7},
}

QUESTION_BANK = {
    "HIV": [
        {"condition": "ART defaulter tracing",
         "severity_weights": {"routine": 0.55, "urgent": 0.4, "emergency": 0.05},
         "questions": [
             "My ART patient missed her refill last month. What do I do?",
             "Patient hasn't picked up ART in 3 weeks, advice?",
             "ART defaulter — refusing to come back. Next step?",
             "Mother on ART, missed appointment, no answer on phone. Help.",
             "Patient stopped ART because of stigma at work. What now?",
         ],
         "response": "Per ART Defaulter Pathway § 4.2: home visit between days 14 and 28, leave a discreet note if not reached, escalate to facility supervisor if refusing re-engagement. Want to log this as a defaulter case for your supervisor?",
         "sources": [{"source": "ART Missed-Dose & Defaulter Tracing Pathway", "section": "§ 4", "score": 0.62}]},
        {"condition": "HIV testing",
         "severity_weights": {"routine": 0.85, "urgent": 0.15, "emergency": 0},
         "questions": [
             "How do I test for HIV in a community setting?",
             "Patient wants HIV test — what's the procedure here?",
             "Couple wants testing together, can I do that?",
             "Index testing — household contact, where do I start?",
         ],
         "response": "Per HIV Testing & Counseling § 5: rapid finger-prick test, read at 15-20 min. Follow national algorithm with second confirmatory test if reactive. Want me to send the full pre-test counseling checklist?",
         "sources": [{"source": "HIV Testing & Counseling (HTS)", "section": "§ 5", "score": 0.71}]},
        {"condition": "ART initiation",
         "severity_weights": {"routine": 0.5, "urgent": 0.5, "emergency": 0},
         "questions": [
             "Can I start this patient on ART today after positive test?",
             "Newly diagnosed, when does ART start?",
             "Same-day ART for someone with TB symptoms — safe?",
             "Test was reactive yesterday. Initiation today?",
         ],
         "response": "Per ART Initiation Protocol § 3.1: same-day initiation is preferred when patient is clinically stable, has no active TB symptoms, and consents. CHWs do not prescribe; refer to facility nurse for prescription. Want me to log this referral?",
         "sources": [{"source": "ART Initiation Protocol", "section": "§ 3", "score": 0.68}]},
        {"condition": "PrEP eligibility",
         "severity_weights": {"routine": 0.9, "urgent": 0.1, "emergency": 0},
         "questions": [
             "Should I recommend PrEP to a HIV-negative patient with positive partner?",
             "Sex worker asking about PrEP — eligible?",
             "Adolescent girl, multiple partners, PrEP a fit?",
             "Discordant couple wants PrEP. Path?",
         ],
         "response": "Per PrEP Protocol § 3: sero-discordant partners are a priority eligibility group, particularly when the positive partner is not yet virally suppressed. Refer for facility eligibility assessment. Want to log this for follow-up?",
         "sources": [{"source": "PrEP — Pre-Exposure Prophylaxis", "section": "§ 3", "score": 0.66}]},
        {"condition": "PMTCT defaulter",
         "severity_weights": {"routine": 0.1, "urgent": 0.55, "emergency": 0.35},
         "questions": [
             "Pregnant woman is HIV+ but missed her last appointment",
             "PMTCT mother defaulted at 28 weeks, options?",
             "HIV+ pregnant patient stopped ART. Vertical transmission risk?",
         ],
         "response": "Per PMTCT Protocol § 4.3: home visit at day 7 (expedited timeline). Vertical transmission risk drives urgency. Refer to facility PMTCT focal person same-day. Want to log this as a PMTCT defaulter case?",
         "sources": [{"source": "PMTCT", "section": "§ 4", "score": 0.74}]},
        {"condition": "ART side effect",
         "severity_weights": {"routine": 0, "urgent": 0.4, "emergency": 0.6},
         "questions": [
             "Patient on ART is reporting jaundice at month 2",
             "Severe rash on TLD regimen — referral needed?",
             "Patient vomiting daily on ART — drug toxicity?",
         ],
         "response": "Per ART Initiation Protocol § 8: severe rash, jaundice, or persistent vomiting after starting ART — refer to facility same-day. Suspected drug toxicity requires clinician review. Logging this referral.",
         "sources": [{"source": "ART Initiation Protocol", "section": "§ 8", "score": 0.69}]},
        {"condition": "viral load suppression",
         "severity_weights": {"routine": 0.7, "urgent": 0.3, "emergency": 0},
         "questions": [
             "Patient's last VL was 2000, what now?",
             "Viral load not suppressed at 6 months, what's the protocol?",
             "Adherence counseling for unsuppressed VL — checklist?",
         ],
         "response": "Per ART Protocol § 6: unsuppressed VL (>1000 copies/mL) triggers enhanced adherence counseling for 3 months, then repeat VL. Switch to second-line if persistent. Logging this case for the facility ART team.",
         "sources": [{"source": "ART Switching & VL Monitoring Protocol", "section": "§ 6", "score": 0.71}]},
    ],
    "MNCH": [
        {"condition": "antenatal danger sign",
         "severity_weights": {"routine": 0, "urgent": 0.2, "emergency": 0.8},
         "questions": [
             "Pregnant woman has severe headache and blurred vision",
             "Antenatal patient with swelling and high BP, urgent?",
             "Mother at 36 weeks with epigastric pain — concern?",
             "Pregnant, sudden severe headache, looks unwell — what to do?",
         ],
         "response": "Per MNCH Referral Pathway § 1: severe headache with blurred vision is a danger sign for pre-eclampsia. Arrange immediate transport to the nearest CEmOC facility. Logging this as an emergency referral.",
         "sources": [{"source": "Maternal, Newborn & Child Health Referral Pathway", "section": "§ 1", "score": 0.78}]},
        {"condition": "neonatal danger sign",
         "severity_weights": {"routine": 0, "urgent": 0.3, "emergency": 0.7},
         "questions": [
             "Newborn has fast breathing and chest indrawing",
             "3-day-old not feeding and floppy. Help?",
             "Newborn with fever and yellow skin — urgent?",
         ],
         "response": "Per MNCH § 4.2 + IMCI: chest indrawing in a newborn = severe pneumonia signs. Refer immediately. Logging this referral.",
         "sources": [{"source": "Maternal, Newborn & Child Health Referral Pathway", "section": "§ 4", "score": 0.72}]},
        {"condition": "antenatal default",
         "severity_weights": {"routine": 0.6, "urgent": 0.4, "emergency": 0},
         "questions": [
             "Mother missed her first antenatal visit at 12 weeks",
             "Pregnant woman at 22 weeks, no ANC visits yet",
             "ANC patient missed last 2 appointments. Outreach?",
         ],
         "response": "Per MNCH § 2: 8 antenatal contacts is the standard, with first contact before 12 weeks. Schedule home visit, screen for danger signs, link to first ANC. Want to log this follow-up?",
         "sources": [{"source": "Maternal, Newborn & Child Health Referral Pathway", "section": "§ 2", "score": 0.65}]},
        {"condition": "child IMCI danger sign",
         "severity_weights": {"routine": 0.1, "urgent": 0.4, "emergency": 0.5},
         "questions": [
             "Child under 5 with diarrhea and lethargy",
             "Toddler with high fever for 3 days, not playing — concern?",
             "Child convulsion at home, what next?",
         ],
         "response": "Per MNCH § 5.1: lethargy is an IMCI danger sign. Severe dehydration with diarrhea also requires immediate referral. Logging this referral.",
         "sources": [{"source": "Maternal, Newborn & Child Health Referral Pathway", "section": "§ 5", "score": 0.70}]},
        {"condition": "postpartum follow-up",
         "severity_weights": {"routine": 0.65, "urgent": 0.3, "emergency": 0.05},
         "questions": [
             "Mother 2 weeks postpartum, when do I check on her?",
             "Postpartum visit schedule — what to assess?",
             "New mother feeling sad and anxious. Postnatal depression?",
         ],
         "response": "Per MNCH § 6: postnatal contacts at day 1, day 3, day 7, week 6. Screen for danger signs (heavy bleeding, fever, severe headache) and breastfeeding support. Mental health screening at week 6. Logging follow-up.",
         "sources": [{"source": "Maternal, Newborn & Child Health Referral Pathway", "section": "§ 6", "score": 0.66}]},
    ],
    "TB": [
        {"condition": "TB suspect screening",
         "severity_weights": {"routine": 0.5, "urgent": 0.45, "emergency": 0.05},
         "questions": [
             "Patient has cough for 3 weeks, what should I do?",
             "Adult with night sweats and weight loss — TB?",
             "Coughing up blood, screening required?",
             "Persistent cough in HIV+ patient — sputum?",
         ],
         "response": "Per TB Treatment Protocol § 3.1: cough lasting ≥ 2 weeks is a presumptive TB indicator. Refer for sputum collection and GeneXpert testing at facility. Want to log this referral?",
         "sources": [{"source": "TB Treatment & Case Management Protocol", "section": "§ 3", "score": 0.67}]},
        {"condition": "TB contact tracing",
         "severity_weights": {"routine": 0.7, "urgent": 0.3, "emergency": 0},
         "questions": [
             "TB contact in household, what do I check for?",
             "5 household contacts — who needs TPT?",
             "Index TB case — children also need testing?",
         ],
         "response": "Per TB Protocol § 6: screen each household contact for symptoms within 7 days of index case diagnosis. Children under 5 and HIV-positive contacts: refer for TB preventive therapy regardless of symptoms. Logging?",
         "sources": [{"source": "TB Treatment & Case Management Protocol", "section": "§ 6", "score": 0.69}]},
        {"condition": "TB treatment side effect",
         "severity_weights": {"routine": 0, "urgent": 0.4, "emergency": 0.6},
         "questions": [
             "Patient on TB treatment is yellow-eyed at month 2",
             "TB patient with severe nausea and yellowing — drug toxicity?",
             "Numbness and tingling on TB regimen — concern?",
         ],
         "response": "Per TB Protocol § 7: jaundice on first-line TB treatment may indicate hepatotoxicity. Escalate to district TB coordinator same-day. Logging emergency referral.",
         "sources": [{"source": "TB Treatment & Case Management Protocol", "section": "§ 7", "score": 0.73}]},
        {"condition": "MDR TB suspect",
         "severity_weights": {"routine": 0, "urgent": 0.7, "emergency": 0.3},
         "questions": [
             "Patient failed first-line TB treatment, MDR concern?",
             "GeneXpert showed rifampicin resistance — next steps?",
             "TB treatment failure at month 5 — referral?",
         ],
         "response": "Per TB Protocol § 9: rifampicin-resistant or treatment-failure cases require referral to the MDR-TB initiation site. Don't delay — drug resistance amplifies fast. Logging urgent referral.",
         "sources": [{"source": "TB Treatment & Case Management Protocol", "section": "§ 9", "score": 0.78}]},
    ],
    "FP": [
        {"condition": "family planning counseling",
         "severity_weights": {"routine": 1, "urgent": 0, "emergency": 0},
         "questions": [
             "How do I counsel about contraceptive options?",
             "Patient asking about implant vs injection",
             "Couple wants spacing, what's the process?",
         ],
         "response": "Per Family Planning § 4: use the GATHER framework — Greet, Ask, Tell, Help (choose), Explain, Return. Discuss method effectiveness, side effects, and dual protection (condoms + another method) for STI/HIV protection. Want me to send the method comparison table?",
         "sources": [{"source": "Family Planning & Contraception Counseling", "section": "§ 4", "score": 0.64}]},
        {"condition": "adolescent FP",
         "severity_weights": {"routine": 0.85, "urgent": 0.15, "emergency": 0},
         "questions": [
             "Adolescent asking for confidential family planning",
             "16-year-old wants implant, parental consent needed?",
             "Adolescent girl on her own — confidentiality?",
         ],
         "response": "Per Family Planning § 7.1: all methods are medically eligible for adolescents. Counsel confidentially, no parental notification required. Long-acting methods (implants, IUDs) particularly suitable. Want to log this consultation?",
         "sources": [{"source": "Family Planning & Contraception Counseling", "section": "§ 7", "score": 0.66}]},
        {"condition": "method discontinuation",
         "severity_weights": {"routine": 0.85, "urgent": 0.15, "emergency": 0},
         "questions": [
             "Patient wants to stop her implant — process?",
             "Side effects from injectable, switch?",
             "Wants to conceive — when can she stop pill?",
         ],
         "response": "Per Family Planning § 8: removal counseling, switch options, fertility return windows by method. Want me to send the method-switch reference card?",
         "sources": [{"source": "Family Planning & Contraception Counseling", "section": "§ 8", "score": 0.62}]},
    ],
    "STI": [
        {"condition": "STI urethral discharge",
         "severity_weights": {"routine": 0.7, "urgent": 0.3, "emergency": 0},
         "questions": [
             "Patient with urethral discharge, male, sexually active",
             "Painful urination and discharge — STI?",
             "Patient with dysuria for a week — workup?",
         ],
         "response": "Per STI Screening § 3: urethral discharge in men is most likely gonorrhea or chlamydia. Refer to facility for syndromic management. Partner notification should follow. Want me to log this referral?",
         "sources": [{"source": "STI Screening & Syndromic Management", "section": "§ 3", "score": 0.68}]},
        {"condition": "syphilis in pregnancy",
         "severity_weights": {"routine": 0, "urgent": 0.6, "emergency": 0.4},
         "questions": [
             "Pregnant woman with positive syphilis screening",
             "ANC patient RPR reactive — urgency?",
             "Syphilis-positive at 30 weeks — congenital risk?",
         ],
         "response": "Per STI § 7.1: pregnant woman with positive syphilis MUST be treated within 48 hours. Congenital syphilis causes stillbirth and severe infant disease. Refer same-day to facility. Logging emergency.",
         "sources": [{"source": "STI Screening & Syndromic Management", "section": "§ 7", "score": 0.74}]},
        {"condition": "genital ulcer",
         "severity_weights": {"routine": 0.5, "urgent": 0.45, "emergency": 0.05},
         "questions": [
             "Patient with painful genital ulcer — treatment?",
             "Genital sore, possible HSV?",
             "Painless ulcer in a young man, work up for syphilis?",
         ],
         "response": "Per STI § 4: syndromic management for genital ulcer disease — treat for both syphilis and chancroid empirically. Refer for HIV testing if status unknown. Logging treatment plan.",
         "sources": [{"source": "STI Screening & Syndromic Management", "section": "§ 4", "score": 0.67}]},
    ],
    "Nutrition": [
        {"condition": "severe acute malnutrition",
         "severity_weights": {"routine": 0, "urgent": 0.5, "emergency": 0.5},
         "questions": [
             "Child with MUAC 110mm, what now?",
             "Toddler with bilateral pitting edema — SAM?",
             "Severely wasted infant, where to refer?",
         ],
         "response": "Per SAM § 3.1: MUAC < 115mm = SAM. Same-day facility referral required. Facility will perform appetite test and complications screen. Logging this referral.",
         "sources": [{"source": "Severe Acute Malnutrition (SAM) Management", "section": "§ 3", "score": 0.76}]},
        {"condition": "feeding concern",
         "severity_weights": {"routine": 0.4, "urgent": 0.5, "emergency": 0.1},
         "questions": [
             "Mother says child won't eat for 2 days",
             "Infant refusing breast — concern?",
             "Toddler with poor weight gain — investigation?",
         ],
         "response": "Per SAM § 3.3 + IMCI: refusal to eat is an IMCI danger sign in any child under 5. Conduct MUAC measurement and edema check. Refer if any acute malnutrition criteria met. Logging assessment.",
         "sources": [{"source": "Severe Acute Malnutrition (SAM) Management", "section": "§ 3", "score": 0.65}]},
    ],
    "Immunization": [
        {"condition": "missed immunization",
         "severity_weights": {"routine": 0.95, "urgent": 0.05, "emergency": 0},
         "questions": [
             "Child missed pentavalent dose at 10 weeks",
             "Catch-up schedule for 8-month-old who missed BCG?",
             "Defaulted on measles dose — restart?",
         ],
         "response": "Per Immunization § 5: don't restart the series — continue from where the child left off. Maintain 4-week minimum interval between doses. Refer to facility for catch-up. Logging follow-up.",
         "sources": [{"source": "Childhood Immunization Schedule (EPI)", "section": "§ 5", "score": 0.69}]},
        {"condition": "suspected measles cluster",
         "severity_weights": {"routine": 0, "urgent": 0.4, "emergency": 0.6},
         "questions": [
             "Cluster of 3 children with rash and fever in one village",
             "Several kids with fever and red spots — outbreak?",
             "School with multiple absent children, fever and rash — measles?",
         ],
         "response": "Per Immunization § 8: cluster of children with rash + fever = suspected measles. Report immediately to district EPI coordinator for outbreak response. Logging this report.",
         "sources": [{"source": "Childhood Immunization Schedule (EPI)", "section": "§ 8", "score": 0.78}]},
    ],
    "other": [
        {"condition": "out_of_scope",
         "severity_weights": {"routine": 1, "urgent": 0, "emergency": 0},
         "questions": [
             "What's a good lunch recipe?",
             "How do I top up airtime?",
             "Where can I find the supervisor's number?",
         ],
         "response": "I help with patient care questions from your ministry's protocols. For other things — phone, supplies, or admin — please reach your supervisor directly.",
         "sources": [],
         "outcome": "out_of_scope_topic"},
        {"condition": "general health knowledge",
         "severity_weights": {"routine": 1, "urgent": 0, "emergency": 0},
         "questions": [
             "How long does HIV testing take to give a result?",
             "What's the incubation period for measles?",
             "How long does TB treatment last?",
         ],
         "response": "⚠️ Not from your ministry protocols — general public-health information.\n\nWHO-recommended estimate. For your facility's protocol on this, please consult your supervisor.",
         "sources": [],
         "outcome": "fallback_general_knowledge"},
    ],
}

REFUSAL_SAMPLES = [
    {"q": "What dose of bedaquiline should I give a 45kg patient?",
     "outcome": "clinical_advice_requested",
     "response": "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?"},
    {"q": "Does my patient have HIV based on these symptoms?",
     "outcome": "clinical_advice_requested",
     "response": "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?"},
    {"q": "My patient has high blood pressure, what's the protocol?",
     "outcome": "out_of_scope_topic",
     "response": "That topic isn't in my current corpus (ART, TB, MNCH only). Please call your district coordinator. I'll have more topics in the next version."},
    {"q": "How much amoxicillin for a 6-month-old?",
     "outcome": "clinical_advice_requested",
     "response": "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?"},
    {"q": "Can you diagnose this for me?",
     "outcome": "clinical_advice_requested",
     "response": "I can't recommend dosing, diagnosis, or drug interactions — that's a clinician's call. I can send you the relevant protocol section. Want me to do that?"},
]


def pick_weighted_dict(d):
    """Pick a key from {key: weight} weighted by weights."""
    keys = list(d.keys())
    weights = list(d.values())
    total = sum(weights)
    r = random.random() * total
    cum = 0
    for k, w in zip(keys, weights):
        cum += w
        if r <= cum:
            return k
    return keys[-1]


def pick_severity(weights):
    total = weights["routine"] + weights["urgent"] + weights["emergency"]
    r = random.random() * total
    if r < weights["routine"]:
        return "routine"
    if r < weights["routine"] + weights["urgent"]:
        return "urgent"
    return "emergency"


def gaussian(mean, stddev):
    return random.gauss(mean, stddev)


def build_chw_roster():
    chws = []
    counter = 1000
    for d in DISTRICTS:
        for _ in range(d["chws"]):
            phone_id = str(counter)
            counter += 1
            specialty = random.choice(SPECIALTY_KEYS)
            r = random.random()
            activity = "high" if r < 0.2 else ("medium" if r < 0.7 else "low")
            chws.append({
                "id": phone_id,
                "from_number": FROM_PREFIX + phone_id,
                "name": SESOTHO_NAMES[(counter * 7) % len(SESOTHO_NAMES)],
                "district": d["name"],
                "specialty": specialty,
                "activity": activity,
                "text_voice_ratio": 0.5 + random.random() * 0.4,
            })
    return chws


def schedule_conversations(chws):
    weights = [ACTIVITY_PROFILES[c["activity"]]["avg_per_week"] for c in chws]
    total_weight = sum(weights)
    weeks = math.ceil(WINDOW_DAYS / 7)
    total_capacity = total_weight * weeks
    scale = TARGET_COUNT / total_capacity

    schedule = []
    for chw in chws:
        profile = ACTIVITY_PROFILES[chw["activity"]]
        for week in range(weeks):
            expected = profile["avg_per_week"] * scale
            stddev = expected * profile["variance"]
            # Maturity ramp: 0.6× at week 0, 1.4× at last week
            maturity = 0.6 + (week / max(weeks - 1, 1)) * 0.8
            volume = max(0, round(gaussian(expected * maturity, stddev)))
            for _ in range(volume):
                # Day of week (Sun..Sat)
                dow_w = [0.5, 1.2, 1.2, 1.1, 1.1, 1.0, 0.7]
                r = random.random() * sum(dow_w)
                cum = 0
                dow = 0
                for d in range(7):
                    cum += dow_w[d]
                    if r < cum:
                        dow = d
                        break
                # Hour (work hours bias)
                hour_w = [0.05]*6 + [0.3, 0.7, 1.0, 1.3, 1.4, 1.5, 1.4, 1.3, 1.1, 1.0, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1]
                r2 = random.random() * sum(hour_w)
                cum2 = 0
                hour = 12
                for h in range(24):
                    cum2 += hour_w[h]
                    if r2 < cum2:
                        hour = h
                        break
                minute = random.randint(0, 59)
                second = random.randint(0, 59)
                # Timestamp
                days_ago_start_of_week = (weeks - 1 - week) * 7
                days_ago = days_ago_start_of_week + (6 - dow)
                base = datetime.now() - timedelta(days=days_ago)
                ts = base.replace(hour=hour, minute=minute, second=second, microsecond=0)
                schedule.append({"chw": chw, "ts": ts})
    return schedule


def cohort_attributes(topic, condition, severity, age_band, hiv_status):
    out = {}
    cond_l = condition.lower()
    if topic == "HIV":
        if "initiation" in cond_l or "testing" in cond_l:
            out["treatment_status"] = "naive" if random.random() < 0.3 else "pre_art"
        elif "defaulter" in cond_l:
            out["treatment_status"] = "defaulted"
            out["months_on_treatment"] = random.randint(6, 41)
        elif "prep" in cond_l:
            out["treatment_status"] = "prep_eligible"
        else:
            out["treatment_status"] = "on_art"
            out["months_on_treatment"] = random.randint(1, 60)
        if out["treatment_status"] == "on_art" and out.get("months_on_treatment", 0) >= 6:
            r = random.random()
            out["viral_load_band"] = "suppressed" if r < 0.78 else ("low_detectable" if r < 0.92 else "high")
        elif out["treatment_status"] == "defaulted":
            out["viral_load_band"] = "low_detectable" if random.random() < 0.3 else "high"
        else:
            out["viral_load_band"] = "unknown"
        if out["treatment_status"] == "on_art":
            out["regimen"] = "TLD" if random.random() < 0.85 else ("TLE" if random.random() < 0.7 else "second_line")
    elif topic == "TB":
        if "mdr" in cond_l or "resistant" in cond_l:
            out["treatment_status"] = "mdr_treatment"
            out["drug_resistance"] = "rifampicin_resistant"
        elif "screening" in cond_l or "suspect" in cond_l:
            out["treatment_status"] = "screening_only"
        elif "contact" in cond_l:
            out["treatment_status"] = "contact_tracing"
        else:
            out["treatment_status"] = "on_treatment"
            out["months_on_treatment"] = random.randint(1, 6)
        if hiv_status == "positive":
            out["tb_hiv_coinfected"] = True
    elif topic == "MNCH":
        if any(s in cond_l for s in ["antenatal", "anc", "pregnan", "danger"]):
            out["gestational_age_weeks"] = random.randint(6, 40)
            out["parity"] = random.randint(0, 4)
        elif "postpartum" in cond_l or "postnatal" in cond_l:
            out["weeks_postpartum"] = random.randint(1, 6)
        elif any(s in cond_l for s in ["child", "imci", "neonatal", "newborn"]):
            if age_band == "under_5":
                out["child_age_months"] = random.randint(0, 59)
    elif topic == "Nutrition":
        if "sam" in cond_l or "severe acute" in cond_l:
            out["muac_mm"] = random.randint(95, 119)
            out["bilateral_edema"] = random.random() < 0.2

    if topic == "HIV" and random.random() < 0.18:
        out["comorbidities"] = ["TB"]
    elif topic == "TB" and random.random() < 0.55:
        out["comorbidities"] = ["HIV"]

    if out.get("treatment_status") in ("on_art", "on_treatment"):
        r = random.random()
        out["adherence"] = "good" if r < 0.78 else ("fair" if r < 0.6 else "poor")
    return out


def age_band_from_condition(condition):
    c = condition.lower()
    if any(s in c for s in ["pediatric", "child", "under 5", "infant", "newborn", "baby", "neonatal"]):
        return "under_5"
    if "adolescent" in c:
        return "adolescent_15_19"
    if "older" in c or "elder" in c:
        return "older_adult_50plus"
    return "adult_20_49"


def pregnancy_from_condition(condition):
    c = condition.lower()
    if any(s in c for s in ["pregnan", "antenatal", "pmtct", "anc"]):
        return "pregnant"
    if "postnatal" in c or "postpartum" in c:
        return "postpartum"
    if "breastfeeding" in c:
        return "breastfeeding"
    return "unknown"


def hiv_from_topic(topic, condition):
    if topic == "HIV":
        return "positive" if random.random() < 0.85 else "negative"
    if "pmtct" in (condition or "").lower():
        return "positive"
    if topic == "TB":
        return "positive" if random.random() < 0.5 else "negative"
    return "unknown"


def main():
    print("")
    print(f"[hist] Seeding historical operational data:")
    print(f"       target: {TARGET_COUNT} conversations")
    print(f"       window: {WINDOW_DAYS} days ({math.ceil(WINDOW_DAYS / 7)} weeks)")
    print(f"       districts: {len(DISTRICTS)}, CHWs: 50")
    print(f"       refusal: {REFUSAL_RATIO * 100:.0f}%")
    print("")

    # Connect (creates schema if missing — same DDL as JS seeder)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL;")

    conn.executescript("""
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
    """)
    conn.commit()

    # Wipe existing historical rows
    cur = conn.cursor()
    cur.execute(f"SELECT id FROM conversations WHERE from_number LIKE '{FROM_PREFIX}%'")
    ids = [r[0] for r in cur.fetchall()]
    if ids:
        for i in range(0, len(ids), 500):
            batch = ids[i:i+500]
            placeholders = ",".join("?" * len(batch))
            cur.execute(f"DELETE FROM case_tags WHERE conversation_id IN ({placeholders})", batch)
            cur.execute(f"DELETE FROM conversations WHERE id IN ({placeholders})", batch)
        print(f"[hist] Wiped {len(ids)} existing historical rows.")
    conn.commit()

    chws = build_chw_roster()
    print(f"[hist] CHW roster: {len(chws)} workers across {len(DISTRICTS)} districts.")

    schedule = schedule_conversations(chws)
    print(f"[hist] Scheduled {len(schedule)} conversations.")

    inserted = 0
    refused = 0
    fallbacks = 0

    cur.execute("BEGIN")

    for item in schedule:
        chw = item["chw"]
        ts = item["ts"]
        ts_str = ts.strftime("%Y-%m-%d %H:%M:%S")
        input_type = "text" if random.random() < chw["text_voice_ratio"] else "voice"

        # Refusal
        if random.random() < REFUSAL_RATIO:
            r = random.choice(REFUSAL_SAMPLES)
            cur.execute("""
              INSERT INTO conversations
              (created_at, from_number, input_type, input_raw, transcribed_text,
               safety_outcome, retrieved_sources, response_text, response_warning, latency_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (ts_str, chw["from_number"], input_type, r["q"], r["q"], r["outcome"],
                  None, r["response"], None, random.randint(5, 54)))
            inserted += 1
            refused += 1
            continue

        # Topic per specialty
        profile = SPECIALTY_PROFILES[chw["specialty"]]
        topic = pick_weighted_dict(profile)
        pool = QUESTION_BANK.get(topic) or QUESTION_BANK["other"]
        sample = random.choice(pool)
        question = random.choice(sample["questions"])
        severity = pick_severity(sample["severity_weights"])

        is_fallback = sample.get("outcome") == "fallback_general_knowledge"
        is_oos = sample.get("outcome") == "out_of_scope_topic"
        outcome = "allowed"
        if is_fallback:
            outcome = "fallback_general_knowledge"
            fallbacks += 1
        elif is_oos:
            outcome = "out_of_scope_topic"

        sources_json = json.dumps(sample["sources"]) if sample.get("sources") else None

        cur.execute("""
          INSERT INTO conversations
          (created_at, from_number, input_type, input_raw, transcribed_text,
           safety_outcome, retrieved_sources, response_text, response_warning, latency_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (ts_str, chw["from_number"], input_type, question, question, outcome,
              sources_json, sample["response"], None, random.randint(1500, 2999)))
        conv_id = cur.lastrowid

        if is_fallback or is_oos:
            inserted += 1
            continue

        age_band = age_band_from_condition(sample["condition"])
        pregnancy = pregnancy_from_condition(sample["condition"])
        hiv_status = hiv_from_topic(topic, sample["condition"])
        cohort_attrs = cohort_attributes(topic, sample["condition"], severity, age_band, hiv_status)

        extraction = {
            "topic": topic,
            "condition": sample["condition"],
            "action_type": "protocol_surfaced",
            "severity": severity,
            "patient_age_band": age_band,
            "patient_pregnancy_status": pregnancy,
            "patient_hiv_status": hiv_status,
            "chw_id": chw["id"],
            "chw_name": chw["name"],
            "chw_specialty": chw["specialty"],
            **cohort_attrs,
            "_historical": True,
        }

        cur.execute("""
          INSERT INTO case_tags
          (conversation_id, created_at, topic, condition, action_type, severity,
           district, patient_age_band, patient_pregnancy_status, patient_hiv_status,
           raw_extraction)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (conv_id, ts_str, topic, sample["condition"], extraction["action_type"], severity,
              chw["district"], age_band, pregnancy, hiv_status, json.dumps(extraction)))
        inserted += 1

    conn.commit()

    print(f"[hist] Inserted {inserted} conversations ({refused} refused, {fallbacks} fallbacks).")

    # Sanity print
    n = cur.execute(f"SELECT COUNT(*) FROM conversations WHERE from_number LIKE '{FROM_PREFIX}%'").fetchone()[0]
    nt = cur.execute("SELECT COUNT(*) FROM case_tags WHERE raw_extraction LIKE '%_historical%'").fetchone()[0]
    print(f"[hist] Final counts: {n} conversations, {nt} case_tags.")

    print("[hist] Topic distribution:")
    for r in cur.execute("""
      SELECT topic, COUNT(*) FROM case_tags
      WHERE raw_extraction LIKE '%_historical%'
      GROUP BY topic ORDER BY 2 DESC""").fetchall():
        print(f"       {(r[0] or 'null'):14s} {r[1]}")

    print("[hist] District distribution:")
    for r in cur.execute("""
      SELECT district, COUNT(*) FROM case_tags
      WHERE raw_extraction LIKE '%_historical%'
      GROUP BY district ORDER BY 2 DESC""").fetchall():
        print(f"       {(r[0] or 'null'):20s} {r[1]}")

    print("[hist] Severity distribution:")
    for r in cur.execute("""
      SELECT severity, COUNT(*) FROM case_tags
      WHERE raw_extraction LIKE '%_historical%'
      GROUP BY severity""").fetchall():
        print(f"       {(r[0] or 'null'):12s} {r[1]}")

    conn.close()
    print("")
    print("[hist] Done. Restart the server to see populated dashboards.")


if __name__ == "__main__":
    main()
