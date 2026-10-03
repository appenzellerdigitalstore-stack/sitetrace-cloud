// =====================================================================
// sitetrace-api — Webhook delivery stats
//
// GET /api/webhook-stats
//
// Returns per-day counts of Paddle webhook deliveries bucketed by status
// code, for the last 7 UTC days. Reads from the RATELIMIT KV namespace
// where paddle-webhook.js increments counters at every return point.
//
// Auth: none (this is operational metadata; not sensitive. Could gate
// behind an admin key later if it ever leaks anything exploitable.)
// =====================================================================

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

function utcDateNDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.RATELIMIT) {
    return json({ error: 'not_configured', message: 'KV namespace not bound' }, 503);
  }

  // Build list of dates (today + last 6 days).
  const days = [];
  for (let i = 0; i < 7; i++) days.push(utcDateNDaysAgo(i));

  // Read all keys in one Promise.all. KV has no batch get endpoint so
  // we issue parallel gets. Key order MUST match the by_status index
  // mapping below — index 1 = 200, index 2 = 400, index 3 = 401, etc.
  const keys = days.flatMap(d => [
    `wh:${d}:total`,   // index 0
    `wh:${d}:200`,     // index 1
    `wh:${d}:400`,     // index 2
    `wh:${d}:401`,     // index 3
    `wh:${d}:500`,     // index 4
    `wh:${d}:503`,     // index 5
  ]);
  const values = await Promise.all(keys.map(k => env.RATELIMIT.get(k)));

  const byDay = days.map((d, dayIdx) => {
    const offset = dayIdx * 6;
    const total = parseInt(values[offset] || '0', 10) || 0;
    return {
      date: d,
      total,
      by_status: {
        200: parseInt(values[offset + 1] || '0', 10) || 0,
        400: parseInt(values[offset + 2] || '0', 10) || 0,
        401: parseInt(values[offset + 3] || '0', 10) || 0,
        500: parseInt(values[offset + 4] || '0', 10) || 0,
        503: parseInt(values[offset + 5] || '0', 10) || 0,
      },
    };
  });

  // Aggregate the last 24h (today) for the dashboard banner.
  const last24 = byDay[0];
  const errorCount = last24.by_status[400] + last24.by_status[401]
                   + last24.by_status[500] + last24.by_status[503];

  return json({
    by_day: byDay,
    last_24h: {
      date: last24.date,
      total: last24.total,
      errors: errorCount,
      healthy: errorCount === 0 && last24.total > 0,
    },
  });
}