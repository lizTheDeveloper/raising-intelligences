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
npm run dev                                             # server :3000 (or $PORT), client :5173
```

Notes:
- **Where data lives.** With no `DATABASE_URL`, everything is in memory, so events vanish when `tsx watch` restarts the server after an edit. To keep them, point `DATABASE_URL` at a scratch Postgres; migrations, including `034-host-tools.sql`, run at start.
- **Using a real model.** Leave out `RI_DEV_MOCK_LLM`. Real play then uses the usual `OPENROUTER_API_KEY` / `MODEL_TIER` settings.
- **Stripe Identity is never faked in production.** The fake produces test-mode results, which `RI_STRANGER_ALLOW_TEST_IDENTITY` admits only outside production, because production forces that flag off. Production needs a real `RI_STRIPE_IDENTITY_KEY` (an `rk_` restricted key).

## 2. Create a host (or guest reader) and an event

**Admin screen:** open `http://localhost:5173/admin`, enter the `ADMIN_TOKEN`, and choose **Host tools**. The same page works in production at `https://multiversegames.ai/raising-intelligences/admin`. Locally the admin sign-in needs `DATABASE_URL` (the general admin routes only mount on Postgres); without it, use the curl calls below, which work either way.

**With curl.** For production, change `BASE` to `https://multiversegames.ai/raising-intelligences` and use the real `ADMIN_TOKEN`.

```bash
BASE=http://localhost:5173; AUTH="Authorization: Bearer $ADMIN_TOKEN"

# Is it on? (active, share-code secret present, trace settings, paywall)
curl -s -H "$AUTH" $BASE/api/admin/host-tools/status

# A host or guest reader. They must already have passed the 18+ check: they do it
# from any meetup link with "get ready early". Locally that's one click.
# Only a keyed hash of the Matrix id is stored.
curl -s -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/hosts \
  -d '{"matrixId":"@dev:local","displayName":"Dev"}'
# A guest reader with a checked role (the role shows on the card only with roleChecked):
#   -d '{"matrixId":"@jensen:local","displayName":"Sister Jensen","roleText":"premarital counsellor","roleChecked":"practice website"}'

# An event. The plaintext code comes back ONCE, here, and is never stored or shown again.
NOW=$(($(date +%s)*1000)); CLOSE=$((NOW + 3*24*3600*1000))
curl -s -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/events \
  -d "{\"name\":\"tuesday tea\",\"kind\":\"studio\",\"level\":0,\"opensAt\":$NOW,\"closesAt\":$CLOSE}"
# → {"event":{...},"code":"word-word-word-word","link":"?meetup=word-word-word-word"}
# An outside host at level 1:   "kind":"outside","level":1,"hostPersonId":"<id from /hosts>","handleExchange":false
# A studio event with a guest:  "kind":"studio","level":3,"guestReaderId":"<id>"   (needs RI_SHARE_CODE_SECRET)

# Pause, resume, close, or lower the level. After the first player acknowledges
# the card, these are the only changes allowed.
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/events/<id> -d '{"paused":true}'
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' $BASE/api/admin/host-tools/events/<id> -d '{"closed":true}'

# Reports filed with "report this host"
curl -s -H "$AUTH" $BASE/api/admin/host-tools/host-reports
```

The server refuses what §9.1 of the spec rules out. For example: a host with authority over attendees can't run share codes, a dating or events business can't host, a sensitive community can't host, an event can run at most 14 days, and a level-3 event can't be created without `RI_SHARE_CODE_SECRET`. The error message says which rule applied.

## 3. Drive two players through a game cheaply

Each player needs their own browser storage. Use a normal window and a private window, or two browser profiles.

1. **Player A:** open `http://localhost:5173/?meetup=<code>&devmxid=@ash:local`. The `devmxid` shim exists only in dev builds. It signs in as `@ash:local` and is remembered in that window's localStorage.
2. **Player B:** open `http://localhost:5173/?meetup=<code>&devmxid=@bea:local` in the other window.
3. **Each player:** read the event card, then choose **sounds good, continue**. Then agree to the ID check (it returns at once), name the child, and join the queue.
4. **The pair:** both land in the same game. With `RI_DEV_MOCK_LLM=true`, every scene and reply is canned, so playing to the report card costs nothing.

To check the host side: a host who joins their own event's queue gets "stranger mode isn't available here."

## 3b. The host portal and the deck

