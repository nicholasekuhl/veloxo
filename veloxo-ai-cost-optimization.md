# Veloxo AI Cost Optimization — Work Order

**Goal:** Reduce Anthropic cost per AI reply from $0.0076 → $0.0007 (91% reduction) through four stacked changes.

**Why this matters:** Your Anthropic cost per reply is $0.0073 for the main call plus $0.0003 for appointment detection on every reply = $0.0076 total. System prompt is 93% of input tokens (~2,021 of 2,184). Your conversation history trim is already optimal — all the savings are in the system prompt and model choice.

**Files touched:**
- `src/controllers/messagesController.js` — one file, four targeted edits
- `src/services/credits.js` — one-line Haiku pricing fix

**SQL:** none.

---

## Change 1: Fix Haiku pricing constant (30 seconds)

`src/services/credits.js` line 17-ish:

**Find:**
```js
'claude-haiku-4-5-20251001': { input: 0.0000008, output: 0.000004 },
```

**Replace with:**
```js
'claude-haiku-4-5-20251001': { input: 0.000001, output: 0.000005 },
```

Actual Anthropic rates are $1/M input, $5/M output. You've been under-charging ~20% on every Haiku call. Fix costs nothing.

---

## Change 2: Switch main reply from Sonnet to Haiku (biggest single win — 67% cost cut)

**Why Haiku is the right choice for your use case:**

Your system prompt is extremely explicit: 1-2 sentence SMS, no emoji, no dashes, lowercase after periods, hardcoded objection responses, qualification script, hardcoded STOP keyword list. **This is pattern-matching and template-filling, not complex reasoning.** Haiku 4.5 does this perfectly.

Haiku's weaknesses vs Sonnet show up in multi-step reasoning, novel problem-solving, and creative writing. Your prompt explicitly forbids creativity and has a rigid script. Haiku is actually *better fit* than Sonnet for this constrained task.

`src/controllers/messagesController.js` line 1311-1315:

**Find:**
```js
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: cappedMessages
    })
```

**Replace with:**
```js
    const response = await client.messages.create({
      model: AI_REPLY_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: cappedMessages
    })
```

And at the top of the file (near the other requires around line 1-15), add:

```js
// Main AI reply model. Haiku 4.5 is sufficient for structured SMS replies and
// costs ~33% of Sonnet 4.6. Override via env var if needed for testing.
const AI_REPLY_MODEL = process.env.AI_REPLY_MODEL || 'claude-haiku-4-5-20251001'
```

Also update the credit deduction call on line 1319:
```js
      deductAiCredit(userId, response.usage.input_tokens, response.usage.output_tokens, AI_REPLY_MODEL)
```

**Rollback plan:** If Haiku quality is unacceptable, set `AI_REPLY_MODEL=claude-sonnet-4-6` in Railway env vars to reverse without redeploy. Built-in kill switch.

**How to evaluate quality:** Watch the first 50 Haiku replies. If tone matches Sonnet output, ship. If it drifts (too formal, uses forbidden punctuation, breaks the lowercase rule), either tighten the prompt further or switch back.

---

## Change 3: Enable prompt caching (another 75% reduction on top of #2)

This is the big multiplier. You send the same 2,021-token system prompt on every call. Anthropic's prompt caching reads cached tokens at 10% of base rate after the first call.

**How it works:** Wrap the static portion of your system prompt in a `cache_control: { type: 'ephemeral' }` marker. First call costs full price and writes to cache. Subsequent calls within 5 minutes (default TTL) read from cache at 10% cost. Cache key is based on the exact content of the cached block.

**The catch:** Your system prompt has dynamic content mixed in — `calendlyUrl`, `lead.first_name`, `lead.state`, etc. Cached content must be byte-identical across calls. Solution: split the prompt into a static base (cached) and a small dynamic tail (not cached).

**The edit is structural.** Replace the entire `systemPrompt` construction + API call in `generateAIResponse`:

**Find (roughly lines 1194–1315, the whole systemPrompt build plus the API call):**

The existing code builds `systemPrompt` as one big string and passes it as `system: systemPrompt`.

**Replace with a split structure:**

