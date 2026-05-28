# EAC Tools — Developer Playbook

> **Canonical reference for all Claude Code sessions working on this codebase.**
> Read this before touching anything. Update it when you change patterns.

---

## 1. Project Overview

**Repo:** `camav2/eac-tools`
**Live URL:** `https://hub.expertauthor.community`
**Stack:** Vanilla HTML/CSS/JS frontend + Vercel serverless API (TypeScript)
**Purpose:** Free diagnostic tools for expert authors — members log in via the shared EAC auth service; non-members can still submit tool results (gated by email + origin check only).

### Tools
| URL slug | HTML file | API file | Airtable table |
|---|---|---|---|
| `/` | `public/index.html` | — | — |
| `/idea-test` | `public/idea-test.html` | `api/idea-test.ts` | `AIRTABLE_TABLE_ID` |
| `/unblocker` | `public/unblocker.html` | `api/unblocker.ts` | `AIRTABLE_UNBLOCKER_TABLE_ID` |
| `/book-canvas` | `public/book-canvas.html` | `api/book-canvas.ts` | `tblqezI9SqgelqJA5` (hardcoded) |
| `/isbn-wizard` | `public/isbn-wizard.html` | `api/isbn-wizard.ts` | `AIRTABLE_ISBN_WIZARD_TABLE_ID` → `tblZL8zS59pGTAyyY` |
| `/dashboard` | `public/dashboard.html` | multiple GET endpoints | — |
| `/settings` | `public/settings.html` | `api/access-config.ts` | — |
| `/editor` | `public/editor.html` | `api/content.ts` | — |

### Sibling repos
| Repo | Live URL | Notes |
|---|---|---|
| `camav2/eac-auth` | `auth.expertauthor.community` | Shared magic-link auth service |
| `camav2/circle-co-writing-ui` | `cowrite.expertauthor.community` | Next.js co-writing app |

---

## 2. Architecture

```
browser
  │
  ├── public/*.html   (static, served by Vercel CDN)
  ├── public/eac.js   (client-side auth + navbar + shared utils)
  ├── public/style.html  (design-system reference page — not a template)
  │
  └── api/*.ts        (Vercel serverless functions, Node.js runtime)
        ├── _lib/auth.ts       ← canonical JWT verification
        ├── _lib/airtable.ts   ← People upsert + Activity Log
        ├── _lib/brevo.ts      ← contact list + transactional email
        └── _lib/circle.ts     ← Circle API v2 helpers
```

**Deployment:** Push to `master` → Vercel auto-deploys to production.
There is no `test`/`staging` branch for eac-tools (unlike cowrite which uses `test` branch).

---

## 3. Routing (`vercel.json`)

Clean URLs are rewritten to `.html` files:

```
/               → /index.html
/idea-test      → /idea-test.html
/unblocker      → /unblocker.html
/book-canvas    → /book-canvas.html
/dashboard      → /dashboard.html
/settings       → /settings.html
/editor         → /editor.html
```

CORS headers on all `/api/*` routes:
```
Access-Control-Allow-Origin: https://hub.expertauthor.community
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

---

## 4. Authentication

### How it works
1. User visits a protected page (dashboard, settings)
2. `eac.js` frontend calls `requireAuth()` which checks `/api/me`
3. If no session → redirect to `https://auth.expertauthor.community/login?redirect=<current-url>`
4. Auth service validates email against Circle, sends magic link via Resend
5. User clicks link → JWT issued as `eac_session` httpOnly cookie on `.expertauthor.community`
6. Cookie is shared across all `*.expertauthor.community` subdomains automatically

### JWT payload
```typescript
{
  sub: email,           // e.g. "user@example.com"
  circleUserId: number, // global Circle user_id
  name: string,
  avatarUrl: string,
  spaceGroups: string[],// e.g. ['connect'] or ['write-now']
  isAdmin: boolean,
  iat, exp              // 7-day expiry
}
```

### Space groups
| Slug | Access |
|---|---|
| `connect` | Full access — all tools including co-writing |
| `write-now` | Programme access — all tools except co-writing |

### Server-side: `_lib/auth.ts`

**Always use this, never roll your own cookie parsing or admin checks.**

```typescript
import { requireAuth, getSession, ALL_TOOLS, COWRITING } from './_lib/auth'

// For a protected GET/POST route:
const session = await requireAuth(req, res, ALL_TOOLS)
if (!session) return  // requireAuth already sent 401/403

// For admin-only:
const session = await getSession(req)
if (!session) return res.status(401).json({ error: 'Unauthorised' })
if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

// session shape: { email, circleUserId, name, avatarUrl, spaceGroups, isAdmin }
```

