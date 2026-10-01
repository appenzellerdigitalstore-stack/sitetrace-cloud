// =====================================================================
// scripts/post-discord-file.mjs
//
// Uploads a file (e.g. video, image) to a Discord channel as an
// attachment. Optional caption text.
//
// Usage:
//   node scripts/post-discord-file.mjs <file_path> <channel_id> [caption]
//
// Discord limits: 25MB for non-boosted servers (boost level 2+ = 50MB).
// For files larger than that, upload to a temp URL elsewhere and post
// the link in an embed instead.
// =====================================================================

import { readFileSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('Set DISCORD_BOT_TOKEN env var.');
  process.exit(1);
}

const filePath = process.argv[2];
const channelId = process.argv[3];
const caption = process.argv[4] || '';
if (!filePath || !channelId) {
  console.error('Usage: node scripts/post-discord-file.mjs <file_path> <channel_id> [caption]');
  process.exit(1);
}

const absPath = resolve(filePath);
const stat = statSync(absPath);
const filename = basename(absPath);
const mimeType = filename.endsWith('.mp4') ? 'video/mp4'
                : filename.endsWith('.webm') ? 'video/webm'
                : filename.endsWith('.png') ? 'image/png'
                : filename.endsWith('.jpg') || filename.endsWith('.jpeg') ? 'image/jpeg'
                : 'application/octet-stream';

// Use undici (built into Node 18+) for multipart upload
const { FormData, fetch, Blob } = globalThis;
const form = new FormData();
const blob = new Blob([readFileSync(absPath)], { type: mimeType });
form.append('files[0]', blob, filename);
if (caption) form.append('content', caption);

const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
const resp = await fetch(url, {
  method: 'POST',
  headers: { 'Authorization': `Bot ${TOKEN}` },
  body: form,
});

if (!resp.ok) {
  const text = await resp.text();
  console.error(`Discord ${resp.status}: ${text}`);
  process.exit(1);
}

const data = await resp.json();
const att = data.attachments?.[0];
console.log(`Uploaded ${filename} (${stat.size} bytes) as ${att?.id} to message ${data.id}`);
if (att) console.log(`URL: https://cdn.discordapp.com/attachments/${channelId}/${att.id}/${att.filename}`);
