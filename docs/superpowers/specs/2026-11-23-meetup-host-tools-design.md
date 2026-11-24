# Meetup Host Tools: Product Spec (v3, final)

**Game:** Raising Intelligences (RI)
**Author:** CPO (product loop, round 3)
**Status:** Approved for prototype (2026-11-23). The build follows the "Build plan for the prototype" section at the end.
The "Liz decides" list (§13) stays **open**: those are Liz's decisions, and nothing in the build settles them.
**Lineage:**
- `spec-v1.md`, reviewed by `panel-v1.md` and `privacy-v1.md`;
- `spec-v2.md`, reviewed by `round3.md`;
- this document.

Where v3 says "as v2", the v2 text stands unchanged. The v1 and v2 specs and the three reviews (persona panel, privacy review, round 3) are working documents and are not in this repo.

**Checked against:** `raising_intelligences` origin/main at 2.8.4 (`7a319be`, re-fetched this round).

---

## Round 3 changelog

The reviewer's core point is right. v2 let hosts in or kept them out by **category** (faith, dating, health). It should decide by **what data reaches the host**. v2's Phase A gate shut out both hosts in Liz's brief, even though L0 already gives the dating company nothing and share codes already give the counsellor only what a pair hands over.

| # | Round 3 change | Decision | Notes |
|---|---|---|---|
| 1 | Prototype track P: share codes, guest reader, discussion deck, unlinked "we came together", L0 for events businesses | **Accept, merged into one prototype** (§11) | The prototype is now Phase A plus Track P, built and shipped together. Events-business L0 hosting stays gated on Q8a. Until then the business promotes a studio event, which needs no build. |
| 2 | Funnel outcome cells become proportions, at ≥10 games started (B5) | **Accept** | §4.2. |
| 3 | One share step for every finished game; a no looks like waiting; codes appear only on the account page after a random delay (B1, B3) | **Accept** | §5.1. The delay reuses the handle exchange's random-delay pattern (`service.ts` `scheduleEnding`), with its own 2–10 minute range. |
| 4 | A code carries the report card without "Voices" and "Notable Quotes", plus the epilogue; fail closed; honest copy (B2) | **Accept, and strengthened** | Removing the two headings isn't enough to keep the promise "no parent quotes". The prompt also asks the model to "Reference actual events and conversations", so "Pivotal Moments" and the epilogue can quote parents too. v3 adds a deterministic **quote scrub** (§5.3): it drops any sentence that shares a 6-word run with any parent message, shared or private, and any sentence quoting 4 or more words. A sidebar sentinel test covers the whole code, not just the two sections. |
| 5 | Honest L3 card about a room where the host knows who came; stopping a code can be noticed (B4) | **Accept** | §3.4. |
| 6 | Freeze the card's computed lines; the event keeps its card's terms; a stale card is shown again (B6) | **Accept** | H17 is extended (§7.5). The event row stores a `frozen_terms` snapshot, and the opening gate reads it. |
| 7 | Eligibility answers set a ceiling rather than a yes/no gate; add Q8a | **Accept** | §9.1 ceiling table. Q8a is added to §13.3. |
| 8 | Studio events can learn from a game when both players say yes; replaces H18 for studio events | **Accept** | H18 is amended. "L2 at playtests" moves to Phase D. |
| — | Non-blocking items: "what your host saw" defined; "meetups joined" record; unlink instead of delete; report-later voids a code; stale-card re-show; §2 inconsistency | **Accept all** | §5.4, §6, §10 and the build plan. |
| — | Coordinator: Dr. Brooks's path is invite-play safety, not host tools | **Accept** | It's a separate small backlog item (§11, "Invite-play safety"). |

**Where round 3 is wrong about the code:** nowhere I could find. I verified:
- **Code fact 1:** `buildReportCardContext` (`context-assembler.ts:591`) feeds `identitySnapshots` and the epilogue. The prompt headings are at `prompts.ts:252,258`.
- **Code fact 3:** `markGameHeld` is **in-process only** (a `Set` in `child-safety-exclusion.ts`). A persistent check has to use `CaseRow.gameRef` in the child-safety store (build plan §B.2).
- **Code fact 4:** the seat gate is at `socket/handlers.ts:845–870`.
- **Code fact 6:** `payments/config.ts:36`.
- **Code fact 7:** `context-assembler.ts:104,637`.

The album part of fact 7 is outside this spec. It is assumed fixed by the album/report-card sidebar-filter hotfix that another agent is shipping (a prerequisite).

---

## 0. Terms

Host, first parent, event, host session and share code are as v2. Hosted invite game is as v2, but it is **not built in the prototype**. One term changes and one is new:
- **Guest reader** (new). One named, ID-checked person whom Liz invites to a **studio** event as the only person who can redeem that event's share codes. A guest reader sees nothing else about the event.
- **Prototype** (changed). Phase A plus Track P, behind `RI_STRANGER_MODE=meetup`, with every host and event created by Liz. Every prototype event card carries the "prototype" label.

---

## 1. Principles

These are v2's seven, with principle 4 corrected.

1. The game comes first. Hosts never change a scene.
2. The host is a partner, not a suspect, but a room is not a database.
3. Pairs hold their own game.
4. **Host-facing text never *shows* private talks.**
   - The report card and the epilogue are written from the whole game, private talks included, so they can *reflect* them. The card and the share step say so.
   - The quote scrub removes any sentence that repeats a parent's words.
   - Only the AI moment summary (Phase C, not in the prototype) is built from shared talk alone.
5. The card tells the whole truth before anything costly, and **its terms hold for the life of the event**.
6. The existing safety rules are untouched and extended to every host-facing surface.
7. Nothing is removed. `RI_MEETUP_CODES` still works.

---

## 2. Personas and who can do what in the prototype

| # | Host | In the prototype? | How |
|---|---|---|---|
| 1 | **Sister Jensen** (faith matchmaker and counsellor) | **Yes, as a guest reader** at a studio event | Pairs at a studio online meetup can make her a share code. Her own ward events wait for Q4, Q2 and the short format (§13.1). |
| 2 | **Dev, Spark Night** (dating events) | **Yes, as a promoter, with nothing built** | He sends his list to a studio event. The card doesn't name his business, and the handle exchange is off. L0 hosting under his own name comes after Q8a. Speed dating waits for the short format. |
| 3 | **Marisol RN** (prenatal class) | No, but a take-home path exists | The card's "came with someone you know?" link starts an unlinked invite game. She can hand out the RI discussion deck. Nothing links a person to the class. |
| 4 | **Dr. Brooks** (therapist) | **No host tools, ever** | His clients play ordinary invite games and show their own screen in session. He needs the invite-play safety backlog item (§11) and the clinician guide. |
| 5 | **Liz** (studio) | **Yes** | Studio events, guest readers, share codes, the deck, and the studio-learning opt-in (H18). |
| — | Non-sensitive outside host (a games club, a book group) with no authority over attendees | **Yes** | L0, L1, or L3 by share code. |
| 6 | White-label partner | No | A negotiated deal (Phase H). |

---

## 3. The event card

### 3.1 Where it sits

The flow is: `?meetup=` → **event card** → (continue) Matrix sign-in → biometric consent → Stripe Identity → name the child → queue.

- **Acknowledgement is recorded at "continue",** against a random pre-subject token, and bound to the subject when the player signs in.
- **Nothing is tracked on the card,** and the event code never leaves the server (the F5 hotfix).
- **Stale card:** a player whose acknowledged version isn't current sees the new card before their next step (F24, restored).

### 3.2 Card copy (prototype)

The style is lower-case and plain, matching the shipped stranger screens. `{host}` is the host's or guest's display name.

> **prototype** · the studio is testing new host tools with real people. the studio made this meetup and checked {host} itself. everything below is exactly what happens. if anything changes, you'll see a new card first.
>
> **{event name}**
> {studio line: "run by the studio that makes raising intelligences." | host line: "hosted by {host} · ID-checked host, approved by the studio"}
> {welcome text}
>
> **what this asks of you**
> - a multiversegames.ai (Matrix) account.
> - a photo ID and a live selfie, checked by Stripe, to prove you're 18 or over. we keep only "18+: yes" and a coded fingerprint of your document number, so one ID can't open two accounts. Stripe deletes the check once we have the answer, apart from what the law makes it keep.
> - about {length}. you'll raise one child from birth to 25 with one other adult at this meetup. you won't know who until you're in the game, and you'll only see each other's choices as parents.
> - {cost line}
>
> **what's in the game**
> {content notes}
>
> **who sees what**
> {level block, §3.4}
> your co-parent sees everything the two of you do together, and can tell anyone about it. no other player and no host ever sees your private talks with your child, though your child may bring up what you told them.
> your age check, your ID and your Matrix account are never shown to {host}. if you report someone, the report goes to the studio, not to {host}, and {host} isn't told.
>
> **what the studio keeps**
> - the game runs on the studio's servers. what you type is sent to AI providers, through OpenRouter, to write your child's replies. they don't get your name or your ID.
> - the studio keeps a technical record of every game, including private talks, to fix problems and review reports. {trace line}.
> - {learning line}
> - the studio counts, without cookies, how many people reach each step of stranger mode, across all meetups. nothing on this page is counted.
>
> **at the end** {handle line}
>
> **came with someone you know?** you can raise a child together as an ordinary invite game instead. it isn't part of this meetup: {host} sees nothing about it and there's no ID check. the stranger protections (reports to the studio, blocks) don't cover invite games, so only do this with someone you already know. {invite cost clause}
> [ start an invite game ]
>
> [ sounds good, continue ]   [ not for me ]
> get ready early · report this host · everything the studio keeps

