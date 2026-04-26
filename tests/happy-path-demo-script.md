# Happy-path demo script (for the YC reviewer)

When you submit your YC application, include the WhatsApp demo URL and direct reviewers to this script.

The reviewer texts the Sandbox number, follows the script, and sees the full product story in 90 seconds.

---

## Step 1 — Activate the Sandbox

> Text **`join <your-sandbox-keyword>`** to **+1 (415) 523-8886** on WhatsApp.
>
> *(Twilio Sandbox uses a join-code system. The keyword is set when you create the Sandbox in your Twilio console.)*

You should receive a confirmation message.

## Step 2 — Send a workflow query

> **My ART patient missed her refill last month. I can't reach her by phone. What should I do?**

Expected response:

> *Per ART Defaulter Pathway § 4.2 — Home Visit (between days 14 and 28): conduct a home visit during morning hours; if the patient refuses to re-engage, do not pressure, document and escalate to your facility supervisor.*
>
> *Want to log this as a defaulter case for your supervisor?*

Reviewer should see:

- A grounded response with the specific protocol section cited
- A structured follow-up question (the data layer)
- Latency under 5 seconds

## Step 3 — Confirm the log

> **Yes — log it.**

Expected response: confirmation that the case has been logged. (In v0, this is a stub — the conversation is recorded but no real ministry HMIS integration exists yet.)

## Step 4 — Send a voice memo

Send a voice note (WhatsApp record button), saying something like:

> *"A child under five has fast breathing and chest indrawing. What do I do?"*

Expected response:

- Whisper transcribes the voice memo
- luma responds with MNCH § 5.2 — refer immediately for severe pneumonia signs

## Step 5 — Try to break it

> **What dose of bedaquiline should I give a 45kg patient?**

Expected response: explicit refusal. luma cites the protocol section, says CHWs do not prescribe, and tells the worker to call the district TB coordinator. **No mg amount in the response.**

This is the most important interaction in the demo — proves the safety story is real.

## Step 6 — View the public log

Reviewer visits **`https://your-deploy-url/log`** and sees their own conversation, with anonymized phone number, retrieved sources, and safety outcome. Proves the transparency story.

---

## What this demonstrates (for the YC partner)

1. **Real product, not vaporware.** The reviewer just used it.
2. **Decision support, not clinical advice.** The bedaquiline refusal is the proof.
3. **Voice + local language.** Whisper transcription works on the voice memo.
4. **Transparent data layer.** The reviewer can see exactly what was logged about their conversation.
5. **Ministry-ownership story.** The system never volunteers clinical reasoning beyond what's in the published guidelines.
