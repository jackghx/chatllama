const axios = require('axios');
const { ollama } = require('../config');

/**
 * Thrown when a caller cancels a generation, which the runner does when a newer
 * message arrives for the same conversation.
 *
 * It is deliberately its own type. Every other failure here means the model is
 * unreachable and the person gets told so, whereas this one means the answer is
 * being written again with more to go on, and must not reach anybody.
 */
class Aborted extends Error {
  constructor() {
    super('generation aborted');
    this.name = 'Aborted';
  }
}

// Doubles as the reachability check at startup.
async function listModels() {
  const res = await axios.get(`${ollama.host}/api/tags`, { timeout: 10000 });
  return (res.data?.models || []).map((m) => m.name);
}

/**
 * Removes reasoning the model wrote into the reply itself.
 *
 * Ollama returns thinking in its own field, which nothing here reads, but not
 * every template obeys that. A leaked block would be texted to whoever is
 * waiting, so it is cut in code rather than left to the model to get right.
 */
function stripThinking(text) {
  let out = text;

  // A template that primes the model with the opening tag leaves only a close.
  if (/<\/think>/i.test(out) && !/<think>/i.test(out)) {
    out = out.replace(/^[\s\S]*?<\/think>/i, '');
  }

  return out
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Unclosed means a stop sequence or the timeout cut it off mid thought.
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

/**
 * Single-shot completion. Not /v1/generate: the /v1 routes are the OpenAI
 * compatibility layer and have no generate endpoint, so that path 404s.
 */
async function generate({
  model,
  prompt,
  stop,
  format,
  options = {},
  think = ollama.think,
  timeoutMs = ollama.timeoutMs,
  signal,
}) {
  const body = { model, prompt, stream: false, options: { ...options } };
  // Deliberately ignored alongside format rather than left to the caller. A stop
  // sequence the model then writes inside a string value truncates the document
  // mid-object, and the result is unparseable in a way that looks like the model
  // failing rather than the request being wrong.
  if (stop && stop.length && !format) body.options.stop = stop;
  if (format) body.format = format;
  // Only sent when configured. Some builds reject the field outright on a model
  // that has no thinking capability, so an unset variable changes nothing.
  if (think !== null && think !== undefined) body.think = think;

  if (signal?.aborted) throw new Aborted();

  let res;
  try {
    res = await axios.post(`${ollama.host}/api/generate`, body, {
      timeout: timeoutMs,
      signal,
    });
  } catch (err) {
    // Closing the socket stops Ollama generating rather than only discarding
    // the answer, so the work behind an abandoned reply is genuinely given back.
    if (signal?.aborted) throw new Aborted();
    throw err;
  }

  const text = String(res.data?.response ?? '');
  // Structured output goes back untouched. The unclosed-tag rule below cuts
  // everything after a <think> that never closes, which would silently eat the
  // tail of any JSON document containing that literal.
  return format ? text.trim() : stripThinking(text);
}

module.exports = { listModels, generate, Aborted };