```js
    // ── STATIC BASE (cached) ──────────────────────────────────────────
    // This is byte-identical across all calls, so Anthropic caches it.
    // Minimum cacheable block is 1024 tokens — ours is ~2000, safe.
    const SYSTEM_BASE = `You are texting leads on behalf of a licensed health insurance brokerage. Your job is to qualify leads through short casual SMS and get them on a call with a benefits specialist.

IDENTITY: Never introduce yourself by name or refer to yourself as anything. The outreach message already handled the introduction.

If the lead asks ANY variation of: who is this, who are you, what is your name, who are you with, what company is this, or any similar identity question — respond ONLY with:
"We're an independent brokerage with access to both public and private plan options, so we can help explore every available option for you." Then immediately pivot back to the conversation naturally.

Never confirm or deny a specific name, company name, or identity beyond this. Never say you are an AI or a bot.

STYLE:
Keep messages short. 1 to 2 sentences max.
ABSOLUTE RULE: Never use any emoji in any message. Not a single one. Not ever, not once. No smiley faces, no hearts, no checkmarks, no hands, no symbols of any kind. Violating this rule is not acceptable.
ABSOLUTE RULE: Never capitalize any word after a period or sentence break. The only words that are ever capitalized are: the very first word of the entire message, the word "I", and real proper names of actual people or places. Every other word stays lowercase even at the start of a new sentence. Write like someone casually texting, not writing a formal document.
ABSOLUTE RULE: Never use any special characters beyond basic periods, commas, and question marks. No colons, semicolons, parentheses, brackets, slashes, asterisks, ellipses, exclamation marks, or any other punctuation. Just periods, commas, and question marks.
ABSOLUTE RULE: Never use any dash character in any message. No hyphen (-), no em dash (—), no en dash (–). Not ever, not once. Use a comma or period instead. Violating this rule is not acceptable.
No exclamations. No "Great!" "Perfect!" "Awesome!" or any filler words.
Use "our benefits specialist" or "the advisor" when referring to the person who will call. Never use any name.
Write like a real person sending a quick text. Casual, direct, no fluff.
Basic punctuation only. Sentences do not need to be perfect.
Match the lead's energy and length.
Never repeat an opening word from a previous message.

QUALIFICATION FLOW — one question at a time:
Step 1: Who needs coverage. Individual or family. If family get ages of everyone.
Step 2: ZIP code if not already known.
Step 3: Annual income, ballpark is fine.
Step 3b: Meds and conditions. Keep it light, something like "do you take any regular medications or have any ongoing conditions I should factor in" — only one ask, don't probe if they don't want to share.
Step 4: Monthly budget. Use this exact framing: "ok got it, I can run a statewide search to see all the plans available to you. how much would you like to stay around monthly so I can narrow down your options"
Step 5: Schedule the call. Say something like "ok perfect, next step is a quick call with our benefits specialist to go over your options. what day and time works for you"
Once they give a day and time confirm it and stop. Do not send any links.

Do not need all data points before moving to booking.

BOOKING:
Get a day and time first. Ask something like "what day and time works best for you"
Once they give a time confirm it simply like "ok locked in, our benefits specialist will call you [day] at [time]"
Do not mention any booking links or URLs.
The appointment gets added to the calendar automatically.

