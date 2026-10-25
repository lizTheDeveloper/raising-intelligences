# Child safety: evidence preservation and NCMEC reporting

This document covers how Raising Intelligences (RI) handles content flagged as child sexual exploitation: what the server keeps, how long it keeps it, who reviews it, and how a report gets to NCMEC's CyberTipline. A human files every report. Nothing in the code contacts NCMEC or the police.

The code lives in `server/src/safety/child-safety/` (vault, store, crypto, report, maintenance), `server/src/routes/child-safety.ts` (the review queue and ingest API), and `client/src/components/admin/ChildSafety.tsx` (the admin page). The schema is migration `025-child-safety.sql`.

> This is an operational guide, not legal advice. The statute is 18 U.S.C. §2258A, as amended by the CyberTipline Modernization Act (2018) and the REPORT Act (2024). Have counsel check the "what is reportable" section before the first filing.

## What Liz has to do herself

The code can't do these steps.

1. **Register as an electronic service provider with the NCMEC CyberTipline.** §2258A has providers give NCMEC a mailing address, phone number, fax number (if any), email address, and an individual point of contact. Start from NCMEC's site (https://www.missingkids.org, Contact Us / CyberTipline) or call NCMEC at 1-800-843-5678 and ask for **ESP registration**. NCMEC then sets up an ESP account for the provider: reports go through the ESP reporting portal, or later through the reporting API. *I couldn't confirm NCMEC's current ESP-intake email address from a public source, so get it from NCMEC rather than from a blog post.* Register once, under the legal entity that runs the games (Multiverse Games / Multiverse Studios), so the one registration covers RI, Whispers, TSB and BREACH.
2. **Choose the reviewers** (Liz plus at most one or two others) and give them the RI admin token. Every reviewer types their own name into the Child Safety tab, and every view is logged under that name.
3. **Set the contact env vars** on the RI container so the report package fills in the reporting-ESP block. They are optional; without them the reviewer types the details on the form.
   - `CHILD_SAFETY_ESP_NAME` (default "Multiverse Games (Raising Intelligences)")
   - `CHILD_SAFETY_ESP_CONTACT_NAME`
   - `CHILD_SAFETY_ESP_CONTACT_EMAIL`
4. **Review the open queue.** The first deploy copies older sexual-content flags from `moderation_flags` into the vault as open cases (source `ri_legacy_flag`). Two prod flags were `sexual/minors` per-message flags. Look at them first and decide whether each is reportable.
5. **Read the "what is reportable" section with counsel** once, before the first filing.
6. **Keep the encryption key safe.** It is in VaultWarden as **"RI child-safety evidence key"** and in `/opt/raising-intelligences/.env` on the games host as `CHILD_SAFETY_EVIDENCE_KEY`. If it is lost, every stored case becomes unreadable. Don't rotate it without a re-encryption plan: cases record the key id they were written with.

## What is recorded

### Evidence cases (`child_safety.evidence_cases`)

A case is written automatically, in one transaction with an access-log row, whenever RI blocks content in the child-sexual category:

- **The per-message classifier** (OpenAI `omni-moderation`). It checks `sexual/minors` in every phase, plus `sexual` whenever the listener is the child. Every block from this classifier opens a case (`source: ri_message`).
- **The scene reader's `block` verdict** (`source: ri_scene`). That verdict covers sexualization of the child *or* real-world harm, so the reviewer triages. If the reason mentions sexual content, the case is tagged `scene_reader:sexualization`; otherwise it is tagged `scene_reader:block`.
- **Other services** posting to the ingest endpoint (see "Other games" below).

Each case holds:

| Field | Where |
|---|---|
| Flagged content (message, or scene transcript) | encrypted payload |
| The prior N turns of chat, N = `CHILD_SAFETY_CONTEXT_TURNS` (default 20) | encrypted payload |
| Incident time and preservation time | payload and `incident_at` |
| IP address of the flagged request | `ip_address` and payload |
| Every IP, user agent and Matrix ID in the game's IP log, each tagged with the seat (parent1/parent2) that produced it | payload `ipHistory` and `identifiers` |
| User agent | encrypted payload |
| Matrix IDs of the game's players, marked **claimed, unverified** (RI has no accounts) | `identifiers` |
| Game id (text, **not** a foreign key) | `game_ref` |
| Classifier categories, every score, and the exact model version | payload, `categories` |
| SHA-256 of the flagged content | `content_sha256` and payload |

