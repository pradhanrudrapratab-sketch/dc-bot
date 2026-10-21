# Migrating from the old SQLite bot

1. **Back up the old file:** `cp data/bot.db data/bot.db.bak`
2. Create/choose a PostgreSQL database and set `DATABASE_URL`. Run `npm run migrate`.
3. Dry run (reads the old file, writes nothing, prints what would happen):
   `npm run import-legacy -- ./data/bot.db --dry-run`
4. Real run: `npm run import-legacy -- ./data/bot.db`
5. Start the bot. Existing subscribers and slot assignments continue.

What the importer does:

- Converts text timestamps (`datetime('now')` and ISO) to epoch milliseconds; preserves IDs and fixes sequences.
- Payments `VALID` → `PROCESSED`. Slots `INACTIVE` → `health = UNHEALTHY`.
- If several rows claimed the same slot/server/user as "active", the **newest** wins and the others are closed
  (`IMPORT_CONFLICT`) and reported. Duplicate ACTIVE subscriptions per user keep the latest expiry.
- **The plaintext API key is not copied.** Put it in `GLOBAL_API_KEY`, or set `SECRETS_ENCRYPTION_KEY` and re-run with
  `--import-key` to store it encrypted.
- Refuses to run into a non-empty database (so a double run cannot duplicate data).

Backups/recovery of the new database: `pg_dump "$DATABASE_URL" -Fc -f dcbot.dump` / `pg_restore -d "$DATABASE_URL" dcbot.dump`.
