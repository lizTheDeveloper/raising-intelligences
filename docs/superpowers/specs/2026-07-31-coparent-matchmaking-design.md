# Incidental Co-Parenting Matchmaking — Design

**Date:** 2026-07-31 (revised 2026-11-22)
**Status:** Approved by Liz, 2026-11-22. Her decisions of that date (below)
replace the subscription model and the "paywall is the age gate" idea in the
July draft.
**Game:** Raising Intelligences (RI)
**Plan:** `docs/superpowers/plans/2026-11-22-stranger-coparenting.md`

## Liz's decisions, 2026-11-22

These replace the parts of the July draft they contradict. Where the old text
is kept for the record it is marked *superseded*.

1. **No subscription.** Solo play is free forever. Partner play costs **$20 per
   child, paid once**. This covers invite-link partner play and stranger mode
   alike.
2. **The host pays**, and is charged **when the partner joins**, never when an
   invite is sent. (Exact trigger and host rule: see "Pricing and who pays".)
3. **The paywall is not the age gate any more.** The two are separate checks.
   The hard line holds: **no minor ever reaches the stranger pool.** Both
   players in stranger mode must pass Stripe Identity (photo ID plus a matching
   live selfie), whoever pays. Solo play and the AI co-parent stay open to
   everyone, minors included.
4. **Kept from the July draft:** no profiles, no swiping, no "it's a match!"
   screen; the run is played blind; the only real contact is a mutual-opt-in
   Matrix handle exchange at the end (`matrix.multiversegames.ai`).
5. **Stranger mode ships dark.** It is built in full but sits behind a server
   flag that is **off for the public by default**. Liz switches it on for her
   own online meetups (invite-only meetup codes) and checks the legal and
   safety questions there herself before any public launch.
6. **Money safety.** Charges run in Stripe **test mode** until Liz moves the
   payment key to live. The server refuses a live payment key unless she sets
   an explicit second switch.

## Summary

