# Claude Rules — Read Before Every Task

Read and follow ALL of these rules for every
task in this session without exception.
These rules take priority over everything else.

## RULE 0: READ FILES SELECTIVELY
Read ONLY the specific files mentioned in
each task. Do not read the entire codebase
unless explicitly asked to.
Only read additional files if directly
needed to complete the specific task.

## RULE 1: NO PERSONAL OR SPECIFIC DATA
Never use specific real names, company names,
vendor names, or personal data anywhere in
the codebase as placeholder, example, or
default values.

Veloxo operates under Kuhl Technologies LLC.
Cornerstone Legacy Group LLC (Coverage by Kuhl)
is a separate insurance agency — never
conflate the two.

BANNED — never appear anywhere in code:
- "Dynasty", "Redmedia", "Gold Bars", "30 EXL"
- "Nick Kuhl", "Nicholas Kuhl", "Nick"
- "Coverage by Kuhl", "Cornerstone Legacy Group"
- "Kuhl Technologies" (use generic or env vars)
- Any email containing "kuhl" or "coveragebykuhl"
- "+15614805670", "+15616526496"
- "USHA", "USHealth", "US Health Advisors"
- "Vanessa" as a default agent name

REPLACE ALL with generic versions:
- Campaign names: "My First Campaign",
  "Follow Up Sequence", "Outreach Campaign A"
- Disposition tags: "Hot Lead",
  "Not Interested", "Callback Requested"
- Agent name: "Your Name"
- Agency name: "Your Agency Name"
- Email: "you@youragency.com"
- Phone: "+1 (555) 000-0000"
- Bucket names: "New Leads", "My Bucket"
- Sample lead names: "Jane Smith", "John Doe",
  "Sarah Johnson", "Mike Williams"
- Sample phone: "+1 (555) 000-0001"
- Sample email: "jane.smith@email.com"

## RULE 2: FILE ORGANIZATION
The public/ directory is split into separate
page files. Never create a monolithic index.html.

Existing page files (do not duplicate):
- public/landing.html (marketing landing page)
- public/login.html, signup.html
- public/request-access.html, invite.html
- public/onboarding.html, tos-required.html
- public/reset-password.html, suspended.html
- public/leads.html (leads list)
- public/lead.html (lead profile detail)
- public/conversations.html
- public/campaigns.html
- public/dispositions.html
- public/drips.html
- public/templates.html
- public/buckets.html
- public/pipeline.html
- public/calendar.html
- public/stats.html
- public/settings.html
- public/admin.html
- public/archive.html
- public/billing.html
- public/lead-vendors.html
- public/bracket.html (sales tournament, separate feature)

Shared code lives in:
- public/js/shared.js (sidebar, auth, toast,
  notifications, renderSidebar function)
- public/css/shared.css (design system,
  CSS variables)
- public/toast.js

SIDEBAR RULE:
The sidebar is rendered via renderSidebar()
in public/js/shared.js and injected into
every page. Never hardcode sidebar HTML
in individual page files. If adding new
nav items update shared.js only.

ADDING TO EXISTING FILES:
Add to existing page file if feature belongs
to that page and adds under 200 lines.

CREATING NEW FILES:
Create new file if feature:
- Is a full page experience
- Has its own navigation entry
- Would make existing file exceed 1000 lines
- Serves a completely different workflow

FILE SIZE LIMIT:
If any file exceeds 1000 lines tell me
what needs splitting before proceeding.

NEVER duplicate shared code across files.

## RULE 3: DATABASE PERFORMANCE
Whenever adding a new table or column used
in WHERE, ORDER BY, or JOIN, automatically
add the appropriate index in the same SQL block.

Always use this pattern:
CREATE INDEX IF NOT EXISTS idx_[table]_[column]
  ON [table](user_id, [column]);

Always:
- Use IF NOT EXISTS
- Put user_id first in composite indexes
- Add indexes in same block as CREATE/ALTER TABLE
- Use partial indexes when filtering on status
  (e.g. WHERE status = 'pending')

Standard indexes to always add:
- Every foreign key column
- Every filter column (status, is_sold, etc)
- Every sort column (created_at, scheduled_at)
- Every lookup column (phone, email, twilio_sid)

For counter columns that multiple processes
increment (e.g. outbound_initiated_today,
sent_today, balance), use atomic Postgres
functions via supabase.rpc() — never
read-modify-write from Node code.
Existing atomic RPCs:
- deduct_credit(user_id, amount, type, description)
- bump_outbound_initiated(lead_id)
- add_household_member(lead_id, user_id, dob)
- check_phone_rate_limit(phone_number, max_per_minute)
- increment_message_count(conv_id)
- increment_sent_today(phone_number)

## RULE 4: NEVER BREAK EXISTING FUNCTIONALITY
Before making any changes:
1. Read all relevant files first
2. Identify what is already working
3. Make surgical changes only
4. Never rewrite working code from scratch
5. If full rewrite needed explain why
   and wait for confirmation

