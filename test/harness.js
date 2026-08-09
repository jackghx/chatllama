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
const http = require('http');
const crypto = require('crypto');
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
    this.info = { wid: { _serialized: 'me@c.us' } };
    // Scripted per test. A map from requested ID to the row the page returns,
    // or a function, so a test can also make the lookup reject.
    this.lidLookups = null;
    this.lidCalls = [];
    lastClient = this;
  }
  async getContactLidAndPhone(ids) {
    this.lidCalls.push(ids);
    if (typeof this.lidLookups === 'function') return this.lidLookups(ids);
    return ids.map((id) => (this.lidLookups && this.lidLookups[id]) || {});
  }
  on(event, fn) {
    this.handlers[event] = fn;
  }
  initialize() {}
  async sendMessage(to, body) {
    this.sent.push({ to, body });
    // The real client hands back the Message it created, which is how the
    // runner recognises its own text arriving on message_create.
    return { id: { _serialized: `sent-${this.sent.length}` } };
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
  'OLLAMA_THINK',
  'REPLY_MODE',
  'COMMAND_PREFIX',
  'AUTO_REPLY_TEXT',
  'AUTO_REPLY_GAP_MINUTES',
  'AUTO_REPLY_MAX_PER_DAY',
  'OWNER_COMMANDS',
  'OWNER_COMMAND_ACK',
  'ALLOWED_CONTACTS',
  'CAPTURE_IDS',
  'CONTACT_CACHE_FILE',
  'CONTACT_CACHE_TTL_DAYS',
  'CONTACT_RESOLVE_DELAY_MS',
  'IGNORE_OLDER_THAN_SECONDS',
  'ALLOW_GROUPS',
  'MAX_REPLIES_PER_HOUR',
  'MAX_INTERRUPTS',
  'RATE_LIMIT_NOTICE',
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
  'SUMMARY_FORMAT',
  'SUMMARY_MODEL',
  'SEND_API_PORT',
  'SEND_API_HOST',
  'SEND_API_KEY_SHA512',
  'SEND_API_MAX_PER_MINUTE',
  'SEND_API_ALLOW_ANY',
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

/**
 * axios stub that hangs until released, and rejects if the caller aborts first.
 * Real generation is the only slow part of a reply, so holding it open is what
 * puts the runner in the state a second message, or a cancellation, arrives into.
 */
const heldAxios = () => {
  const prompts = [];
  let release = null;
  return {
    prompts,
    calls: [],
    posts: () => [],
    finish: (text) => release && release(text),
    async get() {
      return { data: { models: [] } };
    },
    post(url, body, cfg) {
      prompts.push(body.prompt);
      return new Promise((resolve, reject) => {
        release = (text) => resolve({ data: { response: text } });
        if (cfg?.signal) {
          cfg.signal.addEventListener('abort', () => reject(new Error('socket closed')));
        }
      });
    },
  };
};

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

/**
 * Boots the runner with a recording handler and returns the delivery helpers.
 *
 * REPLY_MODE is pinned rather than left to the default. Every section below
 * asserts what a particular mode does, so inheriting the default would mean
 * changing it silently rewrote what all of them were testing. The shipped
 * default has its own section instead.
 */
function bootRunner(env = {}, { pinMode = true } = {}) {
  resetModules(pinMode ? { REPLY_MODE: 'always', ...env } : env);
  axiosStub = makeAxios();
  const { run } = require(srcFile('lib', 'runner.js'));
  const seen = [];
  const observed = [];
  const started = run({
    name: 'test',
    clientId: 'test',
    handle: async (id, text) => {
      seen.push({ id, text });
      return 'ok';
    },
    // No auto() on purpose, so the runner's own fallback is what gets exercised.
    observe: (id, text) => observed.push({ id, text }),
  });
  const client = lastClient;
  return {
    seen,
    observed,
    client,
    runtime: started && started.runtime,
    server: started && started.server,
    async deliver(msg) {
      await client.emit('message', { from: 'x@lid', timestamp: now(), ...msg });
      await settle();
    },
    /** A message the owner typed, which arrives on the other event. */
    async command(body, extra = {}) {
      await client.emit('message_create', {
        fromMe: true,
        to: 'me@c.us',
        timestamp: now(),
        id: { _serialized: `own-${Math.random()}` },
        body,
        ...extra,
      });
      await settle();
    },
  };
}

/** Boots without pinning REPLY_MODE, which is how the default itself is tested. */
const bootDefaults = (env = {}) => bootRunner(env, { pinMode: false });

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

  await section('reply mode auto, a fixed reply with the model on request', async () => {
    const FIXED = 'not at my phone, send it all in one go';
    const env = { REPLY_MODE: 'auto', AUTO_REPLY_TEXT: FIXED };

    const a = bootRunner(env);
    await a.deliver({ body: 'you around this evening' });
    check('a plain message gets the fixed reply', () =>
      assert.deepStrictEqual(
        a.client.sent.map((s) => s.body),
        [FIXED]
      )
    );
    check('and never reaches the model', () => assert.strictEqual(a.seen.length, 0));

    await a.deliver({ body: '/ai what time do you finish' });
    check('the command still reaches the model', () =>
      assert.deepStrictEqual(
        a.seen.map((s) => s.text),
        ['what time do you finish']
      )
    );

    // The gap is measured from their last message, so a burst is one reply.
    const b = bootRunner(env);
    await b.deliver({ body: 'hello' });
    await b.deliver({ body: 'you there' });
    await b.deliver({ body: 'anyone' });
    check('a burst gets one fixed reply, not one each', () =>
      assert.strictEqual(b.client.sent.length, 1)
    );
    check('the messages that got no reply are still recorded for the briefing', () =>
      assert.deepStrictEqual(
        b.observed.map((o) => o.text),
        ['you there', 'anyone']
      )
    );

    const c = bootRunner({ ...env, AUTO_REPLY_GAP_MINUTES: '0.004' });
    await c.deliver({ body: 'first' });
    await wait(400);
    await c.deliver({ body: 'back again later' });
    check('someone coming back after a gap gets it again', () =>
      assert.strictEqual(c.client.sent.length, 2)
    );

    const d = bootRunner({ ...env, AUTO_REPLY_GAP_MINUTES: '0', AUTO_REPLY_MAX_PER_DAY: '2' });
    for (const body of ['one', 'two', 'three', 'four']) await d.deliver({ body });
    check('the daily ceiling stops it repeating all day', () =>
      assert.strictEqual(d.client.sent.length, 2)
    );

    const e = bootRunner({ REPLY_MODE: 'off', AUTO_REPLY_TEXT: FIXED });
    await e.deliver({ body: 'hello' });
    await e.deliver({ body: '/ai are you there' });
    check('off answers nothing at all, command or not', () => {
      assert.deepStrictEqual(e.client.sent, []);
      assert.strictEqual(e.seen.length, 0);
    });

    // Sent by the bot rather than straight from the runner, so that the one
    // outbound message with no model behind it is not also the one message with
    // nothing marking it as automatic.
    resetModules({ REPLY_MODE: 'auto', AUTO_REPLY_TEXT: FIXED });
    axiosStub = makeAxios(ollamaReplies('unused'));
    require(srcFile('bots', 'assistant.js'));
    const { run } = require(srcFile('lib', 'runner.js'));
    run(capturedBot);
    const marked = lastClient;
    await marked.emit('message', { from: 'sam@lid', timestamp: now(), body: 'hello' });
    await settle();
    check('the fixed reply still carries the disclosure marker', () =>
      assert.deepStrictEqual(
        marked.sent.map((s) => s.body),
        [`[AI] ${FIXED}`]
      )
    );

    // With nothing to send, auto has nothing to do that prefix does not, so it
    // should behave identically. Same table as the prefix section above.
    await replyModeCases({ REPLY_MODE: 'auto', AUTO_REPLY_TEXT: '' }, [
      ['/ai what is 2+2', 'what is 2+2'],
      ['/airplanes are loud', null],
      ['/ai', null],
      ['hello there', null],
    ]);
  });

  await section('the fixed reply does not interrupt a real one', async () => {
    const boot = () => {
      resetModules({
        REPLY_MODE: 'auto',
        AUTO_REPLY_TEXT: 'not at my phone',
        AI_PREFIX_MODE: 'never',
      });
      axiosStub = heldAxios();
      require(srcFile('bots', 'assistant.js'));
      const { run } = require(srcFile('lib', 'runner.js'));
      const started = run(capturedBot);
      return { client: lastClient, ollama: axiosStub, runtime: started && started.runtime };
    };

    const { client, ollama } = boot();
    await client.emit('message', { from: 'sam@lid', timestamp: now(), body: '/ai when is the train' });
    await settle();
    check('the command starts generating', () => assert.strictEqual(ollama.prompts.length, 1));

    await client.emit('message', { from: 'sam@lid', timestamp: now(), body: 'also thanks' });
    await settle();
    // Firing the fixed line here would drop "not at my phone" into the middle
    // of an answer being written for that same person, seconds before it lands.
    check('a plain message mid-answer sends nothing', () =>
      assert.deepStrictEqual(client.sent, [])
    );
    check('and does not scrap the answer being written', () =>
      assert.strictEqual(ollama.prompts.length, 1)
    );

    ollama.finish('quarter past six');
    await wait(20);
    check('the real answer still arrives', () =>
      assert.deepStrictEqual(
        client.sent.map((s) => s.body),
        ['quarter past six']
      )
    );
  });

  await section('commands the owner types from their own phone', async () => {
    // ready is what tells the runner which chat is its own.
    const boot = async (env = {}) => {
      const r = bootRunner(env);
      await r.client.emit('ready');
      r.client.sent.length = 0;
      return r;
    };

    const inbound = { from: 'sam@lid', to: 'me@c.us', timestamp: now(), body: 'hello' };

    const dup = await boot();
    await dup.client.emit('message_create', inbound);
    await dup.client.emit('message', inbound);
    await settle();
    // Both events fire for every message that arrives, message_create first.
    check('a message arriving on both events is handled once', () =>
      assert.strictEqual(dup.seen.length, 1)
    );

    const echo = await boot();
    await echo.deliver({ from: 'sam@lid', body: 'hi' });
    const ownId = { _serialized: 'sent-1' };
    await echo.command('/ai off', { id: ownId });
    check('the bot does not read its own outgoing message as a command', () =>
      assert.strictEqual(echo.runtime.mode, 'always')
    );

    const c = await boot();
    await c.command('/ai status');
    check('status answers in the same chat', () => {
      assert.strictEqual(c.client.sent.length, 1);
      assert.ok(c.client.sent[0].body.includes('mode always'));
    });
    check('status changes nothing', () => assert.strictEqual(c.runtime.mode, 'always'));

    await c.command('/ai off');
    await c.deliver({ from: 'sam@lid', body: 'anyone there' });
    check('off stops the model answering', () => {
      assert.strictEqual(c.runtime.mode, 'off');
      assert.strictEqual(c.seen.length, 0);
    });

    await c.command('/ai on');
    await c.deliver({ from: 'sam@lid', body: 'and now' });
    check('on puts the configured mode back', () => {
      assert.strictEqual(c.runtime.mode, 'always');
      assert.strictEqual(c.seen.length, 1);
    });

    await c.command('/ai away 2h in a meeting');
    check('away switches to the fixed reply without touching REPLY_MODE', () => {
      assert.strictEqual(c.runtime.effectiveMode(), 'auto');
      assert.strictEqual(c.runtime.mode, 'always');
      assert.strictEqual(c.runtime.awayText, 'in a meeting');
    });

    c.client.sent.length = 0;
    await c.deliver({ from: 'kim@lid', body: 'you free' });
    check('and the wording typed into the command is what goes out', () =>
      assert.deepStrictEqual(
        c.client.sent.map((s) => s.body),
        ['in a meeting']
      )
    );

    await c.command('/ai back');
    check('back returns to the configured mode', () => {
      assert.strictEqual(c.runtime.effectiveMode(), 'always');
      assert.strictEqual(c.runtime.awayText, '');
    });

    const stale = await boot();
    await stale.command('/ai off', { timestamp: now() - 300 });
    // Replayed history includes the owner's own messages. Without the backlog
    // filter covering this path, every restart would re-run old commands.
    check('a command replayed from the backlog is ignored', () =>
      assert.strictEqual(stale.runtime.mode, 'always')
    );

    const elsewhere = await boot();
    await elsewhere.command('/ai off', { to: 'sam@lid' });
    check('by default a command only counts in your own chat', () =>
      assert.strictEqual(elsewhere.runtime.mode, 'always')
    );

    const anywhere = await boot({ OWNER_COMMANDS: 'any' });
    await anywhere.command('/ai off', { to: 'sam@lid' });
    check('OWNER_COMMANDS=any accepts one from any one-to-one chat', () =>
      assert.strictEqual(anywhere.runtime.mode, 'off')
    );

    const grouped = await boot({ OWNER_COMMANDS: 'any', ALLOW_GROUPS: 'true' });
    await grouped.command('/ai off', { to: '123@g.us' });
    check('but never from a group, where the answer would be public', () =>
      assert.strictEqual(grouped.runtime.mode, 'always')
    );

    const disabled = await boot({ OWNER_COMMANDS: 'off' });
    await disabled.command('/ai off');
    check('OWNER_COMMANDS=off ignores them entirely', () =>
      assert.strictEqual(disabled.runtime.mode, 'always')
    );

    const quiet = await boot({ OWNER_COMMAND_ACK: 'false' });
    await quiet.command('/ai off');
    check('the acknowledgement can be switched off without losing the command', () => {
      assert.strictEqual(quiet.runtime.mode, 'off');
      assert.deepStrictEqual(quiet.client.sent, []);
    });

    const unknown = await boot();
    await unknown.command('/ai wibble');
    check('an unknown command says so rather than doing nothing', () =>
      assert.ok(unknown.client.sent[0].body.includes('Not a command'))
    );
  });

  await section('switching off stops a reply already being written', async () => {
    resetModules({ REPLY_MODE: 'always', AI_PREFIX_MODE: 'never' });
    axiosStub = heldAxios();
    require(srcFile('bots', 'assistant.js'));
    const { run } = require(srcFile('lib', 'runner.js'));
    const started = run(capturedBot);
    const client = lastClient;
    const ollama = axiosStub;
    await client.emit('ready');

    await client.emit('message', { from: 'sam@lid', timestamp: now(), body: 'you around' });
    await settle();
    check('the reply is under way', () => assert.strictEqual(ollama.prompts.length, 1));

    await client.emit('message_create', {
      fromMe: true,
      to: 'me@c.us',
      timestamp: now(),
      id: { _serialized: 'own-1' },
      body: '/ai off',
    });
    await wait(20);
    // Going quiet for new messages while still sending the ones already in
    // flight is not off, it is off in a minute.
    check('the answer in flight is dropped rather than finished', () =>
      assert.strictEqual(
        client.sent.filter((s) => s.to === 'sam@lid').length,
        0
      )
    );
    check('and it is not simply written again', () =>
      assert.strictEqual(ollama.prompts.length, 1)
    );
    check('the state says off', () =>
      assert.strictEqual(started && started.runtime.mode, 'off')
    );
  });

  await section('the shipped default, with nothing configured', async () => {
    const d = bootDefaults();
    await d.deliver({ body: 'you around this evening' });
    check('a plain message gets the fixed reply out of the box', () =>
      assert.strictEqual(d.client.sent.length, 1)
    );
    check('with no model in the path at all', () => assert.strictEqual(d.seen.length, 0));

    await d.deliver({ body: '/ai what time do you finish' });
    check('the command is what reaches the model', () =>
      assert.deepStrictEqual(
        d.seen.map((s) => s.text),
        ['what time do you finish']
      )
    );

    const back = bootDefaults({ REPLY_MODE: 'always' });
    await back.deliver({ body: 'plain message' });
    check('REPLY_MODE=always is the way back to the old behaviour', () =>
      assert.strictEqual(back.seen.length, 1)
    );
  });

  await section('an unrecognised REPLY_MODE falls back rather than failing', async () => {
    const { seen, client, deliver } = bootDefaults({ REPLY_MODE: 'nonsense' });
    await deliver({ body: 'plain message' });
    check('falls back to the default rather than refusing to start', () => {
      assert.strictEqual(seen.length, 0);
      assert.strictEqual(client.sent.length, 1);
    });
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
    const notice = 'automatic replies are paused for now';
    const { seen, deliver, client } = bootRunner({
      MAX_REPLIES_PER_HOUR: '3',
      RATE_LIMIT_NOTICE: notice,
    });
    for (let i = 0; i < 5; i += 1) await deliver({ body: `message ${i}` });
    check('replies stop at the cap', () => assert.strictEqual(seen.length, 3));
    check('the sender is told why, once, rather than left in silence', () =>
      assert.deepStrictEqual(
        client.sent.filter((m) => m.body === notice),
        [{ to: 'x@lid', body: notice }]
      )
    );
    check('the notice comes after the replies, not in front of them', () =>
      assert.strictEqual(client.sent[client.sent.length - 1].body, notice)
    );
    check('and nothing else is sent to the chat', () =>
      assert.strictEqual(client.sent.length, 4)
    );

    const silent = bootRunner({ MAX_REPLIES_PER_HOUR: '2', RATE_LIMIT_NOTICE: '' });
    for (let i = 0; i < 5; i += 1) await silent.deliver({ body: `m${i}` });
    check('an empty RATE_LIMIT_NOTICE goes back to saying nothing', () =>
      assert.strictEqual(silent.client.sent.length, 2)
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
      const limited = bootRunner({ MAX_REPLIES_PER_HOUR: '1', RATE_LIMIT_NOTICE: '' });
      for (let i = 0; i < 4; i += 1) await limited.deliver({ body: `m${i}` });
    });
    check('the breach is logged once, not per message', () =>
      assert.strictEqual(logs.filter((l) => l.includes('[limit]')).length, 1)
    );

    // Silence is the point of the cap, so the explanation cannot be the thing
    // that keeps a runaway conversation going.
    const loop = bootRunner({ MAX_REPLIES_PER_HOUR: '1' });
    for (let i = 0; i < 30; i += 1) await loop.deliver({ body: `m${i}` });
    check('a sender who keeps writing is told once and no more', () =>
      assert.strictEqual(loop.client.sent.length, 2)
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

  await section('a sender who corrects themselves', async () => {
    const boot = (env = {}) => {
      resetModules({ REPLY_MODE: 'always', ...env });
      axiosStub = heldAxios();
      require(srcFile('bots', 'assistant.js'));
      const { run } = require(srcFile('lib', 'runner.js'));
      const bot = capturedBot;
      run(bot);
      return { client: lastClient, ollama: axiosStub };
    };

    const send = async (client, body) => {
      await client.emit('message', { from: 'sam@lid', timestamp: now(), body });
      await settle();
    };

    const { client, ollama } = boot({ AI_PREFIX_MODE: 'never' });
    await send(client, 'hey jack are you up on tuesday');
    check('the first message starts generating straight away', () =>
      assert.strictEqual(ollama.prompts.length, 1)
    );

    await send(client, 'oh wait actually thursday');
    await settle();
    check('the second message scraps that attempt and starts another', () =>
      assert.strictEqual(ollama.prompts.length, 2)
    );
    check('nothing was sent for the message that was taken back', () =>
      assert.deepStrictEqual(client.sent, [])
    );
    check('the new attempt carries both messages', () => {
      const latest = ollama.prompts[1];
      assert.ok(latest.includes('tuesday') && latest.includes('thursday'), latest);
    });
    check('and carries them as one turn, not two', () =>
      assert.strictEqual((ollama.prompts[1].match(/^User:/gm) || []).length, 1)
    );

    ollama.finish('thursday is easier, i will pass it on');
    await settle();
    await settle();
    check('one reply covers the whole thing', () =>
      assert.deepStrictEqual(client.sent, [
        { to: 'sam@lid', body: 'thursday is easier, i will pass it on' },
      ])
    );

    // Two messages, one reply, so charging twice would empty the hourly
    // allowance at half the rate the setting says. With one reply allowed, a
    // charged correction is refused by the limiter and never amends anything.
    const tight = boot({ MAX_REPLIES_PER_HOUR: '1', AI_PREFIX_MODE: 'never' });
    await send(tight.client, 'are you up tuesday');
    await send(tight.client, 'sorry, thursday');
    await settle();
    check('the correction did not cost a slot against the hourly cap', () =>
      assert.strictEqual(tight.ollama.prompts.length, 2)
    );

    const capped = boot({ MAX_INTERRUPTS: '1', AI_PREFIX_MODE: 'never' });
    await send(capped.client, 'one');
    await send(capped.client, 'two');
    await settle();
    check('the cap allows the first correction', () =>
      assert.strictEqual(capped.ollama.prompts.length, 2)
    );
    await send(capped.client, 'three');
    await settle();
    check('and stops restarting once it is reached', () =>
      assert.strictEqual(capped.ollama.prompts.length, 2)
    );

    const off = boot({ MAX_INTERRUPTS: '0', AI_PREFIX_MODE: 'never' });
    await send(off.client, 'first');
    await send(off.client, 'second');
    await settle();
    check('MAX_INTERRUPTS=0 answers each message on its own, as before', () =>
      assert.strictEqual(off.ollama.prompts.length, 1)
    );
    off.ollama.finish('one');
    await settle();
    await settle();
    check('the queue then works through the second separately', () =>
      assert.strictEqual(off.ollama.prompts.length, 2)
    );

    // The abort has to be told apart from an unreachable model, or every
    // correction texts the person an error.
    resetModules({});
    axiosStub = heldAxios();
    const { generate, Aborted } = require(srcFile('lib', 'ollama.js'));
    // Bounded, because a build that ignores the signal leaves this pending for
    // ever. Node then empties its event loop and exits 0 with no tally printed,
    // which reads as a pass.
    const settleOrGiveUp = (promise) =>
      Promise.race([
        promise.then(() => 'resolved with no error', (err) => err),
        wait(250).then(() => 'still waiting, the signal was ignored'),
      ]);

    const controller = new AbortController();
    const pending = settleOrGiveUp(
      generate({ model: 'm', prompt: 'p', signal: controller.signal })
    );
    controller.abort();
    const thrown = await pending;
    check('an aborted generation throws Aborted, not a transport error', () =>
      assert.ok(Aborted && thrown instanceof Aborted, String(thrown))
    );

    const dead = new AbortController();
    dead.abort();
    const sentBefore = axiosStub.prompts.length;
    const early = await settleOrGiveUp(generate({ model: 'm', prompt: 'p', signal: dead.signal }));
    check('a signal aborted before the call never reaches the model', () => {
      assert.strictEqual(early?.name, 'Aborted', String(early));
      assert.strictEqual(axiosStub.prompts.length, sentBefore);
    });
  });

  await section('a reply that is called off', async () => {
    const boot = () => {
      resetModules({ REPLY_MODE: 'always', AI_PREFIX_MODE: 'never' });
      axiosStub = heldAxios();
      require(srcFile('bots', 'assistant.js'));
      const { run } = require(srcFile('lib', 'runner.js'));
      const started = run(capturedBot);
      return { client: lastClient, ollama: axiosStub, runtime: started && started.runtime };
    };

    const first = boot();
    check('the runner hands back the state it is working from', () =>
      assert.ok(first.runtime && first.runtime.writing instanceof Map)
    );

    await first.client.emit('message', { from: 'sam@lid', timestamp: now(), body: 'you around' });
    await settle();
    check('the reply starts being written', () =>
      assert.strictEqual(first.ollama.prompts.length, 1)
    );

    // Guarded rather than called straight: against a source that returns a bare
    // client this is undefined, and throwing here would take the whole
    // differential run down instead of failing one check.
    const stopped = first.runtime
      ? first.runtime.cancel('sam@lid', 'called off')
      : 'the runner returned no state';
    await wait(20);
    check('cancelling reports that there was something to stop', () =>
      assert.strictEqual(stopped, true)
    );
    // The bug this guards. answer() loops on any abort, so a cancellation with
    // no new text to add used to regenerate the same reply immediately, and
    // forever, because every attempt was aborted the same way.
    check('the abandoned reply is not written again', () =>
      assert.strictEqual(first.ollama.prompts.length, 1)
    );
    check('nothing reaches the sender', () => assert.deepStrictEqual(first.client.sent, []));
    check('the conversation is no longer being written for', () =>
      assert.strictEqual(first.runtime && first.runtime.writing.has('sam@lid'), false)
    );
    check('cancelling a conversation with nothing in flight changes nothing', () =>
      assert.strictEqual(first.runtime && first.runtime.cancel('nobody@lid', 'off'), false)
    );

    // Set directly rather than through cancel(), because this is the race
    // cancel() cannot produce: the reply finished generating in the moment
    // between the decision to drop it and the abort landing, so aborting the
    // finished request did nothing and only the flag is left to catch it.
    const second = boot();
    await second.client.emit('message', { from: 'kim@lid', timestamp: now(), body: 'hello' });
    await settle();
    const live = second.runtime && second.runtime.writing.get('kim@lid');
    if (live) live.cancelled = 'called off';
    second.ollama.finish('too late');
    await wait(20);
    check('a reply that finished just as it was dropped is still not sent', () =>
      assert.deepStrictEqual(second.client.sent, [])
    );
  });

  await section('bundled prompts', async () => {
    const dir = path.join(REPO, 'prompts');
    const strip = (f) => fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();

    // Read defensively. A repo without the directory should fail this check and
    // let the rest of the suite run, rather than throwing out of main().
    let scenarios = [];
    let listing = null;
    try {
      scenarios = fs.readdirSync(path.join(dir, 'scenarios')).filter((f) => f.endsWith('.md'));
    } catch (err) {
      listing = err.message;
    }

    check('there are scenarios to choose from', () => {
      assert.ok(!listing, listing);
      assert.ok(scenarios.length >= 5, `found ${scenarios.length}`);
    });

    let templates = 0;
    for (const name of scenarios) {
      const text = strip(path.join(dir, 'scenarios', name));
      // A file that is all comment strips to nothing, and loadSystemPrompt would
      // fall through to the default without saying why.
      check(`${name} survives comment stripping`, () => assert.ok(text.length > 100, name));

      // Personas name nobody and need nothing filled in. Templates do, and a
      // real name in one means somebody's details were committed by accident.
      check(`${name} names no one`, () => assert.ok(!/\bJack\b/.test(text), name));
      if (/\[[^\]]+\]/.test(text)) templates += 1;
    }

    check('the templates still carry placeholders to fill in', () =>
      assert.ok(templates >= 5, `only ${templates} of ${scenarios.length}`)
    );

    // The live one is filled in, so an unreplaced placeholder here is the
    // failure the README warns about: texting people the words "[your name]".
    const live = strip(path.join(dir, 'assistant.md'));
    check('assistant.md has no placeholders left in it', () => {
      const found = live.match(/\[[^\]]+\]/g);
      assert.ok(!found, JSON.stringify(found));
    });
    check('assistant.md is not empty after stripping', () => assert.ok(live.length > 100));
    check('summary.md is not empty after stripping', () =>
      assert.ok(strip(path.join(dir, 'summary.md')).length > 100)
    );
  });

  await section('thinking models', async () => {
    const generateWith = async (env, response) => {
      resetModules(env);
      axiosStub = makeAxios(ollamaReplies(response));
      const { generate } = require(srcFile('lib', 'ollama.js'));
      const text = await generate({ model: 'm', prompt: 'p' });
      return { text, body: axiosStub.posts()[0].body };
    };

    const unset = await generateWith({}, 'hello');
    check('OLLAMA_THINK unset leaves the field off the request entirely', () =>
      assert.ok(!('think' in unset.body), JSON.stringify(unset.body))
    );

    const off = await generateWith({ OLLAMA_THINK: 'false' }, 'hello');
    check('OLLAMA_THINK=false asks the model not to think', () =>
      assert.strictEqual(off.body.think, false)
    );

    const on = await generateWith({ OLLAMA_THINK: 'true' }, 'hello');
    check('OLLAMA_THINK=true asks for it', () => assert.strictEqual(on.body.think, true));

    // Reasoning belongs in Ollama's own field. These are the shapes seen when a
    // template puts it in the reply instead, which is what gets texted out.
    for (const [label, raw, expected] of [
      ['a closed block', '<think>they want a time</think>Not sure, I will ask.', 'Not sure, I will ask.'],
      ['an unclosed block, cut off by a stop sequence', 'Sure.<think>although actually', 'Sure.'],
      ['a template that primed the opening tag', 'weighing it up</think>Sounds good.', 'Sounds good.'],
      ['more than one block', '<think>a</think>One.<think>b</think> Two.', 'One. Two.'],
      ['mixed case tags', '<THINK>hmm</Think>Fine by me.', 'Fine by me.'],
      ['nothing to strip', 'Just a reply.', 'Just a reply.'],
    ]) {
      const got = await generateWith({}, raw);
      check(`reasoning stripped: ${label}`, () => assert.strictEqual(got.text, expected));
    }

    // Stripping can empty a reply that was nothing but reasoning, and an empty
    // string is not something WhatsApp will send.
    const logs = await capturingLogs(async () => {
      resetModules({});
      axiosStub = makeAxios(ollamaReplies('<think>no idea what they mean</think>'));
      require(srcFile('bots', 'assistant.js'));
      const reply = await capturedBot.handle('c1', 'you around?', { isSim: true, from: null });
      check('a reply that was all reasoning falls back rather than going out empty', () =>
        assert.ok(/did not manage an answer/.test(reply), JSON.stringify(reply))
      );
    });
    check('and the empty reply is logged', () =>
      assert.ok(logs.some((l) => l.includes('empty reply')), JSON.stringify(logs))
    );
  });

  await section('contact ID capture', async () => {
    const lines = await capturingLogs(async () => {
      const { seen, deliver } = bootRunner({ CAPTURE_IDS: 'true' });

      await deliver({ from: '183765432109876@lid', body: 'hi' });
      await deliver({ from: '183765432109876@lid', body: 'still here' });
      await deliver({ from: '274839201847362@lid', body: 'hello' });

      check('capture mode answers nobody', () => assert.strictEqual(seen.length, 0));
    });

    const captured = lines.filter((l) => l.startsWith('[capture]'));
    check('the sender ID is logged', () =>
      assert.ok(
        captured.some((l) => l.startsWith('[capture] 183765432109876@lid')),
        JSON.stringify(lines)
      )
    );
    check('a second sender is logged too', () =>
      assert.ok(captured.some((l) => l.startsWith('[capture] 274839201847362@lid')))
    );
    check('the same sender writing again is not logged twice', () =>
      assert.strictEqual(captured.length, 2, JSON.stringify(captured))
    );

    // Now that the numbers resolve themselves, there is nothing to paste and
    // the only question left is why somebody is being ignored. So capture says
    // whether the ID matched, which is the answer.
    const withList = await capturingLogs(async () => {
      const { seen, deliver } = bootRunner({
        CAPTURE_IDS: 'true',
        ALLOWED_CONTACTS: 'guessed@c.us,183765432109876@lid',
      });
      await deliver({ from: '183765432109876@lid', body: 'hi' });
      await deliver({ from: '274839201847362@lid', body: 'hello' });
      check('an allowlist set does not stop the capture', () =>
        assert.strictEqual(seen.length, 0)
      );
    });
    check('a sender on the allowlist is logged as allowed', () =>
      assert.ok(withList.includes('[capture] 183765432109876@lid allowed'), JSON.stringify(withList))
    );
    check('a sender missing from it is logged, and says so', () =>
      assert.ok(withList.includes('[capture] 274839201847362@lid not allowed'))
    );

    const groups = await capturingLogs(async () => {
      const { deliver } = bootRunner({ CAPTURE_IDS: 'true' });
      await deliver({ from: '1234@g.us', body: 'hi' });
      await deliver({ from: '1234@broadcast', body: 'hi' });
    });
    check('groups and broadcasts are not captured unless ALLOW_GROUPS is on', () =>
      assert.deepStrictEqual(groups.filter((l) => l.startsWith('[capture]')), [])
    );

    const startup = await capturingLogs(async () => {
      const { client } = bootRunner({ CAPTURE_IDS: 'true' });
      await client.emit('ready');
    });
    check('startup says capture mode is on', () =>
      assert.ok(startup.some((l) => l.startsWith('[capture] on,')), JSON.stringify(startup))
    );
    check('capture mode does not also warn about the open allowlist', () =>
      assert.ok(!startup.some((l) => l.includes('[access]')))
    );

    const { seen: after, deliver: deliverAfter } = bootRunner({ CAPTURE_IDS: 'false' });
    await deliverAfter({ from: '183765432109876@lid', body: 'hi' });
    check('turning capture off restores replies', () => assert.strictEqual(after.length, 1));
  });

  await section('phone numbers resolved to WhatsApp IDs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatllama-ids-'));
    let n = 0;
    const cacheFile = () => path.join(dir, `cache-${++n}.json`);

    // Sets the lookup table up before ready, which is when resolution runs.
    const boot = async (env, lookups) => {
      const r = bootRunner({ CONTACT_RESOLVE_DELAY_MS: '0', ...env });
      r.client.lidLookups = lookups;
      await r.client.emit('ready');
      return r;
    };

    const LID = '183765432109876@lid';

    const a = await boot(
      { ALLOWED_CONTACTS: '447700900123', CONTACT_CACHE_FILE: cacheFile() },
      { '447700900123@c.us': { lid: LID, pn: '447700900123@c.us' } }
    );
    await a.deliver({ from: LID, body: 'hello' });
    check('a bare phone number matches the ID it resolves to', () =>
      assert.strictEqual(a.seen.length, 1)
    );

    await a.deliver({ from: '999999999999@lid', body: 'hello' });
    check('and nobody else gets in', () => assert.strictEqual(a.seen.length, 1));

    check('the number is looked up one at a time', () =>
      // The library wraps the batch in a single Promise.all inside the page, so
      // one bad entry in an array would reject the whole call.
      assert.ok(a.client.lidCalls.every((ids) => ids.length === 1), JSON.stringify(a.client.lidCalls))
    );

    const b = await boot(
      { ALLOWED_CONTACTS: '447700900123', CONTACT_CACHE_FILE: cacheFile() },
      { '447700900123@c.us': { lid: LID, pn: '447700900123@c.us' } }
    );
    await b.deliver({ from: '447700900123@c.us', body: 'hello' });
    check('the phone-number form still matches, for contacts not yet migrated', () =>
      assert.strictEqual(b.seen.length, 1)
    );

    const c = await boot(
      { ALLOWED_CONTACTS: `${LID},447700900123`, CONTACT_CACHE_FILE: cacheFile() },
      { '447700900123@c.us': { lid: '2222@lid' } }
    );
    check('an entry that is already an ID is never sent for lookup', () =>
      assert.deepStrictEqual(c.client.lidCalls, [['447700900123@c.us']])
    );
    await c.deliver({ from: LID, body: 'hello' });
    check('and is matched as written', () => assert.strictEqual(c.seen.length, 1));

    // enforceLidAndPnRetrieval returns {} when the number is not on WhatsApp,
    // so a call that succeeded can still carry nothing.
    const empty = await capturingLogs(async () => {
      const d = await boot(
        { ALLOWED_CONTACTS: '447700900123,447700900999', CONTACT_CACHE_FILE: cacheFile() },
        { '447700900123@c.us': { lid: LID } }
      );
      await d.deliver({ from: LID, body: 'hello' });
      await d.deliver({ from: '999999999999@lid', body: 'hello' });
      check('one number failing does not lock out the ones that worked', () =>
        assert.strictEqual(d.seen.length, 1)
      );
    });
    check('the number that could not be resolved is named at startup', () =>
      assert.ok(empty.some((l) => l.includes('447700900999')), JSON.stringify(empty))
    );

    const thrown = await capturingLogs(async () => {
      const e = await boot({ ALLOWED_CONTACTS: '447700900123', CONTACT_CACHE_FILE: cacheFile() }, () => {
        throw new Error('page closed');
      });
      await e.deliver({ from: LID, body: 'hello' });
      // The failure that matters. A broken lookup must never be read as an
      // empty allowlist, which is the one that answers everybody.
      check('a lookup that throws answers nobody rather than everybody', () =>
        assert.strictEqual(e.seen.length, 0)
      );
    });
    check('the failure is logged rather than swallowed', () =>
      assert.ok(thrown.some((l) => l.includes('[contacts]')))
    );

    const shared = cacheFile();
    const warm1 = await boot(
      { ALLOWED_CONTACTS: '447700900123', CONTACT_CACHE_FILE: shared },
      { '447700900123@c.us': { lid: LID } }
    );
    check('the resolved ID is written to the cache', () =>
      assert.ok(fs.readFileSync(shared, 'utf8').includes(LID))
    );

    const warm2 = await boot({ ALLOWED_CONTACTS: '447700900123', CONTACT_CACHE_FILE: shared }, {});
    check('a warm cache means no lookup at all next time', () =>
      assert.deepStrictEqual(warm2.client.lidCalls, [])
    );
    await warm2.deliver({ from: LID, body: 'hello' });
    check('and the cached ID still matches', () => assert.strictEqual(warm2.seen.length, 1));

    // Backdated so the entry is stale and gets refreshed, but the refresh
    // fails. Expiring it there would silence a contact that has worked for
    // weeks because of one rate-limited lookup.
    // Guarded, because a source that writes no cache leaves nothing to open and
    // throwing here would take the whole differential run down. The two checks
    // below then fail on their own, which is the point of running it.
    try {
      const stale = JSON.parse(fs.readFileSync(shared, 'utf8'));
      stale.entries['447700900123'].at = 0;
      fs.writeFileSync(shared, JSON.stringify(stale));
    } catch {
      // Nothing cached to backdate.
    }

    const refreshed = await boot(
      { ALLOWED_CONTACTS: '447700900123', CONTACT_CACHE_FILE: shared },
      {}
    );
    check('a stale entry is retried', () =>
      assert.strictEqual(refreshed.client.lidCalls.length, 1)
    );
    await refreshed.deliver({ from: LID, body: 'hello' });
    check('but a failed refresh never throws away what already worked', () =>
      assert.strictEqual(refreshed.seen.length, 1)
    );

    const open = await boot({ CONTACT_CACHE_FILE: cacheFile() }, {});
    await open.deliver({ from: 'anyone@lid', body: 'hello' });
    check('an empty ALLOWED_CONTACTS still lets anyone write in', () =>
      assert.strictEqual(open.seen.length, 1)
    );
    check('and looks nothing up', () => assert.deepStrictEqual(open.client.lidCalls, []));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await section('the send endpoint', async () => {
    const KEY = 'test-key-0123456789abcdef';
    const HASH = crypto.createHash('sha512').update(KEY).digest('hex');

    const boot = async (env = {}) => {
      const r = bootRunner({
        SEND_API_PORT: '0',
        SEND_API_KEY_SHA512: HASH,
        ALLOWED_CONTACTS: 'sam@lid',
        ...env,
      });
      await r.client.emit('ready');
      return r;
    };

    const call = (port, { method = 'POST', route = '/send', key = KEY, body = {} } = {}) =>
      new Promise((resolve, reject) => {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method,
            path: route,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              ...(key ? { 'x-api-key': key } : {}),
            },
          },
          (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, text }));
          }
        );
        req.on('error', reject);
        req.end(payload);
      });

    /**
     * Closes the listener whatever happens. main() sets process.exitCode rather
     * than calling process.exit, so one socket left open would hang the suite
     * for ever instead of failing it.
     */
    const withServer = async (r, label, fn) => {
      if (!r.server) {
        check(label, () => assert.fail('the endpoint did not start'));
        return;
      }
      try {
        const port = await new Promise((resolve, reject) => {
          if (r.server.listening) return resolve(r.server.address().port);
          r.server.once('listening', () => resolve(r.server.address().port));
          r.server.once('error', reject);
        });
        await fn(port);
      } finally {
        await new Promise((res) => r.server.close(res));
      }
    };

    const happy = await boot();
    await withServer(happy, 'a correct key is accepted', async (port) => {
      const res = await call(port, { body: { to: 'sam@lid', text: 'yes, 11 works' } });
      await settle();
      check('a correct key is accepted', () => assert.strictEqual(res.status, 202));
      // 202 rather than 200: waiting for the queue would hold the request open
      // behind whatever generation is already running.
      check('the message goes out', () =>
        assert.deepStrictEqual(happy.client.sent, [{ to: 'sam@lid', body: 'yes, 11 works' }])
      );
    });

    const guarded = await boot();
    await withServer(guarded, 'the key is checked', async (port) => {
      const wrong = await call(port, { key: 'not-the-key', body: { to: 'sam@lid', text: 'hi' } });
      const missing = await call(port, { key: null, body: { to: 'sam@lid', text: 'hi' } });
      const short = await call(port, { key: 'zz', body: { to: 'sam@lid', text: 'hi' } });
      await settle();
      check('a wrong key is refused', () => assert.strictEqual(wrong.status, 401));
      check('no key at all is refused', () => assert.strictEqual(missing.status, 401));
      // Malformed hex decodes short, and comparing lengths first is what stops
      // timingSafeEqual throwing on it.
      check('a key that is not even hex-length is refused, not a crash', () =>
        assert.strictEqual(short.status, 401)
      );
      check('and nothing was sent to anyone', () =>
        assert.deepStrictEqual(guarded.client.sent, [])
      );
    });

    const shaped = await boot();
    await withServer(shaped, 'the request shape is checked', async (port) => {
      const get = await call(port, { method: 'GET' });
      const elsewhere = await call(port, { route: '/anything' });
      const notJson = await call(port, { body: 'this is not json' });
      const noText = await call(port, { body: { to: 'sam@lid' } });
      const blank = await call(port, { body: { to: 'sam@lid', text: '   ' } });
      check('GET is refused', () => assert.strictEqual(get.status, 405));
      check('another path is not found', () => assert.strictEqual(elsewhere.status, 404));
      check('a body that is not JSON is refused', () => assert.strictEqual(notJson.status, 400));
      check('a missing text is refused', () => assert.strictEqual(noText.status, 400));
      check('so is an empty one', () => assert.strictEqual(blank.status, 400));
    });

    const strangers = await boot();
    await withServer(strangers, 'recipients are restricted', async (port) => {
      const res = await call(port, { body: { to: 'stranger@lid', text: 'hello' } });
      await settle();
      // Without this, a leaked key can message anybody at all from your number
      // rather than only the people the bot already talks to.
      check('a recipient not on the allowlist is refused', () =>
        assert.strictEqual(res.status, 403)
      );
      check('and nothing reaches them', () =>
        assert.deepStrictEqual(strangers.client.sent, [])
      );
    });

    const anyone = await boot({ SEND_API_ALLOW_ANY: 'true' });
    await withServer(anyone, 'the restriction can be lifted', async (port) => {
      const res = await call(port, { body: { to: 'stranger@lid', text: 'hello' } });
      await settle();
      check('SEND_API_ALLOW_ANY lifts the restriction deliberately', () =>
        assert.strictEqual(res.status, 202)
      );
    });

    const capped = await boot({ SEND_API_MAX_PER_MINUTE: '2' });
    await withServer(capped, 'the endpoint is rate limited', async (port) => {
      const body = { to: 'sam@lid', text: 'hi' };
      await call(port, { body });
      await call(port, { body });
      const third = await call(port, { body });
      await settle();
      check('the endpoint has its own ceiling', () => assert.strictEqual(third.status, 429));
      // The per-chat limiter would have texted the contact the rate-limit
      // notice, which is nothing to do with them.
      check('and hitting it does not text the contact anything', () =>
        assert.strictEqual(capped.client.sent.length, 2)
      );
    });

    const big = await boot();
    await withServer(big, 'oversized bodies are refused', async (port) => {
      const res = await call(port, {
        body: JSON.stringify({ to: 'sam@lid', text: 'x'.repeat(200 * 1024) }),
      });
      check('a body over the cap is refused rather than buffered', () =>
        assert.strictEqual(res.status, 413)
      );
    });

    const noKey = await capturingLogs(async () => {
      const r = bootRunner({ SEND_API_PORT: '0', SEND_API_KEY_SHA512: '' });
      await r.client.emit('ready');
      // A send endpoint reachable with no credential is a spam relay wired to a
      // real phone number, so refusing to start is the only safe reading.
      check('a port with no key does not start the endpoint at all', () =>
        assert.strictEqual(r.server, null)
      );
    });
    check('and says why', () =>
      assert.ok(noKey.some((l) => l.includes('SEND_API_KEY_SHA512')), JSON.stringify(noKey))
    );

    const off = bootRunner({});
    check('no port means no listener', () => assert.strictEqual(off.server, null));
  });

  await section('an approved reply replaces the one being written', async () => {
    const KEY = 'test-key-0123456789abcdef';
    resetModules({
      REPLY_MODE: 'always',
      AI_PREFIX_MODE: 'never',
      SEND_API_PORT: '0',
      SEND_API_KEY_SHA512: crypto.createHash('sha512').update(KEY).digest('hex'),
    });
    axiosStub = heldAxios();
    require(srcFile('bots', 'assistant.js'));
    const { run } = require(srcFile('lib', 'runner.js'));
    const started = run(capturedBot);
    const client = lastClient;
    const ollama = axiosStub;

    if (!started || !started.server) {
      check('the endpoint started', () => assert.fail('no server was created'));
    } else {
      try {
        const port = await new Promise((resolve) => {
          if (started.server.listening) return resolve(started.server.address().port);
          started.server.once('listening', () => resolve(started.server.address().port));
        });

        await client.emit('message', { from: 'sam@lid', timestamp: now(), body: 'you free sat' });
        await settle();
        check('the model is writing a reply', () => assert.strictEqual(ollama.prompts.length, 1));

        await new Promise((resolve, reject) => {
          const payload = JSON.stringify({ to: 'sam@lid', text: 'yeah 11 works, book it' });
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              method: 'POST',
              path: '/send',
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                'x-api-key': KEY,
              },
            },
            (res) => {
              res.resume();
              res.on('end', resolve);
            }
          );
          req.on('error', reject);
          req.end(payload);
        });
        await wait(20);

        check('the reply you approved is what gets sent', () =>
          assert.deepStrictEqual(
            client.sent.map((s) => s.body),
            ['yeah 11 works, book it']
          )
        );
        check('and the one being written is dropped, not queued behind it', () =>
          assert.strictEqual(ollama.prompts.length, 1)
        );
      } finally {
        await new Promise((res) => started.server.close(res));
      }
    }
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
            ? JSON.stringify({
                urgency: 'today',
                wants: 'Sam wants to climb on Saturday and the booking is still yours to make.',
                deadline: '',
                draft_reply: 'Saturday works for me.',
              })
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

  await section('structured briefings', async () => {
    // Runs one exchange, lets the conversation go idle, and hands back the
    // briefing request and the notification it produced.
    async function briefingFor(env, response) {
      resetModules({
        N8N_WEBHOOK_URL: 'http://stub-n8n/webhook/test',
        WEBHOOK_IN_SIM: 'true',
        SUMMARY_IDLE_MINUTES: '0.004',
        ...env,
      });
      const sent = [];
      axiosStub = makeAxios({
        '/api/generate': async (body) => ({
          data: { response: body.prompt.includes('Briefing:') ? response : 'Sounds good.' },
        }),
        'stub-n8n': async (body) => {
          sent.push(body);
          return { status: 200 };
        },
      });
      require(srcFile('bots', 'assistant.js'));
      await capturedBot.handle('c1', 'sam asked about the deposit', { isSim: true, from: null });
      await wait(500);
      return {
        summary: sent.find((s) => s.event === 'conversation_summary'),
        request: axiosStub.posts().find((p) => p.body?.prompt?.includes('Briefing:')).body,
      };
    }

    const good = JSON.stringify({
      urgency: 'now',
      wants: 'Sam needs the deposit paid.',
      deadline: 'Friday',
      draft_reply: 'I will pay it tonight.',
    });

    let r = await briefingFor({}, good);
    check('the briefing request carries the schema', () => assert.ok(r.request.format));
    check('no stop sequences travel with a structured request', () =>
      assert.strictEqual(r.request.options.stop, undefined)
    );
    check('the fields reach the webhook', () => {
      assert.strictEqual(r.summary.triage.urgency, 'now');
      assert.strictEqual(r.summary.triage.draftReply, 'I will pay it tonight.');
    });
    check('summary stays a readable string alongside them', () =>
      assert.ok(r.summary.summary.includes('deposit'))
    );

    r = await briefingFor({}, `Here you go:\n\`\`\`json\n${good}\n\`\`\``);
    check('an object wrapped in prose is still read', () =>
      assert.strictEqual(r.summary.triage.urgency, 'now')
    );

    r = await briefingFor(
      {},
      JSON.stringify({ urgency: 'IMMEDIATELY', wants: 'x', deadline: '', draft_reply: '' })
    );
    check('an urgency the model invented is coerced to one n8n can route', () =>
      assert.strictEqual(r.summary.triage.urgency, 'whenever')
    );

    let bad;
    const logs = await capturingLogs(async () => {
      bad = await briefingFor({}, 'not json at all, just a sentence about the booking');
    });
    check('a briefing that is not JSON still reaches the webhook', () =>
      assert.ok(bad.summary.summary.includes('booking'))
    );
    check('and reports no fields rather than pretending it parsed', () => {
      assert.strictEqual(bad.summary.triage, null);
      assert.ok(logs.some((l) => l.includes('did not come back as JSON')));
    });

    r = await briefingFor({ SUMMARY_FORMAT: 'prose' }, 'Sam wants the deposit paid by Friday.');
    check('prose mode sends no schema and keeps its stop sequences', () => {
      assert.strictEqual(r.request.format, undefined);
      assert.ok(r.request.options.stop.includes('User:'));
    });
    check('prose mode reports no fields at all', () =>
      assert.strictEqual(r.summary.triage, null)
    );

    r = await briefingFor({ SUMMARY_MODEL: 'bigger:70b' }, good);
    check('SUMMARY_MODEL changes the briefing model and nothing else', () => {
      assert.strictEqual(r.request.model, 'bigger:70b');
      const reply = axiosStub
        .posts()
        .find((p) => p.body?.prompt && !p.body.prompt.includes('Briefing:'));
      assert.strictEqual(reply.body.model, 'llama3.1:8b');
    });
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
