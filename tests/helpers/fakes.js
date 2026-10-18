'use strict';
const { PermissionFlagsBits } = require('./fakeDiscord');

const permsOf = (names) => ({ has: (p) => (Array.isArray(p) ? p : [p]).every((x) => names.includes('Administrator') || names.includes(x)) });

/** Build a fake guild with members, roles and recordable REST calls. */
function makeGuild({ id = 'G1', ownerId = 'OWNER', botPerms = ['BanMembers', 'KickMembers', 'ModerateMembers', 'ManageChannels', 'ManageRoles', 'ViewAuditLog', 'ManageGuild', 'SendMessages', 'EmbedLinks', 'ViewChannel'], members = {} } = {}) {
  const calls = [];
  const errors = {}; // method -> error to throw
  const mk = (mid, { top = 1, perms = [], bot = false } = {}) => ({
    id: mid, user: { id: mid, tag: `${mid}#0001`, bot }, permissions: permsOf(perms), roles: { highest: { position: top }, cache: new Map(), add: async (r) => { calls.push(['roles.add', mid, r]); if (errors.roleAdd) throw errors.roleAdd; }, has: () => false },
    kick: async (r) => { calls.push(['kick', mid, r]); if (errors.kick) throw errors.kick; },
    timeout: async (ms, r) => { calls.push(['timeout', mid, ms, r]); if (errors.timeout) throw errors.timeout; },
  });
  const store = new Map(Object.entries(members).map(([k, v]) => [k, mk(k, v)]));
  const me = mk('BOT', { top: 50, perms: botPerms });
  store.set('BOT', me);
  const sent = [];
  const guild = {
    id, name: 'Test Guild', ownerId, calls, errors, sent,
    members: {
      me,
      fetch: async (mid) => { const m = store.get(mid); if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 }); return m; },
      ban: async (uid, o) => { calls.push(['ban', uid, o]); if (errors.ban) throw errors.ban; },
      unban: async (uid, r) => { calls.push(['unban', uid, r]); if (errors.unban) throw errors.unban; },
      kick: async (uid, r) => { calls.push(['members.kick', uid, r]); if (errors.kick) throw errors.kick; },
    },
    client: { users: { fetch: async (uid) => ({ id: uid, send: async (p) => { sent.push(['dm', uid, p]); if (errors.dm) throw errors.dm; } }) } },
    channels: { fetch: async () => null, create: async (o) => { calls.push(['channels.create', o]); if (errors.channelCreate) throw errors.channelCreate; return { id: 'NEWCH', ...o }; } },
    roles: { create: async (o) => { calls.push(['roles.create', o]); return { id: 'NEWROLE', ...o }; } },
    systemChannel: null,
    fetchOwner: async () => ({ send: async (p) => { sent.push(['owner-dm', p]); } }),
  };
  guild.addMember = (mid, opts) => { store.set(mid, mk(mid, opts)); return store.get(mid); };
  return guild;
}

/** Stub services used by honeypot/moderation tests. */
const stubLogs = () => {
  const alerts = [];
  return { alerts, alertStaff: async (g, a) => { alerts.push(a); return { delivered: true }; }, alertSuperAdmins: async () => ({ delivered: 1 }) };
};
const stubAudit = () => {
  const records = []; const security = [];
  return { records, security, record: async (r) => { records.push(r); }, recordSecurityEvent: async (r) => { security.push(r); } };
};

const discordErr = (code, status = 403) => Object.assign(new Error(`Discord error ${code}`), { code, status });

module.exports = { makeGuild, stubLogs, stubAudit, discordErr, permsOf, PermissionFlagsBits };
