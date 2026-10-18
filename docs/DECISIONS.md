# Decisions where the spec was silent or ambiguous

Each is deliberately small and reversible. Change them by editing the noted place.

| ID | Decision | Why | Where |
|---|---|---|---|
| D-1 | **PostgreSQL only** (`pg`); timestamps are `BIGINT` epoch-ms | Your other bots use Render + PostgreSQL; Render's disk is ephemeral so SQLite would lose data; epoch-ms removes the timestamp-format bug class | `src/database` |
| D-2 | Slot `status` and `health` are separate; **unhealthy slots stay assigned** but are not handed out | Spec §17.8 | `services/slots.js` |
| D-3 | API key: env `GLOBAL_API_KEY` preferred; `/setkey` stores it **AES-256-GCM encrypted** and refuses if `SECRETS_ENCRYPTION_KEY` is unset | Spec: no raw secrets in ordinary tables | `settingsStore.js` |
| D-4 | Slot API contract: control endpoints authenticated (`?key=` default for compatibility, `x-api-key` optional); `/health` unauthenticated | I cannot see your slot server; query mode keeps old deployments working | `afkApi.js` |
| D-5 | Slot URLs must be public **https** (DNS-checked against private ranges) unless `ALLOW_PRIVATE_SLOT_URLS=true` | SSRF / key exfiltration | `urlGuard.js` |
| D-6 | Prefix `!kick` is **not registered**. Moderation kick = `/kick` + `!modkick`; fun actions are `!slap !hug !pat !bonk !highfive !punt` | Spec §15 "must not share a handler" | `commands/moderation`, `commands/fun` |
| D-7 | Honeypot sends the **DM before the ban** (2.5 s timeout) | Discord usually blocks DMs once the user shares no server with the bot. Outcome is recorded either way | `services/honeypot.js` |
| D-8 | Honeypot ignores other bots/webhooks; deleting the honeypot channel by an unauthorized user **alerts** by default (`/honeypot tamper ban` to ban). Always recreated if possible | Banning an admin/integration is high-impact; conservative default | `honeypot.js` |
| D-9 | Verification never mass-edits channels on its own. `lockdown` (confirmation required) touches only channels **@everyone can currently see**, records the prior state, and `unlock` restores exactly that. `disable` leaves permissions untouched. Existing members are **not** auto-verified | Spec §6: don't expose private channels / surprise-grant access | `services/verification.js` |
| D-10 | Bot-add guard = allowlist **and** Administrator at add time; the server owner and Super Admins are implicitly trusted. Detection is *after the fact* (kick bot + ban adder); Discord has no pre-add veto. Unknown adder ⇒ alert (optionally kick the bot), **never ban a guess** | Spec §13 | `botguard.js` |
| D-11 | Anti-nuke buckets: `channel_delete`, `role_delete`, `member_kick_ban`; "more than 3 in 60 s" (env-configurable globally, not per guild). Actor from `guildAuditLogEntryCreate`. Restore of channels/roles is best-effort | Spec §12 | `antinuke.js` |
| D-12 | **OwO bot archive not used.** It is CC BY-NC-SA 4.0 (non-commercial, share-alike) and this is a paid service; spec forbids copying third-party bot source. DarkEssence is a minimal ledger (`/balance`, owner `/deadmin`); **no earning/games/shop rules were invented** | Licence + spec §16 | `services/economy.js` |
| D-13 | DarkEssence is a **global per-user** balance, non-negative by construction, idempotent via `ref_key` | Not specified; changing to per-guild is a schema change | `economy.js` |
| D-14 | Deleted/edited message content is kept **in memory only** (5 000 msgs, 24 h) and only for guilds with message logging on | Privacy; spec §9 asks to decide | `messageCache.js` |
| D-15 | Invite attribution is recorded only when unambiguous; otherwise "Unknown inviter". A rejoin gets credit only if that join is itself reliably attributed | Spec §10 | `invites.js` |
| D-16 | Giphy is the single implemented GIF provider (interface allows more); **not live-tested** | Spec: don't hard-code a provider | `fun.js` |
| D-17 | Warnings: active count resets when 30 days pass since the **last** warning (exactly ≥ 30 d); lazy on read + daily job; history rows never deleted; idempotent per command event | Spec §5 | `warnings.js` |
| D-18 | Slash commands are guild-only except owner commands and `/help` | Safety | command specs |
