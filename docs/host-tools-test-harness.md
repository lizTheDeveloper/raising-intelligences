# Host tools: local test harness

This guide runs meetup mode and the host tools prototype on your own machine. Sign-in, the ID check and the model are faked, so testing costs nothing and needs no Stripe or Matrix account. The fakes exist only outside production: with `NODE_ENV=production`, every `RI_DEV_*` flag is refused and logged as `dev_harness_refused_in_production`.

## 1. Start the app with meetup mode on

From the repo root:

```bash
export RI_STRANGER_MODE=meetup
export RI_STRANGER_PEPPER=$(openssl rand -hex 32)       # any 32+ bytes; keep it for the session
export RI_SHARE_CODE_SECRET=$(openssl rand -hex 32)     # needed only for level-3 (share code) events
export ADMIN_TOKEN=local-admin                          # the admin screen and the curl calls below
export RI_DEV_FAKE_MATRIX=true                          # "dev:@name:local" tokens sign in as @name:local
export RI_DEV_FAKE_IDENTITY=true                        # the ID check passes at once, as an adult...
export RI_STRANGER_ALLOW_TEST_IDENTITY=true             # ...which is a test-mode result, so allow those
export RI_DEV_MOCK_LLM=true                             # canned scenes and replies: no model calls
# optional: export RI_MEETUP_CODES=tea-party            # listed codes become studio level-0 events
# optional: export DATABASE_URL=postgres://…            # needed for the admin screen; keeps data across restarts
# optional: export RI_PUBLIC_BASE_URL=http://localhost:5183   # only if the client isn't on :5173 (see notes); also the base of the portal's meetup links
npm run dev                                             # server :3000 (or $PORT), client :5173
```

