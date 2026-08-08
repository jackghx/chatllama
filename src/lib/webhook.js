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

// Deliberately not awaitable. Handlers run inside the serial queue, so waiting
// on n8n would delay the reply to the person waiting on their phone.
function notify(payload) {
  if (!webhook.url) return;
  post(payload);
}

module.exports = { notify, enabled: () => Boolean(webhook.url) };
