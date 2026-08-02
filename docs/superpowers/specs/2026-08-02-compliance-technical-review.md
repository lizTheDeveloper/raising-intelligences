# Co-Parent Matchmaking — Technical Compliance Review (Baseline)

**Date:** 2026-08-02
**Status:** Baseline audit — "where we stand" starting point
**Companion to:** `2026-07-31-coparent-matchmaking-design.md` (legal findings + phased checkpoints)

*Not legal advice. This is an engineering read of the current RI codebase against
the eight verified legal controls, to establish what exists, what's missing, and
where each control lands. Based on a read-only audit of five surfaces
(auth/tier, data model, Stripe, Matrix/messaging, consent UI).*

## Bottom line

RI today has **essentially none** of the compliance scaffolding the dating tier
needs — which is expected, because the entire paid/human path is still a draft
spec. The important findings are:

1. **There is no authenticated account.** This is the keystone. Almost every
   control (age gate, entitlement, verification status, identity-based blocking,
   data-subject rights) needs a trustworthy server-side user record, and none
   exists. Identity today is a **client-asserted Matrix ID** (never verified) plus
   the request IP.
2. **Two live privacy issues exist right now**, independent of the new feature,
   and should be fixed regardless of whether matchmaking ever ships (see §Fix Now).
3. **The good news:** two big scope items are currently *not* triggered — **BIPA**
   (no selfie/biometric anywhere yet) and the **§2258A CSAM pipeline** (no Matrix
   message ever touches our code yet). They come into scope only when Stripe
   Identity and the human handle-exchange are actually built.

The cleanest sequencing that falls out of this: **ship the free AI-parent tier
first** (small, contained COPPA/AI-Act surface) and treat the paid human tier as
a distinct, later project that carries the heavy controls.

## The keystone: authenticated accounts

Everything downstream depends on this, so it's called out first.

- No `users` table, no signup, no password/email, no server-verified session.
  Migrations end at `019`; identity is `players.user_id` (a Matrix handle) that is
  only **format-validated, never authenticated** (`server/src/routes/user.ts:9-12`),
  plus the IP (`017-game-ip.sql`).
- The Matrix auth widget is an **external** script (`client/index.html:15` →
  `/matrix-auth.js`, not in this repo). It can assert a `userId` and even offers
  `getOpenIdToken()` — but that token is **never verified server-side**
  (`matrix-auth.d.ts:1-14`; token never called).
- **Consequence:** we cannot attach "is an adult," "is a paid subscriber," or
  "verified on <date>" to anyone reliably until there is a real account record
  with a server-verified identity. This is the first build item for the paid tier,
  and it's a prerequisite for COPPA (#1), the tier fork, HEAA (#5), and
  identity-based blocking.

## Findings by surface → control → where it lands

Legend: control numbers reference the legal findings table in the companion spec.

### 1. Age gate & tier fork  (controls #1 COPPA, #5 UK HEAA)
- **Exists:** nothing. No age gate, no DOB, no "are you 18," no free/paid
  distinction. Play is fully anonymous (`client/src/App.tsx:183-207`). The word
  "tier" in-code means LLM model tier, not user entitlement.
- **Missing:** a neutral age gate before play; a verified-adult gate before the
  human path; any entitlement concept.
- **Lands in:** client — `App.tsx:183-247` (neutral gate + mode gating); server —
  the authoritative gate is `io.use` admission (`server/src/app.ts:231-245`) and
  the `CREATE_GAME`/`JOIN_GAME` handlers (`server/src/socket/handlers.ts:600,627`),
  mirroring the existing IP-ban check. Requires a new users/entitlement table.

### 2. Data retention & data-subject rights  (controls #1 COPPA, #6 GDPR)
- **Exists:** nothing. **No deletion or retention mechanism for any user data** —
  everything in Postgres is indefinite. The only `DELETE FROM` in the server is
  `banned_ips` un-ban (`repository.ts:705`). No delete-my-data, no export.
- **Stored indefinitely:** child names, both parents' confessionals + OCEAN
  (`games.parent_personalities`, `007-personality.sql`), all private/debrief
  message bodies (`messages`, `001-initial.sql`), IPs on every game + safety event.
- **Lands in:** a written retention policy + a scheduled purge job (new); a
  delete-account / export endpoint (new, `server/src/routes/`); wire deletion
  through the existing `ON DELETE CASCADE` FKs (which already exist but are never
  triggered because nothing deletes the parent `games` row).
- **Note:** DB is dual-mode — `DATABASE_URL` unset = in-memory with TTL eviction;
  set = permanent Postgres. **Open item:** confirm prod `deploy/.env`
  `DATABASE_URL` — it determines whether this is permanent-storage exposure.

### 3. Stripe Identity + subscription  (controls #4 BIPA, #6 GDPR, open-Q4 ARL)
- **Exists:** only a one-time "pay what you can" **donation** proxy
  (`server/src/routes/support.ts`) that forwards to the external org
  `stripe-webhook` service. No Stripe SDK, no keys in repo, **no webhook received
  back**, no subscription, no entitlement recorded, no Stripe Identity.
- **Missing (all greenfield):** recurring subscription; a **webhook receiver with
  signature verification** to learn `customer.subscription.*` and
  `identity.verification_session.verified`; **verification-status-only storage**
  (an enum + timestamp, explicitly no document/image columns); ARL auto-renew
  disclosure + easy-cancel.
