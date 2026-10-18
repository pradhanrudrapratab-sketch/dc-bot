'use strict';
const { EmbedBuilder } = require('discord.js');

const COLORS = Object.freeze({
  brand: 0x8b5cf6, // Royal Violet
  deep: 0x6d28d9, // Deep Violet
  success: 0x10b981, // Success Emerald
  error: 0xef4444, // Error Crimson
  warn: 0xf59e0b, // Warning Amber
});

const FOOTER = 'DC Bot';

// Status is always conveyed in text (icon + label), never by colour alone.
function make(color, title, description) {
  const e = new EmbedBuilder().setColor(color).setFooter({ text: FOOTER });
  if (title) e.setTitle(String(title).slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4096));
  return e;
}

const embed = {
  brand: (title, desc) => make(COLORS.brand, title, desc),
  info: (title, desc) => make(COLORS.brand, title, desc),
  owner: (title, desc) => make(COLORS.deep, title, desc),
  success: (title, desc) => make(COLORS.success, `✅ ${title}`, desc),
  error: (title, desc) => make(COLORS.error, `❌ ${title}`, desc),
  warn: (title, desc) => make(COLORS.warn, `⚠️ ${title}`, desc),
};

module.exports = { embed, COLORS };
