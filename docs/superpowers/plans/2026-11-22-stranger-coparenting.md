# Stranger Co-Parenting (Tier 4) — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-07-31-coparent-matchmaking-design.md`
(approved by Liz, 2026-11-22).
**Rule for every phase:** tests first, then code. The full server suite and the
client tests pass before every merge to main. Every merge bumps the version
(feature = minor, docs/fix = patch). Nothing here removes an existing feature.

Everything ships **dark**: `RI_PARTNER_PAYWALL` and `RI_STRANGER_MODE` are off
by default, so production behaviour is unchanged until Liz switches them on.

## Ground truth this plan builds on

- Partner play today: `CREATE_GAME` / `JOIN_GAME` (invite link `?game=<id>`),
  `session-manager.ts` two-slot sessions, the lobby ready gate, the guardian quiz
  submitted per seat (`SUBMIT_PERSONALITY`), and the opening (seed + scene 1)
  generated once both personalities are in (`handlers.ts`, `startFirstScene`).
  Temperament is merged by `generatePersonalitySeed(parent1, parent2)`.
- Stranger mode reuses all of it. A matched pair is an ordinary two-seat game:
  the server creates it, writes both intakes in as `parentPersonalities`, and
  each player takes their seat through `JOIN_GAME` with a single-use match
  ticket instead of the invite link. There is no second game loop.
- Stripe: the only payment code is the PWYC support link and the
  `pay.multiversegames.ai` proxy, which runs on the studio's live key and has no
  callback. RI integrates Stripe directly through its REST API (no new npm
  dependency) with its own keys.
- Matrix: the client widget exposes `getOpenIdToken()`; Synapse answers
  `GET https://matrix.multiversegames.ai/_matrix/federation/v1/openid/userinfo`
  (checked 2026-11-22: an invalid token returns `M_UNKNOWN_TOKEN`). That turns
  the client-claimed Matrix id into a server-verified one.

## Phase 1 — Docs

- Spec updated with Liz's 2026-11-22 decisions, status "Approved by Liz,
  2026-11-22". This plan.

## Phase 2 — $20 per child, host pays when the partner joins

**Goal:** a two-human child costs the host $20 once, charged at the moment the
partner has really joined; everything off by default.

**Server**
- `server/src/payments/config.ts`: `RI_PARTNER_PAYWALL` (`on` enables),
  `RI_STRIPE_SECRET_KEY`, `RI_STRIPE_WEBHOOK_SECRET`, `RI_STRIPE_LIVE_PAYMENTS`
  (must be `true` for an `sk_live_`/`rk_live_` key to be used at all),
  `RI_PUBLIC_BASE_URL` (return URLs). `paywallActive()` is true only when the
  switch is on and a usable key is present; otherwise partner play stays free
  and a startup log line says why.
- `server/src/payments/stripe.ts`: a tiny form-encoded REST client
  (`createCheckoutSession`, `retrieveCheckoutSession`, `expireCheckoutSession`,
  `createRefund`) with idempotency keys, plus `verifyWebhookSignature`
  (HMAC-SHA256 over `t.payload`, constant-time compare, 5-minute tolerance).
- `server/src/payments/store.ts` + migration `028-partner-payments.sql`: one row
  per child (`partner_payments`), one row per Checkout Session
  (`partner_payment_sessions`), processed webhook event ids
  (`stripe_events`). In-memory twin for tests and DB-less dev. No foreign key
  to `games`: payment records outlive a deleted game.
- `server/src/payments/partner-payments.ts`: the per-child state machine
  `not_required → due → paid` (+ `refunded`), and the single function every
  path calls when a session reports paid (`applyPaidSession`). Duplicate paid
  session for an already-paid child → automatic refund.
- Opening gate in `handlers.ts`: the tail of `SUBMIT_PERSONALITY` becomes
  `tryStartOpening(gameId)`. For a two-human game with the paywall active it
  marks the child `due` and stops; after payment it runs the unchanged seed +
  `startFirstScene` path. `RETRY_OPENING` re-runs it for a client that has
  already submitted.