## RULE 5: SQL CONFIRMATION
Never assume SQL has been run in Supabase.
When task requires database changes:
1. Output all SQL clearly labeled
2. Tell me to run it in Supabase SQL editor
3. Wait for my confirmation before writing
   any code that depends on new columns or tables

## RULE 6: MASTER TWILIO ONLY
Never add per-user Twilio credentials.
All SMS sending uses master credentials:
- process.env.TWILIO_ACCOUNT_SID
- process.env.TWILIO_AUTH_TOKEN
From number comes from user's phone_numbers
table record only.
Never read Twilio credentials from user_profiles.
FORWARDING_NUMBER = process.env.FORWARDING_NUMBER
Used only for agent notification texts.

Phase 5 will migrate to Telnyx ISV with
per-user subaccounts. Until then, master only.

## RULE 7: DATABASE COLUMN NAMES
The leads table uses these exact column names:
- 'phone' NOT 'phone_number'
- 'zip_code' NOT 'zip'
- 'product' NOT 'plan_type'
- 'user_id' for owner
- 'bucket_id' for bucket assignment
- 'previous_bucket_id' for sold-bucket rollback
- 'is_sold', 'is_blocked', 'is_cold' booleans
- 'autopilot' boolean
- 'opted_out' boolean
- 'opted_out_at' timestamp
- 'do_not_contact' boolean (DNC-flagged)
- 'first_message_sent' for compliance footer
- 'first_message_sent_at' timestamp
- 'deleted_at' for soft delete
- 'engagement_status' for ghost tracking
- 'lead_tier' ('priority' or 'standard')
- 'queued_at' timestamp (priority queue)
- 'skip_until' timestamp (pause sends today)
- 'last_called_at', 'last_contacted_at'
- 'pipeline_stage', 'pipeline_stage_set_at'
- 'pipeline_ghosted', 'pipeline_ghosted_at'
- 'outbound_initiated_today' (TCPA daily counter)
- 'quote_low', 'quote_high', 'quoted_at'
- 'household_size' (maintained by DB trigger)
- 'has_replied' boolean

The conversations table has these columns:
- 'user_id', 'lead_id' (unique pair)
- 'is_starred' for favorites
- 'needs_agent_review' for handoff flag
- 'handoff_reason' for handoff type
- 'consecutive_followups' for follow-up count
- 'appointment_confirmed' boolean
- 'appointment_id' FK to appointments
- 'last_inbound_at' timestamp
- 'last_outbound_at' timestamp
- 'followup_count' integer
- 'followup_stage' text
- 'scheduled_followup_at' timestamp
- 'engagement_status' text
- 'quote_push_count' integer
- 'unread_count' integer
- 'ai_pending_at' timestamp (AI debounce flag)
- 'archived_at' timestamp (nightly archive)
- 'message_count' integer (bumped via RPC)
- 'from_number' (which Twilio number)
- 'summary' (post-archive summary)
- 'status' ('active', 'closed', etc.)

The messages table:
- 'conversation_id', 'user_id'
- 'direction' ('inbound', 'outbound', 'system')
- 'body', 'sent_at', 'status', 'is_ai'
- 'twilio_sid', 'error_code', 'error_message'
- 'from_number' (added in migration — populate
  at every insert to support violation tracking)

Always verify column names before writing
queries against existing tables. When in
doubt, ask before guessing.

## RULE 8: VISUAL CONSISTENCY
All new UI components must use existing
CSS variables from shared.css.
Never hardcode colors, shadows, or border radius.

Always use:
- var(--color-primary) not #6366f1
- var(--shadow-md) not box-shadow: 0 4px...
- var(--radius-md) not border-radius: 10px
- var(--color-border) not #e2e8f0
- var(--color-text-secondary) not #475569
- var(--space-4) not padding: 16px

New cards: white bg, shadow-md, radius-md
New buttons: use .btn-primary or .btn-secondary
New badges: use .badge class with color modifier
New modals: use existing .modal class structure
New tables: use existing .table class structure

Dark mode uses CSS variables with localStorage
persistence. Any new component that renders
color must work in both light and dark.

If a new component needs a style not in shared.css
add it to shared.css as a reusable class.
Never add one-off inline styles.

## RULE 9: AI SYSTEM PROMPT RULES
When modifying the AI system prompt in
src/controllers/messagesController.js:

Always inject known lead data BEFORE conversation
history so the AI never re-asks for info already
known:
- lead.first_name, last_name, phone
- lead.zip_code, state, email, date_of_birth
- Mark fields as 'unknown' if null

Always use agent_nickname if set, otherwise
first name from agent_name.split(' ')[0]

Never use agent full name in casual conversation.

After appointment confirmed the AI must stop
qualifying — send one closing message maximum.

