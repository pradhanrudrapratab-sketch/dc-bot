'use strict';
const axios = require('axios');
const { loadCommands } = require('../framework/registry');
const { CooldownManager } = require('../utils/cooldown');
const { createSecretBox } = require('../services/secretBox');
const { createSettingsStore } = require('../services/settingsStore');
const { createAfkApi } = require('../services/afkApi');
const { createUsers } = require('../services/users');
const { createSubscriptions } = require('../services/subscriptions');
const { createSlots } = require('../services/slots');
const { createPaymentProcessor } = require('../services/payments');
const { createGuildSettings } = require('../services/guildSettings');
const { createAudit } = require('../services/audit');
const { createLogDispatcher } = require('../services/logDispatcher');
const { createPermissionMonitor } = require('../services/permissions');
const { createWarnings } = require('../services/warnings');
const { createModeration } = require('../services/moderation');
const { createConfirmations } = require('../services/confirmations');
const { createInviteRepo, createInviteTracker } = require('../services/invites');
const { createHoneypot } = require('../services/honeypot');
const { createAntiNuke } = require('../services/antinuke');
const { createBotGuard } = require('../services/botguard');
const { createAnnouncements } = require('../services/announcements');
const { createFun, createGiphyProvider } = require('../services/fun');
const { createEconomy } = require('../services/economy');
const { createMessageCache } = require('../services/messageCache');
const path = require('node:path');

/**
 * Composition root: builds every service once and wires them together.
 * `client` is passed lazily (getClient) because services are created before login.
 */
function createContainer({ config, db, getClient }) {
  const http = axios.create();
  const secretBox = config.afk.encryptionKey ? createSecretBox(config.afk.encryptionKey) : null;
  const settings = createSettingsStore({ db, secretBox, envApiKey: config.afk.globalApiKey });
  const afkApi = createAfkApi({ getApiKey: () => settings.getGlobalApiKey(), afkConfig: config.afk, http });

  const users = createUsers();
  const subs = createSubscriptions({ durationMs: config.subscription.days * 86_400_000 });
  const slots = createSlots({});
  const payments = createPaymentProcessor({ db, users, subs });

  const guildSettings = createGuildSettings({ db });

  // logs <-> audit <-> permissionMonitor are mutually dependent; wire with late-bound closures.
  let logs;
  const permissionMonitor = createPermissionMonitor({
    db,
    onChange: async ({ guildId, feature, state, missing }) => {
      const guild = getClient()?.guilds.cache.get(guildId);
      if (!guild) return;
      await logs.alertStaff(guild, state === 'blocked'
        ? { title: 'Feature degraded: missing permission', description: `**${feature}** is blocked. Missing: ${missing.join(', ')}.\nOnly that feature is affected. I will tell you once when it recovers.`, severity: 'warn' }
        : { title: 'Feature recovered', description: `**${feature}** works again.`, severity: 'success' });
    },
  });
  logs = createLogDispatcher({ db, getClient, permissionMonitor });
  const audit = createAudit({ db, sink: (g, c, e) => logs.sink(g, c, e) });

  const warnings = createWarnings({ db });
  const moderation = createModeration({ warnings, audit, logs });
  const confirmations = createConfirmations();
  const inviteRepo = createInviteRepo({ db });
  const inviteTracker = createInviteTracker({ repo: inviteRepo, onDegraded: (guildId, missing) => permissionMonitor.report(guildId, 'invite-tracking', missing) });
  const honeypot = createHoneypot({ moderation, audit, logs });
  const superAdmins = config.bot.superAdmins;
  const antiNuke = createAntiNuke({ db, moderation, audit, logs, superAdmins, threshold: config.antinuke.threshold, windowMs: config.antinuke.windowMs });
  const botGuard = createBotGuard({ db, moderation, audit, logs, superAdmins });
  const announcements = createAnnouncements({ db, settings });
  const provider = config.gif.provider === 'giphy' ? createGiphyProvider({ apiKey: config.gif.apiKey, http }) : null;
  const fun = createFun({ db, provider });
  const economy = createEconomy({ db });
  const messageCache = createMessageCache();

  const registry = loadCommands(path.join(__dirname, '../commands'));
  const cooldowns = new CooldownManager();

  const deps = {
    config, db, http, settings, afkApi, users, subs, slots, payments, guildSettings, audit, logs, permissionMonitor, warnings,
    moderation, confirmations, inviteRepo, inviteTracker, honeypot, antiNuke, botGuard, announcements, fun, economy, registry,
    funProviderAvailable: !!provider,
  };
  const runEnv = { config, cooldowns, permissionMonitor };

  return { ...deps, deps, runEnv, messageCache, cooldowns, getClient };
}

module.exports = { createContainer };
