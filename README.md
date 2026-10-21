# DC Bot

Minecraft AFK subscription controller **merged** with a community/moderation/security bot, on one
PostgreSQL-backed codebase. Node.js ≥ 22.5, discord.js 14.

> **Status:** logic layers are unit-tested (88 tests). Anything that needs a live Discord gateway or a live
> PostgreSQL has **not** been run yet; see [docs/TESTING.md](docs/TESTING.md) for the exact list and a
> go-live checklist. Do the checklist on a *test server* first.

## What you get

| Area | Highlights |
|---|---|
| **Minecraft AFK** (all 21 original commands kept) | OwO payment → subscription → `/assign` slot → `/start /stop /status …`. Idempotent payments, atomic slot claim, health never frees assigned slots, encrypted API key. |
| **Moderation** | `/ban /unban /kick /mute /unmute /warn /warnings /warnreset /purge` + prefix twins. Warning ladder: 3 = 24h timeout, 4 = kick, 5+ = ban; active count resets after 30 quiet days (history kept). |
| **Security** | Verification (button + role + reversible lockdown), honeypot channel, anti-nuke, bot-add allowlist. Actors come from Discord's audit log, never guessed. |
| **Server management** | Per-guild prefix, 7-category audit logging, invite tracking, `/steal` emoji, global announcement relay, permission monitor (`/permcheck`). |
| **Fun** | `slap kick punch hug pat bonk highfive punt poke cuddle` (`!kick` is the *joke* kick; real kick = `/kick` or `!modkick`). GIFs from Giphy by default once a key is set; per-guild text/GIF overrides with `funset`. |
| **Economy games** | DarkEssence (DE): `daily` (24h, streak bonus), `coinflip` (**every 7th flip loses**), `give`, `balance`, `richest`. |

Full list: [docs/COMMANDS.md](docs/COMMANDS.md). Every decision I made where the spec was silent: [docs/DECISIONS.md](docs/DECISIONS.md).
What was broken in the old code and how it was fixed: [docs/AUDIT.md](docs/AUDIT.md).

## Quick start

```bash
npm install
cp .env.example .env        # fill in the values (table below)
npm run migrate             # creates the schema in PostgreSQL (also runs automatically on start)
npm run deploy-commands     # registers slash commands (global; up to ~1h to appear)
                            #   DEV_GUILD_ID=<test guild id> npm run deploy-commands  → instant, one guild
npm start
```

Coming from the old SQLite bot? Run the importer first: [docs/MIGRATION.md](docs/MIGRATION.md).

### Discord Developer Portal (required)

1. **Bot → Privileged Gateway Intents:** enable **Server Members Intent** and **Message Content Intent**.
   (Presence intent is *not* needed.) Without Message Content, prefix commands, OwO payment detection and
   message logs do not work. Without Server Members, joins/leaves/invite tracking do not work.