### `isAdmin` — important
`isAdmin` comes from the JWT (set at login time by eac-auth, which checks `ADMIN_EMAILS` env var). **Do NOT check `ADMIN_EMAILS` yourself in eac-tools** — that env var is only in eac-auth. The JWT already carries `isAdmin: true`. Just read `session.isAdmin`.

### jose version
**Must use `jose ^4.15.9`** (pinned in package.json). jose v5+ is ESM-only and breaks Vercel's CJS compilation. Do not upgrade.

### Client-side: `eac.js`
Public tool pages (idea-test, unblocker, book-canvas) are **not** auth-gated — they do not call `requireAuth()`. Only dashboard and settings call it.

`eac.js` provides on gated pages:
- `requireAuth()` — redirects to login if no session
- `eacAuthReady` — Promise that resolves when session confirmed
- `eacUser` — global: `{ email, name, avatarUrl, isAdmin, spaceGroups }`
- Navbar injection with admin Settings link

---

## 5. Form Security

Tool forms (idea-test, unblocker, book-canvas) use **two layers of protection**:

1. **Origin check** — server refuses requests where `origin`/`referer` header doesn't start with `https://hub.expertauthor.community`. This is the primary bot/direct-API defence.
2. **Email validation** — regex check on submitted email.

**No honeypot fields.** Honeypot `<input name="website">` was removed because Chrome autofill populates it with real emails, silently blocking legitimate submissions. Origin check is sufficient.

```typescript
const ALLOWED_ORIGINS = ['https://hub.expertauthor.community']

const origin = (req.headers['origin'] ?? req.headers['referer'] ?? '') as string
if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
  return res.status(403).json({ error: 'Forbidden' })
}
```

---

## 6. Design System

Reference page: `https://hub.expertauthor.community/style`

### Tokens
```css
--color-navy:    #00003D   /* primary background, text */
--color-yellow:  #FFE64B   /* EAC brand yellow — CTAs, highlights */
--color-blue:    #5296FB
--color-orange:  #FE8D17
--color-white:   #FFFFFF
--color-grey-100:#F5F5F7   /* page background */
--color-grey-200:#E8E8EC
--color-grey-400:#9999AA
--color-grey-700:#444455
```

### Email gate form pattern
All three tool forms use the `.email-card` pattern. **Always match this exactly:**

```html
<div class="email-card">
  <h2 class="email-card-title">Get Your Results</h2>
  <p class="email-card-desc">Brief description of what they'll receive.</p>

  <!-- For tools with a question: question first, then name, then email -->
  <div class="form-field">
    <label class="form-label" for="idea-text">Your idea or question</label>
    <textarea class="form-input" id="idea-text" rows="4" placeholder="..."></textarea>
  </div>

  <div class="form-field">
    <label class="form-label" for="first-name">First name</label>
    <input class="form-input" type="text" id="first-name" placeholder="Your first name">
  </div>

  <div class="form-field">
    <label class="form-label" for="email">Email address</label>
    <input class="form-input" type="email" id="email" placeholder="you@example.com">
  </div>

  <!-- Consent checkbox — always present, submit disabled until checked -->
  <div class="form-consent">
    <input type="checkbox" id="consent"
      onchange="document.getElementById('btn-submit').disabled = !this.checked;">
    <label class="form-consent-label" for="consent">
      I agree that when I sign up for my results, I will be added to a marketing list
      where I will receive occasional news from EAC on writing, books and authors.
    </label>
  </div>

  <button class="btn-submit" type="submit" id="btn-submit" disabled>
    See My Result &rarr;
  </button>
  <p class="form-error" id="form-error" style="display:none"></p>
</div>
```

**Field order rules:**
- Tools with a question textarea: question → first name → email
- Tools without a question (book-canvas): first name → email

**No "Skip for now" links** on any gate form.

### Navbar
```html
<header class="site-header">
  <a href="/" class="header-logo">
    <!-- EAC SVG logo -->
    <span class="header-logo-text">Author Hub</span>
    <span class="beta-badge">Beta</span>
  </a>
  <!-- auth nav injected by eac.js for gated pages -->
</header>
```

Logo text is **"Author Hub"** (not "EAC Tools"). Beta badge always present.

