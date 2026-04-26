# luma — prototype

> **WhatsApp workflow assistant for community health workers.**
> A YC application prototype. Decision support, not clinical advice.
> Grounded in published Lesotho Ministry of Health protocols.

This repo is a working v0. Boot it with mocked APIs in 60 seconds; boot it with real APIs (Twilio + Anthropic + OpenAI) in 30 minutes. Demo URL goes in the YC application "demo" field.

---

## What's in here

```
luma-prototype/
├── server.js                      # Express + Twilio webhook + insights API
├── package.json
├── .env.example                   # Copy to .env and fill in keys
├── src/
│   ├── claude.js                  # Anthropic Claude grounded + fallback responses
│   ├── whisper.js                 # OpenAI Whisper voice transcription
│   ├── rag.js                     # In-memory vector retrieval over corpus/
│   ├── ingest.js                  # Build embeddings index from corpus/
│   ├── safety.js                  # Refusal patterns + post-LLM checks
│   ├── prompts.js                 # Grounded + fallback system prompts
│   ├── twilio.js                  # WhatsApp send + signature verify
│   ├── db.js                      # SQLite logging
│   ├── extractor.js               # Claude pass that tags conversations
│   └── projections.js             # Aggregator + Bayesian projection engine
├── corpus/                        # 11 ministry protocol scaffolds (~25K words)
│   ├── README.md                  # Corpus overview
│   ├── SOURCES.md                 # Public-source provenance
│   ├── art-defaulter-pathway.md
│   ├── art-initiation.md
│   ├── hiv-testing-counseling.md
│   ├── pmtct.md
│   ├── prep-prophylaxis.md
│   ├── tb-treatment-protocol.md
│   ├── mnch-referral-pathway.md
│   ├── childhood-immunization.md
│   ├── family-planning.md
│   ├── severe-acute-malnutrition.md
│   └── sti-screening.md
├── public/
│   ├── index.html                 # Landing page
│   ├── log.html                   # Public conversation dashboard
│   ├── insights.html              # Customer-facing insights dashboard
│   └── methodology.html           # Projection methodology page
├── tests/
│   ├── adversarial-prompts.md
│   └── happy-path-demo-script.md
├── scripts/
│   ├── setup.sh
│   ├── test-claude.js
│   └── test-adversarial.js
├── data/                          # SQLite + embeddings (gitignored)
├── render.yaml                    # Render deployment config
└── fly.toml                       # Fly.io deployment config
```

---

## Quick start (mocked APIs — 60 seconds, no accounts)

To verify the harness works without signing up for anything:

```bash
cd luma-prototype
npm install
USE_MOCK_APIS=true npm run ingest
USE_MOCK_APIS=true node scripts/test-claude.js
USE_MOCK_APIS=true ALLOW_UNSIGNED_REQUESTS=true npm start
```

Visit `http://localhost:3000/log` to see the dashboard. POST to `/webhooks/twilio/whatsapp` to simulate an inbound message:

```bash
curl -X POST http://localhost:3000/webhooks/twilio/whatsapp \
  -d "From=whatsapp:+12025550100" \
  -d "Body=My ART patient missed her refill last month. What should I do?" \
  -d "NumMedia=0"
```

You should get an `<Response/>` immediately, see a mock reply printed to console, and find the conversation logged in the dashboard.

---

## Real setup (30 minutes — sign up + paste keys)

### 1. Sign up for the three accounts (~20 min total)

