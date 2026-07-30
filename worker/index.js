/* Cloudflare Worker — the event mirror.
 *
 * Two endpoints. Sync is a union of append-only events deduped by uuid, so
 * there is no conflict resolution here and nothing to merge — just insert.
 *
 *   GET  /events?since=<seq>   -> { events: [...], seq }
 *   POST /events { events }    -> { ok, seq }
 *
 * Auth is a single shared bearer token (wrangler secret QUESTLOG_TOKEN). Be
 * clear-eyed: that token is the entire security boundary. Fine for a personal
 * quest log; don't put anything sensitive in here.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });

/* Constant-time compare so the token can't be probed byte-by-byte. */
function tokenOk(header, secret) {
  if (!secret) return false;
  const given = (header || '').replace(/^Bearer\s+/i, '');
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname !== '/events') return json({ error: 'not found' }, 404);

    if (!tokenOk(request.headers.get('Authorization'), env.QUESTLOG_TOKEN)) {
      return json({ error: 'unauthorized' }, 401);
    }

    if (request.method === 'GET') {
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const { results } = await env.DB
        .prepare('SELECT id, ts, seq, type, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 5000')
        .bind(since)
        .all();

      const events = (results || []).map(r => ({
        id: r.id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload)
      }));
      const seq = results && results.length ? results[results.length - 1].seq : since;
      return json({ events, seq });
    }

    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

      const incoming = Array.isArray(body.events) ? body.events : [];
      if (incoming.length > 5000) return json({ error: 'batch too large' }, 413);

      /* INSERT OR IGNORE on the uuid primary key — a retried or duplicated
       * batch is free, which is what makes push idempotent. */
      const stmt = env.DB.prepare(
        'INSERT OR IGNORE INTO events (id, ts, type, payload) VALUES (?, ?, ?, ?)'
      );
      const batch = incoming
        .filter(e => e && typeof e.id === 'string' && typeof e.ts === 'string' && typeof e.type === 'string')
        .map(e => stmt.bind(e.id, e.ts, e.type, JSON.stringify(e.payload ?? {})));

      if (batch.length) await env.DB.batch(batch);

      const row = await env.DB.prepare('SELECT MAX(seq) AS seq FROM events').first();
      return json({ ok: true, written: batch.length, seq: (row && row.seq) || 0 });
    }

    return json({ error: 'method not allowed' }, 405);
  }
};