2. Invite the bot with the URL built from your `CLIENT_ID` (also DM'd to new subscribers):
   `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=<see below>`
   Permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages,
   Manage Channels, Manage Roles, Manage Server, Kick, Ban, Timeout Members, View Audit Log, Manage Expressions.
   (The exact integer is computed by `src/utils/invite.js`.) Missing permissions only disable the affected
   feature; `/permcheck` shows which.
3. **Role position matters:** drag the bot's role *above* any role it must moderate or hand out (e.g. the Verified role).
4. There is no OAuth callback/redirect. The old OAuth variables were unused and are removed.

### Environment variables

| Variable | Req. | Meaning |
|---|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID` | ✅ | Bot token / application ID |
| `BOT_OWNER_ID` | ✅ | Primary Super Admin. Owner commands, payment receiver. |
| `SUPER_ADMIN_IDS` | | Extra Super Admins (comma-separated) |
| `DATABASE_URL` | ✅ | `postgresql://…` (PostgreSQL only; SQLite paths are rejected with a clear message) |
| `DATABASE_SSL` | | `auto` (default: TLS unless localhost) / `true` / `false` |
| `MASTER_SERVER_ID` | ✅ | Server where the OwO payment message is watched |
| `OWO_BOT_ID` | | Default `408785106942164992` |
| `SUBSCRIPTION_AMOUNT` / `SUBSCRIPTION_DAYS` | | Default `25000000` / `30`; **all messages use the configured values** |
| `GLOBAL_API_KEY` | | Key sent to slot APIs. Preferred way to supply it. |
| `SECRETS_ENCRYPTION_KEY` | | 32 bytes (64 hex or base64). Needed **only** if you want `/setkey` to store a key in the DB (AES-256-GCM). Without it `/setkey` refuses rather than store plaintext. |
| `AFK_API_KEY_MODE` | | `query` (default, `?key=` like the old bot) or `header` (`x-api-key`). Use `header` if your slot API supports it: keys then never appear in URLs. |
| `ALLOW_PRIVATE_SLOT_URLS` | | `false` by default: slot URLs must be public **https**. Set `true` only for http/private-IP slots. |
| `GIF_PROVIDER` / `GIF_API_KEY` | | `none` (default) or `giphy` (implemented, **not live-tested**) |
| `ANTINUKE_THRESHOLD` / `ANTINUKE_WINDOW_SECONDS` | | Default `3` / `60` ("more than 3 in 60 s") |
| `HEALTH_PORT` (or Render's `PORT`), `LOG_LEVEL` | | Health endpoint port, log level |

Announcement **source channel** is not an env var: the owner runs `!announcesource set` in the master channel
(stored in the DB so it can change without a redeploy).

### Status page and UptimeRobot

`GET /` or `/health` is an **HTML status page** showing Discord (logged in or not, gateway ping), Database
(connected or not, latency) and uptime. It returns **HTTP 200 only when both are up, otherwise 503**, so any
monitor sees a failure. `GET /health.json` has the same data as JSON.

UptimeRobot setup: *HTTP(s)* monitor → URL `https://<your-app>.onrender.com/health`. For a stricter check choose
*Keyword* monitoring and alert when the keyword **`ALL SYSTEMS ONLINE`** is *missing*. HEAD requests (UptimeRobot's
default) work.

### GIFs (Giphy)

Set `GIF_PROVIDER=giphy` and `GIF_API_KEY=<your key>`, redeploy. All fun commands then use GIFs by default
(each action has a sensible search term; change it with `funset source`). Replies show "Powered by GIPHY" as
Giphy requires. If Giphy fails or hits its quota the command still replies with text only. The Giphy call itself
is **not live-tested**: after adding the key run `/funset preview action:slap` once.

### Economy games

| Command | Rules |
|---|---|
| `daily` | Once per 24 h (rolling). 500 DE (`DAILY_AMOUNT`), +50 per consecutive day up to +300. Claim again within 48 h to keep the streak. |
| `coinflip <bet> [heads\|tails]` (`cf`, `flip`) | 50/50, win = +bet, lose = −bet, 5 s cooldown, max bet `COINFLIP_MAX_BET` (50 000). **Every 7th flip of each player is a guaranteed loss** (`COINFLIP_FORCED_LOSS_EVERY`), tracked per player in the database, so it survives restarts. A rejected flip (not enough DE etc.) does not count. By default the result shows `Flip 3/7`; set `COINFLIP_SHOW_COUNTER=false` to hide it. |
| `give <user> <amount>` | Atomic transfer. |
| `balance`, `richest` | Balance / top 10. |

### Deploying on Render (free tier)

`render.yaml` is included. Key facts:

- **No local disk is used.** All state is in PostgreSQL, so Render's ephemeral filesystem is fine. Back up the
  database (Render dashboard backups, or `pg_dump "$DATABASE_URL" > backup.sql`; restore with `psql`).
  Free Render Postgres instances expire/are limited, so use your existing database or a paid plan for production.
- Deployed as a *web service* so it can answer `GET /health` (200 only when Discord is ready **and** the DB answers).
  Point UptimeRobot at `/health` to prevent free-tier sleeping.
- On start the bot connects to the DB, applies pending migrations under an advisory lock, starts jobs, then logs in.
- Graceful shutdown on SIGTERM (jobs stopped, gateway destroyed, pool closed).

## Operations cheatsheet

- Add a slot: `/addslot url:https://…` → `/health slot:1` → users run `/assign`.
- Something degraded? `/permcheck` (server admins) lists blocked features and what is missing.
- Audit: every config change and moderation action lands in `audit_logs` (secrets redacted) and, if configured, the log channel.
- Security events (honeypot, anti-nuke, bot guard) are in `security_events` with evidence.

## Repository layout

```
src/
  config/        validated env (fails fast, lists every problem)
  database/      pg pool, migration runner, SQL migrations, legacy SQLite importer
  framework/     one command definition → slash + prefix; option parser; runner (perms, cooldown, errors)
  services/      domain logic (payments, slots, moderation, honeypot, anti-nuke, invites, …), Discord-free where possible
  commands/      thin command definitions per module
  bot/           client, container (composition root), event handlers, command deploy script
tests/           node:test suites (+ fake discord.js + SQLite adapter; PG integration test is opt-in)
docs/            AUDIT, DECISIONS, MIGRATION, TESTING, COMMANDS (generated)
```
