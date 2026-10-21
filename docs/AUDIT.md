# Source audit: what was wrong, what changed

Both archives were extracted and read in full. The README's 16 "known issues" were each **confirmed against the
actual files first**, then fixed. "Test" = automated test that fails if the fix is reverted (several were verified by
deliberately re-introducing the bug).

## Archives

| Archive | Verdict |
|---|---|
| `discord-afk-bot.zip` | The base. Ported to the new architecture; all 21 slash commands, the OwO payment flow and slot model are preserved. Contained a stray directory literally named `{commands,...}` (a shell brace-expansion accident) and a `.env.example` that claimed SQLite *or* PostgreSQL while only `better-sqlite3` was implemented. |
| `Discord-OwO-Bot-master.zip` | A complete third-party OwO bot (MariaDB + Redis, ~280 command files). **Licence: CC BY-NC-SA 4.0** (non-commercial, share-alike). This project is a paid service, and the spec says not to copy third-party bot source, so **no code or assets were copied**. It was used only as a *reference for the scale of a future economy/games roadmap*. See DECISIONS.md D-12. |

## README §17 issues

| # | Issue (confirmed in source?) | Fix | Test |
|---|---|---|---|
| 1 | `requireMinecraftAccess` called `reply()` after `deferReply/deferUpdate` → crash on every denied button/command (confirmed) | `bot/respond.js` picks reply/editReply/followUp from state; access check is pure data (`afkAccess.js`); buttons use `followUp` | `respond()` test |
| 2 | `.env.example` said SQLite or PostgreSQL; code was SQLite-only (confirmed) | **PostgreSQL only.** `DATABASE_URL` must be `postgresql://`; SQLite paths rejected with a migration hint | config test |
| 3 | ISO strings compared with `datetime('now')` text in expiry SQL (confirmed; wrong for same-day) | All timestamps are `BIGINT` epoch-ms, generated in JS | same-day expiry test |
| 4 | Payment row written before user/subscription; failure lost the payment (confirmed) | PENDING row first; user+subscription+PROCESSED flip in **one transaction**; conditional claim; FAILED rows retried by a 10-min reconcile job; username-fetch failure no longer aborts | duplicate / concurrent / partial-failure / racing-reconciler tests |
| 5 | Check-then-insert slot claim (confirmed) | Single conditional `UPDATE … RETURNING` + partial unique indexes (slot, server, user) + retry | concurrent-claim tests; PG integration test |
| 6 | `ON DELETE RESTRICT` blocked deleting slots with history (confirmed) | Never-used slots are deleted; others are **retired** (history kept, retired numbers are never reused) | retire tests |
| 7 | Source sent the API key to `/health`; README says no key (confirmed mismatch) | Contract: control endpoints are authenticated, `/health` is **not** (key not sent) | afkApi test |
| 8 | Failed health probe set `INACTIVE` even on assigned slots (confirmed) | `status` (AVAILABLE/ASSIGNED/RETIRED) and `health` are separate columns; health never touches status | health test |
| 9 | "30 days" hard-coded in messages (confirmed) | Messages derive from `SUBSCRIPTION_DAYS`/real expiry | – (config + renewal tests) |
| 10 | `/renew` read `configSvc?.subscription?.days` (nonexistent) → always 30 (confirmed) | Uses `subs.durationMs` from validated config | renewal tests |
| 11 | Un-awaited `interaction.reply` in owner check (confirmed) | All responses awaited through `respond()`; runner has a guarded error reply | runner test |
| 12 | Fixed customId `confirm_delete` collector (confirmed) | `cf:<random>:y/n`, bound to user + guild, 60 s TTL, single-use, permission re-checked in the action | confirmation tests |
| 13 | OAuth callback treated like an invite URL; unused secrets (confirmed) | Removed OAuth vars; real invite URL generated from `CLIENT_ID` | invite URL test |
| 14 | Key in query string, no URL validation, no payload validation (confirmed) | `header` mode; https-only + DNS-resolved private-address blocking (SSRF), no redirects, 8 s timeout, 64 KB cap, payload interpreted (`ok:false` ⇒ failure), endpoint whitelist, input validators | urlGuard / afkApi tests |
| 15 | Raw error objects logged | Redacting logger (tokens, `key=`, Bearer, DB URLs, registered secrets); user errors are generic | redaction tests |
| 16 | No tests | 76 automated tests + opt-in PG suite | – |

## Additional defects found while reading

- Add-slot URLs were unvalidated (SSRF / key exfiltration to an attacker URL) → guarded (see #14).
- Slot numbers were `MAX+1` over live rows and slots were hard-deleted, so removing the highest slot let its number be reused → numbers of retired slots are no longer reused (a never-used slot that is hard-deleted frees its number).
- Control commands accepted any string for IP/port/name → validated (hostname, 1–65535, `[A-Za-z0-9_]{1,16}`).
- The hourly cron ran `expireOld()` and then released slots in a separate, non-atomic loop using the mixed-format timestamp comparison from #3, and never ran at startup (an outage left expired slots assigned) → now one transaction that expires due subscriptions and releases only owners without an active subscription, also run at startup.
- `/setkey` stored the key in plaintext in the DB and logged around it → encrypted at rest or refused.
