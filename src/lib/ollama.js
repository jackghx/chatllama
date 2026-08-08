const axios = require('axios');
const { ollama } = require('../config');

// Doubles as the reachability check at startup.
async function listModels() {
  const res = await axios.get(`${ollama.host}/api/tags`, { timeout: 10000 });
  return (res.data?.models || []).map((m) => m.name);
}

/**
 * Single-shot completion. Not /v1/generate: the /v1 routes are the OpenAI
 * compatibility layer and have no generate endpoint, so that path 404s.
 */
async function generate({ model, prompt, stop, format, options = {} }) {
  const body = { model, prompt, stream: false, options: { ...options } };
  if (stop && stop.length) body.options.stop = stop;
  if (format) body.format = format;

  const res = await axios.post(`${ollama.host}/api/generate`, body, {
    timeout: ollama.timeoutMs,
  });

  return String(res.data?.response ?? '').trim();
}

module.exports = { listModels, generate };
