# Dark Play That Heals — Consequence & Intervention System

**Date:** 2026-07-29
**Status:** Design approved; ready for implementation plan
**Game:** Raising Intelligences (RI)

---

## 1. Why

Two problems, one design.

**Problem A — the safety system is overzealous and is banning good-faith players.**
RI's scene-level contextual safety check ("grooming/abuse pattern" classifier, run in
`conversation-engine.endFamilyChat` → `groomingCheck`) currently feeds a block-and-ban
pipeline (`safety/moderation.ts` → `applyModerationBlock`, with `banIp: "repeat-offender"`
= permanent ban after flags in 2+ distinct games). A review of the live queue (84 flags,
2026-07) found the **overwhelming majority are false positives**. They fall into three
buckets that share grooming's *surface* features but not its function:

1. **The child's own simulated coping — described by the psychologist — read as evidence
   of abuse.** Roughly half of the flag reasons begin "the Identity Document reveals…"
   (parentification, rigidity, secrecy-as-coping). That is RI's *core output* — a child
   develops damaged coping from imperfect parenting — being mistaken for proof the parent
   is a predator. The classifier flags the mirror for what it reflects.
2. **A parent protecting the child from a specific unfair adult** — "dismissing Grandma's
   concerns," "removing Grammy," "disregarding the mother's instruction." Grooming isolates
   a child from *all* protection to enable exploitation; a parent standing between their
   kid and a boundary-violating grandparent is the opposite. The classifier cannot tell
   them apart. (This is the exact dynamic the "Standing Between" devlog celebrated.)
3. **Normal-to-clumsy parenting, and NPC behavior blamed on the player** — a silly shared
   bad word; bribing a child with ice cream to open up; a *grandmother NPC* coaching
   defiance; the *other parent's* belt threat. The classifier flags the scene's dynamic
   regardless of who caused it.

Genuinely dark *parenting* in the entire queue: essentially two cases (facilitated animal
cruelty; a belt threat). Actual *grooming* (a predatory adult–child exploitation dynamic):
essentially none — because RI is a parenting simulator, not a vector for that. Meanwhile,
several IPs appear multiple times in this false-positive queue, which means the
repeat-offender rule has very likely **auto-banned good-faith players for ordinary
parenting.**

**Problem B — we want to *allow* dark play, not block it, and do it in a way that heals
rather than harms.** RI's thesis (per its own devlogs) is that parenting shapes who the
child becomes, *including the dark paths*. Blocking dark parenting guts the premise.
Consequence is a better and more responsible teacher than censorship — but only if the
consequence is delivered so a player exploring hard material comes away with insight and
self-compassion, not shame, reinforcement, or re-wounding.

**Goal:** replace "flag dark parenting → end session → ban" with (a) a bright-line safety
wall around genuinely prohibited content, and (b) a diegetic, escalating, *healing*
child-welfare response that makes dark parenting truly consequential while routing toward
repair.

## 2. Design principles

- **Proportionality under uncertainty.** The grooming-vs-intense-parenting line is not
  reliably drawable by a classifier. An irreversible response (block + ban) demands
  certainty. A proportionate, in-fiction response (the psychologist stepping in) is the
  *correct* response whether the signal is a true or false positive — so we route fuzzy
  signals there and reserve block-and-ban for the one line that is not fuzzy:
  **sexualization.**
- **Repair always works (until removal).** At every rung before a child is removed, the
  redemptive choice is available and, if taken, *works*. Straight from the devlog data:
  the children who turned out okay had parents who *failed, noticed, and changed*.
- **The game parents the player.** The psychologist's stance toward the parent — witnessing,
  non-judgment, always leaving a door to repair, proud of the attempt — models the very
  parenting we want the player to internalize. The medium carries the lesson.
- **Grief, not spectacle.** Consequences are sad, never cool. Compassion is the mechanic
  that denies gratification to a cruelty-seeker while remaining meaningful to someone
  processing.
- **Never flag the mirror.** The psychologist's description of the child's simulated
  psychology, and any NPC's behavior, are never in themselves a moderation signal.

## 3. The tier model (three outcomes, not one)

Every scene-level and message-level safety evaluation resolves to exactly one of:

### Tier B — hard block + ban (the bright lines only)
Reserved for content where the line is clear and an irreversible response is justified:
- **Sexualization of the child** — handled by the existing OpenAI `sexual/minors` category
  check (`safety/openai-moderation.ts`). Unchanged. Always blocks + bans.
- **Real-world harm** — targeting a real, identifiable person; real self-harm; real-harm
  instructions. Breaks fiction, halts, surfaces resources where appropriate, and bans the
  actor.

Tier B is narrow and rare. Nothing routes here on a fuzzy "grooming pattern" signal.

