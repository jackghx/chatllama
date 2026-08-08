/**
 * Drives the real source in src/ with stubbed dependencies, so the assistant
 * can be exercised without npm install, a WhatsApp session or a live Ollama.
 *
 *   npm test
 *
 * There is no test runner and no dev dependency. Everything the source would
 * reach for is intercepted through a Module._load hook: axios, dotenv,
 * whatsapp-web.js and qrcode-terminal all resolve to stubs defined below.
 *
 * Point it at a different copy of the repo to compare two versions:
 *
 *   HARNESS_REPO=/path/to/other/checkout node test/harness.js
 *
 * Useful when the tests were written after the fixes they cover, as these were:
 * a suite that asserts nothing passes too, and that run tells the two apart.
 *
 * Exits non-zero if any check fails.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = process.env.HARNESS_REPO
  ? path.resolve(process.env.HARNESS_REPO)
  : path.join(__dirname, '..');

const srcFile = (...parts) => path.join(REPO, 'src', ...parts);

let axiosStub = null;
let capturedBot = null;
let lastClient = null;

class ClientStub {
  constructor(opts) {
    this.opts = opts;
    this.handlers = {};
    this.sent = [];
    lastClient = this;
  }
  on(event, fn) {
    this.handlers[event] = fn;
  }
  initialize() {}
  async sendMessage(to, body) {
    this.sent.push({ to, body });
  }
  emit(event, arg) {
    if (this.handlers[event]) return this.handlers[event](arg);
  }
}

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'axios') return axiosStub;
  if (request === 'dotenv') return { config: () => ({}) };
  if (request === 'qrcode-terminal') return { generate: () => {} };
  if (request === 'whatsapp-web.js') return { Client: ClientStub, LocalAuth: class {} };
  // The bot calls run() at module scope. Capture the definition instead of
  // booting a client, so handle() can be called directly.
  if (request === '../lib/runner' && parent && parent.filename.includes('bots')) {
    return {
      run: (bot) => {
        capturedBot = bot;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

/** Everything config reads, cleared between scenarios so defaults are real. */
const CONFIG_ENV = [
  'OLLAMA_HOST',
  'OLLAMA_TIMEOUT_MS',
  'REPLY_MODE',
  'COMMAND_PREFIX',
  'ALLOWED_CONTACTS',
  'LOG_UNMATCHED',
  'IGNORE_OLDER_THAN_SECONDS',
  'ALLOW_GROUPS',
  'MAX_REPLIES_PER_HOUR',
  'ASSISTANT_MODEL',
  'ASSISTANT_MEMORY_WINDOW',
  'SYSTEM_PROMPT_FILE',
  'SYSTEM_PROMPT',
  'AI_PREFIX',
  'AI_PREFIX_MODE',
  'N8N_WEBHOOK_URL',
  'WEBHOOK_IN_SIM',
  'SUMMARY_IDLE_MINUTES',
  'SUMMARY_MAX_MESSAGES',
];

/**
 * Config is read from the environment once, at require time, so each scenario
 * that changes the environment needs the repo's modules loaded again.
 */
function resetModules(env = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(REPO) && key !== __filename) delete require.cache[key];
  }
  for (const key of CONFIG_ENV) delete process.env[key];
  process.env.OLLAMA_HOST = 'http://stub:11434';
  Object.assign(process.env, env);
  capturedBot = null;
  lastClient = null;
}

/** axios stub. `responses` maps a URL substring to a handler. */
function makeAxios(responses = {}) {
  const calls = [];
  return {
    calls,
    posts: () => calls.filter((c) => c.method === 'post'),
    async get(url) {
      calls.push({ method: 'get', url });
      return { data: { models: [{ name: 'stub-model' }] } };
    },
    post(url, body) {
      calls.push({ method: 'post', url, body });
      for (const [match, fn] of Object.entries(responses)) {
        if (url.includes(match)) return fn(body);
      }
      throw new Error(`unexpected POST to ${url}`);
    },
  };
}

const ollamaReplies = (text) => ({
  '/api/generate': async () => ({ data: { response: text } }),
});

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (err) {
    results.push([false, `${name}\n      ${err.message.split('\n')[0]}`]);
  }
}