---

## 7. CMS (Content Editing)

**How it works:** Content is stored as a JSON block in each page's `<head>`:
```html
<script type="application/json" id="page-content">{
  "index/hero/title": "Tools for <span>clearer thinking</span><br>and <span>stronger writing</span>",
  "index/hero/subtitle": "Free reflections...",
  ...
}</script>
```

The JS runtime reads this on page load and sets `element.innerHTML` for any element with a `data-content-key` attribute matching a key in the map.

**To make an element editable:**
```html
<h1 data-content-key="index/hero/title">Default fallback text</h1>
<a href="/default-url" data-content-href-key="index/hero/cta-url"
   data-content-key="index/hero/cta-label">Default label</a>
```

Keys follow the pattern `page/section/element`. Both text content (`data-content-key`) and link URLs (`data-content-href-key`) are supported.

**Admin editor:** `/editor` page — admin-only, writes back to GitHub via `api/content.ts` which commits the updated HTML directly to the repo. Vercel then deploys.

**Supported pages in `PAGE_FILES` map (`api/content.ts`):**
```typescript
'index':       'public/index.html'
'idea-test':   'public/idea-test.html'
'unblocker':   'public/unblocker.html'
'book-canvas': 'public/book-canvas.html'
```

---

## 8. API Patterns

### Tool submission handler structure

Every tool POST handler follows this exact sequence:

```
1. Set Cache-Control: no-store
2. Origin check (block non-hub.expertauthor.community origins)
3. Destructure req.body
4. Validate email
5. resolvePersonWithCircle() — best-effort, never throws
6. Write to tool-specific Airtable table (ALWAYS — even if step 5 failed)
7. addContactToList() + sendResultsEmail() in parallel — best-effort
8. logActivity() — only if personId exists, wrapped in try/catch
9. Return { ok: true }
```

Steps 5, 7, 8 are best-effort. Step 6 is always attempted. Only step 6 failure causes a non-200 response.

### GET (member results)
Every tool also has a GET handler for logged-in members to retrieve their own results:
- `?id=<recordId>` → full single result (verifies email ownership)
- No params → list of all results for the session user

Both require `requireAuth(req, res, ALL_TOOLS)`.

---

## 9. Airtable Schema

**Base ID:** `process.env.AIRTABLE_BASE_ID` (env var)

### Shared tables (all tools write to these)

**People** (`tblbJgznPsbETLl8q`)
| Field | Type | Notes |
|---|---|---|
| Email | text | unique lookup key |
| Full Name | text | |
| Category | select | "Member" or "Non Member" |
| First Seen | datetime | ISO string |
| Last Active | datetime | ISO string, updated on every upsert |
| Circle Member ID | text | global Circle user_id from JWT |
| Access Group | link | linked to Access Groups table |
| Access Group ID | text | Circle access group ID |

**Activity Log** (`tblgK9bOiRsjfzvdM`)
| Field | Type | Notes |
|---|---|---|
| Summary | text | human-readable description |
| Person | link | linked to People |
| Action Type | select | must be an existing choice — see below |
| Timestamp | datetime | ISO string |
| Source Tool | text | e.g. "idea-test" |
| Reference ID | text | Airtable record ID of the tool result |

**Action Type choices** (hardcoded in `book-canvas.ts`):
- Login
- Idea Test Completed
- Co-writing Session Created
- Co-writing Session Attended
- Writing Unblock Completed
- Book Canvas Completed ← added dynamically if missing via Airtable Meta API

### Primary key convention — all new tables

**Every new tool-specific table must use an auto-increment `ID` field as the primary key (first column).** Do not use Email or any user-supplied value as the primary field.

- Primary field: `ID`, type `autoNumber`
- Airtable record lookups in the API always use the Airtable record ID (`rec...`), never the primary field value — so this is purely a display/admin convenience and has no effect on API reads or writes.
- Existing tables (Idea Test, Unblocker, Book Canvas) pre-date this convention and use Email as primary.

### Tool-specific tables

**Idea Test** (`process.env.AIRTABLE_TABLE_ID`)
Key fields: Email, First Name, Idea Text, Score, Tier, Q1–Q5 answers, Submitted At, Source Tool, Person (link)

**Unblocker** (`process.env.AIRTABLE_UNBLOCKER_TABLE_ID`)
Key fields: Email, First Name, Primary Blocker, Secondary Blocker, Intensity Tier, Score: Time/Structure/Noise/Isolation/Momentum, Context, Is Member, Combination Pattern, Source, Submitted At, Person (link)