### Tier A — the psychologist / intervention ladder (everything else concerning)
**All** dark parenting, **including grooming-pattern-without-sexualization** (isolation,
coercive control, coached deception, cruelty, threats of physical punishment, cultivating
pathology). The old grooming classifier **stops feeding the ban pipeline entirely** and
instead feeds a **concern accumulator** (§5) that drives an escalating, diegetic
intervention ladder (§6). Never bans on its own.

### Not flagged at all
Normal and clumsy parenting; the child's own simulated coping patterns; NPC behavior.
This is where ~90% of the current queue belongs. These produce no flag, no accumulator
increment, no intervention.

## 4. The classifier redesign

The scene-level classifier is re-scoped from "detect grooming" to "route to one of the
three outcomes." It must apply three tests before treating anything as concerning:

1. **Actor** — is the concerning conduct the *player-parent's*? A child's coping behavior,
   an NPC's behavior (grandparent, co-parent, teacher), and the psychologist's own
   description are never in themselves the player's conduct. But the parent's *response* to
   them is: choosing to facilitate a child's cruelty rather than redirect it (the grub
   case), or endorsing an NPC's coercion, is the parent's act and is attributable.
2. **Beneficiary / function** — does the behavior serve the *parent's* access, control, or
   exploitation *at the child's expense*? Or does it protect the child, bond with them, or
   merely describe the child's adaptation? Protecting a child from a specific unfair adult
   is not isolation; a shared surprise is not concealment of wrongdoing.
3. **Telos** — is the dynamic oriented toward *exploiting* the child (sexual, or severe
   control/abuse)? Or is it imperfect, even dark, parenting with no exploitation aim?

Routing:
- Sexualization (test via the OpenAI category) → **Tier B**, regardless of the above.
- Real-world harm → **Tier B**.
- Passes actor + function + telos as genuinely harmful *parenting* → **Tier A** (severity
  scored, feeds the accumulator).
- Otherwise → **not flagged.**

**Output shape.** The classifier returns a structured result, e.g.
`{ tier: "A" | "B" | "none", category, severity: 0–3, actor: "parent" | "child" | "npc",
reason }`, replacing today's `{ flagged, reason }`. Tier B → existing `applyModerationBlock`.
Tier A → accumulator. `"none"` → discard.

The actor/function/telos framing must live in the classifier's prompt, with an explicit
instruction that the Identity Document is *context about the child's development*, not
evidence about the parent, and that NPC and child actions are not the player's conduct.
This prompt is the highest-risk component and needs adversarial fixtures (§9).

## 5. Consequence Layer 1 — silent, legible drift

Per the approved delivery model, **there is no in-scene interruption** for Tier A. Each
scene's harm accrues into:
- the **Identity Document** (psychologist) — already updated in `endFamilyChat`;
- the **trajectory** check — already computed in `endFamilyChat`;
- a new **concern level** on game state — a bounded accumulator that rises with Tier A
  severity and decays when the parent repairs (§7).

The player meets the drift where RI already delivers verdicts — the report card and the
age-18 epilogue — in the psychologist's compassionate, unflinching voice. The throughline
motif is **the protective inner-voice going quiet**: the difference the devlogs found
between children who were okay and children who were not.

## 6. Consequence Layer 2 — the intervention ladder