Add **random-matched co-parenting** to Raising Intelligences: two strangers are
paired to raise one AI child together. The child's personality is a genetic +
emotional blend of both parents (RI's existing two-parent mechanic). The run is
played blind — display names only, no profiles, no dating UI. At the end of a
two-human run, each player independently sees **one** prompt — *"Want to stay in
touch? Exchange Matrix handles"* — and a mutual yes connects them on
`matrix.multiversegames.ai`. The dating is entirely emergent; the only artifact
is a handle exchange both people chose.

Raising a child with a second human costs the host **$20 per child, once**,
whether the partner came from an invite link or from the stranger pool. Getting
**into the stranger pool** needs something different: a verified Matrix account
and a Stripe Identity check proving the player is 18 or over. Everyone else —
minors, the unverified, anyone in an empty queue — can raise a child with a warm
**AI co-parent**, for free.

## Motivation

- **The hook:** co-parenting is an exceptional compatibility revealer — warmth,
  conflict style, values, how someone behaves when the "child" struggles. Far
  more signal than a dating profile, and *incidental*: nobody performs, so you
  see the real person. "Raise a kid with a stranger, discover you're compatible."
- **Monetization that doesn't fight safety:** the $20 is charged per child raised
  with another human, at the moment that human really arrives. The core game,
  solo play and the AI co-parent stay free. The age check is its own wall, with
  no payment attached, so a parent's card can never stand in for a child's age.
- **Growth loop:** the connection payoff lives on the Multiverse Matrix server,
  so successful matches drive Matrix sign-ups.

## Non-Goals

- No dating profiles, swiping, preferences, or "it's a match!" screen.
- No changes to the free single-player experience. The stranger-mode intake
  additions (maturity items) appear only in stranger mode.
- No wait-time estimates at launch (v2 — requires historical data).
- No claim, anywhere, that any in-game instrument *verifies age*. Age is verified
  only by Stripe Identity.
- No subscription, credits or recurring billing (*superseded* the July tier table).

## Pricing and who pays

| | Solo | AI co-parent | Invite-link partner | Stranger mode |
|---|---|---|---|---|
| Price | free | free | **$20 per child, once** | **$20 per child, once** |
| Who pays | — | — | the host | the host |
| Age verification | none | none | none | **both players**, Stripe Identity |
| Open to minors | yes | yes | yes (no stranger contact) | **never** |
| Handle exchange at the end | — | — | — | mutual opt-in only |

**Who the host is.**
- Invite-link play: the player who created the game (seat `parent1`).
- Stranger mode: the queue is symmetric (both players queue; nobody "opens" a
  run), so **the host is whoever queued first**. On a match the server creates
  the child from the host's proposed name and seats the host as `parent1`; the
  matched stranger joins the host's run as `parent2`. Ties on the queue
  timestamp break on the entry id, so the rule is deterministic.
- So in every mode the host is the `parent1` seat, and only `parent1` is ever
  shown the payment step.

**When the partner has "joined".** The charge is due at the moment **the
opening is complete with two humans**: both seats are held by people (not the
AI), and both parents' intake answers are in. In invite play that is the
partner finishing the guardian quiz; in stranger mode it is both matched
players arriving in the join window (their intake was taken before queueing).
Nothing is generated for the child — no personality seed, no first scene —
until the host has paid. This is what "charged when the partner joins" means in
code, and it rules out a charge for:
- an invite that was sent and never opened;
- a link opened by a chat app's preview fetcher, or a partner who opened it and
  left before the quiz;
- a matched stranger who never turned up in the join window.

**One charge per child.** A child is paid for once:
- reconnects, retried joins, device handoffs and a re-invited partner taking a
  dropped seat never create another charge;
- the host's repeated "pay" clicks reuse the open Checkout Session;
- if two sessions for the same child are both paid anyway (two tabs racing),
  the second payment is refunded automatically;
- every Stripe webhook event is processed at most once.

**Free cases.** A child raised with the AI co-parent is free, including a
stranger-mode run where the match no-showed and the present player chose the AI
instead. A paid child whose human partner later drops keeps its AI stand-in and
is not refunded automatically; refunds are an admin action
(`POST /api/admin/games/:id/refund`).

**Paywall switch.** The $20 step is behind `RI_PARTNER_PAYWALL=on` (default
off), so invite partner play stays free until Liz turns it on. It also needs a
Stripe key; if the switch is on but no usable key is configured, partner play
stays free and the server logs `partner_paywall_unconfigured`. A
misconfiguration never blocks a game.

## Stranger mode switch

`RI_STRANGER_MODE`:
- `off` (default): nothing about stranger mode is visible or reachable. The
  start screen is unchanged, the API refuses every stranger endpoint, and the
  socket refuses every queue event.
- `meetup`: stranger mode appears only for a visitor who arrives with
  `?meetup=<code>` where the code is listed in `RI_MEETUP_CODES`
  (comma-separated). Players are only matched with others holding the same code.
- `public`: visible to everyone. Not to be used until the Phase 4 legal sign-off.

## Core Flows

### 1. Intake (extends the existing instrument — does not replace it)

RI already collects, per parent: **OCEAN scores (5)** + **two confessionals**
(free-text emotional themes). These already combine to seed the child's
personality (`server/src/game/personality.ts`). In stranger mode the same
questions are asked **before** queueing, plus a few **maturity items**. This
one instrument does three jobs:

1. Soft-filters obvious immaturity and sets a serious tone.
2. Feeds the child's personality seed (unchanged behavior — the answers are
   written into the matched game as each parent's personality, and the seed is
   generated by the same code as every other two-parent game).
3. Provides the signal the LLM matchmaker reads.

There is no second, separate quiz: a matched player does not retake the
guardian quiz in the game. The maturity items are a *soft filter and
tone-setter only* — explicitly **not** an age gate. Intake answers held for
matching live in server memory only and are dropped when the player leaves the
queue or is matched.

### 2. The fork (gate is a routing decision, not a wall)

Stranger mode's first screen routes the player:

- **Signed in with Matrix and age-verified as 18+** → intake → the human queue.
- **Everyone else** (unverified, anonymous, a minor, anyone who declines the ID
  check) → an **AI co-parent**, instantly. Same full parenting experience, free.

No one sees a "you can't play" screen. The AI path is the default and the
fallback. A verification that shows the player is under 18 routes them to the AI
co-parent or solo play, and blocks that Matrix account from the stranger pool.

### 3. Age verification (Stripe Identity)

- Requires a **server-verified Matrix account**. The client gets an OpenID token
  from the Matrix widget; the server checks it against Synapse
  (`/_matrix/federation/v1/openid/userinfo`) and uses the verified user id as
  the account key. A client-claimed Matrix id is never trusted for this.