Notes:
- **Where data lives.** With no `DATABASE_URL`, everything is in memory, so events vanish when `tsx watch` restarts the server after an edit. To keep them, point `DATABASE_URL` at a scratch Postgres; migrations, including `034-host-tools.sql`, run at start.
- **Using a real model.** Leave out `RI_DEV_MOCK_LLM`. Real play then uses the usual `OPENROUTER_API_KEY` / `MODEL_TIER` settings.
- **Seeing trace tags.** The canned model goes through the same Langfuse tracer as the real one, so its traces carry the same `game_id:<id>`, `hosted_no_analysis` and `child_safety_hold` tags. With no Langfuse configured the tracer does nothing, unless you set `RI_DEV_TRACE_FILE=/some/path.jsonl`: every trace the server would send (tags, metadata and the redacted prompt) is then appended there as JSON lines. `jq -c 'select(.type=="trace") | .tags' /some/path.jsonl` lists the tags. Like the other dev flags, it is refused in production. A local Langfuse (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL`) takes precedence over the file. A trace that would name no game is never written; the server logs `llm_trace_refused_no_game_id` instead.
- **A client on another port.** After the ID check, the browser goes back to `RI_PUBLIC_BASE_URL`, which defaults to `http://localhost:5173`. If the client runs anywhere else (a second worktree on :5183, say), set `RI_PUBLIC_BASE_URL` to its address, or the return lands on a dead port and the page is blank.
- **The real model's card.** The canned report card has Personality, Strengths and Struggles, so a local share preview shows a card. A real model's card goes through the same scrub (`server/src/hosts/share-snapshot.ts`); pass an `explain` array to `buildShareSnapshot` to see each dropped sentence and why.
- **Stripe Identity is never faked in production.** The fake produces test-mode results, which `RI_STRANGER_ALLOW_TEST_IDENTITY` admits only outside production, because production forces that flag off. Production needs a real `RI_STRIPE_IDENTITY_KEY` (an `rk_` restricted key).

## 2. Create a host (or guest reader) and an event

**Admin screen:** open `http://localhost:5173/admin`, enter the `ADMIN_TOKEN`, and choose **Host tools**. The same page works in production at `https://multiversegames.ai/raising-intelligences/admin`. Locally the admin sign-in needs `DATABASE_URL` (the general admin routes only mount on Postgres); without it, use the curl calls below, which work either way.

**With curl.** For production, change `BASE` to `https://multiversegames.ai/raising-intelligences` and use the real `ADMIN_TOKEN`.

```bash
BASE=http://localhost:5173; AUTH="Authorization: Bearer $ADMIN_TOKEN"

# Is it on? (active, share-code secret present, trace settings, paywall)
curl -s -H "$AUTH" $BASE/api/admin/host-tools/status

# The usual way: an invite. It takes them through sign-in, the 18+ check (host copy) and the host terms,
# and only then makes the person, with that agreement recorded. The link is shown once (14 days, once).
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/invites \
  -d '{"displayName":"Sister Jensen","hostType":"sensitive","organisation":"Riverside Ward"}'
# → {"invite":{...},"token":"…","link":"http://localhost:5173/?hostinvite=…"}
# Open the link with &devmxid=@jensen:local appended. List: GET …/invites (open/used/expired/revoked);
# revoke: POST …/invites/<id>/revoke.

# Or directly: a host, guest reader or promoter who has already passed the 18+ check (from any
# meetup link with "get ready early"; locally that's one click). Without "agreementSigned":true
# (optionally "agreementVersion":"paper-2026-11") their portal asks them to agree to the host terms first.
# Only a keyed hash of the Matrix id is stored.
# hostType is required and set once (§9.1 lives on the person, not the event):
#   club             no authority over attendees, not a business, not sensitive: hosts at L0, L1 or L3
#   authority        authority over likely attendees: hosts at L0 or L1, never share codes, never a guest reader
#   events_business  a dating or events business: never hosts; may promote a studio event (unnamed, exchange off)
#   sensitive        a faith or sensitive-community counsellor: never hosts; guest reader at a studio event
#   studio           studio staff: guest reader at a studio event
curl -s -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/hosts \
  -d '{"matrixId":"@kofi:local","displayName":"Kofi","hostType":"club"}'
# A guest reader with a checked role (the role shows on the card only with roleChecked):
#   -d '{"matrixId":"@jensen:local","displayName":"Sister Jensen","hostType":"sensitive","roleText":"premarital counsellor","roleChecked":"practice website"}'
# A promoting business: its organisation name is kept off the card (refused in the event's name or welcome).
#   -d '{"matrixId":"@dev:local","displayName":"Dev (Spark Night)","hostType":"events_business","organisation":"Spark Night"}'
# Someone added before host types shows hostType null and can't go on a new event until it's set (once):
#   curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/hosts/<id>/type -d '{"hostType":"club"}'

# An event. The code comes back here. It is derived from RI_STRANGER_PEPPER, the event id and a count of
# replacements, so it is never stored in the clear (only its keyed hash), and can be shown again:
#   curl -s -H "$AUTH" $BASE/api/admin/host-tools/events/<id>/link          → {"code","link"}  (null for an event from before 2.17.0)
#   curl -s -X POST -H "$AUTH" $BASE/api/admin/host-tools/events/<id>/new-link  → a new code; the old one stops at once
NOW=$(($(date +%s)*1000)); CLOSE=$((NOW + 3*24*3600*1000))
curl -s -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/events \
  -d "{\"name\":\"tuesday tea\",\"kind\":\"studio\",\"level\":0,\"opensAt\":$NOW,\"closesAt\":$CLOSE}"
# → {"event":{...},"code":"word-word-word-word","link":"?meetup=word-word-word-word"}
# An outside host at level 1:   "kind":"outside","level":1,"hostPersonId":"<id from /hosts>","handleExchange":false
# A studio event with a guest:  "kind":"studio","level":3,"guestReaderId":"<id>"   (needs RI_SHARE_CODE_SECRET)
# Promoted by someone:          "promoterIds":["<id>"]   (refused at the queue and at JOIN_GAME like the host; an events
#                               business promoter turns the handle exchange off and is never named on the card)

# Pause, resume, close, or lower the level. After the first player acknowledges
# the card, these are the only changes allowed.
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/events/<id> -d '{"paused":true}'
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/events/<id> -d '{"closed":true}'

# Reports filed with "report this host"
curl -s -H "$AUTH" $BASE/api/admin/host-tools/host-reports
```

The server refuses what §9.1 of the spec rules out, from each person's host type (the per-event boxes can only add to it). For example: a host with authority over attendees can't run share codes, a dating or events business can't host (only promote a studio event that doesn't name it), a sensitive-community counsellor can't host, an event can run at most 14 days, and a level-3 event can't be created without `RI_SHARE_CODE_SECRET`. The error message says which rule applied.