AI response typing delay is 12–75 seconds,
scaled by word count. The delay is implemented
by inserting into scheduled_messages with a
future send_at — NOT via setTimeout. Do not
revert this to a setTimeout: the DB-backed
delay survives deploy restarts. Do not remove.

AI-typed SMS output has strict formatting rules
that are hard-coded in the system prompt:
- Never use emojis
- Never use em-dashes, en-dashes, or hyphens
- Never use exclamation marks, colons,
  semicolons, parentheses, brackets, asterisks
- Never capitalize after a sentence break
  (only first word, "I", and proper nouns)
- Keep replies 1–2 sentences
- Match the lead's energy and length

## RULE 10: COMPLIANCE
Quiet hours and daily send caps are enforced
in src/compliance.js. Never hardcode hours
in individual files — always call:
- isWithinQuietHours(leadState, leadTimezone)
  → returns { blocked, reason }
- checkSystemInitiatedLimit(leadState,
    outbound_initiated_today)
  → returns { blocked, reason }
- getNextSendWindow(leadState, leadTimezone)
  → returns ISO timestamp

State rules vary: FL/OK/MD/WA/NJ are 8am–8pm,
Texas has Sunday-noon restrictions, AL/LA/SD
block Sundays entirely. See STATE_RULES in
compliance.js for the full table.

FL, OK, and MD have a 3-per-day
system-initiated cap that applies to
campaigns, drips, and ghost follow-ups —
but NOT to AI conversational replies or
manual agent replies (those are reactive,
not system-initiated).

## RULE 11: AFTER EVERY TASK TELL ME
1. Which files were changed
2. What SQL needs to be run (if any)
3. Whether to push to GitHub now or wait

## QUICK REFERENCE — FILE LOCATIONS

Frontend pages: (see Rule 2 for full list)

Shared:
- JS utilities: public/js/shared.js
- CSS design system: public/css/shared.css
- Toast system: public/toast.js

Backend entries:
- Web server: src/server.js
- Worker entry: src/worker.js
- All scheduled jobs: src/scheduler.js

Backend core:
- Supabase client: src/db.js
- Twilio helpers: src/twilio.js
- SMS queue (multi-lane): src/smsQueue.js
- Compliance rules: src/compliance.js
- Pipeline detection: src/pipeline.js
- Area code to state: src/areaCodes.js
- Spintext: src/spintext.js
- Notifications: src/notifications.js

Backend services:
- Credits ledger: src/services/credits.js

Backend utils:
- DNC check: src/utils/dncCheck.js
- Message count: src/utils/messageCount.js
- Email helper: src/utils/email.js

Middleware:
- JWT auth: src/middleware/auth.js

Routes (src/routes/):
admin.js, advisor.js, apiLeads.js,
appointments.js, auth.js, bracket.js,
buckets.js, campaigns.js, conversations.js,
credits.js, dispositions.js, drips.js,
leadVendors.js, leads.js, messages.js,
notifications.js, numbers.js, phoneNumbers.js,
scheduledMessages.js, stats.js, tasks.js,
templates.js

Controllers (src/controllers/):
One per major route (15 controllers).

## QUICK REFERENCE — KEY PATTERNS

Creating a notification:
createNotification(userId, type, title, body,
  leadId, conversationId)
Types: 'inbound_message', 'hot_lead',
  'lead_ghosted', 'campaign_reply',
  'quote_requested', 'appointment_booked'

Sending SMS (always use master credentials):
sendSMS(to, body, fromNumber)
fromNumber comes from phone_numbers table via:
- pickNumberForLead(phoneNumbersArray, leadState)
  when you already have the array in memory
- getNumberForLead(userId, leadState)
  when you need to query the DB

Deducting credits (atomic, never read-modify-write):
const { data } = await supabase.rpc('deduct_credit', {
  p_user_id, p_amount, p_type, p_description
})

Bumping outbound_initiated_today (atomic):
await supabase.rpc('bump_outbound_initiated', {
  p_lead_id: lead.id
})

Engagement status values:
'active', 'ghosted_mid', 'positive_ghosted',
'dormant'

Handoff reason values:
'appointment_confirmed', 'quote_requested',
'complex_medical', 'frustration_detected',
'qualification_complete', 'consecutive_followups',
'positive_ghosted', 'unresponsive_after_followups',
'soft_decline', 'cold_lead', 'ai_null_response'

Follow-up stages:
'none', 'stage1', 'stage2', 'stage3',
'stage4', 'scheduled', 'completed'

Pipeline stages (STAGE_ORDER in src/pipeline.js):
'new_lead', 'contacted', 'replied', 'quoted',
'appointment_scheduled', 'sold', 'lost'

Lead statuses (STATUS_PRIORITY):
'new' (0), 'contacted' (1), 'replied' (2),
'booked' (3), 'sold' (4), 'opted_out'
Status is monotonic — never downgrade.