- Before any camera or upload step, a **biometric consent screen** explains what
  Stripe collects (photo ID, a selfie, face geometry), why (to prove 18+), and
  what RI keeps (only "adult: yes" and the date). The server records the consent
  before it creates the Stripe session.
- The session is a Stripe Identity `document` check with
  `require_matching_selfie` and `require_live_capture`.
- The server reads the verified date of birth once, computes 18+, stores only
  the outcome (`adult` / `minor` / `unverified`), the date and whether the check
  was live-mode. It never stores the date of birth, the document or the images.
  By default it then asks Stripe to **redact** the session
  (`RI_IDENTITY_REDACT=on`).
- **Test-mode checks never admit anyone in production.** A Stripe test-mode
  verification can be completed without a real document, so the pool only
  accepts a live-mode verification when `NODE_ENV=production`. The Identity key
  (`RI_STRIPE_IDENTITY_KEY`, a restricted live key with Identity permissions
  only) is separate from the payment key, so the age check can be real while
  charges stay in test mode.
- Pool admission is re-checked at queue join, at match time and before the
  handle exchange.

### 4. Human matchmaking queue (battle.net-style async)

- Player **opts into the pool** after intake (does not block on it), after a
  click-through of the dating-safety notice (NJ/TX, below).
- The queue screen shows a **live count of waiting parents**, framed as positive
  social proof: *"3 parents ready to be matched"* means a match is close, not a
  warning.
- **Notify-when-matched**, not a countdown: in-app (sound-free; the tab title
  changes) while the player is on the page. Matrix notification for players
  who have wandered off is optional and off unless a notifier token is
  configured.
- **Join window on match:** a match opens a join window (default 3 minutes).
  The shared session starts when both arrive. If one no-shows, the present
  player is **re-queued at their original place, or offered the AI co-parent**
  — never stranded.
- **Wait estimate** (v2): once there is historical data, show a typical-wait
  estimate.

**Launch realism:** at low concurrency, async human matches may rarely converge
to both-present-at-once. The **AI-parent path is the real launch product**; human
matchmaking grows with the verified pool. Meetups are where it is tested first,
because there everyone is present at once.

### 5. LLM matchmaker

An LLM reads waiting players' OCEAN + confessionals + maturity answers (as
anonymous entry ids — no names) and pairs for:

1. **Emotional safety first** — never match two people whose confessionals share
   a raw theme onto an event that would re-traumatize both (e.g. two dead-parent
   confessionals onto a child-loss scene).
2. **Gentle complementarity second** — mild preference for balancing temperaments
   (an anxious parent with a calmer one), never a hard optimization.

Judgment, not vector arithmetic. If the model call fails, the two longest-waiting
compatible entries are paired (first-in, first-out), and the fallback is logged.
Pairs blocked by a report are never matched again. The matchmaker prompt is
redacted in Langfuse traces in full, like the personality-seed prompt.

### 6. AI co-parent — double duty

- **Mentor:** models good parenting (patient, repairs conflict, names feelings) —
  on-brand with RI's "play that heals" ethos. For a minor, this warm example *is*
  the point. It speaks in the family chat as the second parent, sparingly, and
  the child answers it like any parent.
- **Clearly an AI:** it is named "AI co-parent" everywhere it appears (lobby,
  chat, report card), which is the EU AI Act Art. 50 disclosure.
- **Harm-safety observer:** every human message still goes through RI's existing
  moderation (`server/src/safety/moderation.ts`, `pattern-detection.ts`).
  **Important limitation:** that classifier detects *cruel/exploitative parenting
  toward the child* (grooming, coercion, abuse) — it is **not** an age or
  immaturity detector, and immaturity is not cruelty. Age protection rests on
  Stripe Identity, not on behavioral inference.
- **Never** introduces the dating layer.
- **Seamless takeover:** if a human partner in a stranger run disconnects and
  stays away past a grace period, the AI stands in for their seat so the shared
  child is never orphaned. If they come back, they take the seat back.

### 7. The connection handoff (the only real-contact moment)

