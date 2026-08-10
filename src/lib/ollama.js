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

// Ollama reports its own timings in nanoseconds.
const asMs = (ns) => (typeof ns === 'number' ? Math.round(ns / 1e6) : 0);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * A bare number is seconds and has to travel as one. Anything else is a
 * duration Ollama parses itself, such as 30m, or -1 for indefinitely.
 */
function withKeepAlive(body) {
  if (!ollama.keepAlive) return body;
  body.keep_alive = /^-?\d+$/.test(ollama.keepAlive) ? Number(ollama.keepAlive) : ollama.keepAlive;
  return body;
}

/**
 * One line per generation, because the wait is otherwise a black box.
 *
 * load is the model being read off disk, and it is reported separately from the
 * generation for a reason: in auto mode nothing keeps the model resident, so a
 * prefixed message hours after the last one starts cold, and most of the wait
 * is spent before a single token is produced. Without this line that is
 * indistinguishable from a model that is simply slow, and the two have
 * completely different fixes.
 */
function logTiming(model, m) {
  // A response with no timings is a stub or a build that does not report them.
  if (!m.totalMs) return;

  const parts = [secs(m.totalMs)];
  if (m.loadMs) parts.push(`load ${secs(m.loadMs)}`);
  if (m.promptMs) parts.push(`prompt ${secs(m.promptMs)}`);
  if (m.tokens) {
    const rate = m.evalMs ? (m.tokens / (m.evalMs / 1000)).toFixed(1) : '?';
    parts.push(`${m.tokens} tokens at ${rate}/s`);
  }
  if (m.truncated) parts.push('stopped at the token ceiling');

  console.log(`[ollama] ${model}: ${parts.join(', ')}`);
}

/**
 * Loads a model and reads a prompt into its cache, without writing a reply.
 *
 * Both halves matter, and the second is the larger by far. Loading the weights
 * is the obvious cost, but reading the prompt is what actually dominates on a
 * CPU: measured on an 8B, a 480-token system prompt took 82 seconds to read
 * against 12 to load. Ollama keeps the evaluated prefix, so the same prompt
 * arriving again costs almost nothing, and every reply shares the persona as
 * its opening. Sending it here means the person asking pays neither.
 *
 * num_predict is 1 rather than 0. One token is half a second and guarantees the
 * prompt was evaluated in full, where 0 is a value different Ollama builds have
 * disagreed about and is not worth being clever over.
 *
 * Its own timeout, and a generous one. Reading several gigabytes off a disk
 * that is also running everything else takes as long as it takes, and there is
 * nobody waiting on this.
 */
async function warmUp({ model, prompt = '', timeoutMs = 120000 }) {
  const body = withKeepAlive({ model, prompt, stream: false, options: { num_predict: 1 } });
  await axios.post(`${ollama.host}/api/generate`, body, { timeout: timeoutMs });
}

/**
 * Single-shot completion. Not /v1/generate: the /v1 routes are the OpenAI
 * compatibility layer and have no generate endpoint, so that path 404s.
 *
 * onMeta receives what the request cost and whether it ran into num_predict,
 * which the caller needs because a reply stopped at the ceiling ends mid
 * sentence and has to be tidied before anybody reads it.
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
  onMeta,
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
  withKeepAlive(body);

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

  const data = res.data || {};

  const meta = {
    // Ollama says why it stopped. "length" is num_predict, and the reply it
    // hands back is cut wherever the counter ran out, mid word if need be.
    truncated: data.done_reason === 'length',
    totalMs: asMs(data.total_duration),
    loadMs: asMs(data.load_duration),
    promptMs: asMs(data.prompt_eval_duration),
    evalMs: asMs(data.eval_duration),
    tokens: data.eval_count || 0,
  };
  logTiming(model, meta);
  if (onMeta) onMeta(meta);

  const text = String(data.response ?? '');
  // Structured output goes back untouched. The unclosed-tag rule below cuts
  // everything after a <think> that never closes, which would silently eat the
  // tail of any JSON document containing that literal.
  return format ? text.trim() : stripThinking(text);
}

module.exports = { listModels, generate, warmUp, Aborted };
