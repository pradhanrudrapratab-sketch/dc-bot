'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { redact, redactString } = require('./redact');

let level = process.env.LOG_LEVEL || 'info';
let winstonLogger = null;

function build() {
  if (winstonLogger) return winstonLogger;
  let winston;
  try {
    winston = require('winston');
  } catch {
    return null; // dependency not installed (e.g. unit tests); console fallback below
  }
  const { createLogger, format, transports } = winston;
  const list = [new transports.Console()];
  try {
    const dir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    list.push(new transports.File({ filename: path.join(dir, 'error.log'), level: 'error' }));
  } catch { /* read-only FS: console only */ }
  winstonLogger = createLogger({
    level,
    format: format.combine(format.timestamp(), format.json()),
    transports: list,
  });
  return winstonLogger;
}

const ORDER = ['error', 'warn', 'info', 'debug'];

function emit(lvl, message, meta) {
  const safeMsg = redactString(message instanceof Error ? message.message : String(message));
  const safeMeta = meta === undefined ? undefined : redact(meta);
  const w = build();
  if (w) return w.log(lvl, safeMsg, safeMeta && typeof safeMeta === 'object' ? safeMeta : { detail: safeMeta });
  if (ORDER.indexOf(lvl) > ORDER.indexOf(level)) return undefined;
  const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, message: safeMsg, ...(safeMeta ? { meta: safeMeta } : {}) });
  (lvl === 'error' ? console.error : console.log)(line);
  return undefined;
}

module.exports = {
  setLevel(l) { level = l; if (winstonLogger) winstonLogger.level = l; },
  error: (m, meta) => emit('error', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  info: (m, meta) => emit('info', m, meta),
  debug: (m, meta) => emit('debug', m, meta),
};