At the end of a **two-human** stranger run only, each player independently sees
one prompt: *"Want to stay in touch? Exchange Matrix handles."* The dating-safety
notice is repeated there (its second channel). A mutual yes shows each player the
other's Matrix handle, with a `matrix.to` link. One prompt, both must opt in,
nothing else is revealed. A no from either side closes it for that child, and
the player who said yes is not told who declined.

### 8. Report and block

Either player in a stranger run can report the other at any time. A report:
closes the handle exchange for that child, blocks that pair from ever being
matched again, and suspends the reported account from the pool until an admin
reviews it (`GET /api/admin/stranger/reports`). A Matrix account banned by a
confirmed child-safety case can never enter the pool.

## Hard Safety Line

- **No minor ever reaches the stranger pool.** Pool admission requires a
  server-verified Matrix account with a live-mode Stripe Identity result of 18+
  on record. Checked at queue join and again at match.
- The end-of-run Matrix handle exchange exists **only between two
  verified-adult players on the human path.** Never on AI runs, never with a
  seat the AI is standing in for, never for minors or the unverified. Re-checked
  when the exchange is decided.
- A stranger-run seat can only be taken by the matched person: the invite link
  does not work for stranger runs, a dropped seat cannot be reclaimed by someone
  new, and device handoff is turned off for them.
- These are bright lines in the code, not soft defaults, and each has a test.

**Residual risk, stated plainly:** software cannot stop a verified adult from
handing their unlocked device to a child. That is the same limit every
age-verified service has; the report flow and the account ban are the response.

## Legal & Regulatory Findings

*Not legal advice — engineering research to scope controls; a licensed attorney
must confirm applicability before the human tier ships. Sourced from a verified
deep-research pass (24 primary/secondary sources, 24 of 25 claims confirmed).
This area is fast-moving; re-check before launch.*

Eight regimes have **verified, citable controls**. Each maps to a review
checkpoint in the phase table below.

