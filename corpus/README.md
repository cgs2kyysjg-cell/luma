# Corpus — ministry protocol documents

This directory contains the knowledge base luma retrieves from. Every grounded response from the agent is anchored in a specific section of one of these documents, cited by name and section number.

## Provenance

**Every document here is scaffold content** synthesized from publicly available WHO and national guidelines. None of them are direct copies of Lesotho Ministry of Health PDFs. See **[SOURCES.md](./SOURCES.md)** for the full list of public references each scaffold draws on, with URLs.

**Before any real CHW use**, scaffolds must be replaced with the current ministry-approved versions, with clinical advisory review.

## What's in the corpus (11 protocols)

| File | Topic | WHO source year |
|---|---|---|
| `art-defaulter-pathway.md` | ART missed-dose & defaulter tracing | 2021 |
| `art-initiation.md` | ART initiation under Treat-All | 2021 |
| `hiv-testing-counseling.md` | HIV Testing Services (HTS) | 2020 |
| `pmtct.md` | Prevention of Mother-to-Child Transmission | 2021 |
| `prep-prophylaxis.md` | Pre-Exposure Prophylaxis | 2021 |
| `tb-treatment-protocol.md` | TB treatment, DS-TB and MDR-TB pathways | 2017 / 2022 |
| `mnch-referral-pathway.md` | Maternal, newborn, child health referrals | 2016 / 2014 |
| `childhood-immunization.md` | EPI schedule and catch-up | 2024 |
| `family-planning.md` | Contraception counseling | 2022 |
| `severe-acute-malnutrition.md` | SAM identification and CMAM | 2013 |
| `sti-screening.md` | STI screening and syndromic management | 2021 |

Total corpus size: ~25,000 words across ~80 sections. In production, expect 50K–200K words per country once full ministry guidelines are loaded.

## Format

Each protocol is a Markdown file with:

- **YAML frontmatter** containing `title`, `source_organization`, `source_publication`, `source_year`, `source_url`, `scaffold_version`, and `scope`
- **`## Section N — Title`** headers that become the citation anchor (e.g. "§ 4.2")
- **`### Subsection`** headers for finer retrieval granularity
- Numbered procedural steps where applicable (`1.`, `2.`, `3.`)
- An explicit `## Section N — When to escalate` block per protocol with district-coordinator contact placeholders

## How retrieval works

`src/ingest.js` chunks each file at the `## Section` boundary, generates embeddings via OpenAI `text-embedding-3-small`, and writes them to `data/embeddings.json`. At query time, `src/rag.js` retrieves the top-3 chunks by cosine similarity and passes them into the Claude system prompt as grounded context.

## Three-tier response behavior

Not every CHW question will match a protocol section. luma uses a 3-tier response system:

1. **Hard refuse** — dosing requests, diagnostic asks, drug interactions, pediatric pharmacology, or topics out of CHW scope (diabetes, surgery). Caught by `src/safety.js` before any LLM call.
2. **Grounded answer** — query has a high-confidence corpus match (cosine ≥ 0.45). Claude responds with the protocol section cited.
3. **Soft fallback** — query passes safety but has no good corpus match. Claude responds using general WHO/public-health knowledge with a clear "⚠️ Not from your ministry protocols" disclaimer at the top of the response. Logged with a distinct `fallback_general_knowledge` tag for ministry-side review.

The fallback path means CHWs get useful answers to questions like "How long does HIV self-testing take to give a result?" even before that specific protocol is in the corpus — but the disclaimer makes the source visible. Every fallback response surfaces a "should we add a protocol for this?" signal that the ministry can act on.

## Extending the corpus

To add a new protocol:

1. Drop the markdown file in `corpus/` with proper YAML frontmatter
2. Add a row to this README's table
3. Add the source to `SOURCES.md`
4. Run `npm run ingest`
5. Restart the server

The new content is immediately available.

## Update cadence (production)

Protocols update — drugs change, regimens evolve, contact numbers move. Production deployment requires a quarterly re-ingestion cadence and ministry review board sign-off on each update.