**Book Canvas** (`tblqezI9SqgelqJA5` — hardcoded)
Key fields: Email, First Name, Is Member, Submitted At, Source Tool, Pillars Completed (0–9), Purpose, Positioning, Audience, Problem/Need, Market Fit, Unique Value, Platform, Objective, Strategy, Person (link)

**ISBN Wizard Results** (`tblZL8zS59pGTAyyY` — env var `AIRTABLE_ISBN_WIZARD_TABLE_ID`)
Key fields: ID (auto-increment, primary), Email, First Name, Is Member, Submitted At, Source Tool, Country, Formats, Platform, Publisher, Quantity, ISBN Count, Recommended Pack, Person (link)

### `_lib/airtable.ts` helpers

```typescript
// Upsert a person record (find by email, update or create)
await upsertPerson({ email, name, isMember, circleMemberId, accessGroup, accessGroupId })

// Combined: Circle lookup + person upsert. Returns personId or undefined (never throws)
const personId = await resolvePersonWithCircle({ email, name, isMember, circleUserId })

// Log an activity (only call if personId is defined)
await logActivity({ personId, actionType, sourceTool, summary, referenceId })
```

---

## 10. Brevo (Email Marketing)

### Lists
| Tool | List ID |
|---|---|
| unblocker | 64 |
| idea-test | 65 |
| book-canvas | 66 |
| isbn-wizard | 68 |

### Templates
| Tool | Template ID |
|---|---|
| unblocker | 548 |
| idea-test | 547 |
| book-canvas | 546 |
| isbn-wizard | 550 |

### `_lib/brevo.ts` helpers

```typescript
// Add/update contact in Brevo and subscribe to tool list
await addContactToList({ email, firstName, tool: 'idea-test' })

// Send results email via Brevo template
await sendResultsEmail({
  to: { email, name: firstName },
  tool: 'idea-test',
  templateParams: {
    FIRSTNAME: '...',
    // tool-specific params matching the template variables
  },
})
```

Both are best-effort (errors logged, not re-thrown). Always call in `Promise.all([...])`.

---

## 11. Circle API

Two different Circle IDs per person — easy source of confusion:
- `user_id` — global Circle account ID. This is what the JWT stores as `circleUserId`
- `community_member_id` — community-specific ID. This is what the Circle API needs for access group lookups

`_lib/circle.ts` handles this transparently: `getCircleAccessGroup(email)` resolves both IDs internally.

```typescript
// Get the primary access group for a member (returns null if not found or any error)
const group = await getCircleAccessGroup(email)
// group: { id: number, name: string } | null
```

Circle API calls always fail silently — they must never block a form submission.

---

## 12. Environment Variables

### In Vercel (eac-tools project)

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ | Same value as eac-auth — never change without updating all apps |
| `AIRTABLE_API_KEY` | ✅ | Airtable personal access token |
| `AIRTABLE_BASE_ID` | ✅ | EAC Airtable base: `appvucz2Xo0PLqN2k` |
| `AIRTABLE_TABLE_ID` | ✅ | Idea Test table ID |
| `AIRTABLE_UNBLOCKER_TABLE_ID` | ✅ | Unblocker table ID |
| `BREVO_API_KEY` | ✅ | Brevo API key |
| `GITHUB_TOKEN` | ✅ | Personal access token with repo write permission (for CMS) |
| `GITHUB_OWNER` | ✅ | `camav2` |
| `GITHUB_REPO` | ✅ | `eac-tools` |
| `CIRCLE_API_TOKEN` | ✅ | Circle API token (v2) |
| `CIRCLE_COMMUNITY_ID` | ✅ | EAC community: `9832` |
| `CIRCLE_ADMIN_GROUP` | optional | Default: `"Administrator"` |

> ⚠️ **`ADMIN_EMAILS` is NOT needed here.** Admin status is resolved in eac-auth at login time and stored in the JWT. Read `session.isAdmin` — do not check env vars.

---

## 13. Adding a New Tool — Checklist