**The computed lines.** These are worked out once and **frozen** at the first acknowledgement (H17):

| Line | Values |
|---|---|
| **Cost line** | **Paywall off when frozen:** "it's free at this meetup." (v2 said "free during testing". It now promises only this event, and the freeze makes it true.) **Paywall on:** "$20 per child, paid once by whoever is paired first, and only after your co-parent arrives. nobody pays for a no-show." |
| **Trace line** | Either "kept for {N} days, then deleted" (only if a purge is actually running), or "kept until the studio deletes it. you can ask the studio to take your game off your account from your account page." Either way, it also states where traces live ("on the studio's own servers" or "with Langfuse, our tracing provider"), whichever is true. |
| **Learning line** | **Studio events:** "if you both say so at the end, the studio may read your game to improve stranger mode. it's never published or used to train AI. if either of you says no, it isn't read for that." **Outside-host events:** "games from this meetup are never used in the studio's blog posts, research or AI training." |
| **Handle line** | **On:** "if you both say yes, you'll each see the other's Matrix handle (not a phone number or email). if either says no, nothing is shared." **Off:** "there's no contact swap at this meetup." |
| **Invite cost clause** | **Paywall off:** "it's free." **Paywall on:** "it's $20 per child, paid by whoever starts it, once the other person joins." The invite path is a separate product, so this clause follows the live paywall setting and is not frozen. The card says so: "invite prices can change." |
| **Content notes** | As v2, draft wording for Liz's spoiler review: "family arguments, a child who lies and keeps secrets, school trouble, illness, grief, and teenage risk-taking. if a child is treated cruelly, the story can bring in outside help." |
| **{length}** | Measured at Liz's next meetup. |

### 3.3 "Not for me"

As v2:

> that's fine. nothing about this is counted or passed on.
> you can raise a child on your own, free{invite clause}.
> [ play solo ]  [ invite someone ]

### 3.4 Level blocks

**Studio event without a guest reader:**
> this meetup is run by the studio that makes the game. the studio holds your game the way it holds every game: to run it, keep it safe and review reports. nobody outside the studio sees it.

**Studio event with a guest reader:** the studio block above, plus:
> {guest}{, {role}, checked by the studio on {date}} is a guest at this meetup. if you both want to talk your game through with {guest}, you can make a share code for {guest}. {guest} sees nothing else about this meetup.

**L0 (outside host):**
> {host} can't see anything about you or your game. they only know whether the meetup is open.

**L1 (outside host):**
> {host} sees only rough totals for the whole meetup, a day after it closes: about how many people joined and how many games started, in ranges like "10–19", and, if at least 10 games started, whether more or less than half finished and swapped handles. if fewer than 5 games started, {host} sees nothing at all.
> {host} can't see who you were paired with, anything in your game, or what you said yes or no to. in a small room people may notice who left early. RI never tells {host} why.