- **Host portal:** `http://localhost:5173/?host=1&devmxid=@robin:local` (the `devmxid` stand-in is dev-only). Sign in. An approved host sees their events' status. Numbers appear only for level 1 and up, once, 24 hours after close. Hosts can pause, resume, close and lower their own events. A guest reader sees each event's name and dates.
- **Studio pause:** a pause made through the admin PATCH is the studio's. The host can't resume it ("the studio paused this meetup…"); only the admin can.
- **Every portal request re-checks the person.** The request is refused if the person is no longer approved by the admin, is no longer a verified adult, is on the ban list, or is suspended from stranger mode. Revoking the account's stranger passes also revokes its host pass.
- **Publish a funnel early** (for testing, once the event has been closed for 24 hours): `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/api/admin/host-tools/events/<id>/publish`
- **Discussion deck alone:** `http://localhost:5173/?deck=1`. No sign-in is needed, and it prints cleanly.
- **Untracked pages:** the meetup card, the portal and the deck send no Umami pageview and don't start the session beats.

## 3c. Share codes, end to end

1. Create an outside host at level 3 (needs `RI_SHARE_CODE_SECRET`): `"kind":"outside","level":3,"hostPersonId":"<id>","handleExchange":false`. A studio event at level 3 needs a guest reader instead.
2. Drive two players through a game at that code (section 3). With `RI_DEV_MOCK_LLM`, play to the report card.
3. After the report card, each seat sees the share step. Both say **yes**.
4. The code appears on each player's account page (`http://localhost:5173/?stranger=account&devmxid=@ash:local`) 2 to 10 minutes after the second yes. Locally you have to wait, because the delay is real.
5. The host enters the four words in the portal (`?host=1&devmxid=@robin:local`, under "share codes"). The view shows the scrubbed report card and epilogue with a watermark. Each opening appears on both players' account pages.
6. **A game that can't make a code** behaves exactly the same for its players, except that no code ever appears. Examples: the safety ladder fired, there is a child-safety case or hold, a seat is now a minor, banned or suspended, or the pair is blocked. After 14 days the account page says "no code was made for this game."
7. **Stopping:** "stop this code" on the account page. The host's next attempt to open it says "this code isn't available." The co-parent's row doesn't change.

## 3d. Studio learning, unlinking and the purge

- **Studio learning:** create a studio event with `"studioLearning":true` (a level-3 studio event also needs a guest reader for share codes). After the report card, and after the share step if there is one, each seat is asked "can the studio learn from your game?". Either answer gets "thanks. that's noted." The co-parent sees nothing, and the first answer stands. Each player's account page shows their own answer.
- **What the studio may read:** `curl -H "$AUTH" $BASE/api/admin/host-tools/analysis-allowlist` → `{"games":[...]}`. A game is listed only when it's at a studio event, both seats said yes, and nothing excludes it (the same exclusions as share codes). Every Langfuse trace of a game at any event is tagged `hosted_no_analysis`. `scripts/model-search.ts` and the ri-devlog skill drop those traces unless the game is on this list. The script reads the list with `RI_ADMIN_URL` and `ADMIN_TOKEN`; without them it drops every hosted trace.
- **Take this game off my account:** on the account page, a player chooses "take this game off my account" for a game, then confirms. Their code stops opening at once, and the co-parent's row doesn't change. The request then waits for the studio:
  ```bash
  curl -s -H "$AUTH" $BASE/api/admin/host-tools/unlink-requests            # id, when, event name: no player ids
  curl -s -X POST -H "$AUTH" $BASE/api/admin/host-tools/unlink-requests/<id>/done
  ```
  "done" deletes the player's acknowledgements, share decision and learning choice for that game. It replaces their subject in the game's run with a placeholder, disconnects their seat, and stops the seat being taken again. The game disappears from their account page, and the co-parent keeps it. A report the co-parent files later still reaches the original account, through the request row, which is kept for a year.
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
npx vitest run tests/host-*.test.ts tests/langfuse-hosted-and-landmine.test.ts tests/dev-harness.test.ts
DATABASE_URL=postgres://… npx vitest run --no-file-parallelism tests/*pg*.test.ts   # Postgres store, migrations 034–035
```

`tests/helpers/host-tools.ts` (`HostHarness`) boots the whole app with stranger mode, a fake ID check, a switchable paywall and host tools. It drives players through the real routes: `h.event()`, `h.arrive()`, `h.queue()`, and `h.pair()`, which matches two adults and seats them both.