| # | Law (citation) | Applies because | Concrete control required |
|---|---|---|---|
| 1 | **COPPA** — 15 U.S.C. 6501; amended Rule, Fed. Reg. 2025-05904 (eff. 23 Jun 2025; full compliance **22 Apr 2026**) | Free tier is open to children; threshold is **under-13** (not 16). Amended Rule now treats **biometric identifiers and gov-issued IDs as personal information**. | Neutral age gate at signup; if child-directed or actual knowledge of under-13s, verifiable parental consent (VPC) *before* any collection; third-party/targeted-ad sharing **off** absent separate opt-in VPC; **written data-retention policy** (purpose-bound, no indefinite retention); treat any selfie/faceprint or gov-ID from a minor as COPPA PI. |
| 2 | **NJ Internet Dating Safety Act** — N.J.S.A. 56:8-168 to 56:8-171 | A "NJ member" = anyone giving a NJ billing zip — so the **Stripe billing step** is the jurisdictional hook. Opt-in stranger-matching + handle exchange plausibly = an "Internet dating service" (arguable; conservative posture = comply). Enforced (Bumble consent order, $315k, Feb 2024). | Post a **safety-awareness notice**; if no criminal background checks are run, disclose that to NJ members in **2+ channels** (email / click-through / profile / signup), in **bold, CAPITAL letters, ≥12-pt type**. |
| 3 | **TX Internet Dating Safety Act** — Tex. Bus. & Com. Code Ch. 106 (§§106.001, .004, .006) | Broad "online dating service provider" definition, no "primarily engaged" limiter; same billing-based hook. | Same as NJ (bold/caps/≥12-pt no-background-check disclosure + safety notice). **One combined multi-state disclosure template** satisfying the strictest rule covers both. |
| 4 | **Biometric privacy** — IL **BIPA** 740 ILCS 14/15; TX **CUBI**; (WA RCW 19.375 **excludes** photo-derived data) | Stripe Identity's **selfie face-geometry** is a biometric identifier under BIPA/CUBI. *Cothron v. White Castle* (2023) = per-scan liability. Stripe states it is **not** the compliance owner. | **Informed written consent screen BEFORE** the selfie step; published **retention/destruction schedule**; configure Stripe so biometric templates aren't retained beyond need. (No legal duty to offer a non-biometric alternative — *refuted 0-3* — though it's good practice.) |
| 5 | **UK Online Safety Act 2023** — Part 3/5; Ofcom HEAA Guidance (24 Apr 2025) | Service likely accessed by UK children with an adult tier must use **"highly effective age assurance" (HEAA)**. Self-declaration / debit-card / T&C age limits are **not** HEAA. Reddit fined £14.47m (Feb 2026). | Deploy a **HEAA method** to separate the child tier from the adult tier — Stripe Identity photo-ID matching / facial age estimation qualifies; **document the choice against Ofcom's criteria**. |
| 6 | **EU GDPR age assurance** — EDPB Statement 1/2025; GDPR Arts. 5(1)(c), 6, 9(2), 35 | Age/biometric verification of EU users is high-risk special-category processing. | **DPIA (Art. 35) signed off before** any EU user hits verification; documented **Art. 6 basis + Art. 9(2) exception**; privacy-preserving design (store **age-attribute confirmation only**, not raw IDs/biometrics). |
| 7 | **EU age-verification blueprint** (v2, 10 Oct 2025) + **DSA** minor-protection | DSA-covered user-to-user functionality in the EU. | Align device-based age verification with the **blueprint / EUDI-wallet** reference to evidence DSA compliance. |
| 8 | **CSAM reporting** — 18 U.S.C. 2258A (+2258E; REPORT Act 2024) | RI **self-hosts a Matrix server** carrying private messages → covered provider. Trigger = **actual knowledge** of apparent CSAM. **No** proactive-scan duty (§2258A(f)). | **Register with NCMEC**; stand up a **CyberTipline reporting workflow + evidence-preservation** procedure; train moderation/support on the actual-knowledge trigger — all before private messaging goes live. |

### Data-handling notes (carry into design)
- **Confessionals** are intimate free-text that blend into a shared child *and*
  feed the LLM matchmaker — a co-parent could reverse-infer a partner's themes
  from the seeded child. Define retention, who can read them, and whether raw
  confessionals are ever exposed cross-partner. (Interacts with COPPA #1, GDPR #6.)
- **Stripe Identity** returns real identity documents. Store verification
  *status*, not documents (aligns #4, #6). The **age gate** must be an actual
  Stripe Identity check (doc + selfie), **not** a card charge — a parent's card
  does not verify age. (Since 2026-11-22 the payment and the age check are
  separate steps, so this can't be blurred by accident.)

### Open questions — asked but NOT yet verified (need dedicated legal follow-up)
These regimes are in-scope but produced no surviving verified claim; treat as
**known gaps**, not cleared:
1. **US state minor social-media / design-code laws** — CA AADC (post-9th-Cir.),
   Utah Minor Protection in Social Media Act, TX SCOPE Act / HB 18 + app-store
   age-verification, FL HB 3: which survived injunction, and is RI a "covered
   platform" under each?
2. **EU AI Act Art. 50** — duty to disclose to users they're interacting with an
   AI (directly relevant to the **free-tier AI co-parent**); applies **from 2 Aug
   2026**. Confirm exact UI implementation. *(Unverified but near-certain — build
   the disclosure in.)*
3. **EU CSAM Regulation ("Chat Control")** — adoption status as of 2026 and
   whether it adds detection duties on the Matrix server beyond §2258A.
4. *(Moot since 2026-11-22: no subscription.)* **Auto-renewal / subscription law** — FTC "Click-to-Cancel" Rule was **vacated
   by the 8th Cir. (July 2025)**; California ARL (Bus. & Prof. 17600 et seq., SB
   313) still applies. Confirm before wiring Stripe recurring billing.
5. **UK ICO Children's Code (AADC)** — map the free child tier against its 15
   standards (default high-privacy, data minimization, profiling off by default).

## Review Checkpoints (mapped to build phases)

Each checkpoint must be **verified before that phase ships to production**. The
human/dating tier is blocked on Phase-4 legal sign-off in full.

*Added 2026-11-22:* all phases are built, but they ship to production behind
switches that are off (`RI_PARTNER_PAYWALL`, `RI_STRANGER_MODE`). "Ships to
production" below means "is switched on for the public". Liz's meetup sessions
(`RI_STRANGER_MODE=meetup`) are where she checks these items herself; the
checklist of what she still has to confirm is in the implementation plan.

**Phase 0 — Legal groundwork (before anything ships publicly)**
- [ ] Engage counsel; confirm applicability of the eight regimes + five open
  questions to RI's model and target geographies.
- [ ] Draft privacy policy + **written data-retention policy** (COPPA #1, GDPR #6).
- [ ] Decide launch geographies (US-only first materially narrows UK/EU load).

**Phase 1 — Free AI-parent tier + intake maturity items**
- [ ] **COPPA (#1):** neutral age gate; no under-13 PI to third parties without
  VPC; retention policy live. Re-verify if/when any analytics or ad SDK is added.
- [ ] **AI Act Art. 50 (open-Q 2):** AI co-parent clearly disclosed as AI at
  first interaction.
- [ ] **UK Children's Code (open-Q 5):** free child tier defaults to high-privacy,
  profiling off.

**Phase 2 — Age/ID verification (Stripe Identity)**
- [ ] **BIPA/CUBI (#4):** written biometric-consent screen renders *before* the
  selfie step; retention/destruction schedule published; Stripe retention configured.
- [ ] **UK HEAA (#5):** verification method meets HEAA criteria and blocks the
  human path for anyone not verified-adult; choice documented vs. Ofcom criteria.
- [ ] **GDPR (#6):** DPIA signed off and Art. 6 / Art. 9(2) basis documented
  *before* any EU user hits the flow; store age-attribute only, not documents.
- [ ] **EU blueprint (#7):** device-based approach evaluated against the reference model.

**Phase 3 — One-time $20 per-child payment** (*superseded:* "Paid
subscription + recurring billing")
- [x] ~~**Auto-renewal (open-Q 4):** CA ARL disclosures + easy-cancel.~~ No longer
  applies: there is no recurring billing. Re-open if a subscription ever returns.
- [ ] Receipts (Stripe's own emailed receipt, turned on in the Stripe dashboard),
  a refund path (admin endpoint) and refund wording reviewed.
- [ ] **AI companion-chatbot laws** (CA SB 243 and the WA/OR/ID equivalents) —
  from the funding plan's Tier 2: counsel review before the paywall goes live.

**Phase 4 — Matchmaking queue + dating handoff + Matrix private messaging**
- [ ] **NJ + TX dating-safety (#2, #3):** member detection by billing zip;
  combined bold/caps/≥12-pt no-background-check disclosure + safety notice in 2+
  channels incl. a click-through captured at opt-in.
- [ ] **NCMEC / §2258A (#8):** CyberTipline reporting pipeline + evidence
  preservation live; staff trained on the actual-knowledge trigger — **before**
  any adult-to-adult private contact is enabled.
- [ ] **EU CSAM Regulation (open-Q 3):** re-check status; add detection duties if adopted.
- [ ] **Final legal sign-off** on the full human/dating tier — the bright-line
  gate before this tier is enabled in production.

## Reused vs. New

**Reused (do not rebuild):**
- Two-parent personality blend + confessional intake (`personality.ts`).
- Socket lobby / create-join / ready / two-slot session
  (`socket/protocol.ts`, `session-manager.ts`).
- Scene-safety moderation (`safety/pattern-detection.ts`) — for *harm*, per the
  limitation above.
- Matrix sign-in (existing `userId` on create/join payloads).
- ~~Org-wide Stripe wiring.~~ The shared `stripe-webhook` service runs on the studio's live key and has no callback, so RI integrates Stripe directly with its own (test-mode) keys.

**New:**
- Maturity items appended to intake.
- Matchmaking queue service (opt-in pool, live count, LLM pairing, notify,
  join-window handshake, re-queue/AI fallback).
- LLM matchmaker prompt + call.
- $20 per-child Checkout (host pays when the partner joins) + signed webhook.
- Server-verified Matrix accounts (OpenID) + Stripe Identity age check.
- AI-parent mentor/observer role + mid-run takeover.
- End-of-run mutual handle-exchange prompt + Matrix connect.

## Success Criteria

- Solo play and invite partner play are unchanged while the switches are off.
- Free AI-parent runs remain unwalled.
- A verified adult can enter the pool, see the live count, and be matched +
  notified in-app.
- The host is charged exactly once per two-human child, only after the partner
  has joined; never for a no-show, never twice.
- A dropped human partner is replaced by the AI with no orphaned child.
- The handle exchange fires only on mutual opt-in between two verified adults.
- No path lets an unverified user or a minor reach the human pool or the handle exchange.
- Stranger mode is invisible and unreachable while `RI_STRANGER_MODE=off`.