**L3 by share code** (outside host, or the guest-reader paragraph above), followed by:
> {host} only sees your game if **you two** give them a share code. at the end you'll each be asked, on your own, and you'll see exactly what it shows first. if you both say yes, a code appears on your account page, and you decide whether and when to give it to {host}.
>
> RI never gives {host} a list of who played or who made a code. but {host} may know you came, and may notice that no code came from your pair. they can't tell why. games end up without a code when they don't finish, when either of you says no or waits, when you keep the code to yourselves, or for reasons RI doesn't share.
>
> a code shows: part of your report card (your child's personality, strengths and struggles) and your child's epilogue. both were written from your whole game, including what each of you said in private, so they can reflect it. we take out every sentence that quotes anyone or repeats five or more of your words in a row, and we try to take out every name either of you typed and anything that retells what you said in private. your names become "Parent 1" and "Parent 2". you'll read exactly what {host} would see before you choose.
>
> if you both say yes but no code appears, your game couldn't make one. RI doesn't say why.
>
> you can stop a code from your account page at any time. that stops {host} opening it again; it can't make {host} forget what they've already read. if you stop it, {host} will see that it no longer opens, and might say so in front of your co-parent.

---

## 4. What the host sees

### 4.1 Live

At every level, the host sees only whether the event is **open, paused, closed or full.** Guest readers see nothing at all about the event, live or afterwards.

### 4.2 Counting rules (replaces v2 §4.2, rules 1–3)

1. **Minimum size:** nothing is published unless at least **5 games started**. Below that the host sees "this meetup was too small to show numbers". Invite games are never counted.
2. **Size cells, in bands:** "joined the queue" and "games started", shown as `5–9`, `10–19`, `20–49` or `50+`.
3. **Outcome cells, as proportions:** "games finished" and "pairs who swapped handles" (the latter only if the exchange is on).
   - Shown only when **at least 10 games started**.
   - Even then, only as "half or fewer" or "more than half" of games started.
   - Below 10 they read "not shown at this size".
   - Never a count, an exact zero, "all" or "none".
4. **One publication,** at least 24 hours after close. It is never recomputed.
5. **No exemptions** for any host or deal.
6. **No per-pair status anywhere.**
7. **No counts of codes** made, redeemed or stopped, anywhere: not in the host portal, not on any player's account page, not in "what your host saw".

### 4.3 Matrix (prototype)

✓ means available; – means not.

| What the host sees | Studio, no guest | Studio + guest reader | Outside L0 | Outside L1 | Outside L3 (codes) |
|---|---|---|---|---|---|
| Open / paused / closed / full | (studio admin) | – | ✓ | ✓ | ✓ |
| Banded funnel (§4.2) | (studio admin) | – | – | ✓ | ✓ |
| RI discussion deck | ✓ | ✓ | ✓ | ✓ | ✓ |
| Items from codes a pair handed over | – | ✓ (guest only) | – | – | ✓ |
| Any list, any live count, any count of codes | never | never | never | never | never |
| Sidebar, confessionals, identity document, safety internals | never | never | never | never | never |

---

## 5. Share codes (L3, in the prototype)

### 5.1 Flow (replaces v2 §5.1)

1. **Every finished game at an event with share codes on gets the same share step**, with the same screens, copy and timing distribution. This includes:
   - games the safety system acted on (H15);
   - games with a child-safety case or hold;
   - games where a seat can't make a code (for example, a seat that no longer passes the adult check).

   In those games, answers are recorded and discarded, and no code is ever made. Games that ended early, including any reported game, never reach the end screen, as today.
2. **The order of end screens:** report card → **share step** → studio learning (studio events only) → handle exchange (if on).
3. **Preview.** Tapping "show me exactly what {host} would see" renders the trimmed content (§5.3). It is deterministic, there is no LLM call, and excluded games are rendered too.
4. **Decision screen copy:**
   > **make a share code for {host}?**
   > a share code lets {host} read part of your report card (your child's personality, strengths and struggles) and your child's epilogue. both were written from your whole game, including what each of you said in private, so they can reflect it. we take out every sentence that quotes anyone or repeats five or more of your words in a row, and we try to take out every name either of you typed and anything that retells what you said in private. your names become "Parent 1" and "Parent 2".
   > [ show me exactly what {host} would see ]
   > RI won't tell your co-parent what you chose. if one of you says yes and no code appears, that can mean the other said no, or is deciding later, or that this game can't make a code. RI never says which.
   > [ yes ]   [ no ]   [ decide later, on my own ]

   No button is pre-selected (H20).
5. **What each answer sees afterwards:**
   - **yes:** "if your co-parent says yes too, a code will appear on your account page." This stays until a code appears or the 14-day window closes.
   - **no:** "okay, nothing will be made."
   - **decide later:** "you can decide on your account page until {date}."
6. **Codes appear only on the account page, never on the end screen.** The code appears at a random time 2 to 10 minutes after the second yes. The same delay mechanism is applied to excluded games, so nothing about them differs except that no code ever appears.
7. **When the window closes without a code,** both players' account pages show "no code was made for this game." It is the same line for a no, a lapse, decide-later running out, and a game that can't make a code.
8. **Residual risk, stated on the card:** two players who both said yes and compare notes will know their game couldn't make a code. They won't know why.

### 5.2 A code

- **The code itself:** four words from a 2,048-word list, about 44 bits. It is derived from a server secret and the code's row id, so **the plaintext is never stored**. Lookup is by a peppered hash.
- **Who can use it:** only the event's host, or its guest reader. It is valid for 14 days after it appears.
  - The first redemption binds it to that reader.
  - Access then runs 30 days from redemption (the prototype has no setting).
- **What it carries:** a **frozen snapshot** made when the code is created, identical to the preview. It holds:
  - the trimmed report card (or nothing, if trimming failed closed);
  - the scrubbed epilogue.
- **Failed redemptions:** the host sees **"this code isn't available."** That one line covers a wrong code, an expired one, a stopped one, one for another host, one that never existed, or one that was rate-limited. Every failure gets the same status, body and timing.

### 5.3 Trimming and the quote scrub (B2)

> Superseded in 2.14.1: see "As built: the fail-safe scrub (2.14.1)" at the end. The original rule is kept below for the record.

The snapshot is built by a pure function, `buildShareSnapshot(reportCard, epilogue, parentMessages)`:

1. **Remove sections.** Drop the `## The Voices in Their Head` and `## Notable Quotes That Stuck` sections of the report card by heading, up to the next `## ` heading or the end. If either heading isn't found, **leave out the whole report card**, and the preview says "your report card couldn't be trimmed safely, so a code would carry only the epilogue."
2. **Quote scrub.** In what remains of the report card and in the epilogue, drop every sentence that:
   - (a) shares a run of **6 or more consecutive normalised words** with any message sent by `parent1` or `parent2` in any chat (shared, private or debrief). Normalising means lower-case, punctuation stripped, whitespace collapsed; or
   - (b) contains a **quoted span of 4 or more words** inside “ ” or " ".
3. **Fail closed.** If the scrub removes more than 40% of the report card's remaining sentences, leave out the report card. If it removes more than 40% of the epilogue's sentences, leave out the epilogue. If both are left out, the share step still runs, and every code for that game carries nothing. In practice this means **no code is made** (it behaves like an excluded game).
4. **Display.** The snapshot is plain text, rendered as markdown headings and paragraphs only (no links or images).

### 5.4 The account page (stranger players, behind the stranger pass)

It contains:
- **Meetups you joined:** each with the card exactly as you accepted it, and a **"remove from my list"** button.
- **Your games at these meetups:** child name and event name.
  - Share state: waiting, decide-later with a "decide now" button, the code, or "no code was made for this game".
  - For a code: the access log, in the form "{host} opened it on {dates}" or "{host} hasn't opened it", and a **"stop this code"** button.
- **Studio learning** (studio events): your own answer.
- **What your host saw:** the event's published panel and your own code's access log. **Nothing else, ever.**
- **"Take my game off my account"**, which asks the studio to unlink you (§6).
- **"report this host".**

Stopping a code is silent to the co-parent. Their row doesn't change, except that the access log stops growing.

---

## 6. "Take my game off my account" (unlink, not delete)

In a stranger game, deleting the game would end it for the partner and tip them off. So the studio **unlinks the requester** instead:
- any code is voided (silently, like a stop);
- the requester's acknowledgements, share decisions, learning choice and account-page rows are deleted;
- their subject is removed from `stranger_runs`, unless a report or block needs it;
- their resume credential for the game is invalidated.

The game's messages stay in the co-parent's copy, labelled only "Parent 1" or "Parent 2", as now.

The copy says so:
> the studio will take this game off your account and cancel any code. your co-parent keeps their copy of the game, which includes what you wrote, without your name.

Full erasure in shared games goes to counsel as Q13.

---

## 7. Pairing, safety, hard lines

### 7.1 Pairing

First-come, as built. "We came together" is an unlinked invite game (§3.2). Linked hosted invite games are not in the prototype. Any later linked version must require (B7):
- a Matrix sign-in for both players;
- the stranger suspension and block checks at seat join;
- `STRANGER_REPORT`.

"I know this person" is in Phase B, as v2. The man-woman setting is Phase G, as v2.

### 7.2 Safety

As v2:
- reports go to the studio only;
- there are no per-player host controls;
- hosts can pause, close or rotate a code;
- "report this host" is in the prototype.

When report-later ships (Phase B), a later report voids the game's code silently. The host sees "this code isn't available", the same as for any other reason.

### 7.3 Pre-existing issue

The blocked pair that waits for ever: as v2 §7.4. It is not built in the prototype.

### 7.5 Hard lines

H1 to H24 are as v2, except:
- **H1** now covers codes: no code is made unless both seats pass `adultForPool` at code creation.
- **H17** and **H18** are replaced:

**H17 (amended).** Events end within 14 days of opening. After the first acknowledgement:
- the host or admin can only pause, close or lower the level;
- every computed line on the card (cost, trace retention, trace location, handle exchange, learning) is frozen with it, in `frozen_terms`.

If a studio-wide setting changes while an event is open:
- the event keeps its card's terms. A player whose card said "free" is never charged for a child started at that event;
- a change in the player's favour (shorter retention) applies at once;
- a change that can't be honoured closes the event.

**H18 (amended).**
- Games from **outside hosts'** events are never used for devlogs, research, training or any analysis that reads traces, by the host or by RI.
- At **studio events**, the studio may read a game's traces for playtest learning only if **both** co-parents chose "let the studio learn from our game", with no default. Either no covers the whole game.
- Even with that yes, a game is never in a devlog or anything published, never used for AI training, and never read if H15 applies.

**H25 (new). Every outcome of the share step looks the same.** For every finished game at a code event, the share step is identical in screens, copy and timing distribution, whatever the game's safety state, eligibility or the partner's answer.

---

## 8. Payment

- In the prototype, the payer is the first parent (as built), or nobody when the frozen cost line says free.
- **The opening gate honours `frozen_terms`.** A stranger game whose event froze "free" is `not_required`, even if `RI_PARTNER_PAYWALL` has since been switched on.
- Host pays is Phase B, as v2.

---

## 9. Hosts: ceilings, onboarding, agreement

### 9.1 The ceiling table (replaces v2 §9.1 step 2)

Liz records each answer at creation, and the answers set the highest level the event can have.

| Answer | Ceiling in the prototype |
|---|---|
| No to all three questions | L1, or L3 by share code |
| Authority over likely attendees | L1. Never a share code. |
| Dating or events business | Until Q8a: none. The business may promote a studio event, unnamed, with the handle exchange off. After Q8a: L0, handle exchange off. |
| Sensitive community | Not as a host (Q4). The person may be a **guest reader at a studio event**, because the event itself isn't sensitive. |

### 9.2 Onboarding (prototype)

Liz creates every host and guest reader in the admin. Each one:
- signs in with Matrix through the server-verified OpenID path;
- passes the same 18+ check as players;
- signs the short-form host agreement (v2 §9.3 clauses 1–11, plus the who's-responsible map and the Art. 26 summary). Liz records its version.

A role line ("premarital counsellor") appears on the card only if Liz checked it and recorded what she checked (H16).

The DPIA addendum is signed off before the first outside host or guest reader.

### 9.3 The agreement for guest readers

The agreement as v2, plus three clauses:
- "You'll only open codes a pair gives you, and only to talk their game through with them."
- "You won't ask anyone whether they made a code."
- "Nothing you read goes to your congregation, your clients' files or anyone else."

---

## 10. Retention

The §10 table is as v2, with these changes for the prototype:
- `frozen_terms` and the published funnel are kept for 1 year.
- `share_decisions` are deleted when a code is made, or when the window closes.
- `studio_learning_choices` are kept for as long as the game's traces.

**In the prototype, the purges run from an admin endpoint** (build plan §B.3), which Liz triggers weekly from a checklist. A scheduled job comes in Phase C.

---

## 11. Phases

**Prerequisites for the prototype.** These are hotfixes to shipped code, done by another agent; this spec doesn't duplicate them:
- **F1:** seat-scoped `/api/game/:id/state`, and an authenticated `/api/user/:userId/kids`;
- **F5:** the meetup code never leaves the server;
- **F2:** a held player counts in everyone's queue count;
- **The album and report-card sidebar filter.**

### The prototype (Phase A plus Track P) ★

Behind `RI_STRANGER_MODE=meetup`. Every host and event is created by Liz, and every event is labelled "prototype".

- [ ] Events in the database (generated codes, a 14-day maximum, the §9.1 ceiling enforced). `RI_MEETUP_CODES` codes become studio events with L0 terms and no codes.
- [ ] Event card (§3), acknowledgement at "continue", stale-card re-show, Global Privacy Control respected.
- [ ] Frozen terms, with the opening gate honouring them (B6, H17).
- [ ] A host never plays at their own event, and a guest reader never plays at the event they read for (H12).
- [ ] Host portal: Matrix sign-in, live status, the banded funnel with proportions (B5), pause, close and lower-level.
- [ ] RI discussion deck (§B.6), public to hosts and guest readers.
- [ ] Share codes at L3 (§5): one identical share step (B1, B3), the deterministic preview, trimming and the quote scrub (B2), codes only on the account page after a delay, host redemption with one uniform failure, and the watermarked read-only view.
- [ ] Guest reader at studio events.
- [ ] Account page (§5.4), with unlink (§6) and "report this host".
- [ ] "Came with someone you know?" as an unlinked invite game.
- [ ] The studio-learning opt-in at studio events (H18), and trace tagging plus an allow-list for analysis.
- [ ] Admin: hosts, events, purge, unlink queue, host reports.
- [ ] Shipped-copy fixes: the "both are free" line and the stale README AI co-parent line. The `world_manager` confessional redaction ships here too, unless the hotfix agent has taken it.

**Not in the prototype:**
- L2 patterns;
- the AI moment summary;
- linked hosted invite games (B7);
- host pays;
- sensitive communities as hosts;
- authority hosts above L1;
- events businesses as named hosts;
- clinicians;
- "I know this person", leave-quietly and report-later for stranger games;
- the man-woman setting;
- self-serve onboarding.

### Invite-play safety (a separate small backlog item, not host tools)

This is for invite play generally, and it is the path for Dr. Brooks's clients:
- **Quick exit:** one tap on every screen calls `location.replace` to a neutral site, so RI's entry leaves the history stack.
- **Discreet title:** an option that sets the page title and favicon to neutral ones for the rest of the session, so browser history doesn't name the game.
- **Leave quietly:** a button that behaves exactly like a lost connection for the co-parent.
- **A clinician guide** (content only): contraindications, and how to use the game as homework with clients showing their own screen.

It doesn't depend on any host tools. It can ship before or after the prototype.

### Later phases

These are as v2, with these changes:
- **Phase B:** "I know this person", leave-quietly plus report-later for stranger games (report-later voids codes), host pays, "raise a concern", and the booking link.
- **Phase C:** sensitive communities and authority hosts. Gates: Q1, Q2, Q4, Q9, Q10, Q13. Also host roles, the AI moment summary, and scheduled retention jobs.
- **Phase D:** L2 patterns (including studio playtests, opt-in) and linked hosted invite games, with the B7 conditions. Gates: Q3, Q6.
- **Phase E:** clinicians, L4 client-held. Gates: Q5, Q11.
- **Phase F:** self-serve hosting, and events businesses as named L0 hosts (gate: Q8a; Q8 for anything beyond L0).
- **Phase G:** the man-woman setting. Gates: Q7, Q12.
- **Phase H:** partner deals.

---

## 12. White-label and platform partners

As v2 §12.

---

## 13. Liz decides (final)

### 13.1 A short format for events (OQ-12)

**Recommendation:**
1. Measure real game length at your next online meetup, which also fills the card's `{length}`.
2. Then treat the short format as a game-design project with the game director: one RI-owned "meetup length" format, a fixed slice of life events, always ending in its slot. Hosts never choose the events.

It decides whether Sister Jensen's ward activity and Dev's Friday night can ever run. The prototype stays online and long-form until it exists.

### 13.2 A studio-owned "gentler intensity" setting for clinical events

**Recommendation: not yet.**
- Ship the content notes now and the clinician guide with the invite-play safety item.
- Ask the first clinicians who use invite play as homework whether a gentler version would change their practice.
- If it's built: one studio switch tied to an event kind, never set by a host, never touching child-safety moderation or the intervention ladder, and disclosed on the card.

### 13.3 Questions for counsel

The v2 table stands. These are added:

| # | Question | Gates | Until it's answered |
|---|---|---|---|
| Q8a | When a dating or events business hosts an L0 event with no handle exchange, and RI does no matching beyond first-come, is RI or the business an "online dating service" under NJ/TX law, Cal. Civ. Code §1694 or NY GBL §394-c? | Events businesses as named L0 hosts | The business may promote a studio event, unnamed, with the handle exchange off. |
| Q13 | In a two-person game, how far does one player's erasure request reach, given that the co-parent's copy holds the requester's messages? Is unlinking (§6) enough under Art. 17 and the CCPA? | Phase C (prototype runs on unlink plus honest copy) | Unlink, as in §6. |

**Recommendation on order and spend:**
- **Run the prototype on the working assumptions,** because:
  - every event is created by you, online, and non-sensitive;
  - the host agreement carries an Art. 26 summary;
  - the card is truthful about traces;
  - the reported-player data-request procedure is written down.
- **Commission Q1, Q9, Q10, Q13 and Q8a together now,** so the answers are in by the time the prototype has taught you something.
- **Commission Q2 and Q4** (needed before Sister Jensen's own ward events) next.
- Q3 and Q6 come before Phase D, Q5 and Q11 before Phase E, and Q7 and Q12 last.

### 13.4 Smaller calls

| # | Call | Recommendation |
|---|---|---|
| a | **Trace retention N for hosted games, and the purge** | 30 days plus the report window, run from the prototype's purge endpoint. Until it runs, the card uses the "until the studio deletes it" line, which is true. Also confirm where production traces go (self-hosted or Langfuse cloud). The repo defaults to cloud when no base URL is set. |
| b | **Content-note wording** | Check the draft in §3.2 against your spoiler rules and the event bank. |
| c | **The first guest reader** | Invite Sister Jensen as a guest reader at one studio online meetup, not her ward. Show a role line only if you've checked something you can name ("practice website and state business registration checked"). |
| d | **Dev promoting a studio event** | Yes, at no build cost: his list, your event, his name not on the card, the handle exchange off. |
| e | **Outside hosts with codes in the first prototype meetup** | Start with a guest reader at a studio event only. Add a non-sensitive outside host with codes at the second meetup, after you've watched one round of codes in real use. |
| f | **The invite-play safety item** | Schedule it alongside the prototype. It's small, it helps every invite player, and it's Dr. Brooks's only path. |
| g | **Paywall during the prototype** | Keep `RI_PARTNER_PAYWALL` off for prototype events. The freeze protects players either way, but off keeps the first meetups simple. |

---

# Build plan for the prototype

**For an implementer.** It follows the repo's rules: tests first, the full server and client suites green before every merge, and every merge bumps the version (a feature is a minor bump; the prototype starts at 2.9.0). Nothing existing is removed.

**Prerequisite:** merge the F1, F5, F2 and album/report-card sidebar-filter hotfixes first. This plan doesn't redo them. Its tests assume their regression tests exist.

**Suggested PR slicing:**
1. **PR 1:** data model, admin, card, acknowledgement, freeze, host-never-plays.
2. **PR 2:** host portal, funnel, deck.
3. **PR 3:** share step, codes, account page.
4. **PR 4:** studio learning, came-together, unlink, purge.

## B.1 Data model

One new migration (the next free number, expected `032-host-tools.sql`), plus an in-memory twin, following the `StrangerStore` pattern.

```sql
-- A person who can host or read codes. Subject = the same HMAC as stranger subjects (RI_STRANGER_PEPPER).
CREATE TABLE host_people (
  id               UUID PRIMARY KEY,
  subject          TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL CHECK (char_length(display_name) <= 60),
  role_text        TEXT NULL CHECK (char_length(role_text) <= 80),
  role_checked     TEXT NULL,          -- what Liz checked; role_text is shown only if this and role_checked_at are set
  role_checked_at  BIGINT NULL,
  agreement_version TEXT NOT NULL,
  agreement_at     BIGINT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('approved','suspended','closed')),
  created_at       BIGINT NOT NULL
);

CREATE TABLE host_events (
  id             UUID PRIMARY KEY,
  code_hash      TEXT NOT NULL UNIQUE,  -- peppered hash; the plaintext code is shown once to the admin
  name           TEXT NOT NULL CHECK (char_length(name) <= 60),
  kind           TEXT NOT NULL CHECK (kind IN ('studio','outside')),
  host_person_id UUID NULL REFERENCES host_people(id),  -- outside only
  guest_reader_id UUID NULL REFERENCES host_people(id), -- studio only
  sensitive      BOOLEAN NOT NULL,
  authority      BOOLEAN NOT NULL,
  events_business BOOLEAN NOT NULL,
  level          SMALLINT NOT NULL CHECK (level IN (0,1,3)),
  share_codes    BOOLEAN NOT NULL DEFAULT false,
  studio_learning BOOLEAN NOT NULL DEFAULT false,
  handle_exchange BOOLEAN NOT NULL,
  welcome_text   TEXT NOT NULL DEFAULT '' CHECK (char_length(welcome_text) <= 600),
  conduct_url    TEXT NULL,
  capacity       INT NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  join_window_ms INT NOT NULL,
  opens_at       BIGINT NOT NULL,
  closes_at      BIGINT NOT NULL CHECK (closes_at > opens_at AND closes_at - opens_at <= 14*24*3600*1000),
  paused         BOOLEAN NOT NULL DEFAULT false,
  closed_at      BIGINT NULL,
  card_version   INT NOT NULL DEFAULT 1,
  frozen_terms   JSONB NULL,            -- {cost:"free"|"first_parent", traceLine:string, traceWhere:string, handleExchange:bool, learning:bool}; set at first ack
  first_ack_at   BIGINT NULL,
  published_funnel JSONB NULL,          -- set once, ≥24h after close
  published_at   BIGINT NULL,
  created_at     BIGINT NOT NULL,
  -- ceilings (§9.1), enforced again in code
  CHECK (NOT (kind = 'outside' AND sensitive)),
  CHECK (NOT (kind = 'outside' AND events_business)),          -- until Q8a
  CHECK (NOT (authority AND (level = 3 OR share_codes))),
  CHECK (NOT (kind = 'studio' AND (host_person_id IS NOT NULL OR sensitive))),
  CHECK (NOT (kind = 'outside' AND (guest_reader_id IS NOT NULL OR studio_learning))),
  CHECK (share_codes = (level = 3)),
  CHECK (NOT (events_business AND handle_exchange))
);

CREATE TABLE host_event_acks (
  id           UUID PRIMARY KEY,
  event_id     UUID NOT NULL REFERENCES host_events(id),
  card_version INT NOT NULL,
  pre_token_hash TEXT NOT NULL UNIQUE,
  subject      TEXT NULL,               -- bound at stranger pass issue
  at           BIGINT NOT NULL,
  bound_at     BIGINT NULL
);
CREATE INDEX ON host_event_acks (subject, event_id);

ALTER TABLE stranger_runs ADD COLUMN event_id UUID NULL REFERENCES host_events(id);

CREATE TABLE share_decisions (           -- one per seat per game; deleted when a code is made or the window closes
  game_id    UUID NOT NULL,
  slot       TEXT NOT NULL CHECK (slot IN ('parent1','parent2')),
  answer     TEXT NOT NULL CHECK (answer IN ('yes','no','later')),
  at         BIGINT NOT NULL,
  window_ends_at BIGINT NOT NULL,
  PRIMARY KEY (game_id, slot)
);

CREATE TABLE share_codes (
  id          UUID PRIMARY KEY,
  game_id     UUID NOT NULL UNIQUE,
  event_id    UUID NOT NULL REFERENCES host_events(id),
  code_hash   TEXT NOT NULL UNIQUE,     -- HMAC(pepper, words); words = derive(RI_SHARE_CODE_SECRET, id)
  snapshot    JSONB NOT NULL,           -- {reportCard: string|null, epilogue: string|null, reportCardOmitted: bool}
  visible_at  BIGINT NOT NULL,          -- second yes + random 2..10 min
  expires_at  BIGINT NOT NULL,          -- visible_at + 14 days (unredeemed)
  redeemed_by UUID NULL REFERENCES host_people(id),
  redeemed_at BIGINT NULL,
  access_until BIGINT NULL,             -- redeemed_at + 30 days
  stopped_at  BIGINT NULL
);

CREATE TABLE share_access_log (
  code_id        UUID NOT NULL REFERENCES share_codes(id) ON DELETE CASCADE,
  host_person_id UUID NOT NULL,
  opened_at      BIGINT NOT NULL
);

CREATE TABLE studio_learning_choices (
  game_id UUID NOT NULL,
  slot    TEXT NOT NULL CHECK (slot IN ('parent1','parent2')),
  answer  TEXT NOT NULL CHECK (answer IN ('yes','no')),
  at      BIGINT NOT NULL,
  PRIMARY KEY (game_id, slot)
);

CREATE TABLE host_reports (               -- "report this host"; no account needed
  id UUID PRIMARY KEY, event_id UUID NULL, text TEXT NOT NULL CHECK (char_length(text) <= 2000),
  at BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE unlink_requests (
  id UUID PRIMARY KEY, game_id UUID NOT NULL, subject TEXT NOT NULL, at BIGINT NOT NULL, done_at BIGINT NULL
);
```

**Not stored anywhere:**
- the plaintext event code (shown to the admin once at creation, then only as the hash);
- the plaintext share code;
- any count of codes per event.

**Env codes** (`RI_MEETUP_CODES`): at startup, each listed code is upserted as a studio event with these defaults:
- level 0, `share_codes=false`, `studio_learning=false`;
- handle exchange on (as today);
- `closes_at` set to now plus 14 days, rolled forward at each restart while the code is still listed.

These env events are exempt from the 14-day check only through this rolling mechanism. The admin sees them labelled "env".

## B.2 Server modules

All new code lives in `server/src/hosts/`.

| Module | What it does |
|---|---|
| `config.ts` | Feature on only when `RI_STRANGER_MODE !== "off"`. `RI_SHARE_CODE_SECRET` is required (32+ bytes); without it, `share_codes` events refuse to open, failing closed like the pepper does. |
| `store.ts` | Interface plus Postgres and in-memory implementations for the tables above. |
| `card.ts` | `cardFor(event, liveConfig)` returns the card payload. `freezeTerms(event, liveConfig)` runs atomically at the first acknowledgement, with a `WHERE frozen_terms IS NULL` guard. |
| `funnel.ts` | `publishFunnel(counts)`, a pure function implementing §4.2. |
| `share.ts` | `shareStep` (record an answer; schedule code creation on the second yes), `buildShareSnapshot` (§5.3, pure), `canMakeCode(gameId)`, `deriveWords(id)`, `redeem(hostPersonId, words)`, `view(hostPersonId, codeRef)`, `stop(subject, codeRef)`. |
| `exclusion.ts` | `excludedFromSharing(gameId)`: true if `highestRungFired > 0`, `cpsOutcome != null`, `therapyMessages.length > 0`, `isGameHeldInProcess(gameId)`, or `childSafetyStore.hasCaseForGame(gameId)` (a **new** store method that queries `CaseRow.gameRef`). Also true if either seat fails `adultForPool` now, or the game is reported or stopped. |
| `learning.ts` | Records learning choices. `analysisAllowed(gameId)` is true only for a studio event, with both yes, and `!excludedFromSharing`. |
| `routes.ts` | See §B.3. |

**Changes to existing code:**

| Where | Change |
|---|---|
| `stranger/service.ts` `issuePass` | Takes `ackToken`. Binds the ack's `subject`. Refuses with "Please read the meetup card first." (409) when the event has no acknowledgement at the current `card_version`. |
| `stranger/matching.ts` `join` | Checks that the event is open, not paused and under capacity, that the acknowledgement is current, and that the subject isn't the event's host or guest. The host or guest is refused with the existing neutral 403 "stranger mode isn't available here." |
| Matching `createGame` hook | Writes `stranger_runs.event_id`. |
| `JOIN_GAME` (stranger seat) | Repeats the host/guest check. |
| Payment opening gate `tryStartOpening` | If the game's event has `frozen_terms.cost === "free"`, the child is `not_required`. |
| End-of-game flow | After `REPORT_CARD` in a stranger game whose event has `share_codes`, the server marks the seat eligible for `SHARE_DECISION`. Same for `STUDIO_LEARNING` at studio events with `studio_learning`. |
| Langfuse (`TracedLLMClient`) | Traces for games whose run has an `event_id` get the tag `hosted_no_analysis` (a new constant beside `CHILD_SAFETY_HOLD_TAG`). The ri-devlog skill and `scripts/model-search.ts` drop those traces unless the game id is in the admin allow-list. |

## B.3 Routes

Every route under `/api/events/*`, `/api/host/*` and `/api/stranger/account*` falls through, with `next("router")`, when stranger mode is off, exactly like the existing stranger routes. All are rate-limited with the existing `limit` middleware. No response or log line carries an event code, a share code, a game id given to a host, a seat token, a subject or a Matrix id (H11, H21).

| Route | Auth | Does |
|---|---|---|
| `GET /api/events/card?meetup=` | none | The card payload for an open, visible event. Unknown, closed or off codes get the same 404 as the off switch. Not logged with the code. |
| `POST /api/events/ack` `{meetup, cardVersion}` | none | Records the acknowledgement and returns `{ackToken}`. If `cardVersion` is stale: 409 with the current card. Freezes the terms on the first acknowledgement. |
| `POST /api/events/report-host` `{meetup?, text}` | none | Writes `host_reports` and returns `{ok}`. |
| `GET /api/events/deck` | none | The static RI deck (§B.6). |
| `POST /api/stranger/pass` (existing) | Matrix OpenID | Now also takes `ackToken`. |
| `POST /api/stranger/share/preview` `{pass, gameRef}` | stranger pass, subject must hold a seat in that game | `buildShareSnapshot` for the game, the same for excluded games. `gameRef` is the account page's opaque per-subject reference, not the game id. |
| socket `SHARE_DECISION` `{answer}` | seat (stranger seat binding) | Records the decision. Replies only with the answering seat's own view (§5.1 step 5). Answers from excluded games are recorded the same way, and later discarded. |
| socket `STUDIO_LEARNING` `{answer}` | seat | Records the choice. The reply is "thanks. that's noted." whatever the answer. |
| `POST /api/stranger/account` `{pass}` | stranger pass | The account page payload (§5.4), only this subject's rows. |
| `POST /api/stranger/account/decide` `{pass, gameRef, answer}` | stranger pass + seat | A decide-later answer. |
| `POST /api/stranger/account/stop` `{pass, codeRef}` | stranger pass + seat | Sets `stopped_at`. Silent. |
| `POST /api/stranger/account/forget-meetup` `{pass, eventRef}` | stranger pass | Removes the event from "meetups you joined". The acknowledgement is kept only for its retention period, unlisted. |
| `POST /api/stranger/account/unlink` `{pass, gameRef}` | stranger pass + seat | Writes an `unlink_requests` row and voids the code at once. |
| `POST /api/host/pass` `{openIdToken}` | Matrix OpenID, server-verified | A host pass if the subject is in `host_people` with status `approved`. Otherwise the same 401 as a bad token. |
| `POST /api/host/events` `{pass}` | host pass | The events this person hosts or reads for. Host: status, level, published funnel. Guest: name and dates only. |
| `POST /api/host/events/:id/pause` / `close` / `lower` `{pass}` | host pass, host of that event (never a guest reader) | Allowed at any time. `lower` decrements the level within the ceiling and bumps `card_version`. |
| `POST /api/host/codes/redeem` `{pass, words}` | host pass | Redeems a code. Rate limit: 10 per hour and 30 per day per host person; over the limit gets the same failure. Success returns `{codeRef}`; every failure returns 404 `{error: "this code isn't available."}` after a constant 400 ms floor. |
| `POST /api/host/codes/view` `{pass, codeRef}` | host pass, the reader who redeemed it, while `access_until` holds | The snapshot plus a watermark. Appends to `share_access_log`. Sends `Cache-Control: no-store`. There is no download route. |
| `POST /api/admin/host-tools/hosts` (create, suspend) | `requireAdmin` | Takes the Matrix id from Liz and stores only the HMAC subject. Refuses unless `adultForPool(mxid).ok`. |
| `POST /api/admin/host-tools/events` (create) / `PATCH .../events/:id` | `requireAdmin` | Enforces the ceilings. `PATCH` is refused with 409 for any field except `paused`, `closed_at` and lower `level` once `first_ack_at` is set. Create returns the plaintext event code **once**. |
| `POST /api/admin/host-tools/events/:id/publish` | `requireAdmin` | Publishes the funnel if at least 24 hours have passed since close and it isn't already published. It's also triggered lazily on the first host view after 24 hours. |
| `POST /api/admin/host-tools/purge` | `requireAdmin` | Runs the §10 schedule and returns only counts of rows deleted, per table. |
| `GET /api/admin/host-tools/host-reports`, `GET .../unlink-requests`, `POST .../unlink-requests/:id/done` | `requireAdmin` | The review queues. `done` performs the unlink (§6). |
| `GET /api/admin/host-tools/analysis-allowlist` | `requireAdmin` | Game ids where `analysisAllowed` is true. Used by ri-devlog and model-search. |

## B.4 Client screens

| Screen | Where | Notes |
|---|---|---|
| `EventCard.tsx` | first on `?meetup=` | It calls `/events/card`, and on "continue" calls `/events/ack` and keeps the `ackToken` in `sessionStorage`. The came-together button starts the existing `CREATE_GAME` invite flow, with **no meetup in any request or URL**: the code is dropped from memory before navigation. "Get ready early" enters `StrangerMode` with a `prepareOnly` flag that stops after the age check. "Not for me" shows the §3.3 screen. A 409 from any later step shows "this meetup's card changed. here's the new one." followed by the card. |
| `StrangerMode.tsx` | existing | Passes `ackToken` to `/stranger/pass`. |
| `ShareStep.tsx` | after `ReportCard` in stranger games at code events | §5.1 copy. Preview view, three buttons with none pre-selected. |
| `StudioLearning.tsx` | after `ShareStep` at studio events | Two equal buttons, no default. |
| `StrangerExchange.tsx` | existing | Unchanged. Shown after the above when the handle exchange is on. |
| `Account.tsx` | `?stranger=account` (stranger pass) | §5.4. A "your account" link on the end screen and the queue screen leads here. |
| `HostPortal.tsx` | `?host=1` | Matrix sign-in, events list, panel, deck, enter code, code view. |
| `Deck.tsx` | portal and `/events/deck` | Static, printable. |

## B.5 Player- and host-facing copy, exactly

Copy for the card, the levels, the share step and unlinking is in §3, §5 and §6. The rest:

**Studio learning (end screen):**
> **can the studio learn from your game?**
> the studio would read your game, including private talks, to improve stranger mode. it's never published, never in a blog post and never used to train AI. it only happens if you both say yes, and RI won't tell your co-parent what you chose.
> [ yes, let the studio learn from our game ]   [ no ]
> → (either answer) thanks. that's noted.

**Preview:**
> **this is everything {host} would see.** nothing else.
> {snapshot}
> (if the report card was omitted) your report card couldn't be trimmed safely, so a code would carry only the epilogue.
> [ back ]

**Account page:**
> **your account**
> **meetups you joined**: {event name} · {date} · [ the card you agreed to ] · [ remove from my list ]
> **your games**
> **{child name}** · {event name}
> - (waiting) you said yes. if your co-parent says yes too, a code will appear here.
> - (later) you haven't decided yet. you can until {date}. [ decide now ]
> - (code) share code for {host}: **{w1 w2 w3 w4}**. give it to {host} when and if you want to. it works for {host} only, until {date}.
>   {host} opened it on {dates}. | {host} hasn't opened it.
>   [ stop this code ]: stopping it means {host} can't open it again. it can't make {host} forget what they've already read. {host} will see that it no longer opens, and might say so in front of your co-parent.
>   (after stopping, own view only) you stopped this code on {date}.
> - (none) no code was made for this game.
>
> **what your host saw**: {published panel | "nothing yet. numbers, if there are any, appear a day after the meetup closes." | "this meetup was too small to show numbers."} and your code's openings above. nothing else.
> [ take this game off my account ] · [ report this host ]

**Host portal:**
> **host tools · prototype**
> sign in with your multiversegames.ai account.
>
> **{event name}** · {open | paused | closed | full}
> while your meetup is open you'll only see whether it's open, paused, closed or full. numbers, if there are any, appear a day after it closes.
> (after) joined the queue: {band} · games started: {band} · games finished: {more than half | half or fewer | not shown at this size} · pairs who swapped handles: {same}
> (small) this meetup was too small to show numbers.
>
> **share codes**
> RI never shows you who played or who made a code. please don't ask anyone whether they made one.
> [ enter a code a pair gave you ] → "this code isn't available." (every failure)
>
> **code view**
> watermark on every block: opened by {reader name} on {date} · for a conversation with this pair only · don't copy or share
> you can open this until {date}.

**Guest-reader portal:**
> you're a guest at **{event name}**. you only see what a pair gives you.

**"Report this host":**
> tell the studio what happened. a person reads every report. {host} isn't told who sent it.
> [ text ] [ send ] → thanks. the studio will look into it.

## B.6 The RI discussion deck (static, no player data)

> **talking about raising someone, together**
> questions for after the game. they come from the studio, not from anyone's game.
> 1. what did your child need from you that you didn't expect to have to give?
> 2. at 3, a tantrum. what did you reach for first: calm, rules, or distraction? where did you learn that?
> 3. when your child first lied, did you want the truth or the reason?
> 4. what's a secret a 14-year-old should be allowed to keep?
> 5. when you and your co-parent disagreed, what did you want your child to see?
> 6. what did you say that you'd want your child to hear in their head at 25?
> 7. what's one thing your own parents did that you caught yourself repeating, or refusing?
> 8. if your child asked you something with no clean answer, what did you do with the not-knowing?
> 9. what does "fair" between two parents look like when one of you is tired?
> 10. what would you do differently with a second child?

The deck is checked against Liz's spoiler rules with the content notes. Every beat it mentions is already public in the README.

## B.7 Tests (tests first; each fails before its code lands)

### Leak fixes

| Leak | Test file | Asserts |
|---|---|---|
| **B1** | `share-step-uniform.test.ts` | Three fixtures: an ordinary game; a game with a persisted child-safety case (`gameRef`) **and** a game with `highestRungFired > 0`; and a game where one seat later fails `adultForPool`. Both seats answer yes in each. Then: (1) the socket emits to each seat are byte-identical in event names and payload shapes; (2) the account-page payloads are identical until the window closes; (3) the scheduled-reveal timer draws from the same distribution (injected RNG and clock); (4) excluded games have no `share_codes` row; (5) after the window, every game without a code shows the same "none" state. |
| **B2** | `share-snapshot.test.ts` | Plants a sidebar sentinel phrase (7+ words) in a `chatType:"private"` message, and puts it in a canned report card under Voices, Notable Quotes **and** Pivotal Moments, and in the epilogue. The snapshot contains no 6-word run of the sentinel. Also: a missing Voices heading omits the report card (`reportCardOmitted=true`, and the preview copy says so); a quoted 4-word span is dropped; a scrub above 40% omits that part; the preview output equals the stored snapshot; a shared-chat parent line repeated in the epilogue is removed. |
| **B3** | `share-no-tipoff.test.ts` | One seat answers yes. Its view is identical when the partner answered no, answered later, didn't answer, or the game is excluded (copy, fields and timing), until the window closes. The end screen never carries a code. The code's `visible_at` falls between 2 and 10 minutes after the second yes. A no-sayer's reply is only "okay, nothing will be made." No message is ever sent to the other seat because of an answer. |
| **B4** | `card-copy.test.ts` | A snapshot of the L3 and guest-reader blocks. Must contain the "may notice that no code came from your pair", "can reflect them" and "might say so in front of your co-parent" sentences. Must not contain "isn't told you were asked" or "no list of who played or who made a code" (v2's wording). |
| **B5** | `funnel.test.ts` | Exhaustive over started 0–60 and finished, swapped from 0 to started: started < 5 gives "too small"; started < 10 gives "not shown at this size"; otherwise outcomes are only "more than half" or "half or fewer". For every started ≥ 10, each output value covers at least 2 underlying values, including a non-extreme one, so neither 0 nor "all" is identifiable. Size cells are banded from 5. A published funnel is immutable (a second publish is a no-op). |
| **B6** | `frozen-terms.test.ts` | Acknowledge with the paywall off, then flip `RI_PARTNER_PAYWALL=on`. A match where both arrive gives the child `not_required`, with no checkout. The card served to a new player still shows the frozen cost. `PATCH` of frozen fields after the first acknowledgement returns 409. A shorter trace retention is applied at once and bumps `card_version`. A stale-version player gets 409 with the new card at pass and at queue join. |
| **Code no-tip-off** | `share-code-redeem.test.ts` | A wrong code, an expired code, a stopped code, a code for another host, a never-existing code and a rate-limited attempt all return the same status, body and constant-time floor. No host route returns a count of codes. `/stranger/account` "what your host saw" contains only the funnel and the caller's own log. A stop is invisible in the partner's account payload. |

### Hard lines

| Line | Test |
|---|---|
| H1 | A code is never created when either seat fails `adultForPool` at creation time. |
| H2 | With a `minor` verification on either seat, no code is created. |
| H3 | Host route response schemas contain no report, suspension or block fields. A report filed during the game prevents the end screen, as today. |
| H4 | Host views are identical for an event with a report and one with a no-show at the same funnel bands. |
| H5 | The host portal and account page render no partner identity. Snapshot tests contain no display names. |
| H6 | The handle exchange never runs in invite games started from the card (no event link exists). |
| H8 | No code without two yes rows. |
| H9 | The snapshot never contains confessional, identity-document or `memorySummary` sentinels planted in the fixture. |
| H10 | No route returns a snapshot except `/host/codes/view`, which sends `no-store`. There is no download route. |
| H11 | A regex sweep over every host and account response finds no UUID game id, seat token, subject hash or Matrix id. `gameRef`, `codeRef` and `eventRef` are per-caller opaque references. |
| H12 | Host and guest subjects are refused at queue join and at `JOIN_GAME`, with the neutral copy. |
| H13 | Existing moderation tests run against a game with `event_id` set. |
| H14 | A host pass is bound to one subject, and `codes/view` refuses any other reader. |
| H15 | Covered by the B1 fixtures. `analysisAllowed` is false for excluded games. |
| H16 | `role_text` is absent from the card payload unless `role_checked_at` is set. |
| H17 | Covered by the B6 test, plus the `closes_at` 14-day database check. |
| H18 | Traces of games with an event get `hosted_no_analysis`. The allow-list contains only studio-event games with two yeses and not H15. Outside-host events can't enable `studio_learning` (database check). |
| H19 | While the event is open, `/host/events` returns status only. |
| H20 | Client tests: `ShareStep`, `StudioLearning` and every consent control render with nothing selected. |
| H21 | Every new route and log line is run with an event code and a share code containing a sentinel. Outbound HTTP mocks (Stripe, OpenRouter, Langfuse) and captured logs contain neither. This extends the F5 hotfix's test. |
| H23 | No route lets a host send anything to a player. |
| H24 | "Not for me" always offers solo. |
| H25 | Covered by B1 and B3. |
| Came-together | An invite game started from the card has no row linking it to the event, in any table. Its create request carries no meetup field, and no log line from it contains the code. |

### Phase A checkpoint (adversarial, before release)

- [ ] Do the hotfix prerequisites pass on main?
- [ ] Is the card first on every entry path?
- [ ] Is an acknowledgement stored before any Matrix or Stripe call?
- [ ] Is every card line true against the frozen terms?
- [ ] Can any host surface change during the event, apart from its status?
- [ ] Is the share step identical across ordinary, held, rung-fired and ineligible games?
- [ ] Can any code contain text from the Voices or Notable Quotes sections, or a 6-word parent run?
- [ ] Does any view show a count of codes?
- [ ] Can a came-together game be linked to the event?
- [ ] Can a guest reader open anything except a code made for them?
- [ ] With no database events and the flag in meetup mode, does stranger mode behave as 2.8.4, apart from the card?

---

# As built (prototype, 2.9.0–2.12.0)

The prototype shipped in four PRs: 2.9.0 (data model, admin, card, freeze, host-never-plays, came-together), 2.10.0 (host portal, funnel, deck), 2.11.0 (share step, codes, account page) and 2.12.0 (studio learning, unlink, purge, trace tagging). Local harness: `docs/host-tools-test-harness.md`. Where the build differs from the text above:

- **On only in meetup mode.** §B.2 says the feature is on whenever `RI_STRANGER_MODE !== "off"`. As built, it's on only when `RI_STRANGER_MODE=meetup`. In every other mode, every host-tools route falls through like a path that was never built.
- **Migrations** are `034-host-tools.sql` and `035-host-event-paused-by.sql`, not `032`.
- **The studio's pause wins.** `host_events.paused_by` records who paused an event. A host can't resume a pause the studio made.
- **The host portal re-checks each request.** Every request re-checks that the person is approved, a verified adult, not banned and not suspended. Revoking a stranger pass also revokes the host and account passes.
- **Env-code events** run in rolling 14-day periods, as §B.1 says. Queue entries follow the event: a paused, closed or re-carded event ends or re-shows the card for players already queued.
- **The free opening gate** goes through `payments.exemptWhen`: a game whose event froze "free" is never charged.
- **The share snapshot's corpus is broader than §5.3.** Besides parent chat lines, the scrub covers:
  - every chat type;
  - confessionals;
  - the identity document and its snapshots;
  - `memorySummary`;
  - therapy messages.

  Player names are replaced with "Parent 1" and "Parent 2". Without both names the snapshot isn't made (fail closed).
- **The adult check works at the account level after a restart.** When no Matrix id is in memory for a seat, the code path checks the stored verification and hashes the ban list's Matrix ids against the seat's subject. If the ban list can't be read, no code is made.
- **Reveal times are whole milliseconds.** The Postgres columns are BIGINT, and a fractional delay failed there.
- **Untracked pages.** The meetup card, the portal, the deck and the account page send no Umami pageview and start no session beats.
- **The account-page probe** checks the deck endpoint, because a JSON 401 can't tell "off" from "signed out".
- **"Report this host" from the account page** doesn't attach the event.
- **"everything the studio keeps"** on the card isn't built (no page exists to link to).
- **Studio learning.** The first answer stands. The socket reply is `{answered}` and never carries the answer. The account page shows a player only their own answer.
- **Trace tagging (H18).** `hosted_no_analysis` is added to every trace of a game whose run has an event. The game is marked when it's matched, when its seats are read, and at boot from every event's runs, so a restart doesn't lose it. `scripts/model-search.ts` and the ri-devlog skill drop hosted traces unless the game is on the allow-list. With no allow-list (no `RI_ADMIN_URL`/`ADMIN_TOKEN`), they drop every hosted trace. 2.12.0 shipped this inert: no trace carried a game id, so the tag was never added. 2.12.2 carries the game id to every call through the async context and refuses to send a trace without one (docs/observability.md, "Which game a call belongs to"); the readers also skip any trace without a `game_id` tag.
- **Unlink (§6).** A request voids the code at once, using a stop by that seat, so the co-parent's row doesn't change. When the admin marks it done, these are deleted:
  - the requester's acknowledgements at the event;
  - their share decision;
  - their learning choice.

  The run's seat subject becomes `unlinked:<request id>`, the seat cache is dropped, and the seat's sockets are disconnected, so the seat can't be taken again. Rather than keeping the subject in the run "when a report or block needs it", the request row maps the placeholder back: a report the co-parent files later still reaches the original account. Blocks already store subjects on their own.
- **Retention periods (§10).** The v2 §10 table isn't in the repo, so these were chosen:
  - acknowledgements, frozen terms and the published funnel: 1 year after close;
  - share decisions: when the window closes (or the code is made);
  - a code's snapshot: cleared when it stops opening;
  - the code's row and access log: 30 days later;
  - done unlink requests: 1 year.

  Learning choices aren't purged while traces are kept until the studio deletes them (`RI_HOSTED_TRACE_RETENTION_DAYS` unset). Liz runs the purge from the admin; there's no scheduled job.
- **The `world_manager` confessional redaction** shipped here, because the hotfix agent hadn't taken it. The world manager's "pressure point" carries one parent confessional verbatim. Every traced system prompt now redacts that section, failing closed to the end of the text.
- **Shipped-copy fixes.**
  - The under-18 screen no longer says "both are free". It now says "you can still raise a child on your own for free, or with someone you invite."
  - The README no longer mentions an AI co-parent, because there isn't one.
- **Still open:** §13 ("Liz decides") is unchanged; those are Liz's decisions.

# As built: disclosure fixes (2.13.0)

Two persona tests of 2.12.0 found player-facing sentences that the code didn't keep. The rule applied: every sentence a player reads about their data must be literally true. Where code and copy disagreed, the code now keeps the promise the player agreed to.

- **"What the host or guest saw" shows each role exactly.** A studio event never has a funnel, with or without a guest reader. The account page says "{guest} saw nothing about this meetup…" (or, with no guest, that the studio ran it alone) and never publishes or computes a funnel for it. `publishIfDue` and the admin publish route refuse every event that isn't an outside event at level 1 or above. An outside level-0 host sees only the status, and the page says so.
- **Unlink takes the name, the credential and the listing.** The request takes the game off the requester's kid list at once (the Matrix id is in hand then, and is never stored); the user routes refuse to list or re-sync a stranger game for an account that isn't one of its seats or has asked to be unlinked. "Done" also renames the seat to "Parent 1"/"Parent 2" (saved and live, before the disconnect, so the co-parent's lobby already carries it) and replaces the seat token, so the old resume credential reads nothing. The co-parent's seat is untouched. This supersedes "the co-parent's row doesn't change": see the next point.
- **A player's stop says so on both rows.** The stopper reads "you stopped this code"; the co-parent reads "this code no longer opens", and never why. The same "ended" row shows when a code lapsed by the clock (unopened after 14 days, or its read window ran out), a schedule that's the same for every code. This replaces §5.4's silent stop for explicit player stops: the old row said the code worked when it didn't.
- **No safety oracle on the account page.** A row is never computed from live safety state (a report, case, hold, ban, block, suspension or failed adult check). A code the server stops for one of those (`stopped_by` null) keeps the row it had, and surfaces only as the reader's generic "this code isn't available". The account page is loaded by the player, so anything else would tell a reported or banned player so. A test compares a reported player's rows with a clean control's.
- **A code's date is the latest date anyone can read it.** Before it's opened, the row gives the open-by date (14 days after it appears) and the latest read date (open-by + 30 days). After, the real read-until. The card's L3 block states both periods.
- **A share "no" can become "yes" until the window closes**, from the end screen or the account page. To the other seat this is the same as a "later" that became yes: no message, the same random 2–10 minute delay before a code. The no-sayer's line says they can change it, and until when.
- **Studio learning can be withdrawn.** `POST /stranger/account/learning {answer:"no"}` sets this seat's answer to no at any time (only "no" is accepted there). The allow-list is read from the answers, so the game leaves it at once. The question screen says a yes can be changed later.
- **"Remove from my list" deletes the attendance record** (`host_event_acks` for that subject and event), after a confirm that says so. Nothing needs it once the player lets it go: the event's terms are frozen on the event, reports go through the game's run, and a funnel already published is kept as published (one not yet published counts one fewer). The card discloses the record: "the studio records that your account came to this meetup, and which card you agreed to, until a year after the meetup closes…".
- **The card's trace line** no longer suggests the account page deletes the technical record: it says there's no way yet to ask for deletion, and that taking a game off your account deletes neither the game nor the record.

# As built: persona-test fixes, host side (2.12.1 onward)

- **Report card on reopen (2.12.1).** The report card is server-owned state (`GameState.reportCard`), on every STATE and `GET /state`; rehydration restores it and the epilogue from the `endgames` row.
- **Host type on the person (2.14.0).** §9.1 is recorded once per person (`host_people.host_type`: club, authority, events_business, sensitive, studio), not per event. Each event's `authority` and `events_business` flags are derived from its people (the per-event boxes can only add to them). An events business never hosts and can only promote a studio event; its `organisation` (and any "(…)" in its display name) is refused in the event's name and welcome. A sensitive-community counsellor or studio staff can be a guest reader, never a host; an authority host gets L1 at most and is never a guest reader. People from before migration 036 are backfilled only where an event already says what they are (an authority outside host → authority, any other outside host → club); the rest stay unset and can't go on a new event until the admin sets the type, once.
- **Promoters (2.14.0).** `host_events.promoter_ids`. A promoter is refused at the queue and at JOIN_GAME exactly like the host (H12, the same neutral copy), sees nothing in the portal, and the card says "the business or group that sent you this link can't play at this meetup, and sees nothing about who came or how it went." Promoters can be added after the first acknowledgement (a new card version), except an events business when the card promised the handle exchange.
- **Reader codes (2.15.0).** The redemption limit counts failures only (10 an hour, 30 a day). A code the reader already opened re-opens by its words, uncounted and even while new codes are paused. Past the limit, every new code (right or wrong) gets the same 429 "too many codes didn't open lately…" after the same floor; nothing about which codes exist leaks. The portal lists her opened codes for their read window (`POST /host/codes/list`), re-opened by ref without redemption. The code view has one sticky watermark and a faint tiled mark instead of a watermark under every block (S3-3).
- **Public pages (2.16.0).** The deck is served in every mode (`/api/events/deck`, mounted outside the host-tools gate), so a handout link works whenever the site is up; its printout gives the game's address and how two people start. The portal and the account page probe `GET /api/host/on` instead. Analytics: Global Privacy Control means no Umami at all (the checklist item); a session that began at a meetup card, the portal, the deck or the account page sends no referrer, and no Umami payload carries a query or fragment (`data-before-send`). IBM Plex Mono is self-hosted and Google is gone from the CSP.
- **The host's link, card and new link (2.17.0).** An admin event's code is derived (`deriveEventCode(pepper, id, codeSeq)`, migration 037's `host_events.code_seq`), like a share code's words, so it is still stored only as a keyed hash but can be shown again: to the event's host in the portal and to the admin. The portal also shows the card exactly as players get it, read-only. "get a new link" bumps `code_seq`: the old code answers as for a code never made, so a player still on the card gets the neutral "this meetup isn't open anymore." (the card and sign-in now read the admin catch-all's bare 401 as that too); live passes and queue entries made at the old code move to the new one, so anyone past the card carries on. Events from before 037 keep `code_seq` null and offer only "get a new link". The numbers note no longer says "while your meetup is open" under a closed meetup.

# As built: the fail-safe scrub (2.14.1)

The 2.12 persona tests got third-party names (a bishop, a grandfather, a mission companion, a town), a paraphrased sidebar line, curly-single-quoted speech, quotes split across sentences and lines, and the players' nicknames through the §5.3 scrub. The rule is now: **a shared artifact never quotes or describes private-talk content, and never names anyone a player typed.** `buildShareSnapshot(reportCard, epilogue, sources)` (`server/src/hosts/share-snapshot.ts`) fails safe:

- **Sources, by kind.** `typed`: every parent message in every chat, confessionals, therapy lines. `privateTalk`: every non-shared message from either side (private and debrief, the child's private replies too) and confessionals. `derived`: the identity document, its snapshots, the memory summary. `scenes` and `childLines`: text the world generated (event description/setting/trigger, the child's shared lines). `childName`, `players`.
- **Report card: an allow-list, not a deny-list.** Only the title (rewritten to the child's name), `## Personality`, `## Strengths` and `## Struggles` are kept. Pivotal Moments (the section that retold scenes), Voices, Quotes and any unknown section never go. A missing Voices or Quotes heading still leaves out the whole card.
- **A sentence goes when it:**
  - overlaps a quoted span of **2+ words**, in any style (“” "" ‘’ '' «» „“ ‹› 「」 『』), where spans are found on the whole text so they cross sentences and lines, and an unclosed quote runs to the end of its paragraph. Apostrophes and one-word scare quotes stay;
  - shares a **5-word run** with `typed` or `privateTalk`, or a **6-word run** with `derived`, checked on the whole text so a run crossing a sentence or line break still counts. A run of only common words doesn't count;
  - shares **3 distinctive stems** (4+ letters, not a common or family word, not the child's or players' names) with one sentence of private talk (a paraphrase: the purple giraffe), or **2 private-only stems**: stems of one private sentence that appear nowhere in the open (shared chat, scenes, the child's shared lines). The real-model check game needed this: its epilogue said the child's red door "reminds her of Daddy's attic kite", from a sidebar about a kite hidden in the attic;
  - mentions secrets or confidences;
  - **names someone the game didn't generate.** A capitalised word mid-sentence must be the child's name, a name in `scenes`/`childLines` that no player also typed, a day, month, holiday or family word, or a player's name or nickname. A capitalised word at the start of a sentence goes if it's a title (Bishop, Elder, Aunt…), is written capitalised mid-sentence in what was typed or in the text itself, or was typed and is never an ordinary lowercase word in the generated text (so "gary" typed in lower case is still a name).
- **40% rule** per part, as before.
- **Security review (2.16.1).** Three weakenings fixed: bold text mid-sentence is mid-sentence (only a leading `**label**` and the first word after it count as a start); typed words are compared in one normal form, as written and possessive-stripped, so a typed "Gary's" keeps a scene's "Gary" off the allow-list; relationship and person words (dad, mother, home, boy…) count in every overlap and paraphrase check and are excluded only from the typed-name rule. A second real-model game then showed "much like their mother crying in the car" (a sidebar line) surviving on stems alone, so private-only words now count from 3 letters ("car", "hit").
- **Debugging.** `buildShareSnapshot(..., explain)` fills `explain` with each dropped sentence and its reason (quote, copied run, secret, name, paraphrase, private-only words).
- **Names (H5).** The players' names, diminutives (Rebecca → Becca, Becky; Tom → Tommy, Thomas) and nicknames built on them become "Parent 1"/"Parent 2". The child's name always wins.
- **Copy.** The card and the share step say what a code carries: the child's personality, strengths and struggles plus the epilogue, with quotes and 5-word copies removed, and a best effort on typed names and retellings ("we try to"), because those two are heuristics.

# As built: disclosure copy (2.16.2)

- **Never in a blog post.** The ri-devlog skill (outside this repo, `~/.claude/skills/ri-devlog/SKILL.md`) drops every `hosted_no_analysis` trace, allow-listed or not. The allow-list is for model-search and internal review only; the admin screen says so.
- **Never used to train AI.** `scripts/model-search.ts` replays real prompts to candidate models. Every request now carries OpenRouter's `provider: {data_collection: "deny"}` (`benchmarkRequest`), so allow-listed games go only to providers that don't store or train on prompts. A model with no such provider fails.
- **The ID check, as stored.** The card (`ID_LINE`) and the consent screen both name what's kept: the outcome, the Stripe session id, and a keyed fingerprint of the document's number and issuing country. None has a deletion path yet, and both say so. `CONSENT_VERSION` is now `2026-11-24.1`, so everyone re-consents to the corrected wording.
- **Who outside the studio gets what you type.** The reply models via OpenRouter, and OpenAI's moderation endpoint, which is called directly. The album prompt carries the name a player gives their co-parent, so the card no longer says "they don't get your name". `STUDIO_BLOCK` no longer says "nobody outside the studio sees it"; at a guest-reader event it's `STUDIO_BLOCK_GUEST`, which allows for the share code.
- **"In short".** Five plain lines open every card. Dates use the studio's day (`America/Los_Angeles`). The guest's role line shows what was checked and closes its clause with a comma. "Matrix handle" becomes "multiversegames.ai username" in the card and the exchange copy.
- **No live headcount.** `queue/poll` returns `{status:"waiting", others}` (is anyone else waiting here), not `{position, count}`. Held players still count like waiting ones (F2).
- **Studio events have no host to report.** The link reads "tell the studio about a problem" when no card names a host, and "report {name}" otherwise.
- **The queue form** asks "what should your co-parent call you? (any name)".
- **Private talk wording.** No multiplayer control starts a private talk (the button was removed in June: "private moments happen automatically", but nothing triggers them). The share copy now says "what each of you said in private", which covers the confessionals.