The `moderation_flags` row for the same block now stores `[withheld: child-safety case <id>]` in place of the content. That row still cascades with the game, but the vault copy does not.

### Whose identifiers: the flagged sender vs other participants

RI games can be multiplayer, and a device can be shared, so a case never treats everyone in a game as the offender:

- Every IP-log row records the **seat** that produced it: game create, join, rejoin, or message.
- The case marks each identifier as **flagged** (the sender of the flagged content) or **other participant** (any other seat, or no known seat).
  - For a per-message flag, the request IP is the sender's.
  - For a scene-reader flag, the request that ended the scene may have come from the co-player. In that case the sender's IPs come from their seat's IP-log rows.
- **Confirm bans only the flagged sender's verified identifiers.** Only those go in the report package.
- Other participants appear separately in the review page, marked "not banned, not in the report". A reviewer can **Include** one, with a required reason. That choice is logged as `include_participant`, and the identifier is then banned and reported.
- **Only verified identifiers can be banned or reported.** In RI the only verified identifiers are IPs the server observed. A Matrix `userId` is client-supplied: it is kept as evidence and labelled "claimed, unverified" in the report, but it never drives a ban, and a reviewer cannot include one. Ingest callers mark an identifier `verified: true` only when their own service authenticated it.
- A shared device means a shared IP. If both seats used the same IP, banning the sender's IP also blocks that device. The reviewer sees this in the IP log.

### Storage and access

