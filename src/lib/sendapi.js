const http = require('node:http');
const crypto = require('node:crypto');

// Chunks are accumulated in memory, and this process is holding a live WhatsApp
// session. A large POST should be refused, not swallowed until the box runs out.
const MAX_BODY = 64 * 1024;

const sha512 = (v) => crypto.createHash('sha512').update(v).digest('hex');

/**
 * Constant-time comparison of the presented key against the stored digest.
 *
 * The digest is stored rather than the key so that a copy of .env is not a
 * working credential. Unsalted is fine here because the documented way to make
 * one is 32 random bytes, which no table has.
 */
function keyMatches(presented, expectedHex) {
  if (!presented || !expectedHex) return false;

  const got = Buffer.from(sha512(presented), 'hex');
  const want = Buffer.from(String(expectedHex).trim().toLowerCase(), 'hex');

  // Malformed hex decodes short, and timingSafeEqual throws on a length
  // mismatch rather than returning false.
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function respond(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * A small endpoint so something else, n8n in practice, can have the bot send a
 * message. That is what turns a drafted reply into one you approve with a tap
 * rather than retype.
 *
 * Returns null when it is switched off, or when it is configured without a key.
 * It will not start unauthenticated: a send endpoint reachable on a LAN with no
 * credential is a spam relay wired to a real phone number.
 */
function startSendApi({ port, host, keyHash, maxPerMinute, allows, deliver }) {
  if (port === null || port === undefined) return null;

  if (!keyHash) {
    console.error(
      '[send] SEND_API_PORT is set but SEND_API_KEY_SHA512 is empty, so the ' +
        'endpoint has not been started. Generate a key with "openssl rand -hex 32" ' +
        'and store its SHA-512.'
    );
    return null;
  }

  // Global rather than per conversation. The per-chat limiter is a budget for
  // replies the model wrote unprompted; a reply you approved yourself should
  // never be refused because that conversation was busy, and refusing it there
  // would text the contact the rate-limit notice.
  const hits = [];
  const affordable = (at = Date.now()) => {
    while (hits.length && at - hits[0] > 60000) hits.shift();
    if (maxPerMinute > 0 && hits.length >= maxPerMinute) return false;
    hits.push(at);
    return true;
  };

  const server = http.createServer((req, res) => {
    if (req.url !== '/send') return respond(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return respond(res, 405, { error: 'use POST' });
    if (!keyMatches(req.headers['x-api-key'], keyHash)) {
      return respond(res, 401, { error: 'bad or missing x-api-key' });
    }
    if (!affordable()) return respond(res, 429, { error: 'too many sends' });

    let size = 0;
    let oversize = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (oversize) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        oversize = true;
        // Answered but not destroyed, so the response actually reaches the
        // caller instead of racing a reset.
        respond(res, 413, { error: 'body too large' });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (oversize) return;

      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return respond(res, 400, { error: 'body is not JSON' });
      }

      const to = String((payload && payload.to) || '').trim();
      const text = String((payload && payload.text) || '');
      if (!to || !text.trim()) return respond(res, 400, { error: 'to and text are required' });

      // A leaked key would otherwise be able to message anybody at all from
      // your number, rather than only the people the bot already talks to.
      if (!allows(to)) return respond(res, 403, { error: 'not an allowed recipient' });

      deliver(to, text);

      // Accepted, not sent. Waiting would hold the request open behind whatever
      // is already on the queue, which can be a two-minute generation.
      respond(res, 202, { queued: true, to });
    });
  });

  server.on('error', (err) => console.error('[send] listener failed:', err.message));
  server.listen(port, host, () => {
    const bound = server.address();
    console.log(`[send] listening on ${host}:${bound && bound.port}, key required`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn('[send] bound beyond loopback. Keep this off any port forward.');
    }
  });

  // So a listener left open can never be the only thing holding the process up.
  server.unref();
  return server;
}

const stopSendApi = (server) =>
  server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();

module.exports = { startSendApi, stopSendApi, keyMatches, sha512, MAX_BODY };