| Account | Where | Why | Cost |
|---|---|---|---|
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) | Claude API for grounded responses | ~$3/mo prototype |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) | Whisper STT + embeddings for RAG | ~$2/mo prototype |
| **Twilio** | [console.twilio.com](https://console.twilio.com) | WhatsApp Sandbox for messaging | Free tier covers prototype |

For each: create an account, add billing, generate an API key. For Twilio, additionally:

1. Go to **Messaging → Try it out → Send a WhatsApp message**
2. Note the Sandbox phone number (looks like `+1 (415) 523-8886`) and the join keyword (looks like `join <some-words>`)
3. Configure the inbound webhook URL: **Messaging → Settings → WhatsApp Sandbox Settings**
   - "When a message comes in" → `https://<your-server>/webhooks/twilio/whatsapp` (POST)

### 2. Configure `.env`

```bash
cp .env.example .env
# Edit .env — fill in:
#   ANTHROPIC_API_KEY=sk-ant-...
#   OPENAI_API_KEY=sk-...
#   TWILIO_ACCOUNT_SID=AC...
#   TWILIO_AUTH_TOKEN=...
```

### 3. Build the embeddings index (one-time)

```bash
npm run ingest
```

This reads `corpus/*.md`, embeds each section via OpenAI, and writes `data/embeddings.json`. Takes ~30 seconds. One-time cost: ~$0.05.

### 4. Run locally

```bash
npm start
```

In a second terminal, expose your local server to Twilio with [ngrok](https://ngrok.com):

```bash
ngrok http 3000
```

Take the `https://xxx.ngrok.app` URL, append `/webhooks/twilio/whatsapp`, and paste it into your Twilio Sandbox webhook field.

### 5. Test on WhatsApp

1. Send `join <your-keyword>` to the Twilio number on WhatsApp
2. Then send: `My ART patient missed her refill last month. What should I do?`
3. You should get a grounded response within ~3 seconds, citing `ART Defaulter Pathway § 4.2`

---

## Deploy (when you're happy with it)

### Option A: Render (easier)

1. Push this repo to GitHub
2. In Render: **New + → Blueprint** → point to your repo
3. Render reads `render.yaml` and provisions everything
4. Set secrets in the Render dashboard: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL` (set to `https://<service-name>.onrender.com`)
5. Update Twilio webhook URL to your Render URL
6. Done. Costs ~$7/mo.

### Option B: Fly.io (cheaper, more control)

```bash
brew install flyctl   # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy --copy-config
fly secrets set \
  ANTHROPIC_API_KEY="sk-ant-..." \
  OPENAI_API_KEY="sk-..." \
  TWILIO_ACCOUNT_SID="AC..." \
  TWILIO_AUTH_TOKEN="..." \
  PUBLIC_BASE_URL="https://luma-prototype.fly.dev"
fly deploy
```

Both `render.yaml` and `fly.toml` are configured for **Frankfurt region**, which gives better latency for African testers than US-East.

---

## Architecture (one paragraph)

CHW (or YC reviewer) sends a WhatsApp message. Twilio webhooks our `/webhooks/twilio/whatsapp` endpoint. We immediately respond with `<Response/>` to acknowledge, then process asynchronously: if it's a voice memo, download from Twilio and transcribe via Whisper; run the input through hard-coded safety filters (refuses dosing requests, diagnostic questions, out-of-scope topics); embed the query and retrieve the top-3 most relevant protocol sections from the in-memory corpus. If the top retrieval score is above 0.45, build a **grounded** system prompt that anchors Claude to those protocol sections; otherwise build a **fallback** prompt that allows general WHO/public-health knowledge with a visible "⚠️ Not from your ministry protocols" disclaimer. Call Claude. Run the output through a post-check that verifies citations and scrubs unsafe dose recommendations. Send the response back via the Twilio REST API. Persist the entire interaction (transcript, retrieved sources, response, latency, mode) to SQLite. After the user gets their reply, kick off an async **extraction** pass that uses Claude Haiku to tag the conversation with structured fields (topic, condition, severity, demographics) into a `case_tags` table. The dashboards at `/log`, `/insights/*`, and `/methodology` read from SQLite and render the data publicly.

## Three-tier response system

| Tier | When | Behavior |
|---|---|---|
| **Hard refuse** | Dosing, diagnosis, drug interactions, pediatric pharmacology, out-of-scope topics (diabetes, surgery) | No LLM call. Returns refusal message. |
| **Grounded answer** | Top retrieval score ≥ 0.45 | Claude responds citing § X.Y of a corpus protocol. |
| **Soft fallback** | Passes safety, no good corpus match (top score < 0.45) | Claude responds from general WHO knowledge with a visible disclaimer. Logged with `fallback_general_knowledge` tag. |

## Endpoints

| URL | Purpose |
|---|---|
| `/` | Landing page |
| `/log` | Public conversation log (anonymized) |
| `/log.json` | Same data as JSON |
| `/insights/pharma` | Pharma RWE dashboard — disease burden, cascade signals, daily trends |
| `/insights/who` | WHO surveillance dashboard — severity distribution, district signals |
| `/insights/ministry` | Ministry operational dashboard — CHW network activity |
| `/methodology` | Projection methodology page (the math, the priors, the limits) |
| `/api/insights/pharma` | JSON API for pharma RWE consumers |
| `/api/insights/who` | JSON API for WHO/Africa CDC |
| `/api/insights/ministry` | JSON API for ministry |
| `/health` | Health check |
| `/webhooks/twilio/whatsapp` | Twilio inbound webhook (POST) |

## Data layer (the commercial wedge)

After every conversation logs, an async extractor pass uses Claude Haiku to tag the interaction with structured fields:

- **Topic**: HIV / TB / MNCH / FP / STI / Nutrition / Immunization / other
- **Condition**: e.g. "ART defaulter tracing", "antenatal danger sign", "severe acute malnutrition"
- **Action type**: protocol_surfaced, referral_recommended, case_logged, counseling_provided, refusal, fallback_general
- **Severity**: routine / urgent / emergency
- **Patient age band, pregnancy status, HIV status** — when surfaced in the conversation

These tags feed the **Bayesian projection engine** (`src/projections.js`) which combines sparse primary CHW data with published WHO/UNAIDS/PEPFAR priors for Lesotho to produce district- and country-level burden estimates with confidence intervals.

**Honest caveat at prototype scale**: with a handful of conversations, the posteriors are dominated by the priors. The dashboards display this transparently. The framework is what's real; the numbers become operationally useful only at scale (thousands of CHW interactions per week).

The methodology page (`/methodology`) documents:

- The Beta-Binomial conjugate update math
- The exact priors used for each indicator (with source years)
- What the prototype CAN claim and what it CANNOT (yet)
- How this scales to district-level posteriors with meaningful CIs in production

This is luma's commercial wedge: ministry-licensed primary data, combined with public priors, exposed as a programmatic API that pharma RWE teams pay for.

---

## Safety story (the part that matters for YC)

The single most important interaction in the demo is when a YC partner texts something like *"What dose of bedaquiline should I give a 45kg patient?"* and the prototype responds with a refusal — not a number. That refusal is the proof that the product framing survives scrutiny.

The safety layer has four parts:

1. **Pre-LLM filter** (`src/safety.js`) — hard-coded regex patterns catch dosing, diagnostic, and out-of-scope queries before any LLM is invoked. 17 adversarial test cases pass; run `node scripts/test-adversarial.js` to verify.
2. **Grounded system prompt** (`src/prompts.js`) — Claude is instructed to cite a protocol section in every response, refuse out-of-scope topics, never freeform clinical reasoning, and end with a structured logging follow-up. The prompt is the second line of defense after the regex filter.
3. **Post-LLM check** — if Claude somehow produces a freeform mg recommendation, the post-check scrubs it and returns a fallback. Belt and suspenders.
4. **Public log** — every interaction is publicly visible at `/log`. Reviewer transparency means we can't hide a bad output if one slips through.

---

## Cost estimate (per month, prototype scale)

| Item | Monthly cost |
|---|---|
| Twilio WhatsApp Sandbox | Free |
| Twilio outbound (~500 msgs) | ~$2.50 |
| Anthropic Claude (~1M tokens) | ~$3 |
| OpenAI Whisper (~60 min audio) | ~$0.50 |
| OpenAI embeddings (one-time, ~$0.05 to ingest) | trivial |
| Hosting (Render starter or Fly shared) | $0–$7 |
| Domain (optional) | $1 |
| **Total** | **~$10–15/mo** |

Can be left running indefinitely on <$200/year.

---

## What's next (after YC submission)

- **Replace scaffold corpus with official Lesotho MoH PDFs.** Current corpus is representative content based on WHO + national guidelines; for any real CHW use, swap in the actual ministry PDFs. See `corpus/README.md`.
- **Sesotho output.** v0 handles Sesotho voice **input** via Whisper (good); Sesotho text **output** is untested. Test with Claude in production and decide whether to add a translation layer or ship English-only.
- **Multi-turn context.** Single-turn for v0. Add 5-turn rolling memory once usage warrants.
- **Real ministry HMIS integration.** Currently SQLite-only. Swap for DHIS2 API once a ministry partnership formalizes.
- **First real CHW user.** Even one CHW in Lesotho using it for a week is a stronger YC signal than any prototype demo.
- **Production WhatsApp Business API approval.** Sandbox is fine for demos but requires reviewers to "join" the keyword. Production approval lets users start a conversation by clicking `wa.me/<number>`.

---

## Operational notes

- **Test database**: if `data/luma.db` accumulates noise from local testing, just `rm data/luma.db` and restart — it'll re-init on boot.
- **Re-running ingestion**: re-run `npm run ingest` whenever you change the corpus. It overwrites `data/embeddings.json`.
- **Logs**: `npm start` prints structured logs. In production, pipe to a real logging service (Render and Fly both ship logs by default).
- **Twilio Sandbox vs production**: the Sandbox is great for demos but reviewers must `join <keyword>` to opt in. For a public demo URL that doesn't require that, you need a production WhatsApp Business approval (Twilio → Senders → WhatsApp Senders → Apply). Takes 1–2 weeks.

---

## License

Private — luma application materials. Do not redistribute without permission.

---

*Built April 2026, by Seb Buck, with [Claude in Cowork mode](https://claude.com).*
