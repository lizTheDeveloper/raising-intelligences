# Incidental Co-Parenting Matchmaking — Design

**Date:** 2026-07-31
**Status:** Draft for review
**Game:** Raising Intelligences (RI)

## Summary

Add **random-matched co-parenting** to Raising Intelligences: two strangers are
paired to raise one AI child together. The child's personality is a genetic +
emotional blend of both parents (RI's existing two-parent mechanic). The run is
played blind — display names only, no profiles, no dating UI. At the end of a
two-human run, each player independently sees **one** prompt — *"Want to stay in
touch? Exchange Matrix handles"* — and a mutual yes connects them on
`matrix.multiversegames.ai`. The dating is entirely emergent; the only artifact
is a handle exchange both people chose.

Access to the human-stranger path is a **paid, age-verified subscription**. The
paywall and the age gate are the same wall: subscribing runs a Stripe Identity
check, which both proves adulthood and funds the feature. Everyone else — free
users, minors, the unverified, and anyone in an empty queue — plays the same
game against a warm **AI co-parent**, for free, forever.

## Motivation

- **The hook:** co-parenting is an exceptional compatibility revealer — warmth,
  conflict style, values, how someone behaves when the "child" struggles. Far
  more signal than a dating profile, and *incidental*: nobody performs, so you
  see the real person. "Raise a kid with a stranger, discover you're compatible."
- **Monetization that doesn't fight safety:** the same verified-payment step that
  keeps minors out of the adult-stranger pool is the recurring revenue line. The
  core game stays free; only *being matched with real people* costs money.
- **Growth loop:** the connection payoff lives on the Multiverse Matrix server,
  so successful matches drive Matrix sign-ups.

## Non-Goals

- No dating profiles, swiping, preferences, or "it's a match!" screen.
- No changes to the free single-player / AI-parent experience beyond the intake
  additions and the AI-parent's expanded role.
- No wait-time estimates at launch (v2 — requires historical data).
- No claim, anywhere, that any in-game instrument *verifies age*. Age is verified
  only by Stripe Identity at subscription.

## Product Tiers

| | Free tier | Paid tier (subscription) |
|---|---|---|
| Co-parent an AI child | ✅ unlimited | ✅ |
| Human matchmaking pool | ❌ | ✅ |
| End-of-run Matrix handle exchange | ❌ | ✅ (mutual opt-in only) |
| Age verification | none required | **Stripe Identity on subscribe** |
| Open to minors | ✅ (AI parent only) | ❌ |

The free tier is RI's soul and is never walled. The paid tier unlocks exactly
two things: the human pool and the contact handoff.

## Core Flows

### 1. Intake (extends the existing instrument — does not replace it)

RI already collects, per parent: **OCEAN scores (5)** + **two confessionals**
(free-text emotional themes). These already combine to seed the child's
personality (`server/src/game/personality.ts`). We **add a few maturity items**
to the *same* intake flow. This one instrument does three jobs:

1. Soft-filters obvious immaturity and sets a serious tone.
2. Feeds the child's personality seed (unchanged behavior).
3. Provides the signal the LLM matchmaker reads.

There is no second, separate quiz. The maturity items are a *soft filter and
tone-setter only* — explicitly **not** an age gate.

### 2. The fork (gate is a routing decision, not a wall)

After intake, the player is routed:

- **Verified subscriber** → the human matchmaking queue.
- **Everyone else** (free, unverified, anonymous, minor) → an **AI co-parent**,
  instantly. Same full parenting experience.

No one ever sees a "you can't play" screen. The AI path is the default and the
fallback.

### 3. Human matchmaking queue (battle.net-style async)

- Player **opts into the pool** after intake (does not block on it).
- The queue screen shows a **live count of waiting parents**, framed as positive
  social proof: *"3 parents ready to be matched"* means a match is close, not a
  warning.
- **Notify-when-matched**, not a countdown: in-app if the player is still on the
  page, **via Matrix if they've wandered off or the wait is long**. The Matrix
  account is both the adult gate and the notification channel — one more reason
  the human path requires being signed in.
- **Join window on match:** because matching is async, the two humans may not be
  online at the same instant. A match opens a join window; both are pinged; the
  shared session starts when both arrive. If one no-shows within the window, the
  present player is **re-queued or offered the AI parent** — never stranded.
- **Wait estimate** (v2): once there is historical data, show a typical-wait
  estimate; deliver long-wait notifications over Matrix.

**Launch realism:** at low concurrency, async human matches may rarely converge
to both-present-at-once. The **AI-parent path is the real launch product**; human
matchmaking is the tier that grows as the verified-subscriber pool grows. This is
stated so success is measured honestly, not against a co-equal-paths assumption.

### 4. LLM matchmaker

An LLM reads both waiting players' OCEAN + confessionals + maturity answers and
pairs for:

1. **Emotional safety first** — never match two people whose confessionals share
   a raw theme onto an event that would re-traumatize both (e.g. two dead-parent
   confessionals onto a child-loss scene).
2. **Gentle complementarity second** — mild preference for balancing temperaments
   (an anxious parent with a calmer one), never a hard optimization.

Judgment, not vector arithmetic — honest at low queue volume, where a heavy
compatibility algorithm would be a false promise.

### 5. AI co-parent — double duty

- **Mentor:** models good parenting (patient, repairs conflict, names feelings) —
  on-brand with RI's "play that heals" ethos. For a minor, this warm example *is*
  the point.
- **Harm-safety observer:** watches the human's play and routes genuinely harmful
  parenting through RI's existing scene-safety moderation
  (`server/src/safety/pattern-detection.ts`).
  **Important limitation:** that classifier detects *cruel/exploitative parenting
  toward the child* (grooming, coercion, abuse) — it is **not** an age or
  immaturity detector, and immaturity is not cruelty. The AI observer therefore
  flags *harm*, and does **not** reliably catch "this user is a minor." Age
  protection rests on Stripe Identity, not on behavioral inference.
- **Never** introduces the dating layer.
- **Seamless takeover:** if a human partner disconnects or rage-quits mid-run,
  the AI takes over the empty slot so the shared child is never orphaned.

### 6. The connection handoff (the only real-contact moment)

At the end of a **two-human** run only, each player independently sees one
prompt: *"Want to stay in touch? Exchange Matrix handles."* Mutual yes connects
them on `matrix.multiversegames.ai` (prompting Matrix account creation if
needed). One prompt, both must opt in, no profiles revealed otherwise.

## Hard Safety Line

The end-of-run Matrix handle exchange exists **only between two verified-adult
subscribers on the human path.** Never on AI runs, never for minors, never for
free or anonymous users. This is a bright line in the code, not a soft default.

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
  *status*, not documents (aligns #4, #6). The paywall must be an actual Stripe
  Identity check (doc + selfie), **not** a mere card charge — a parent's card
  does not verify age.

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
4. **Auto-renewal / subscription law** — FTC "Click-to-Cancel" Rule was **vacated
   by the 8th Cir. (July 2025)**; California ARL (Bus. & Prof. 17600 et seq., SB
   313) still applies. Confirm before wiring Stripe recurring billing.
5. **UK ICO Children's Code (AADC)** — map the free child tier against its 15
   standards (default high-privacy, data minimization, profiling off by default).

## Review Checkpoints (mapped to build phases)

Each checkpoint must be **verified before that phase ships to production**. The
human/dating tier is blocked on Phase-4 legal sign-off in full.

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

**Phase 3 — Paid subscription + recurring billing**
- [ ] **Auto-renewal (open-Q 4):** CA ARL disclosures + easy-cancel implemented;
  confirm current FTC negative-option posture at build time.

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
- Org-wide Stripe wiring.

**New:**
- Maturity items appended to intake.
- Matchmaking queue service (opt-in pool, live count, LLM pairing, notify,
  join-window handshake, re-queue/AI fallback).
- LLM matchmaker prompt + call.
- Subscription + Stripe Identity gate distinguishing free vs. paid path.
- AI-parent mentor/observer role + mid-run takeover.
- End-of-run mutual handle-exchange prompt + Matrix connect.

## Success Criteria

- Free AI-parent runs are unchanged in quality and remain unwalled.
- A verified subscriber can enter the pool, see the live count, and be matched +
  notified (in-app and via Matrix).
- A dropped human partner is replaced by the AI with no orphaned child.
- The handle exchange fires only on mutual opt-in between two verified adults.
- No path lets an unverified user reach the human pool or the handle exchange.