- **BIPA (#4) is currently NOT triggered** — no selfie/camera/upload exists
  anywhere in the client. It comes into scope the moment a Stripe Identity selfie
  is added, at which point a **consent screen must render before capture**.
- **Open item:** confirm whether the external `stripe-webhook` service can issue
  subscriptions + Stripe Identity sessions, or whether RI must integrate Stripe
  directly.

### 4. Matrix DMs & CSAM reporting  (control #8 §2258A)
- **The discriminating fact:** there are two channels. **Channel A** (parent ↔
  AI-child) is fully built and moderated in-repo — but it's a *fictional AI
  child*, so it is **not** NCMEC-reportable. **Channel B** (human ↔ human Matrix
  DMs) is the actual §2258A trigger and is **entirely external + unbuilt** — no
  Matrix message ever passes through RI code (no `matrix-js-sdk`, no room
  subscription).
- **Do not** bolt NCMEC reporting onto the existing moderation pipeline — it never
  sees a Matrix message, and `moderation_flags` is **not** a §2258A preservation
  store (it's purged by `ON DELETE CASCADE`).
- **Missing:** NCMEC registration + CyberTipline submission; an
  evidence-preservation / legal-hold store immune to cascade purge; a
  **user-facing report/block** keyed on Matrix identity (today blocking is
  admin-only + IP-based, `server/src/routes/admin.ts` — IPs rotate, so this is
  inadequate for identity-based abuse).
- **Open item (verify against live Synapse, not code):** are the handle-exchange
  DMs end-to-end encrypted? If yes, even the homeserver operator can't read
  content, and **user reports become the only path to "actual knowledge"** — which
  makes the report/block flow the load-bearing control.

### 5. Consent & disclosure UI  (open-Q2 AI Act Art. 50; controls #2/#3 NJ/TX; #4 BIPA)
- **Exists:** nothing. No ToS/privacy page or route (only `/admin` exists), no
  consent checkbox pattern, no bold/caps notice styling, no cookie/GDPR banner.
- **AI Act Art. 50 gap:** the AI child *and* the AI-generated solo co-parent are
  presented as real people; every "AI"/"LLM" string in the client is a code
  comment, never shown. Disclosure needed at first interaction.
- **Lands in:** AI disclosure — the mode-select screen (`App.tsx:225-234`) and the
  first personification beat (`GuardianScreen.tsx:146`). NJ/TX dating notice +
  no-background-check disclosure — a new click-through step in the intake `STEPS`
  array (`GuardianScreen.tsx:145-162`) captured server-side, plus a standing
  notice in `Credits.tsx`. ToS/privacy — new static pages + a footer link + a
  click-through at the pre-game gate. Policy pages must be *authored*, not just linked.

## Fix now — live issues, independent of the new feature

These exist in shipped code today and are worth fixing on their own merits:

1. **Cross-user confessional leak (high severity).** `GET /game/:id/state`
   (`server/src/routes/game.ts:103-131`) strips identity docs and safety
   internals but **not `parentPersonalities`** — so anyone with the `gameId` can
   read the other parent's intimate confessionals + OCEAN over an unauthenticated
   API. This is a confidentiality / purpose-limitation problem regardless of the
   dating tier. **Fix:** strip `parentPersonalities` from the public state
   projection (and, longer term, add per-requester authorization).
2. **Confessionals shipped verbatim to Langfuse cloud by default.** Every LLM call
   is traced with the full prompt (`server/src/observability/langfuse.ts:158,180`),
   and the personality prompt embeds both confessionals verbatim; `baseUrl`
   **defaults to Langfuse cloud** when unset (`langfuse.ts:45`). Intimate free-text
   leaves our infrastructure with no documented retention/DPA. **Fix:** self-host
   Langfuse (a compose file already exists) or redact confessionals from traces.

## Open items to resolve (can't be answered from the repo)

- Production `DATABASE_URL` value (permanent Postgres vs. in-memory) — sets the
  severity of the retention gaps.
- Whether the external `stripe-webhook` service supports subscriptions + Stripe
  Identity, or RI integrates Stripe directly.
- The live Matrix/Synapse E2EE posture for private DMs.
- The external `/matrix-auth.js` widget's capabilities (does it expose a verified
  OpenID token we can validate server-side to bootstrap real accounts?).

## Suggested build order (technical, maps to spec phases)

- **Phase 1 — free AI-parent tier (smallest compliant surface):** neutral age
  gate; AI-disclosure text; retention policy + purge job + delete/export endpoint;
  **fix the two live issues above**. Covers COPPA #1, AI Act Art. 50, GDPR #6
  basics — no accounts/payments needed.
- **Phase 2 — accounts + verification:** authenticated user record (the keystone);
  Stripe Identity with consent-before-selfie + status-only storage; UK HEAA
  documentation; GDPR DPIA before any EU user. *(BIPA enters scope here.)*
- **Phase 3 — subscription:** recurring billing via webhook receiver; ARL
  disclosure + cancel.
- **Phase 4 — human matchmaking + Matrix dating handoff:** NJ/TX disclosures;
  identity-based report/block; NCMEC registration + CyberTipline + preservation
  store; verify Synapse E2EE; final legal sign-off before the tier turns on.
