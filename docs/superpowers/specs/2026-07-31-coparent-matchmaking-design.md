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

## Open Risks & Required Sign-offs

1. **Legal review required (blocking for launch of the human tier).** Matching
   strangers — with a residual chance of an undetected minor — into private
   post-run contact is exactly the surface online-safety / COPPA-type regimes
   target. Stripe Identity mitigates but does not by itself discharge whatever
   the specific obligations are. This must go to whoever owns legal before the
   human tier ships. Do not treat the verification step as self-clearing.
2. **PII / data handling.** Two new categories of sensitive data:
   - **Confessionals** are intimate free-text. They blend into a shared child
     *and* are fed to the LLM matchmaker, so a co-parent could reverse-infer a
     partner's confessional themes from the seeded child. Define retention, who
     can read them, and whether raw confessionals are ever exposed cross-partner.
   - **Stripe Identity** returns real-world identity documents. Follow Stripe's
     handling guidance; store verification *status*, not documents.
3. **Verification strength.** The paywall must be a Stripe Identity check
   (document + selfie), not merely a successful card charge — a card alone
   (a parent's card) does not verify age.

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
