// =====================================================================
// scripts/post-discord-embed.mjs
//
// Posts a Discord embed payload (JSON) to a channel via the bot token.
// Reads DISCORD_BOT_TOKEN from HKCU\Environment (Windows user env var)
// and the channel ID from --channel CLI arg.
//
// Usage:
//   node scripts/post-discord-embed.mjs <embed.json> <channel_id>
//   node scripts/post-discord-embed.mjs path/to/embed.json 1553883472094035988
//
// The JSON file must contain an embed object (or array of fields) shaped
// like Discord's Embed structure:
//   { title, description, color, fields: [{name, value, inline}], footer }
// Discord limits: title 256ch, description 4096ch, field name 256ch,
// field value 1024ch, fields per embed 25, total chars 6000.
// =====================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('Set DISCORD_BOT_TOKEN env var (HKCU\\Environment on Windows).');
  process.exit(1);
}

const file = process.argv[2];
const channelId = process.argv[3];
if (!file || !channelId) {
  console.error('Usage: node scripts/post-discord-embed.mjs <embed.json> <channel_id>');
  process.exit(1);
}

const payload = JSON.parse(readFileSync(resolve(file), 'utf8'));

const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
const resp = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bot ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ embeds: [payload] }),
});

if (!resp.ok) {
  const text = await resp.text();
  console.error(`Discord ${resp.status}: ${text}`);
  process.exit(1);
}

const data = await resp.json();
console.log(`Posted message ${data.id} to channel ${channelId}`);
