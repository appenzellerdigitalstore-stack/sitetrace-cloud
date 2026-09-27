// Discord embed builder + poster with file-relative path support
// Usage: node scripts\discord-embed.cjs <channel_id> <embed_json_file>

const { execSync } = require('child_process');
const fs = require('fs');

function getToken() {
  const out = execSync('reg query HKCU\\Environment /v DISCORD_BOT_TOKEN', { encoding: 'utf8' });
  const m = out.match(/DISCORD_BOT_TOKEN\s+REG_SZ\s+(.+)/);
  return m ? m[1].trim() : null;
}

const COLOR = {
  brand:   0x5e83ff,
  safe:    0x10b981,
  warn:    0xf59e0b,
  danger:  0xef4444,
  ink:     0x222d44,
};

async function send(channelId, embed) {
  const token = getToken();
  if (!token) throw new Error('No token');
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const body = JSON.stringify(embed.attachments
    ? { embeds: [embed], attachments: embed.attachments }
    : { embeds: [embed] });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'sitetrace-api-bot/1.0',
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const [, , channelId, jsonPath] = process.argv;
if (!channelId || !jsonPath) {
  console.error('Usage: node discord-embed.cjs <channel_id> <embed_json_file>');
  process.exit(1);
}

const embed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
send(channelId, embed)
  .then((msg) => console.log('OK', msg.id, msg.channel_id))
  .catch((e) => { console.error('FAIL', e.message); process.exit(1); });

module.exports = { COLOR, send };