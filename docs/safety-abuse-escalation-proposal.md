# Proposal: escalation policy for child-directed abuse flags

**Status:** awaiting decision (Liz)
**Author:** Claude Code, 2026-07-18
**Trigger:** the "Stanky" session (game `52d9a311`, 2026-07-15) — a player used the
parent role to direct sustained verbal abuse and a physical-violence threat at a
3-year-old child character, and mocked the Fred/Mr. Rogers persona directly.

## What already works (deployed, HEAD 26a53a7)

1. **Detection.** The end-of-scene pattern check (`pattern-detection.ts` +
   `routes/game.ts` / `socket/handlers.ts`) correctly flagged this scene as
   *"sustained verbal abuse and humiliation … escalating to threat of physical
   violence ('belt') … trauma response, not discipline."* No new classifier is
   needed — detection is not the gap.
2. **Session termination.** The flag ends the session (`applyModerationBlock`).
3. **IP capture.** The offending IP is persisted to `moderation_flags`
   (`107.115.43.60` here).

## The gap

By deliberate decision (`b5c306e`), scene-level flags set **`banIp: false`** —
they flag + end the session but do **not** permanently ban the IP. Rationale:
scene-level pattern detection can fire on intense-but-normal parenting, and a
permanent ban is a heavy, false-positive-prone action. So a determined abuser
whose session is ended can simply start a new game.

There is currently **no operational path** between "flag captured for review" and
"human decides to ban" — the admin dashboard (`routes/admin.ts`) is read-only and
does not surface moderation flags at all. The Stanky IP was banned only because a
human went into the DB by hand (2026-07-18).

## Options

### A. Human review queue + one-click ban  *(recommended primary)*
- Add an admin view listing `moderation_flags` (game, scene, reason, IP, ban state).
- Add an admin action → `repo.banIp(ip, reason)` and, optionally, unban.
- **Pros:** lowest false-positive risk; keeps a human in the loop for the
  consequential action; operationalizes exactly what was just done by hand;
  purely additive — does not change any auto-ban behavior.
- **Cons:** requires someone to look; not instant.
- **Effort:** small. New read + one write endpoint behind existing admin auth; a
  simple table UI.

### B. Repeat-offender auto-ban  *(recommended to pair with A)*
- Auto-ban an IP that accumulates **N ≥ 2** child-directed-abuse scene flags
  across **distinct games**.
- **Pros:** targets deliberate/returning abusers; a real parent essentially never
  trips the sustained-abuse scene classifier across multiple separate games by
  accident, so false-positive risk is very low; preserves the "don't ban on a
  single ambiguous flag" design.
- **Cons:** still an automated ban; needs a per-IP flag counter (query
  `moderation_flags` by ip_address).
- **Effort:** small–medium. A count check inside the existing scene-flag path.

### C. Severity-tiered auto-ban on first flag
- Have the scene classifier separate "intense/ambiguous parenting" from
  "unambiguous, intentional abuse/trolling directed at the child" and auto-ban
  only the latter on the first occurrence.
- **Pros:** instant for egregious cases.
- **Cons:** puts a permanent-ban decision entirely on classifier judgment on a
  single scene — highest false-positive risk; reverses `b5c306e` most directly.
  Not recommended without A as a safety net.

### D. Do nothing
- Session termination stands; permanent bans stay reserved for the per-message
  grooming/sexual path. Stanky is handled (manually banned). Accept that
  determined verbal abusers can restart.

## Recommendation

**A + B.** Build the human review queue (A) so flags are visible and one-click
bannable, and add repeat-offender auto-ban (B) so returning abusers are stopped
without waiting on a human — while single ambiguous flags still only end the
session, preserving the deliberate `b5c306e` stance. Hold off on C.

## Notes / guardrails

- Everything here must preserve the existing care about **not** penalizing
  ordinary hard parenting (see the extensive comments in `pattern-detection.ts`).
- `adult_chat` phase is already exempt from per-message moderation; confirm the
  scene-flag counting also excludes any phase where the "child" is an adult.
- Bans are IP-based; shared-NAT collateral is possible. The review queue (A)
  should support unban. Consider TTL'd bans rather than permanent for category B.
- Local repo checkout is behind deployed (7f224ef vs 26a53a7); sync before
  implementing.
