// Discord message poster for sitetrace-api
// Reads bot token from HKCU\Environment, posts a message with rich embed
// Usage: node scripts\discord-post.cjs <channel_id> <embed_json_or_text>

const { execSync } = require('child_process');

function getToken() {
  const out = execSync('reg query HKCU\\Environment /v DISCORD_BOT_TOKEN', { encoding: 'utf8' });
  const m = out.match(/DISCORD_BOT_TOKEN\s+REG_SZ\s+(.+)/);
  return m ? m[1].trim() : null;
}

async function post(channelId, payload) {
  const token = getToken();
  if (!token) throw new Error('No token');
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'sitetrace-api-bot/1.0',
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// CLI:   node discord-post.cjs <channel_id> <json_file_path>
//    or: node discord-post.cjs <channel_id> --text "message"
const [, , channelId, mode, ...rest] = process.argv;
if (!channelId) {
  console.error('Usage: node discord-post.cjs <channel_id> <json_file>  |  --text "message"');
  process.exit(1);
}

let payload;
if (mode === '--text') {
  payload = { content: rest.join(' ') };
} else {
  payload = JSON.parse(require('fs').readFileSync(mode, 'utf8'));
}

post(channelId, payload)
  .then((msg) => {
    console.log('OK', msg.id, msg.channel_id, '->', msg.content ? msg.content.slice(0, 80) : '(embed)');
  })
  .catch((e) => {
    console.error('FAIL', e.message);
    process.exit(1);
  });