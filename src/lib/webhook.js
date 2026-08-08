const axios = require('axios');
const { webhook } = require('../config');

async function post(payload) {
  try {
    await axios.post(
      webhook.url,
      { ...payload, timestamp: new Date().toISOString() },
      { timeout: 10000 }
    );
  } catch (err) {
    console.error('[webhook] failed:', err.response?.status || err.message);
  }
}

/**
 * POST an event to the configured n8n webhook.
 *
 * Fire and forget, and deliberately not awaitable: handlers run inside the
 * serial queue, so awaiting this would hold up the reply to the person
 * waiting on their phone for as long as n8n took to answer, up to the
 * timeout. Failures are logged and otherwise ignored.
 */
function notify(payload) {
  if (!webhook.url) return;
  post(payload);
}

module.exports = { notify, enabled: () => Boolean(webhook.url) };