```
□ Create public/<tool-name>.html
  □ Use .email-card gate pattern (section 6)
  □ Field order: question (if any) → first name → email
  □ Consent checkbox + disabled submit
  □ No honeypot fields
  □ Nav: "Author Hub" + Beta badge
  □ Domain: hub.expertauthor.community throughout

□ Create api/<tool-name>.ts
  □ Add ALLOWED_ORIGINS = ['https://hub.expertauthor.community']
  □ POST: origin check → email validation → resolvePersonWithCircle → write Airtable → Brevo → logActivity
  □ GET: requireAuth(req, res, ALL_TOOLS) → return results for session user
  □ res.setHeader('Cache-Control', 'no-store') at top

□ Add Airtable table
  □ Primary field: ID (autoNumber) — not Email
  □ Include: Email, First Name, Is Member, Submitted At, Source Tool, Person (link to People)
  □ Add the table ID to an env var (or hardcode like book-canvas does)

□ Add Brevo list + template
  □ Add list ID to BREVO_LISTS in _lib/brevo.ts
  □ Add template ID to BREVO_TEMPLATES in _lib/brevo.ts

□ Add Activity Log action type
  □ Add to EXISTING_ACTION_CHOICES in book-canvas.ts (it's the canonical list)
  □ Or use the ensureActionType() pattern to patch it via Airtable Meta API

□ Register route in vercel.json rewrites

□ Register page in api/content.ts PAGE_FILES if CMS-editable

□ Test: submit as non-member → check Airtable, Brevo, email received
□ Test: submit as member → check People upserted, Activity Log written
□ Test: load results on dashboard
```

---

## 14. Dashboard

`public/dashboard.html` — member-only, requires `requireAuth()`.

API calls it makes:
- `GET /api/idea-test` → idea test results list
- `GET /api/unblocker` → unblocker results list
- `GET /api/book-canvas` → canvas list
- `GET /api/cowrite-sessions` → co-writing sessions

Result card titles include date/time extracted from `submittedAt`. Format: `DD/MM/YYYY, HH:MM`.

Cowrite CTAs say **"Create a session"** (not "Book a session").

---

## 15. Known Gotchas & Fixed Bugs

### Honeypot + autofill
**Never add `<input name="website">` honeypot fields.** Chrome autofill populates any static input that looks like a contact field, including honeypots, silently blocking real submissions. Origin check is the correct mechanism.

### `ADMIN_EMAILS` env var
Don't add this to eac-tools. Auth works through JWT `isAdmin`. If admin save is broken, check `_lib/auth.ts` is using `getSession()` and reading `session.isAdmin` — not any env var.

### jose CJS vs ESM
`jose ^4.15.9` in package.json. Do not upgrade. v5+ breaks build.

### Circle dual IDs
Never pass `circleUserId` (from JWT) directly to Circle API endpoints that need `community_member_id`. Use `getCircleAccessGroup(email)` which handles resolution.

### `/api/airtable` is gone
The file was renamed to `api/idea-test.ts`. Any reference to `/api/airtable` is stale and will 404.

### CMS content override
If a page has a CMS JSON block with `"page/section/key": "value"`, that overrides the hardcoded HTML fallback. Both must be kept consistent. When changing hero copy etc., update both the JSON block AND the `data-content-key` element's fallback content.

### Domain
All references must use `hub.expertauthor.community`. The old `tools.expertauthor.community` is no longer the canonical domain. Check: `ALLOWED_ORIGINS`, `vercel.json` CORS headers, canonical/og meta tags, JSON-LD, `eac.js`.

---

## 16. Code Style

- **TypeScript** everywhere in `api/`
- Shared helpers live in `api/_lib/` — never duplicate logic across handlers
- All external API calls: log success/failure with `[tool-name]` prefix: `console.log('[idea-test] ...')`
- Best-effort operations (Circle, Brevo, Activity Log): wrap in `try/catch`, log error, never re-throw
- Critical operations (Airtable result write): allow error to propagate → return non-200 response
- No debug `console.log` left in production — clean up after diagnosing issues
- `res.setHeader('Cache-Control', 'no-store')` on every API handler

---

## 17. Deployment

**Push to `master`** → Vercel auto-deploys. No build step needed.

CMS saves also push to `master` via GitHub API (commits the updated HTML directly). Vercel picks up those commits too.

To check a deployment: Vercel dashboard at `vercel.com` or `vercel ls` in CLI.

---

## 18. Related Memory Files

- `eac_auth_architecture.md` — full canonical `_lib/auth.ts` source + integration checklist
- `project_cowrite_auth_migration.md` — cowrite migration context (Clerk → custom auth, DO → Vercel)
- `project_eac_cms_buttons.md` — CMS button/link editing via `data-content-href-key`
