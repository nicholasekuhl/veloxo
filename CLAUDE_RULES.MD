# Claude Rules — Read Before Every Task

Read and follow ALL of these rules for every 
task in this session without exception.
These rules take priority over everything else.

## RULE 1: READ FILES SELECTIVELY
Read ONLY the specific files mentioned in 
each task. Do not read the entire codebase 
unless explicitly asked to.
Only read additional files if directly 
needed to complete the specific task.

## RULE 2: NO PERSONAL OR SPECIFIC DATA
Never use specific real names, company names, 
vendor names, or personal data anywhere in 
the codebase as placeholder, example, or 
default values.

BANNED — never appear anywhere in code:
- "Dynasty", "Redmedia", "Gold Bars", "30 EXL"
- "Nick Kuhl", "Nicholas Kuhl", "Nick"
- "Coverage by Kuhl", "Cornerstone Legacy Group"
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

## RULE 3: FILE ORGANIZATION
The public/ directory is split into separate 
page files. Never create a monolithic index.html.

Existing page files:
- public/leads.html
- public/conversations.html
- public/campaigns.html
- public/stats.html
- public/calendar.html
- public/settings.html
- public/admin.html
- public/login.html
- public/signup.html

Shared code lives in:
- public/js/shared.js
- public/css/shared.css

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

## RULE 4: DATABASE PERFORMANCE
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

Standard indexes to always add:
- Every foreign key column
- Every filter column (status, is_sold, etc)
- Every sort column (created_at, scheduled_at)
- Every lookup column (phone, email, twilio_sid)

## RULE 5: NEVER BREAK EXISTING FUNCTIONALITY
Before making any changes:
1. Read all relevant files first
2. Identify what is already working
3. Make surgical changes only
4. Never rewrite working code from scratch
5. If full rewrite needed explain why and 
   wait for confirmation before proceeding

## RULE 6: SQL CONFIRMATION
Never assume SQL has been run in Supabase.
When task requires database changes:
1. Output all SQL clearly labeled
2. Tell me to run it in Supabase SQL editor
3. Wait for my confirmation before writing 
   any code that depends on new columns or tables

## RULE 7: MASTER TWILIO ONLY
Never add per-user Twilio credentials.
All SMS sending uses master credentials:
- process.env.TWILIO_ACCOUNT_SID
- process.env.TWILIO_AUTH_TOKEN
From number comes from user's phone_numbers 
table record only.
Never read Twilio credentials from user_profiles.

## RULE 8: DATABASE COLUMN NAMES
The leads table uses these exact column names:
- 'phone' NOT 'phone_number'
- 'user_id' for owner
- 'bucket_id' for bucket assignment
- 'is_sold' for sold status
- 'is_blocked' for blocked status
- 'is_cold' for cold status
- 'autopilot' for autopilot toggle
Always verify column names before writing 
queries against existing tables.

## RULE 9: AFTER EVERY TASK TELL ME
1. Which files were changed
2. What SQL needs to be run (if any)
3. Whether to push to GitHub now or wait

## QUICK REFERENCE
- Leads page: public/leads.html
- Conversations: public/conversations.html
- Campaigns: public/campaigns.html
- Stats: public/stats.html
- Calendar: public/calendar.html
- Settings: public/settings.html
- Admin: public/admin.html
- Shared JS: public/js/shared.js
- Shared CSS: public/css/shared.css
- Main server: src/server.js
- Database: src/db.js
- Twilio helper: src/twilio.js
- Scheduler: src/scheduler.js
- Auth routes: src/routes/auth.js
- Lead routes: src/routes/leads.js
- Message routes: src/routes/messages.js
- Campaign routes: src/routes/campaigns.js
- Conversation routes: src/routes/conversations.js
- Phone number routes: src/routes/phoneNumbers.js
- Notifications: src/notifications.js

## VISUAL CONSISTENCY RULE:
All new UI components must use the existing 
CSS variables from shared.css. Never hardcode 
colors, shadows, or border radius values.

Always use:
- var(--color-primary) not #6366f1
- var(--shadow-md) not box-shadow: 0 4px...
- var(--radius-md) not border-radius: 10px
- var(--color-border) not #e2e8f0
- var(--color-text-secondary) not #475569
- var(--space-4) not padding: 16px

New cards: white background, shadow-md, radius-md
New buttons: use existing .btn-primary or .btn-secondary classes
New badges: use existing .badge class with color modifier
New modals: use existing .modal class structure
New tables: use existing .table class structure

If a new component needs a style not in shared.css,
add it to shared.css as a reusable class — 
never add one-off styles inline or in page files.