async function section(name, fn) {
  console.log(`\n${name}`);
  const start = results.length;
  await fn();
  for (const [ok, label] of results.slice(start)) {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}`);
  }
}

const settle = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Captures console output for checks on startup logging. */
async function capturingLogs(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

// Anything older than IGNORE_OLDER_THAN_SECONDS is treated as replayed backlog.
const now = () => Math.floor(Date.now() / 1000);

/** Boots the runner with a recording handler and returns the delivery helpers. */
function bootRunner(env = {}) {
  resetModules(env);
  axiosStub = makeAxios();
  const { run } = require(srcFile('lib', 'runner.js'));
  const seen = [];
  run({
    name: 'test',
    clientId: 'test',
    handle: async (id, text) => {
      seen.push({ id, text });
      return 'ok';
    },
  });
  const client = lastClient;
  return {
    seen,
    client,
    async deliver(msg) {
      await client.emit('message', { from: 'x@lid', timestamp: now(), ...msg });
      await settle();
    },
  };
}

async function replyModeCases(env, cases) {
  const { seen, deliver } = bootRunner(env);
  for (const [body, expected] of cases) {
    seen.length = 0;
    await deliver({ body });
    const got = seen.length ? seen[0].text : null;
    const label = expected === null ? 'ignored' : JSON.stringify(expected);
    check(`${JSON.stringify(body)} -> ${label}`, () =>
      assert.strictEqual(got, expected)
    );
  }
}

async function main() {
  await section('reply mode always, the default', async () => {
    const { seen, deliver } = bootRunner();
    await deliver({ body: 'are you around this evening' });
    check('a plain message with no prefix is answered', () =>
      assert.deepStrictEqual(
        seen.map((s) => s.text),
        ['are you around this evening']
      )
    );

    await replyModeCases({}, [
      ['/ai still works as plain text', '/ai still works as plain text'],
      ['   padded  ', 'padded'],
    ]);
  });

  await section('reply mode prefix, retained as an option', () =>
    replyModeCases({ REPLY_MODE: 'prefix' }, [
      ['/ai what is 2+2', 'what is 2+2'],
      ['/AI mixed case', 'mixed case'],
      ['/ai   padded  ', 'padded'],
      ['/airplanes are loud', null],
      ['/aitken', null],
      ['/ai', null],
      ['hello there', null],
      ['say /ai later', null],
    ])
  );

  await section('prefix mode, prefix "!" (no trailing word character)', () =>
    replyModeCases({ REPLY_MODE: 'prefix', COMMAND_PREFIX: '!' }, [
      ['!hello', 'hello'],
      ['! hello', 'hello'],
      ['hello', null],
    ])
  );

  await section('an unrecognised REPLY_MODE falls back rather than failing', async () => {
    const { seen, deliver } = bootRunner({ REPLY_MODE: 'nonsense' });
    await deliver({ body: 'plain message' });
    check('falls back to always', () => assert.strictEqual(seen.length, 1));
  });

  await section('group chats', async () => {
    const off = bootRunner();
    await off.deliver({ from: '123-456@g.us', body: 'group chatter' });
    check('a group is ignored by default', () => assert.strictEqual(off.seen.length, 0));

    await off.deliver({ from: 'status@broadcast', body: 'a status update' });
    check('a status broadcast is ignored', () => assert.strictEqual(off.seen.length, 0));

    await off.deliver({ from: 'someone@lid', body: 'direct message' });
    check('a direct message still gets through', () => assert.strictEqual(off.seen.length, 1));

    const on = bootRunner({ ALLOW_GROUPS: 'true' });
    await on.deliver({ from: '123-456@g.us', body: 'group chatter' });
    check('ALLOW_GROUPS=true opts back in', () => assert.strictEqual(on.seen.length, 1));
  });

  await section('non-text messages', async () => {
    const { seen, deliver } = bootRunner();
    for (const [msg, label] of [
      [{ body: '' }, 'an empty body'],
      [{ body: '   ' }, 'a whitespace body'],
      [{}, 'an absent body'],
    ]) {
      seen.length = 0;
      await deliver(msg);
      check(`${label} is skipped rather than sent to Ollama`, () =>
        assert.strictEqual(seen.length, 0)
      );
    }

    seen.length = 0;
    await deliver({ body: 'look at this', hasMedia: true });
    check('a captioned image is answered on its caption', () =>
      assert.strictEqual(seen.length, 1)
    );
  });

  await section('reply cooldown', async () => {
    const { seen, deliver, client } = bootRunner({ MAX_REPLIES_PER_HOUR: '3' });
    for (let i = 0; i < 5; i += 1) await deliver({ body: `message ${i}` });
    check('replies stop at the cap', () => assert.strictEqual(seen.length, 3));
    check('nothing further is sent to the chat', () =>
      assert.strictEqual(client.sent.length, 3)
    );

    const other = bootRunner({ MAX_REPLIES_PER_HOUR: '2' });
    for (let i = 0; i < 3; i += 1) await other.deliver({ from: 'a@lid', body: `m${i}` });
    await other.deliver({ from: 'b@lid', body: 'hello' });
    check('the cap is per conversation, not global', () =>
      assert.deepStrictEqual(
        other.seen.map((s) => s.id),
        ['a@lid', 'a@lid', 'b@lid']
      )
    );

    const logs = await capturingLogs(async () => {
      const limited = bootRunner({ MAX_REPLIES_PER_HOUR: '1' });
      for (let i = 0; i < 4; i += 1) await limited.deliver({ body: `m${i}` });
    });
    check('the breach is logged once, not per message', () =>
      assert.strictEqual(logs.filter((l) => l.includes('[limit]')).length, 1)
    );

    const unlimited = bootRunner({ MAX_REPLIES_PER_HOUR: '0' });
    for (let i = 0; i < 25; i += 1) await unlimited.deliver({ body: `m${i}` });
    check('zero disables the limit', () => assert.strictEqual(unlimited.seen.length, 25));
  });

  await section('empty numeric variables fall back to defaults', async () => {
    // Number('') is 0. Left uncaught, a blank IGNORE_OLDER_THAN_SECONDS treats
    // every message as backlog and the assistant answers nobody.
    resetModules({
      IGNORE_OLDER_THAN_SECONDS: '',
      MAX_REPLIES_PER_HOUR: '',
      ASSISTANT_MEMORY_WINDOW: '',
      OLLAMA_TIMEOUT_MS: '  ',
    });
    axiosStub = makeAxios();
    const { access, assistant, ollama } = require(srcFile('config.js'));

    check('blank IGNORE_OLDER_THAN_SECONDS keeps the default', () =>
      assert.strictEqual(access.ignoreOlderThanSeconds, 30)
    );
    check('blank MAX_REPLIES_PER_HOUR keeps the cap', () =>
      assert.strictEqual(access.maxRepliesPerHour, 20)
    );
    check('blank ASSISTANT_MEMORY_WINDOW keeps memory', () =>
      assert.strictEqual(assistant.memoryWindow, 20)
    );
    check('whitespace OLLAMA_TIMEOUT_MS keeps the timeout', () =>
      assert.strictEqual(ollama.timeoutMs, 120000)
    );

    const blanked = bootRunner({ IGNORE_OLDER_THAN_SECONDS: '' });
    await blanked.deliver({ body: 'hello' });
    check('a blank backlog window still answers live messages', () =>
      assert.strictEqual(blanked.seen.length, 1)
    );

    const garbage = bootRunner({ MAX_REPLIES_PER_HOUR: 'twenty' });
    for (let i = 0; i < 25; i += 1) await garbage.deliver({ body: `m${i}` });
    check('an unparseable cap falls back rather than disabling itself', () =>
      assert.strictEqual(garbage.seen.length, 20)
    );
  });

  await section('long running memory stays bounded', async () => {
    resetModules();
    axiosStub = makeAxios();
    const { ConversationStore } = require(srcFile('lib', 'memory.js'));
    const { RateLimiter } = require(srcFile('lib', 'ratelimit.js'));

    const store = new ConversationStore(4, 10);
    for (let i = 0; i < 50; i += 1) store.push(`chat-${i}`, 'a line');
    check('conversations are capped', () => assert.strictEqual(store.conversations.size, 10));
    check('the most recent conversation survives', () =>
      assert.deepStrictEqual(store.lines('chat-49'), ['a line'])
    );
    check('the oldest conversation is evicted', () =>
      assert.deepStrictEqual(store.lines('chat-0'), [])
    );

    store.push('busy', 'one');
    for (let i = 0; i < 10; i += 1) store.push('busy', `line ${i}`);
    check('the line window still holds', () =>
      assert.strictEqual(store.lines('busy').length, 4)
    );

    const active = new ConversationStore(4, 3);
    active.push('a', 'x');
    active.push('b', 'x');
    active.push('a', 'y');
    active.push('c', 'x');
    active.push('d', 'x');
    check('a conversation still in use is not evicted first', () =>
      assert.strictEqual(active.lines('a').length, 2)
    );

    const limiter = new RateLimiter(5);
    const longAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < 20; i += 1) limiter.allow(`old-${i}`, longAgo);
    limiter.sweep();
    check('rate limiter drops conversations that went quiet', () =>
      assert.strictEqual(limiter.hits.size, 0)
    );

    const live = new RateLimiter(5);
    live.allow('recent');
    live.sweep();
    check('rate limiter keeps conversations inside the window', () =>
      assert.strictEqual(live.hits.size, 1)
    );
  });

  await section('access and backlog filters', async () => {
    const { seen, deliver, client } = bootRunner({ ALLOWED_CONTACTS: 'good@lid' });

    await deliver({ from: 'bad@lid', body: 'hi' });
    check('sender not on the allowlist is ignored', () => assert.strictEqual(seen.length, 0));

    await deliver({ from: 'good@lid', body: 'hi', timestamp: now() - 600 });
    check('replayed backlog is ignored', () => assert.strictEqual(seen.length, 0));

    await deliver({ from: 'good@lid', body: 'hi' });
    check('allowed sender is answered', () =>
      assert.deepStrictEqual(seen.map((s) => s.text), ['hi'])
    );
    check('reply is sent back to the sender', () =>
      assert.deepStrictEqual(client.sent, [{ to: 'good@lid', body: 'ok' }])
    );
  });

  await section('startup logging', async () => {
    for (const [env, expected, label] of [
      [{ N8N_WEBHOOK_URL: 'http://stub-n8n/webhook/x' }, '[webhook] logging on', 'webhook URL set'],
      [{}, '[webhook] logging off', 'webhook URL empty'],
    ]) {
      const lines = await capturingLogs(async () => {
        const { client } = bootRunner(env);
        await client.emit('ready');
      });
      check(`${label} -> "${expected}"`, () =>
        assert.ok(lines.some((l) => l.startsWith(expected)), JSON.stringify(lines))
      );
    }

    const openAlways = await capturingLogs(async () => {
      const { client } = bootRunner();
      await client.emit('ready');
    });
    check('an empty allowlist in always mode warns about the blast radius', () =>
      assert.ok(openAlways.some((l) => l.includes('[access]') && l.includes('always')))
    );

    const closed = await capturingLogs(async () => {
      const { client } = bootRunner({ ALLOWED_CONTACTS: 'a@lid' });
      await client.emit('ready');
    });
    check('a set allowlist does not warn', () =>
      assert.ok(!closed.some((l) => l.includes('[access]')))
    );
  });

  await section('system prompt sources', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-'));
    const file = path.join(tmp, 'persona.md');
    fs.writeFileSync(file, '<!-- a note to the editor -->\nYou are a lighthouse keeper.\n');

    const load = (env) => {
      resetModules(env);
      axiosStub = makeAxios();
      return require(srcFile('lib', 'prompt.js')).loadSystemPrompt();
    };

    const fromFile = load({ SYSTEM_PROMPT_FILE: file, SYSTEM_PROMPT: 'inline loses' });
    check('SYSTEM_PROMPT_FILE wins over SYSTEM_PROMPT', () =>
      assert.strictEqual(fromFile.text, 'You are a lighthouse keeper.')
    );
    check('editor comments are stripped before the model sees them', () =>
      assert.ok(!fromFile.text.includes('a note to the editor'))
    );
    check('the file source is named for the startup log', () =>
      assert.ok(fromFile.source.includes('SYSTEM_PROMPT_FILE'))
    );

    const inline = load({ SYSTEM_PROMPT: 'You are terse.' });
    check('SYSTEM_PROMPT wins over the bundled default', () =>
      assert.strictEqual(inline.text, 'You are terse.')
    );
    check('the inline source is named', () =>
      assert.strictEqual(inline.source, 'SYSTEM_PROMPT')
    );

    const bundled = load({});
    check('the bundled default is the last resort', () =>
      assert.ok(bundled.source.startsWith('default'))
    );
    check('the bundled default has content after comment stripping', () =>
      assert.ok(bundled.text.length > 50)
    );
    check('the bundled default does not ask the model to emit the notice', () =>
      assert.ok(!bundled.text.includes('[AI]'))
    );

    const missing = load({ SYSTEM_PROMPT_FILE: path.join(tmp, 'nope.md'), SYSTEM_PROMPT: 'inline' });
    check('an unreadable SYSTEM_PROMPT_FILE falls through rather than throwing', () =>
      assert.strictEqual(missing.text, 'inline')
    );

    const logs = await capturingLogs(async () => {
      resetModules({ SYSTEM_PROMPT: 'You are terse.' });
      axiosStub = makeAxios(ollamaReplies('hello'));
      require(srcFile('bots', 'assistant.js'));
      const { run } = require(srcFile('lib', 'runner.js'));
      run(capturedBot);
      await lastClient.emit('ready');
    });
    check('the winning source is logged at startup', () =>
      assert.ok(logs.some((l) => l.includes('[prompt] loaded from SYSTEM_PROMPT')))
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await section('self-disclosure notice', async () => {
    const boot = (env, response) => {
      resetModules(env);
      axiosStub = makeAxios(ollamaReplies(response));
      require(srcFile('bots', 'assistant.js'));
      return capturedBot;
    };
    const ctx = { isSim: true, from: null };

    for (const [raw, expected, label] of [
      ['Lima.', '[AI] Lima.', 'model omitted the notice'],
      ['[AI] Lima.', '[AI] Lima.', 'model emitted the notice'],
      ['[AI]: Lima.', '[AI] Lima.', 'model emitted it with a colon'],
      ['Assistant: Lima.', '[AI] Lima.', 'model echoed the transcript label'],
      ['[AI] [AI] Lima.', '[AI] Lima.', 'model emitted it twice'],
    ]) {
      const bot = boot({}, raw);
      const reply = await bot.handle('c1', 'q', ctx);
      check(`${label} -> ${JSON.stringify(expected)}`, () =>
        assert.strictEqual(reply, expected)
      );
    }

    const custom = boot({ AI_PREFIX: '(auto)' }, 'Lima.');
    const customReply = await custom.handle('c1', 'q', ctx);
    check('the wording is configurable', () =>
      assert.strictEqual(customReply, '(auto) Lima.')
    );

    const never = boot({ AI_PREFIX_MODE: 'never' }, '[AI] Lima.');
    const neverReply = await never.handle('c1', 'q', ctx);
    check('never mode sends nothing extra, even if the model added it', () =>
      assert.strictEqual(neverReply, 'Lima.')
    );

    const first = boot({ AI_PREFIX_MODE: 'first' }, 'Lima.');
    const one = await first.handle('c1', 'q', ctx);
    const two = await first.handle('c1', 'q', ctx);
    const otherChat = await first.handle('c2', 'q', ctx);
    check('first mode marks the opening reply', () => assert.strictEqual(one, '[AI] Lima.'));
    check('first mode leaves later replies unmarked', () => assert.strictEqual(two, 'Lima.'));
    check('first mode marks each conversation separately', () =>
      assert.strictEqual(otherChat, '[AI] Lima.')
    );

    const empty = boot({}, '   ');
    const emptyReply = await empty.handle('c1', 'q', ctx);
    check('an empty generation falls back and stays marked', () =>
      assert.ok(emptyReply.startsWith('[AI] ') && emptyReply.length > 6)
    );
  });

  await section('conversation memory', async () => {
    resetModules();
    axiosStub = makeAxios(ollamaReplies('[AI] Lima.'));
    require(srcFile('bots', 'assistant.js'));
    const ctx = { isSim: true, from: null };

    await capturedBot.handle('c1', 'capital of peru', ctx);
    await capturedBot.handle('c1', 'and of chile', ctx);

    const secondPrompt = axiosStub.posts()[1].body.prompt;
    check('the transcript stores the bare answer', () =>
      assert.ok(secondPrompt.includes('Assistant: Lima.'))
    );
    check('the notice is not written into the transcript', () =>
      assert.ok(!secondPrompt.includes('Assistant: [AI]'))
    );
    check('the user turn is carried into the next prompt', () =>
      assert.ok(secondPrompt.includes('User: capital of peru'))
    );

    // One shared array here would leak one person's turns into another's chat.
    await capturedBot.handle('c2', 'unrelated question', ctx);
    check('a second conversation starts with empty memory', () =>
      assert.ok(!axiosStub.posts()[2].body.prompt.includes('capital of peru'))
    );
  });

  await section('webhook does not block the reply', async () => {
    resetModules({
      N8N_WEBHOOK_URL: 'http://stub-n8n/webhook/test',
      WEBHOOK_IN_SIM: 'true',
      SUMMARY_IDLE_MINUTES: '0',
    });

    let webhookCalled = null;
    axiosStub = makeAxios({
      '/api/generate': async () => ({ data: { response: 'Lima.' } }),
      // An n8n that accepts the connection and never answers.
      'stub-n8n': (body) => {
        webhookCalled = body;
        return new Promise(() => {});
      },
    });

    require(srcFile('bots', 'assistant.js'));

    let timer;
    const timeout = new Promise((r) => {
      timer = setTimeout(() => r('TIMED OUT'), 1000);
    });
    const reply = await Promise.race([
      capturedBot.handle('c1', 'capital of peru', { isSim: true, from: null }),
      timeout,
    ]);
    clearTimeout(timer);

    check('handle resolves while the webhook is still hanging', () =>
      assert.strictEqual(reply, '[AI] Lima.')
    );
    check('the webhook was still fired', () => assert.ok(webhookCalled));
    check('payload carries the sent reply and a timestamp', () => {
      assert.strictEqual(webhookCalled.event, 'ai_message');
      assert.strictEqual(webhookCalled.bot, 'assistant');
      assert.strictEqual(webhookCalled.botReply, '[AI] Lima.');
      assert.ok(webhookCalled.timestamp);
    });
  });

  await section('digest timing', async () => {
    resetModules();
    axiosStub = makeAxios();
    const { Digest } = require(srcFile('lib', 'digest.js'));

    const record = (into) => (id, state) => into.push({ id, ...state });

    const burst = [];
    const quiet = new Digest({ idleMs: 200, onFlush: record(burst) });
    for (let i = 0; i < 3; i += 1) quiet.track('a', { from: 'a@lid' });
    await settle();
    check('nothing fires while the conversation is still going', () =>
      assert.strictEqual(burst.length, 0)
    );

    await wait(500);
    check('a burst produces one flush, not one per message', () =>
      assert.strictEqual(burst.length, 1)
    );
    check('the flush counts the whole burst', () => assert.strictEqual(burst[0].messages, 3));
    check('the flush carries the sender through', () =>
      assert.strictEqual(burst[0].meta.from, 'a@lid')
    );
    check('idle is recorded as the reason', () => assert.strictEqual(burst[0].reason, 'idle'));

    // The window has to restart on every message, or a long conversation is
    // summarised halfway through and again at the end.
    const reset = [];
    const talking = new Digest({ idleMs: 300, onFlush: record(reset) });
    talking.track('b');
    await wait(80);
    talking.track('b');
    await wait(80);
    talking.track('b');
    check('a new message restarts the window', () => assert.strictEqual(reset.length, 0));
    await wait(600);
    check('the window closes once the talking stops', () =>
      assert.strictEqual(reset.length, 1)
    );
    check('every message in the exchange is counted', () =>
      assert.strictEqual(reset[0].messages, 3)
    );

    // Without this a conversation that never goes quiet never notifies.
    const capped = [];
    const ceiling = new Digest({ idleMs: 60000, maxMessages: 3, onFlush: record(capped) });
    for (let i = 0; i < 3; i += 1) ceiling.track('c');
    await settle();
    check('the message ceiling fires without waiting for silence', () =>
      assert.strictEqual(capped.length, 1)
    );
    check('the ceiling is recorded as the reason', () =>
      assert.strictEqual(capped[0].reason, 'cap')
    );

    ceiling.track('c');
    check('a fresh window opens after the ceiling fires', () =>
      assert.strictEqual(ceiling.pending.get('c').messages, 1)
    );
    await ceiling.flushAll();
    check('flushAll drains what was still waiting', () =>
      assert.strictEqual(capped.length, 2)
    );
    check('shutdown is recorded as the reason', () =>
      assert.strictEqual(capped[1].reason, 'shutdown')
    );
    check('nothing is left pending afterwards', () =>
      assert.strictEqual(ceiling.pending.size, 0)
    );

    const never = [];
    const disabled = new Digest({ idleMs: 0, onFlush: record(never) });
    disabled.track('d');
    await settle();
    check('zero idle minutes disables tracking entirely', () =>
      assert.strictEqual(disabled.pending.size, 0)
    );

    const logs = await capturingLogs(async () => {
      const broken = new Digest({
        idleMs: 60000,
        onFlush: () => {
          throw new Error('n8n is down');
        },
      });
      broken.track('e');
      await broken.flushAll();
    });
    check('a failing flush is logged rather than thrown', () =>
      assert.ok(logs.some((l) => l.includes('[digest] flush failed')))
    );
  });

  await section('conversation summary event', async () => {
    resetModules({
      N8N_WEBHOOK_URL: 'http://stub-n8n/webhook/test',
      WEBHOOK_IN_SIM: 'true',
      SUMMARY_IDLE_MINUTES: '0.004',
      SUMMARY_MAX_MESSAGES: '15',
    });

    const sent = [];
    axiosStub = makeAxios({
      '/api/generate': async (body) => ({
        data: {
          response: body.prompt.includes('Briefing:')
            ? 'Sam wants to climb on Saturday. The booking is still yours to make.'
            : 'Sounds good.',
        },
      }),
      'stub-n8n': async (body) => {
        sent.push(body);
        return { status: 200 };
      },
    });

    require(srcFile('bots', 'assistant.js'));
    const ctx = { isSim: true, from: null };

    await capturedBot.handle('c1', 'you around saturday', ctx);
    await capturedBot.handle('c1', 'climbing then food after', ctx);
    await settle();

    const of = (event) => sent.filter((s) => s.event === event);
    check('every reply still fires its own message event', () =>
      assert.strictEqual(of('ai_message').length, 2)
    );
    check('no summary lands while the conversation is live', () =>
      assert.strictEqual(of('conversation_summary').length, 0)
    );

    await wait(500);
    check('one summary covers the whole exchange', () =>
      assert.strictEqual(of('conversation_summary').length, 1)
    );

    const summary = of('conversation_summary')[0];
    check('the summary is the generated briefing', () =>
      assert.ok(summary.summary.includes('booking'))
    );
    check('the transcript travels with it', () =>
      assert.ok(summary.transcript.some((l) => l.includes('you around saturday')))
    );
    check('the exchange count travels with it', () =>
      assert.strictEqual(summary.messages, 2)
    );
    check('the summary prompt is not the persona prompt', () => {
      const briefing = axiosStub.posts().find((p) => p.body?.prompt?.includes('Briefing:'));
      assert.ok(briefing.body.prompt.includes('Transcript:'));
    });
    check('the bot exposes a shutdown flush for the runner', () =>
      assert.strictEqual(typeof capturedBot.shutdown, 'function')
    );

    const off = { ...ctx };
    resetModules({ N8N_WEBHOOK_URL: '', SUMMARY_IDLE_MINUTES: '0.004' });
    axiosStub = makeAxios(ollamaReplies('Sounds good.'));
    require(srcFile('bots', 'assistant.js'));
    await capturedBot.handle('c1', 'hello', off);
    await wait(300);
    check('no webhook URL means no summary generation is attempted', () =>
      assert.strictEqual(axiosStub.posts().length, 1)
    );
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) console.log(`${failed} failed`);

  // Set the code rather than calling process.exit, so output piped to a file
  // or a CI log is not truncated on the way out.
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