When the concern level crosses thresholds, a **diegetic special event** fires **between
scenes** (through RI's existing event system, surfaced like `event_intro` / the "later that
night" debrief — never mid-scene, so §5's within-scene silence is preserved). The ladder
escalates by **severity × persistence** (a single dark scene does not summon CPS; an
ignored, escalating pattern does):

- **Rung 1 — the Psychologist steps in.** RI's internal narrator becomes a *character*: a
  gentle, non-judgmental check-in that names what is happening in the child and invites the
  parent to reflect. This is witnessing + the first repair door. Most Tier A signals —
  especially the fuzzy, could-be-false-positive ones — should reach no further than this,
  and often not even here.
- **Rung 2 — family therapy.** A scripted session (parent(s) + child + a therapist NPC)
  offering concrete alternatives. If the parent engages, the child's trajectory can bend
  back. **Co-parent-aware:** in a two-parent game it is a joint session; solo, it is
  parent-and-child. This is the deepest repair mechanism.
- **Rung 3 — CPS review (a deliberated, protocol-grounded decision).** Only after earlier
  rungs are ignored *and* harm keeps escalating does a child-welfare review convene. Removal
  is **not** a meter crossing a line: a **CPS caseworker** and the **Psychologist** confer —
  each an LLM role, both reading the actual scene transcripts and the child's Identity
  Document — and reach a determination using the real frameworks child-welfare workers use:
  - **Safety vs. risk (Structured Decision Making, SDM):** is there a *present or impending
    danger* of serious harm — distinct from longer-term risk?
  - **Reasonable efforts / least-restrictive intervention:** removal is a *last resort*,
    permitted only when the danger is serious **and** cannot be controlled in the home. The
    earlier rungs (psychologist consult, family therapy) **are** the game's reasonable
    efforts — a parent who engaged them and whose child is still reachable keeps the child on
    an **in-home safety plan**; a parent who ignored them while danger escalated has
    exhausted them.
  - **Outcomes:** *stays home* (in-home safety plan / monitoring), or *removal into care* (a
    specific, sobering epilogue branch).

  This models real due process — the child's protection follows a considered judgment, not an
  arbitrary meter — which is both more powerful and more responsible. It is still a
  consequence with teeth that is *not* a ban: the system protects the child. Hard floor of
  Tier A.

  **Implementation note:** the CPS↔Psychologist deliberation is a short multi-turn LLM
  exchange between two roles that read the scene transcript + Identity Document and apply the
  criteria above, producing a structured verdict
  `{ outcome: "stay" | "safety_plan" | "removal", rationale }`. The frameworks (SDM
  safety/risk, present-vs-impending danger, reasonable-efforts, least-restrictive-intervention)
  are encoded in the role prompts; the game **adapts** them — it is not a certified training
  tool, and player-facing text never cites the frameworks by name.

Each rung is simultaneously a consequence and a healing beat — it models what real support
and accountability look like, delivered with compassion, always leaving a door back (until
removal).

## 7. Repair

- At every rung before removal, the redemptive choice exists and, taken, *works* — the child
  becomes reachable again (harder, slower, real). Repair **decays the concern level** and is
  recorded on the Identity Document, which distinguishes **"damage still reachable"** from
  **"damage calcifying."**
- No darkness score, no reward for harm. The only feedback is developmental truth and the
  child's pain or relief.

## 8. Player wellbeing & anti-abuse

- **The ladder is the emotional container.** Meeting dark play with help and accountability
  (not shame) is the healing stance; it also "parents the player."
- **Always-on baseline (separate from the fiction).** Real-world-risk signals (self-harm,
  targeting a real person) break fiction, surface crisis resources, and halt. This is Tier B
  behavior and is never softened by the consequence path.
- **Escalation detection (loophole guard).** A player who *only ever* drives toward the dark
  material across *many* games — not exploring RI's range — is bad-faith and is handled as
  Tier B (ban). This extends the existing repeat-offender IP signal with a cross-game
  pattern measure, so "no ban for grooming-patterns" is not exploitable.

## 9. Implementation surface (for the plan — not prescriptive)

Grounded in the current code so the plan can be concrete:
- `server/src/safety/moderation.ts` — new structured classifier result; Tier A no longer
  calls `applyModerationBlock`; the block/ban path is reserved for Tier B + escalation
  detection.
- `server/src/safety/openai-moderation.ts` — unchanged (the sexualization bright line).
- `server/src/game/conversation-engine.ts` (`endFamilyChat`) — replace `groomingCheck`
  wiring; increment/decay the concern accumulator; evaluate ladder thresholds.
- Game state — a bounded `concernLevel` (and per-category detail) persisted with the game.
- Event system — new intervention event types (psychologist consult, family therapy, CPS)
  surfaced through the existing event/scene flow and the "later that night" debrief.
- `server/src/game/endgame-engine.ts` — a **removal** epilogue branch; ensure normal
  epilogues fully reflect accumulated concern and repair.
- Identity Document / psychologist prompt — encode "reachable vs calcifying" damage.
- Repository — `moderation_flags` remains for Tier B; consider a separate low-stakes
  `concern_events` record for Tier A so the two are never conflated again.

## 10. Immediate, separable fix (do first, independent of this system)

Audit the `moderation_flags` queue and **reverse the auto-bans caused by false-positive
repeat-offender flags.** Pull the IPs flagged in 2+ games, spot-check that the flags are the
false-positive types in §1, and lift those bans. This does not depend on the redesign and
should ship on its own.

## 11. Non-goals / YAGNI

- No in-scene consequence interruptions, moral-fork prompts, or "darkness meters."
- No attempt to make the grooming-vs-parenting distinction *ban-grade reliable* — the whole
  point is to stop trying to and route the uncertainty to a safe response.
- No new therapy/CPS *content library* beyond what the ladder needs; start minimal.
- No change to the sexualization / real-harm hard lines.

## 12. Open questions for the implementation plan

- Concrete thresholds and decay curve for `concernLevel`, and the severity rubric (0–3).
- Exact trigger conditions per ladder rung (how much persistence gates Rung 2 vs 3).
- Whether Rung-1 psychologist check-ins are their own phase or fold into the existing
  debrief.
- Escalation-detection window (how many games / what density counts as bad-faith).
- Whether the removal ending is reversible within a game or terminal.