## 3. Drive two players through a game cheaply

Each player needs their own browser storage. Use a normal window and a private window, or two browser profiles.

1. **Player A:** open `http://localhost:5173/?meetup=<code>&devmxid=@ash:local`. The `devmxid` shim exists only in dev builds. It signs in as `@ash:local` and is remembered in that window's localStorage.
2. **Player B:** open `http://localhost:5173/?meetup=<code>&devmxid=@bea:local` in the other window.
3. **Each player:** read the event card, then choose **sounds good, continue**. Then agree to the ID check (it returns at once). The queue form asks first what your co-parent should call you (any name), then the child's name; then join the queue.
4. **The pair:** both land in the same game. With `RI_DEV_MOCK_LLM=true`, every scene and reply is canned, so playing to the report card costs nothing.

To check the host side: a host, guest reader or promoter who joins their own event's queue gets "stranger mode isn't available here."

## 3b. The host portal and the deck

- **Onboarding by invite:** make an invite (section 2, or "Invites" on the admin screen) and open its link with `&devmxid=@jensen:local`. Sign in, agree to the host 18+ consent, "start the ID check" (locally `RI_DEV_FAKE_IDENTITY` sends you straight back to `?hostinvite=back`, which carries no token), read the host terms, "I agree", and the portal opens signed in. The token leaves the address bar as soon as the page loads. Opening the link again says "this invite isn't available."; the admin list shows it "used by Sister Jensen", and the person's "Host terms" column shows the version she agreed to. The routes: `POST /api/host/invite/peek|pass|consent|identity/start|identity/check|accept`.
- **A person added directly without a signed agreement** sees only the host terms in the portal until they agree (`POST /api/host/agree {pass, version}`); share codes and event actions answer 403 until then.

