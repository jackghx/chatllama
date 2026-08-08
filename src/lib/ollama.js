const axios = require('axios');
const { ollama } = require('../config');

/**
 * List models available on the Ollama instance.
 * Doubles as a reachability check at startup.
 */
async function listModels() {
  const res = await axios.get(`${ollama.host}/api/tags`, {
    timeout: 10000,
  });
  return (res.data?.models || []).map((m) => m.name);
}

/**
 * Single-shot completion against /api/generate.
 *
 * Note: /v1/* on Ollama is the OpenAI compatibility layer and does not
 * expose /v1/generate. Use /api/generate.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.prompt
 * @param {string[]} [opts.stop]   Stop sequences.
 * @param {'json'} [opts.format]   Ask Ollama to constrain output to valid JSON.
 * @param {object} [opts.options]  Extra Ollama options (temperature etc).
 * @returns {Promise<string>} raw response text
 */
async function generate({ model, prompt, stop, format, options = {} }) {
  const body = {
    model,
    prompt,
    stream: false,
    options: { ...options },
  };
  if (stop && stop.length) body.options.stop = stop;
  if (format) body.format = format;

  const res = await axios.post(`${ollama.host}/api/generate`, body, {
    timeout: ollama.timeoutMs,
  });

  return String(res.data?.response ?? '').trim();
}

module.exports = { listModels, generate };
