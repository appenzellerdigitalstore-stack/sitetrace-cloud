// Discord channel access test for sitetrace-api
// Tests that the bot can read info from each provided channel
// Usage: node scripts\test-discord-channels.cjs

const { execSync } = require('child_process');

// Get bot token from HKCU\Environment
let token;
try {
  const out = execSync('reg query HKCU\\Environment /v DISCORD_BOT_TOKEN', { encoding: 'utf8' });
  const m = out.match(/DISCORD_BOT_TOKEN\s+REG_SZ\s+(.+)/);
  if (m) token = m[1].trim();
} catch (_) {}
if (!token) {
  console.error('DISCORD_BOT_TOKEN not found in HKCU\\Environment');
  process.exit(1);
}

const CHANNELS = {
  'agenda':              '1553883472094035988',
  'api-testing-results': '1553882134995935302',
  'api-information':     '1553882186565034095',
  'api-how-they-work':   '1553882319365087323',
};

(async () => {
  for (const [name, cid] of Object.entries(CHANNELS)) {
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${cid}`, {
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'sitetrace-api-bot/1.0',
        },
      });
      if (!resp.ok) {
        console.log(`[FAIL] ${name.padEnd(22)} ${cid}  HTTP ${resp.status}  ${resp.statusText}`);
        const body = await resp.text();
        console.log(`        body: ${body.slice(0, 200)}`);
        continue;
      }
      const json = await resp.json();
      console.log(`[OK]   ${name.padEnd(22)} ${cid}  name="${json.name}"  guild="${json.guild_id}"  type=${json.type}`);
    } catch (e) {
      console.log(`[ERR]  ${name.padEnd(22)} ${cid}  ${e.message}`);
    }
  }
})();