- **No cascade.** The vault is a separate schema, `child_safety`, with no foreign key to `games`. Deleting a game (including a player's research deletion through `deleteGameData`) or unbanning an IP leaves the case untouched. Tests: `child-safety.test.ts` "deleting the game keeps the evidence" and `child-safety-pg.test.ts`.
- **Encrypted at rest.** The payload is AES-256-GCM encrypted with `CHILD_SAFETY_EVIDENCE_KEY` (32 bytes, base64) from the container env. If the key is ever missing, the case is still written, with key id `none`, and an error goes to GlitchTip. Losing evidence is worse than storing it unencrypted for a while. Fix the env when that happens.
- **Restricted.** `REVOKE ALL ... FROM PUBLIC` on the schema and its tables. Only the app's own database role can read it, so a read-only analytics role granted on `public` cannot.
- **Access-logged.** `child_safety.access_log` records every list, view, export, dismiss, confirm, report, release, purge and test delete, with the reviewer name and IP. A view writes its log row *before* decrypting; if the log write fails, nothing is shown. Log rows are never purged.
- **Kept out of other logs.** Server logs carry the case id, never the content. The OpenAI moderation trace no longer sends flagged content to Langfuse (`[withheld: child-safety evidence vault]`). When a case opens, every Langfuse trace for that game is tagged `child_safety_hold`, and later traces in the same process carry the tag from the start. `scripts/model-search.ts` and the RI devlog skill drop held traces; any new bulk reader must do the same (`server/src/observability/child-safety-exclusion.ts`).

### IP log (`child_safety.ip_log`)

IP, time, event, user agent and Matrix ID are recorded for every game creation (REST and socket), every multiplayer join, and **every parent message on every surface**: family chat, sidebar, adult chat and therapy, over REST and socket. The scene reader flags at scene end, so its case still gets every IP that wrote the scene.

**Retention: 90 days** (`CHILD_SAFETY_IP_LOG_RETENTION_DAYS`), enforced by the purge sweep. When a case opens, the game's IP-log rows are copied into the case, so they last as long as the case does.

## Retention

| What | Kept for | Setting | Purged by |
|---|---|---|---|
| Open case | **Indefinitely, until a human decides.** Never auto-purged. | — | — |
| Dismissed case (false positive) | **90 days** after dismissal | `CHILD_SAFETY_DISMISSED_RETENTION_DAYS` | sweep |
| Confirmed case | Locked; **at least 365 days** from confirmation | `CHILD_SAFETY_RETENTION_DAYS` (floor 365) | never automatically |
| Reported case | Locked; **at least 365 days from the report date** (§2258A(h)) | same | never automatically |
| Released case | Purgeable straight away, once a human releases it after `retain_until` | — | sweep |
| IP log | **90 days** | `CHILD_SAFETY_IP_LOG_RETENTION_DAYS` | sweep |
| Access log | Indefinitely | — | — |

The sweep runs at startup and every six hours (`startPurgeSweep`). It only deletes unlocked cases in `dismissed` or `released` status, and the database enforces this: a CHECK constraint stops an open, confirmed or reported case from ever getting a purge date, and stops a confirmed or reported case from being unlocked. Setting `CHILD_SAFETY_RETENTION_DAYS` below 365 has no effect; the floor wins. Extend a hold by leaving the case unreleased: nothing releases one automatically.

## Review workflow

Open **Admin → Child Safety** at `https://multiversegames.ai/raising-intelligences/admin` and sign in with the admin token. Enter your name; every action is logged under it.

1. **The list** shows metadata only: time, source, categories, IP and hold state. No content is shown.
2. **View evidence** decrypts the case and is logged. Read the flagged text, the context and the IP log.
3. Decide:
   - **Dismiss**: a false positive. A reason is required. The evidence is purged 90 days later.
   - **Confirm & report**: reportable. This locks the case (one-year minimum hold) and bans the **flagged sender's** IPs. Those IPs can no longer be unbanned from the Moderation tab: the unban returns 409. Co-players are not banned unless you **Include** them, with a reason. Unverified Matrix IDs are never banned.
4. **Report package** (confirmed cases only, and logged as an export) opens a CyberTipline-ready HTML page with the incident type and time, reporting-ESP block, IPs with capture times, user agent, identifiers, content, SHA-256, context transcript, classifier scores and a filing checklist. The JSON form is `POST /api/admin/child-safety/cases/:id/report`.
5. **File it** (see "Filing step by step").
6. **Mark reported**: enter the CyberTipline report number. The one-year hold restarts from that date.
7. After the hold ends, a human may **release** the case (`POST .../release`, which is refused before `retain_until`). It is then purged on the next sweep.

The API is under `/api/admin/child-safety/` and every call needs `Authorization: Bearer $ADMIN_TOKEN` and `X-Reviewer: <name>`:
`GET cases?status=open`, `POST cases/:id/view`, `POST cases/:id/include-participant {kind, value, reason}`, `POST cases/:id/dismiss {reason}`, `POST cases/:id/confirm`, `POST cases/:id/report[?format=html]`, `POST cases/:id/reported {cybertipReportId}`, `POST cases/:id/release`, `GET cases/:id/access-log`.

### Test hook

`POST /api/admin/child-safety/synthetic {"deleteGame": true}` runs a fixed, benign fixture ("SYNTHETIC TEST FIXTURE ...") through the real block path on a throwaway game from IP 192.0.2.10 (a documentation range), then deletes the game. The case is marked `is_test`, so confirming it bans nothing. `DELETE /api/admin/child-safety/cases/:id` removes test cases only and refuses real ones. Use these to check prod after a deploy. Never test with real abusive content.

## What is reportable

§2258A requires a provider that obtains **actual knowledge** of facts or circumstances indicating an **apparent violation** to report it to the CyberTipline. The violations covered are child pornography (§2251, §2251A, §2252, §2252A, §2260), and since the REPORT Act also child sex trafficking (§1591) and enticement of a minor (§2422(b)).

RI is text chat with an AI child character. In practice:

- **Text sexualizing a fictional AI child is often not, by itself, a reportable apparent violation.** It is still a ban and is preserved.
- **Report** when the text shows any of the following:
  - a real child: a real name or school, a disclosure of real abuse, "my daughter", plans to meet;
  - an attempt to obtain imagery of a real child, or to share it;
  - enticement or trafficking of a real minor;
  - that the player is a minor being exploited by someone else.
- **When in doubt, report.** §2258B gives providers limited liability protection for good-faith reports, and NCMEC triages.
- If a real child looks to be in **imminent danger**, also call 911 or local police right away.

Get counsel to confirm this reading once. After that, the reviewer decides case by case.

## Who files, and when

- **Who:** a named reviewer, by default Liz, signed in to the NCMEC ESP account. Nobody else files, and no code files.
- **When:** "as soon as reasonably possible" after a human confirms the case (§2258A(a)(1)). Aim for the same day the case is confirmed; review the open queue at least weekly, and same-day when a GlitchTip `child_safety_case_opened` alert fires.
- **Preservation:** the vault keeps confirmed and reported cases for at least one year from the report (§2258A(h)), and longer if law enforcement asks. Leave the case unreleased in that case.
- **Confidentiality:** don't contact the user, don't delete anything, and don't discuss the content outside the reviewer group. Share it only with NCMEC or law enforcement.

## Filing step by step

1. In Admin → Child Safety, open the confirmed case and click **Report package**. Keep that tab open.
2. Sign in to the NCMEC CyberTipline ESP portal. If registration isn't finished yet, use the public form at https://report.cybertip.org.
3. **Incident type:** choose the closest match. For text chat that is usually Online Enticement of Children for Sexual Acts; for imagery, Child Pornography.
4. **Incident date/time:** use `incidentDateTime` (UTC) from the package.
5. **Reporter / ESP:** fill in from the reporting-ESP block.
6. **Reported person:** enter every IP in the package with its capture time and event, plus the user agent. These belong to the flagged sender only. List any Matrix ID only as "claimed by the user, not verified".
7. **Content:** attach the flagged text and the context transcript as a `.txt` file, or paste them into Additional Information. Give the SHA-256.
8. **"Did you view the content?"** Yes. **"Publicly available?"** No.
9. **Additional information:** describe the service as an AI parenting simulation with an AI-generated child character. Say whether the transcript suggests a real child is involved, and that RI has no verified accounts.
10. Submit, copy the CyberTipline report number, and click **Mark reported** on the case.

## Other games and the shared relay

Other services file into the same vault through `POST /api/internal/child-safety/evidence`. Authenticate with `Authorization: Bearer $CHILD_SAFETY_INGEST_TOKEN`, a token separate from the admin token, kept in VaultWarden as "child-safety ingest token". On the games host, call `http://raising-intelligences:3000/api/internal/child-safety/evidence` over the Docker network.

The body is JSON with these fields:
- `source` (for example `whispers`, `tsb`, `breach`, `llm_proxy`);
- `content`;
- `context` (`[{speaker, content, at}]`);
- `categories`, `scores`, `model`, `reason`;
- `gameRef`, `ipAddress` (the flagged sender's request IP), `userAgent`;
- `identifiers` (`[{kind, value, verified?, role?}]`): `verified: true` only if your service authenticated it; `role: "participant"` for anyone other than the flagged sender;
- `incidentAt`;
- `externalRef` (an idempotency key);
- `groupRef` (optional): related cases from the caller share it, and the Child Safety list's **Group** column shows them together;
- `recordKind` (optional): `flag` (default) or `suppressed_burst`.

Every field is structured. Attribution comes only from `ipAddress`, `userAgent` and `identifiers`, never from `content`. One flag is one case; `content` may be up to 500,000 characters, and a longer one is refused (413) rather than cut.

A **suppressed burst** is what a sending service files when one sender (one seat, or one IP) goes over its per-window case cap. It sends no `content`. Instead it sends `suppressedBurst: {key: {kind, value}, count, firstAt, lastAt, sha256: [up to 200 hex digests]}`, under that sender's own `identifiers` and `ipAddress`. RI writes the case text from those validated fields only. The list marks these cases "suppressed burst".

The endpoint returns `{caseId, created}`. Cases filed this way go through the same review queue and retention as RI's own.