- REST: `POST /api/partner-payment/checkout` (host's player token required),
  `POST /api/partner-payment/confirm` (after the Stripe redirect),
  `POST /api/stripe/webhook` (raw body, signed), admin
  `POST /api/admin/games/:id/refund`. REST `/next-event` and `/message` refuse a
  seated game whose child is `due`.
- `ViewerState.payment`: `{ status, youPay, amountCents }` per seat.
  `ViewerState.yourPersonalitySubmitted` so a reload or a matched player is not
  sent back through the quiz.

**Client**
- `PartnerPaymentGate` in `MultiplayerGame`: host sees "your partner is here —
  $20 to begin raising <name> together" and a button to Stripe Checkout; the
  partner sees "waiting for <host> to finish setting up". After the redirect,
  `?paid=<session id>` calls `/confirm` once.
- `GuardianScreen` takes `alreadySubmitted` and opens on its waiting step.

**Tests first** (`server/tests/partner-payment-*.test.ts`)
- Paywall off (default): two-parent opening runs exactly as today; no payment
  row; solo never touched.
- Paywall on: opening stops at `due` after both personalities; seed is not
  generated; host sees `youPay: true`, partner `youPay: false`.
- No charge when the partner never joined: invite created, partner never
  joined / joined and left before the quiz → no `due`, checkout refused.
- Join retried / reconnect / handoff / re-invited partner → one row, still `due`
  or `paid`, never a second session created while one is open.
- Pay clicked twice → same session URL; concurrent clicks serialized.
- Webhook replayed → processed once; bad signature → 400 and no state change;
  wrong amount/currency/game id → not marked paid.
- Two sessions both paid → second refunded with an idempotency key, child paid
  once.
- `/confirm` and the webhook racing → one paid transition.
- Live key without `RI_STRIPE_LIVE_PAYMENTS=true` → paywall inactive.
- Only the host's token can create a checkout.

**Checkpoint review (adversarial, payment correctness)** — before merge:
- [ ] Can any path create a second charge for the same child? (retry, reload,
  two tabs, webhook + confirm race, a reclaimed seat, a restarted server with a
  stale in-memory cache)
- [ ] Can any path charge when the partner never joined? (link prefetch,
  partner leaves before quiz, partner seat reclaimed, game deleted)
- [ ] Is anything generated for the child before payment?
- [ ] Does a webhook with a forged or stale signature change anything?
- [ ] Is a live key refused without the explicit switch?
- [ ] With the switch off, are invite games byte-for-byte the old flow?

## Phase 3 — Stranger mode gate: switch, meetup codes, verified Matrix, age check

**Server**
- `server/src/stranger/config.ts`: `RI_STRANGER_MODE` (`off`|`meetup`|`public`),
  `RI_MEETUP_CODES`, `strangerVisible(meetupCode)`. `GET /api/stranger/config`
  answers `{ enabled }` and nothing else.
- `server/src/stranger/matrix-identity.ts`: verify an OpenID token against
  `RI_MATRIX_OPENID_USERINFO_URL` (default the Synapse federation endpoint) and
  issue a short-lived stranger pass bound to the verified Matrix id.
- `server/src/stranger/identity.ts`: Stripe Identity with
  `RI_STRIPE_IDENTITY_KEY`; `POST /api/stranger/verify/start` requires the
  recorded biometric consent; `POST /api/stranger/verify/check` and the webhook
  `identity.verification_session.*` both funnel into one `applyVerification`.
  Stores outcome only (`adult` / `minor` / `failed`), never the date of birth.
  Redacts the session afterwards unless `RI_IDENTITY_REDACT=off`.
- `server/src/stranger/store.ts` + migration `029-stranger.sql`: verifications,
  consents, stranger games, handle-exchange choices, reports, suspensions.
- `adultForPool(subject)`: verification `adult` **and** (`livemode` or, outside
  production only, `RI_STRANGER_ALLOW_TEST_IDENTITY=true`), not `minor`, not
  banned by a child-safety case, not suspended.

**Client**
- Start screen shows "raise a child with a stranger" only when
  `/api/stranger/config` says so (with the page's `?meetup=` code).
- `StrangerMode` screens: what this is (18+, played blind, no profiles, the
  dating-safety notice in bold capitals ≥12pt), Matrix sign-in, the biometric
  consent screen, the Stripe Identity redirect and return, and the AI co-parent
  fork for anyone who doesn't verify.

**Tests first**
- Switch off: config says disabled, every stranger endpoint 404s, queue events
  refused, start-screen button absent (client test).
- Meetup mode: wrong / missing code refused; right code allowed.
- Matrix: invalid token refused; client-claimed `userId` never accepted as the
  subject.
- Identity: start refused without consent; dob 17y364d → `minor`; 18 today →
  `adult`; missing dob → not adult; test-mode verification refused in
  production; outcome stored without dob; redact called.

**Checkpoint review (adversarial, minor exclusion)**
- [ ] Is there any way to reach the queue without a live-mode adult result for a
  server-verified Matrix id? (claimed userId, replayed pass, test-mode check in
  prod, a `minor` result followed by a retry, webhook spoof)
- [ ] Does any stored row hold a date of birth, document or image?
- [ ] Does the consent record land before the Stripe session is created?

## Phase 4 — Queue, matchmaker, join window, AI co-parent

**Server**
- `server/src/stranger/queue.ts`: in-memory queue keyed by subject, one entry
  per subject, scoped by meetup code; live count broadcast; matchmaker runs on
  change (debounced, one at a time).
- `server/src/stranger/matchmaker.ts`: `matchmaker` LLM role, anonymous entry
  ids, JSON pairs validated (disjoint, known ids, not a blocked pair); FIFO
  fallback on failure. Langfuse input fully redacted for this role.
- On match: host = earlier `queuedAt`; game created from the host's child name
  with relationship "co-parents who were never together"; both intakes written
  as `parentPersonalities`; two single-use tickets bound to {game, slot,
  subject}; `STRANGER_MATCHED` to each.
- `JOIN_GAME` with `matchTicket` seats the player in their slot. Stranger games
  refuse a plain invite join, a disconnected-seat reclaim by anyone new, and
  `REQUEST_HANDOFF`.
- Join window (`RI_STRANGER_JOIN_WINDOW_MS`, default 3 min): both seated → the
  opening (and the host's payment step); one no-show → the present player is
  offered requeue (original place) or the AI co-parent; nobody → game discarded.
- AI co-parent: `Player.ai` / `Player.aiStandIn` in `session-manager.ts`
  (always ready, always connected for the ready gates); an `ai_coparent` LLM
  role that speaks sparingly in family chat through the same parent-message
  pipeline; takeover after `RI_AI_TAKEOVER_GRACE_MS` disconnected in a stranger
  run; the human reclaims their seat by reconnecting. An AI child is never
  charged.
- Unverified fork: `CREATE_GAME` with `aiCoparent: true` (only where stranger
  mode is visible) creates a game with the AI in seat 2.

**Tests first**
- Queue refuses: not adult, minor, banned, suspended, no disclosure ack,
  already queued, wrong meetup code. Admission re-checked at match.
- Host is the first queued; child name is the host's; seats are host=parent1.
- Ticket single-use, wrong subject refused, invite link refused for a stranger
  game, seat reclaim by a stranger refused, handoff refused.
- No-show: present player requeued at original place / AI chosen → AI seat,
  payment `not_required`; no charge ever created for the no-show match.
- Both arrive + paywall on → `due` for parent1 only.
- AI co-parent: ready gates pass with one human; AI messages are labelled;
  takeover after grace; human reclaims.
- Matchmaker: invalid JSON → FIFO; blocked pair never matched.

**Checkpoint review (adversarial, both lines)**
- [ ] Can a minor or unverified player end up seated in a stranger game by any
  join path (ticket theft, invite link, reclaim, handoff, REST)?
- [ ] Can a no-show match or an AI-completed child be charged?
- [ ] Is the host still the payer after a no-show conversion or a requeue?

## Phase 5 — Handle exchange, report and block

**Server**
- `HANDLE_EXCHANGE` socket event (yes / no + disclosure ack), allowed only after
  the report card in a stranger game with two human seats, both subjects
  re-checked `adultForPool`, no report on the game. Mutual yes → each seat's
  view carries the other's Matrix id; any no → closed.
- `STRANGER_REPORT` at any time: report row, pair block, pool suspension,
  exchange closed. Admin: `GET /api/admin/stranger/reports`,
  `POST /api/admin/stranger/reports/:id/resolve`.

**Client**
- After the report card: the one prompt, with the dating-safety notice.
- A quiet "report this player" control in stranger runs.

**Tests first**
- Exchange: refused on AI runs, with an AI stand-in seat, before the report
  card, for an invite game, after a report, if either verification is gone;
  one yes reveals nothing; mutual yes reveals each to the other only; answers
  are final.
- Report suspends and blocks; suspended subject refused at queue.

**Checkpoint review (adversarial)**
- [ ] Can a handle leak to a non-consenting player, an AI run, a third socket,
  the room broadcast or a log line?
- [ ] Is the handle exchange reachable for a minor by any path?

## After each deploy

Real-browser check against https://multiversegames.ai/raising-intelligences/
(Playwright at `~/.npm/_npx/787f53666b8d4740/node_modules/playwright/index.mjs`,
installed browsers only): solo play starts, invite partner play works with two
browser contexts through the lobby and quiz, and stranger mode is not visible
(start screen, `?meetup=anything`, `/api/stranger/config`).

## What Liz still checks at meetups (from the spec's open questions)

Carried into the final report: COPPA/state minor laws, AI Act Art. 50 wording,
EU CSAM Regulation, UK Children's Code, NJ/TX statutory wording, BIPA retention
schedule, UK HEAA documentation, GDPR DPIA, NCMEC registration before the handle
exchange is used, CA SB 243 before the paywall goes live.
