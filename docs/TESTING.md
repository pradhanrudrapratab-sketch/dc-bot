# Testing: what is verified and what is not

## How to run

```bash
npm install
npm test                                   # 76 offline tests, no Discord, no Postgres needed
TEST_DATABASE_URL=postgresql://… npm test  # also runs 5 real-PostgreSQL concurrency tests (uses a THROW-AWAY db: drops schema public)
npm run check                              # node --check on every file
```

Offline tests use `node:test`, a **fake discord.js** (it enforces the schema rules that most often break command
deploys: name format, description length, option order/limits) and an in-memory **SQLite adapter** that runs the same
portable SQL the bot sends to PostgreSQL.

## Verified by automated tests (76)

Config validation · redaction · durations · payments (parse, validate, duplicate, concurrent, partial failure, recovery) ·
subscriptions (renew/expiry/same-day compare) · slots (atomic claim, one-per-user/server, health vs assignment, retire) ·
expiry job · URL/SSRF guard · AFK API client (key placement, error mapping, retry policy, no key leakage) · secret box ·
legacy import · warnings (ladder, 30-day reset, idempotency) · moderation (permission/hierarchy pre-checks, failures never
reported as success) · permission-monitor state machine · confirmations · cooldowns · invite attribution/leave/rejoin/duplicates ·
honeypot (trigger rules, DM-then-ban, recursion, dedupe, tamper) · anti-nuke (thresholds, buckets, exemptions, restore) ·
bot-add guard · announcement relay (idempotent, no loop, mentions off) · fun (templates, URL validation, fallbacks) ·
economy (no overdraft, atomic transfer, idempotent) · emoji planning · verification planning · command registry
(21 AFK commands present, no name collisions, all slash definitions build) · prefix/slash parsing · `respond()` state handling ·
runner pipeline · composition root wiring.

Bug-injection check: 12 deliberate mutations of critical logic were applied; the suite caught every non-equivalent one
(the one that initially slipped through, the payment conditional-claim guard, now has a dedicated race test).

## NOT verified here (needs your environment)

This build environment had **no network**, so `npm install` could not run and nothing below was executed:

| Not run | Risk if wrong | How to verify |
|---|---|---|
| `npm install` with real `discord.js`, `pg`, `axios`, `winston`, `node-cron` | Typo against the real API | `npm install && npm run check && npm test` |
| **Real PostgreSQL** execution (SQL is portable-subset and tested on SQLite) | PG-specific error | `TEST_DATABASE_URL=… npm test`, `npm run migrate` |
| `npm run deploy-commands` against real builders | Schema rejection | run with `DEV_GUILD_ID` first |
| Gateway login, intents, event delivery, `guildAuditLogEntryCreate` | Missing intent/permission | go-live checklist |
| Real Discord REST behaviour: bans, timeouts, role/overwrite edits, bulk delete, emoji create, invites fetch, vanity data | Permissions/rate limits | checklist, on a test server |
| Slot API integration (`/start`, `/ping`, `/health` payload shapes) | Your slot server's response format | `/health`, `/ping` against a real slot |
| Giphy provider | Response shape | `/funset source` + `/funset preview` |
| Health server on Render, graceful shutdown | – | deploy, hit `/health`, send SIGTERM |

## Go-live checklist (test server first, never a live community)

1. `npm install`, `npm run check`, `npm test` all green. With a scratch PG: `TEST_DATABASE_URL=… npm test` green.
2. Enable **Server Members** + **Message Content** intents; invite with the generated URL; put the bot role at the top.
3. `npm run migrate`; (optional) `npm run import-legacy -- … --dry-run`.
4. `DEV_GUILD_ID=<test guild> npm run deploy-commands`; start; `GET /health` → 200.
5. `/permcheck`. Fix anything red.
6. AFK: `/addslot` → `/health` → make a real (or `/renew`-simulated) subscription → `/assign` → `/status` buttons.
7. Payment: in the master server send the exact OwO text from a test account; confirm one subscription, DM, and that deleting/re-sending the same message ID does nothing.
8. Moderation: `/warn` ×5 on an alt (timeout → kick → ban); try targeting someone above the bot (must fail with a clear reason).
9. Honeypot (alt account), verification button, `lockdown` → `unlock`, anti-nuke (create/delete 4 channels with an alt admin), unauthorized bot add, invite tracking (two invites), `/steal`, announcement relay, `!slap` with and without GIF.
10. Only then run `npm run deploy-commands` globally.