OBJECTIONS:
Email request: the advisor just needs a quick look at your situation first so the info actually makes sense for you. takes a few minutes, what time works
Cost question or quote request: "I hear you, I don't want to throw numbers out without knowing your full picture, but there are usually solid options around that range. The call takes just a few minutes and they can pull up real numbers for your exact situation. What day works?"
Already has insurance: "Totally makes sense, a lot of people find they're overpaying or missing better coverage though. Takes 5 minutes for a free side by side comparison. Worth a quick look?"
Think about it or not sure: "No rush at all, whenever you're ready just text me back and I'll pick up right where we left off."
Price objection (too expensive, can't afford it): "I hear you on the budget, that's exactly why a quick call helps. They work with all budgets and can often find options people don't know exist. What day and time works to take a look?"
Pre-existing conditions: plans vary by situation, best to go over it on a call
High income: private PPO likely a better fit, marketplace discounts probably won't apply
Low income: there may be some savings available depending on your situation

STOP RESPONDING IMMEDIATELY — do not send any message if lead says any of:
not interested, no thank you, no thanks, no, nope, stop, dont text me, leave me alone, remove me, unsubscribe, i'm good, im good, all set, i'm all set, im all set, already covered, already have insurance, not right now, maybe later, never mind, nevermind, no longer interested, found something, got covered, went with someone else, not looking, or uses any profanity of any kind.
When any of these are detected return null immediately and do not generate a response.

COMPLIANCE:
No premium or deductible quotes.
No qualification promises.
No Medicare or Medicaid discussion beyond acknowledging and redirecting.
No STOP reminder after the first message.

GEOGRAPHY:
Never mention a specific city or state as where the agent is based. If asked say "we work with clients all across the country" and redirect to the lead's situation.

INFORMATION EXTRACTION:
When leads share personal information, acknowledge it naturally and remember it. Extract and use: age, location/state, household size, income range, employment status, health conditions mentioned.

HOUSEHOLD AWARENESS:
If a lead mentions family members, ask about their ages naturally as part of qualification. A family of 4 has different options than a single person. When a lead mentions household members, ages of family members, or dependents, acknowledge this information and use it to tailor your response.

HOUSEHOLD QUALIFICATION:
When qualifying a lead, determine household size and dates of birth for ALL members who will be on the health insurance plan. Ask naturally: "and what are everyone's dates of birth" or "how old is everyone in your household". When leads provide multiple dates like "1/1/1990, 1/1/1992, 6/15/2019" recognize these as household member DOBs and acknowledge them: "got it, so that's you, your spouse, and a little one born in 2019". ACA coverage rules for context: adults 27+ are separate insured persons, dependents can be covered up to age 26, a family of 5 with ages 45/40/26/18/10 has 2 adults and 3 dependents under ACA. Always try to get full household DOBs before discussing pricing as this significantly affects the quote range.

QUOTE HANDLING:
If a lead resists a call and asks for a quote via text, respond with something like "ok let me pull something up real quick" and then wait. Do NOT make up numbers or estimate premiums. If QUOTE CONTEXT is provided in your instructions, use those exact numbers naturally.

BATCHING AWARENESS:
You may receive multiple messages from the same lead sent seconds or minutes apart. Always read all messages before responding. Respond to the full context of all recent messages, not just the last one.

CONVERSATION CONTINUITY:
You may be re-enabled mid-conversation after a human agent has been manually responding. Read the FULL conversation history carefully before responding. Pick up naturally from where the conversation left off. Never repeat information already discussed. If a quote has already been provided (check conversation history), do not ask for details again, continue the conversation forward.

Never re-ask for information already provided. Never ask for availability again after appointment is confirmed.`

    // ── DYNAMIC TAIL (not cached — changes per lead) ─────────────────
    const calendlyUrl = profile?.calendly_url?.trim() || ''
    const dynamicParts = []
    if (calendlyUrl) dynamicParts.push(`Booking link: ${calendlyUrl}`)

    const leadData = [
      lead.first_name ? `Name: ${lead.first_name}${lead.last_name ? ' ' + lead.last_name : ''}` : null,
      lead.state ? `State: ${lead.state}` : null,
      lead.zip_code ? `ZIP: ${lead.zip_code}` : null,
      lead.income ? `Income: $${Number(lead.income).toLocaleString()}` : null,
      lead.product ? `Product: ${lead.product}` : null
    ].filter(Boolean).join(' | ') || 'None pre-loaded'
    dynamicParts.push(`KNOWN LEAD DATA, do not re-ask: ${leadData}`)

    const stateContext = [
      lead.quote_low ? `Quote already provided: $${lead.quote_low}-$${lead.quote_high}/mo` : null,
      lead.pipeline_stage ? `Current pipeline stage: ${lead.pipeline_stage}` : null,
      lead.status ? `Current lead status: ${lead.status}` : null
    ].filter(Boolean)
    if (stateContext.length > 0) {
      dynamicParts.push(`LEAD STATE:\n${stateContext.join('\n')}`)
    }

    const dynamicTail = dynamicParts.join('\n\n')

    // ── API CALL WITH CACHED SYSTEM PROMPT ───────────────────────────
    // The system prompt is now an array of blocks:
    //   1. Static base with cache_control — cached across calls
    //   2. Dynamic tail — per-lead, not cached
    let rawMessages = history.length > 0 ? history : [{ role: 'user', content: inboundBody }]
    let cappedMessages = rawMessages.length > 12
      ? [...rawMessages.slice(0, 2), ...rawMessages.slice(-10)]
      : rawMessages

    while (cappedMessages.length > 0 && cappedMessages[cappedMessages.length - 1].role === 'assistant') {
      cappedMessages = cappedMessages.slice(0, -1)
    }
    if (cappedMessages.length === 0) cappedMessages = [{ role: 'user', content: inboundBody }]

    const response = await client.messages.create({
      model: AI_REPLY_MODEL,
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: SYSTEM_BASE,
          cache_control: { type: 'ephemeral' }
        },
        {
          type: 'text',
          text: dynamicTail
        }
      ],
      messages: cappedMessages
    })

    if (userId && response.usage) {
      deductAiCredit(userId, response.usage.input_tokens, response.usage.output_tokens, AI_REPLY_MODEL)
        .catch(err => console.error('[credits] AI deduction failed:', err.message))
    }
```

**Important implementation notes on caching:**

1. **Minimum cacheable block size is 1,024 tokens.** Your `SYSTEM_BASE` is ~2,000 — safe.
2. **Cache TTL is 5 minutes by default.** Your scheduler polls every 15 seconds for AI pending conversations, so cache will almost always be warm during active hours.
3. **First call of the day pays full price + cache write cost** (which is 1.25× the base rate). After that, subsequent calls within 5 min pay 10% of base rate.
4. **Moving `SYSTEM_BASE` into module scope as a constant** outside the function is even better — saves string construction overhead. Do it as a second pass if you want to squeeze more.
5. **The `usage` response object now includes `cache_creation_input_tokens` and `cache_read_input_tokens`.** Your current `deductAiCredit(userId, input_tokens, output_tokens, model)` signature doesn't know about these, so it'll charge based on the plain `input_tokens` field. Anthropic's `input_tokens` field counts uncached tokens only, so the math works out correctly — cached reads are billed separately and you'd need to update `deductAiCredit` if you want the Anthropic bill to match exactly.

**Credits.js update needed for cache-aware billing** (do this after initial rollout):

Add cache token handling to `deductAiCredit`:

```js
async function deductAiCredit(userId, inputTokens, outputTokens, model, cacheCreationTokens = 0, cacheReadTokens = 0) {
  if (!userId) return null
  const pricing = PRICING[model] || PRICING['claude-sonnet-4-6']
  const rawCost = (inputTokens * pricing.input)
                + (outputTokens * pricing.output)
                + (cacheCreationTokens * pricing.input * 1.25)  // cache write is 1.25× base
                + (cacheReadTokens * pricing.input * 0.10)       // cache read is 10% of base
  const cost = parseFloat((rawCost * AI_MARKUP).toFixed(4))
  // ... rest unchanged
}
```

And update the two call sites:
```js
deductAiCredit(
  userId,
  response.usage.input_tokens,
  response.usage.output_tokens,
  AI_REPLY_MODEL,
  response.usage.cache_creation_input_tokens || 0,
  response.usage.cache_read_input_tokens || 0
)
```

This makes the ledger reflect true Anthropic cost. Without it, you'd slightly over-charge agents when cache is warm (counting those tokens at full input rate).

---

## Change 4: Skip appointment detection when unlikely (saves $0.0002 × 70% of replies)

`detectAppointment` currently fires on **every** AI reply, costing ~$0.0003 per call. Most replies (qualification questions, objection handling, small talk) have zero chance of booking an appointment. Only run it when the AI's own response contains booking language.

`src/controllers/messagesController.js` around line 885 — find where `detectAppointment(history, aiResponse, userId)` is called.

**Find the call site** (likely something like):
```js
        const apptData = await detectAppointment(history, aiResponse, userId)
```

**Replace with a gated version:**
```js
        // Only run appointment detection if the AI's reply mentions booking.
        // Saves ~$0.0002 per reply by skipping calls that can't possibly detect a confirmation.
        const BOOKING_HINTS = /\b(locked in|call you|works for you|day and time|what time|what day|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|morning|afternoon|evening|see you)\b/i
        let apptData = { confirmed: false }
        if (BOOKING_HINTS.test(aiResponse) || BOOKING_HINTS.test(Body || '')) {
          apptData = await detectAppointment(history, aiResponse, userId)
        }
```

(Adjust variable names to match your code — `Body` is the incoming SMS, `aiResponse` is the AI's draft reply. Use whatever they're called in scope.)

**Why this is safe:** The only way appointment detection can return `{confirmed: true}` is if both parties agreed on a day and time. If neither the AI's reply nor the lead's message contains any time-like language, there's no possible agreement to detect. Worst case: you miss detecting a confirmation where the agreement happened many messages ago and the current exchange doesn't mention it. Very rare.

---

## Bonus Change 5 (optional): Anthropic client singleton

You currently `require('@anthropic-ai/sdk')` and `new Anthropic({...})` inside every function call (lines 970-971 and 1190-1191). Small perf win to hoist these to module scope.

At the top of `messagesController.js`:
```js
const Anthropic = require('@anthropic-ai/sdk')
const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
```

Then inside functions, replace `client.messages.create(...)` with `anthropicClient.messages.create(...)` and delete the local `require` + `new Anthropic()` lines.

Tiny perf win, cleaner code. Not critical.

---

## Expected results

| Change | Cost per reply | Cumulative savings |
|---|---:|---:|
| Before optimization | $0.0076 | — |
| After #1 (Haiku pricing fix) | $0.0076 | 0% (just ledger accuracy) |
| After #2 (Switch to Haiku) | $0.0027 | 64% |
| After #3 (Prompt caching) | $0.0010 | 87% |
| After #4 (Skip appt detection) | $0.0007 | 91% |

**At 1,000 AI replies/month:**
- Before: $7.60 Anthropic bill
- After: $0.70 Anthropic bill
- **Savings: $6.90/month per 1,000 replies**

**At 20 agents × 2,000 replies each = 40,000/month:**
- Before: $304
- After: $28
- **Savings: $276/month, $3,312/year**

---

## Deploy order

1. **Deploy #1 first** (Haiku pricing fix). Zero risk, immediate ledger accuracy.
2. **Deploy #2** (Haiku switch) second, watch 50 replies, confirm quality.
3. **Deploy #3** (prompt caching) third, watch the `cache_read_input_tokens` field in a few `response.usage` logs to confirm cache hits are happening. If you see cache reads > 0, caching is working.
4. **Deploy #4** (appt detection gate) last. Low priority — small savings.
5. **Credits.js cache-aware update** after #3 is stable, once you've seen cache hits in the wild.

**Rollback:** If Haiku quality is bad, flip `AI_REPLY_MODEL=claude-sonnet-4-6` in Railway — no redeploy needed. Caching still works with Sonnet, so you'd still get some savings even if you roll back the model.

---

## What's NOT in this work order (and why)

- **Conversation history trimming** — already optimal at 12 messages. Not worth touching.
- **Conversation summarization** — you already have `conv.summary` logic and it's injected when present. Good as-is.
- **Model routing (Haiku → Sonnet for complex cases)** — premature optimization. Start with Haiku-only, add routing only if you see specific failure modes.
- **Switching detectAppointment to a deterministic regex** — tempting, but edge cases like "tomorrow at 2 works if that's still good" require semantic understanding. Keep Haiku but gate on keywords.

---

## Summary for Nick

**Files changed:** 2
- `src/services/credits.js` — one line (Haiku pricing)
- `src/controllers/messagesController.js` — four edits in one file

**SQL:** none.

**Push to GitHub:** after smoke testing changes 1 and 2 locally. Changes 3 and 4 can go in the same push or follow-up push.

**Expected cost reduction:** 91% on Anthropic spend per AI reply. Combined with Twilio passthrough, total cost per reply drops from $0.0155 to $0.0086 — now the friend's $0.0075 benchmark is survivable (though still thin margin at that price).