- **Host portal:** `http://localhost:5173/?host=1&devmxid=@robin:local` (the `devmxid` stand-in is dev-only). Sign in. An approved host sees their events' status. Numbers appear only for level 1 and up, once, 24 hours after close. Hosts can pause, resume, close and lower their own events. A guest reader sees each event's name and dates.
- **The host's link, card and new link** (each of the host's own events, not a guest reader's): "show the meetup link" shows the link to hand out, again, with "copy". "see the card your players see" shows the card exactly as `GET /events/card` gives it, read-only. "get a new link" warns, then replaces the code: the old code answers as for a code never made (the card, the acknowledgement and sign-in), so a player still on the card gets "this meetup isn't open anymore."; anyone already past the card (signed in, queued, playing) carries on, because their passes and queue entries move to the new code. A closed meetup shows only the card. An event made before 2.17.0 has no derivable code ("get a new link to see one here"). The routes: `POST /api/host/events/<ref>/link|card|new-link {pass}`.
- **Studio pause:** a pause made through the admin PATCH is the studio's. The host can't resume it ("the studio paused this meetup…"); only the admin can.
- **Every portal request re-checks the person.** The request is refused if the person is no longer approved by the admin, is no longer a verified adult, is on the ban list, or is suspended from stranger mode. Revoking the account's stranger passes also revokes its host pass.
- **Publish a funnel early** (for testing, once the event has been closed for 24 hours): `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/api/admin/host-tools/events/<id>/publish`
- **Discussion deck alone:** `http://localhost:5173/?deck=1`. No sign-in is needed, and it prints cleanly. It ends with a "to play" block giving the game's address and how two people start ("play with a partner", send the link). `GET /api/events/deck` is served in **every** mode, so the deck loads with `RI_STRANGER_MODE` unset too (check it by restarting without `RI_STRANGER_MODE=meetup`). `?host=1` and `?stranger=account` wait on `GET /api/host/on` instead, which is a 200 only in meetup mode and otherwise falls through like a path never built.
- **Untracked pages:** the meetup card, the portal and the deck send no Umami pageview and don't start the session beats.
- **Analytics (production builds only; dev never loads Umami):**
  - With Global Privacy Control on (`navigator.globalPrivacyControl === true`), no Umami script is added and `track()` sends and queues nothing.
  - Every payload passes through `window.__riUmamiBeforeSend` (the tracker's `data-before-send`). In a tab whose session began at a meetup card, the portal, the deck or the account page (`sessionStorage.ri_meetup_session`), the referrer is blank. Elsewhere it keeps the referring page without its query. No url or referrer ever carries a query or fragment.
  - To check without sending anything: build with `NODE_ENV=production npx vite build`, serve `client/dist` under `/raising-intelligences/` (a Playwright `context.route` that fulfils from `dist` and forwards `/api` to the harness server works), answer `analytics.*/script.js` with the real tracker, and fulfil `analytics.*/api/send` locally while recording each payload. Land on `?meetup=<code>` with a `referer` from another site and check that no payload has a referrer or mentions the code.
- **Fonts:** IBM Plex Mono is bundled (`@fontsource/ibm-plex-mono`); the CSP allows fonts and styles from this site only, so no page asks Google for anything.

## 3c. Share codes, end to end

1. Create an outside host at level 3 (needs `RI_SHARE_CODE_SECRET`): `"kind":"outside","level":3,"hostPersonId":"<id>","handleExchange":false`. A studio event at level 3 needs a guest reader instead.
2. Drive two players through a game at that code (section 3). With `RI_DEV_MOCK_LLM`, play to the report card.
3. After the report card, each seat sees the share step. Both say **yes**.
4. The code appears on each player's account page (`http://localhost:5173/?stranger=account&devmxid=@ash:local`) 2 to 10 minutes after the second yes. Locally you have to wait, because the delay is real.
5. The host enters the four words in the portal (`?host=1&devmxid=@robin:local`, under "share codes"). The view shows the scrubbed report card and epilogue, with one sticky watermark bar at the top and a faint mark tiled behind the text. Each opening appears on both players' account pages.
   - **Codes you've opened.** Once the reader has opened a code, it is listed under "codes you've opened" (meetup name, when she opened it, until when she can read it) for its 30-day read window. "read" opens it again with no words and no redemption (`POST /api/host/codes/list {pass}` → `{"codes":[{"codeRef","eventName","openedAt","until"}]}`). A code stopped since stays listed and opens as "this code isn't available."
   - **The limit counts failures only.** Re-entering the words of a code she already opened always works and is never counted. After 10 codes that didn't open in an hour (30 in a day), every *new* code, right or wrong, gets the same 429 "too many codes didn't open lately…" after the same 400ms floor; codes she already opened still open. To check: enter 10 made-up phrases, then a real unopened code and another made-up one, and compare the two answers.
6. **A game that can't make a code** behaves exactly the same for its players, except that no code ever appears. Examples: the safety ladder fired, there is a child-safety case or hold, a seat is now a minor, banned or suspended, or the pair is blocked. After 14 days the account page says "no code was made for this game."
7. **Stopping:** "stop this code" on the account page. The host's next attempt to open it says "this code isn't available." The stopper's row says "you stopped this code"; the co-parent's says "this code no longer opens" (never why). A code that lapsed by the clock reads the same way on both rows. A code the server stopped for a safety reason never changes either row (no oracle); only the reader sees "this code isn't available."
8. **Changing a no:** a player who said no can say yes from the account page until the 14-day window closes. The co-parent can't tell it from a "later" that became yes.

## 3d. Studio learning, unlinking and the purge

- **Studio learning:** create a studio event with `"studioLearning":true` (a level-3 studio event also needs a guest reader for share codes). After the report card, and after the share step if there is one, each seat is asked "can the studio learn from your game?". Either answer gets "thanks. that's noted." The co-parent sees nothing. Each player's account page shows their own answer, and a yes can be changed to no there at any time ("change it to no"), which takes the game off the allow-list at once.
- **What the studio may read:** `curl -H "$AUTH" $BASE/api/admin/host-tools/analysis-allowlist` → `{"games":[...]}`. A game is listed only when it's at a studio event, both seats said yes, and nothing excludes it (the same exclusions as share codes). Every Langfuse trace of a game at any event is tagged `hosted_no_analysis` (check it locally with `RI_DEV_TRACE_FILE`, section 1). `scripts/model-search.ts` and the ri-devlog skill drop those traces unless the game is on this list. The script reads the list with `RI_ADMIN_URL` and `ADMIN_TOKEN`; without them it drops every hosted trace.
- **Take this game off my account:** on the account page, a player chooses "take this game off my account" for a game, then confirms. Their code stops opening at once, and the co-parent's row doesn't change. The request then waits for the studio:
  ```bash
  curl -s -H "$AUTH" $BASE/api/admin/host-tools/unlink-requests            # id, when, event name: no player ids
  curl -s -X POST -H "$AUTH" $BASE/api/admin/host-tools/unlink-requests/<id>/done
  ```
  The request also takes the game off the player's kid list (`/api/user/:id/kids`) at once, and the list won't take it back from a later sync. "done" deletes the player's acknowledgements, share decision and learning choice for that game. It replaces their subject in the game's run with a placeholder, renames their seat to "Parent 1"/"Parent 2" (what the co-parent sees), replaces the seat token (the old resume link reads nothing), disconnects the seat, and stops it being taken again. The game disappears from their account page, and the co-parent keeps it. A report the co-parent files later still reaches the original account, through the request row, which is kept for a year.
- **Purge (weekly, from Liz's checklist):** `curl -s -X POST -H "$AUTH" $BASE/api/admin/host-tools/purge` → `{"deleted":{"host_event_acks":0,...}}`, counts only. What it deletes, and when:

  | What | When |
  |---|---|
  | Acknowledgements, frozen terms and the published funnel | 1 year after the event closes |
  | Share decisions | when the window closes (and as soon as a code is made) |
  | A code's snapshot | cleared when the code stops opening |
  | The code's row and access log | 30 days after it stops opening |
  | Done unlink requests | after 1 year |

  Learning choices stay as long as the game's traces: until the studio deletes them, while `RI_HOSTED_TRACE_RETENTION_DAYS` is unset.
- The admin screen (`/admin`, host tools tab) has all three: the unlink queue, the purge button and the allow-list.

## 4. Run the tests

On the Mac, run only the host tests; send the full suite to the vast box.

```bash
cd server
npx vitest run tests/host-*.test.ts tests/langfuse-hosted-and-landmine.test.ts tests/langfuse-game-id-production-path.test.ts tests/dev-harness.test.ts
DATABASE_URL=postgres://… npx vitest run --no-file-parallelism tests/*pg*.test.ts   # Postgres store, migrations 034–035
```

`tests/langfuse-game-id-production-path.test.ts` checks trace tags on the production path: `new HostHarness({ wrapLlm: (m) => traceAppLlm(m, "standard") })` wraps the canned model exactly as `index.ts` does, and `tests/helpers/langfuse-sink.ts` is a Langfuse stand-in over HTTP that the real SDK posts to (it also answers `GET /api/public/traces?tags=…`).

`tests/helpers/host-tools.ts` (`HostHarness`) boots the whole app with stranger mode, a fake ID check, a switchable paywall and host tools. It drives players through the real routes: `h.event()`, `h.arrive()`, `h.queue()`, and `h.pair()`, which matches two adults and seats them both.
