const fs = require('fs');
const path = require('path');

const { access, assistant, summary, settings: settingsCfg } = require('../config');

/**
 * The settings that can be changed while the bot is running.
 *
 * Everything here has a value in the environment, and this is a layer on top of
 * it rather than a replacement for it: nothing is stored until it is changed, a
 * setting that has never been touched reads straight through to `.env`, and
 * clearing one puts it back. That ordering is what stops this file becoming a
 * second, silent copy of the configuration that nobody remembers is there.
 *
 * Only settings worth changing from a phone are here. Anything that decides how
 * the process is wired up, rather than how it behaves, is deliberately absent:
 * ports, the API key digest, the webhook URL and the send endpoint's own limits
 * cannot be moved by a command, because a command arriving over one of them
 * should never be able to reconfigure the thing that let it in.
 */

// Read at use time rather than captured, so the fallback is whatever config
// holds now and the two cannot drift apart.
const FIELDS = {
  model: {
    kind: 'text',
    base: () => assistant.model,
    describe: 'model used for replies, e.g. llama3.1:8b',
  },
  summary_model: {
    kind: 'text',
    base: () => summary.model,
    allowEmpty: true,
    describe: 'model used for briefings, empty uses the reply model',
  },
  prompt: {
    kind: 'text',
    base: () => '',
    allowEmpty: true,
    multiline: true,
    describe: 'the persona, replacing the prompt file while it is set',
  },
  auto_reply: {
    kind: 'text',
    base: () => access.autoReplyText,
    allowEmpty: true,
    multiline: true,
    describe: 'the fixed reply in auto mode',
  },
  media_notice: {
    kind: 'text',
    base: () => access.mediaNotice,
    allowEmpty: true,
    multiline: true,
    describe: 'added when somebody sends an attachment, {what} becoming "voice notes"',
  },
  gap: {
    kind: 'minutes',
    base: () => access.autoReplyGapMinutes,
    describe: 'silence before the same person gets the fixed reply again',
  },
  follow_up: {
    kind: 'minutes',
    base: () => access.followUpMinutes,
    describe: 'how long a conversation keeps reaching the model without the prefix',
  },
  handover: {
    kind: 'minutes',
    base: () => access.handoverMinutes,
    describe: 'how long the bot keeps out after you answer somebody yourself',
  },
  max_per_day: {
    kind: 'count',
    base: () => access.autoReplyMaxPerDay,
    describe: 'fixed replies per contact per day, 0 removes the cap',
  },
  summary_idle: {
    kind: 'minutes',
    base: () => summary.idleMinutes,
    describe: 'silence before a conversation is briefed, 0 disables briefings',
  },
  quiet: {
    kind: 'window',
    base: () => access.quietHours,
    allowEmpty: true,
    describe: 'hours to behave as though away, e.g. 22:00-08:00, empty for none',
  },
  quiet_mode: {
    kind: 'choice',
    of: ['auto', 'off'],
    base: () => access.quietMode,
    describe: 'what quiet hours do: auto for the fixed reply, off for silence',
  },
  contacts: {
    kind: 'list',
    base: () => access.allowedContacts,
    allowEmpty: true,
    describe: 'phone numbers allowed to write in, empty allows anyone',
  },
};

const NAMES = Object.keys(FIELDS).sort();

/** "22:00-08:00" as minutes past midnight, or null if it is not a window. */
function parseWindow(raw) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!match) return null;

  const [fromH, fromM, toH, toM] = match.slice(1).map(Number);
  if (fromH > 23 || toH > 23 || fromM > 59 || toM > 59) return null;

  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  // Equal ends would be either no time at all or the whole day, and which of
  // those somebody meant is not something to guess at.
  if (from === to) return null;
  return { from, to };
}

/**
 * Whether the clock is inside a window, which may run past midnight.
 *
 * Local time, deliberately. The owner sets this from their own phone thinking
 * in their own hours, and the box is theirs.
 */
function insideWindow(window, at = new Date()) {
  const parsed = typeof window === 'string' ? parseWindow(window) : window;
  if (!parsed) return false;

  const minutes = at.getHours() * 60 + at.getMinutes();
  // Wrapping is the normal case here: quiet hours are usually overnight.
  return parsed.from < parsed.to
    ? minutes >= parsed.from && minutes < parsed.to
    : minutes >= parsed.from || minutes < parsed.to;
}

const PARSE = {
  text: (raw, field) => {
    const value = field.multiline ? String(raw) : String(raw).trim();
    if (!value && !field.allowEmpty) return { error: 'needs a value' };
    return { value };
  },
  minutes: (raw) => {
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || n < 0) return { error: 'needs a number of minutes, 0 or more' };
    return { value: n };
  },
  count: (raw) => {
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n < 0) return { error: 'needs a whole number, 0 or more' };
    return { value: n };
  },
  choice: (raw, field) => {
    const value = String(raw).trim().toLowerCase();
    if (!field.of.includes(value)) return { error: `has to be one of ${field.of.join(', ')}` };
    return { value };
  },
  window: (raw, field) => {
    const value = String(raw).trim();
    if (!value) {
      if (!field.allowEmpty) return { error: 'needs a window' };
      return { value: '' };
    }
    if (!parseWindow(value)) {
      return { error: 'needs two 24-hour times, like 22:00-08:00' };
    }
    return { value };
  },
  list: (raw) => ({
    value: String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }),
};

class Settings {
  /**
   * @param {object} opts
   * @param {string} opts.file  Where overrides are kept. Empty keeps them in
   *   memory only, which is what the simulation uses so that a rehearsal cannot
   *   change what the running bot does.
   * @param {function} opts.onChange Called with (name, value) after a change
   *   lands, for anything that has to be pushed into a live object rather than
   *   read on demand.
   */
  constructor({ file = '', onChange = null } = {}) {
    this.file = file;
    this.onChange = onChange;
    this.overrides = this.read();
  }

  read() {
    if (!this.file) return {};
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const saved = (data && data.settings) || {};
      // Filtered on the way in, so a field removed in a later version does not
      // sit in the file forever being reported by "status" as though it applied.
      return Object.fromEntries(Object.entries(saved).filter(([name]) => FIELDS[name]));
    } catch {
      return {};
    }
  }

  write() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify(
          { version: 1, settings: this.overrides, savedAt: new Date().toISOString() },
          null,
          2
        )
      );
    } catch (err) {
      console.warn('[settings] could not be saved:', err.message);
    }
  }

  /** The value in force: what was set, or what the environment says. */
  get(name) {
    const field = FIELDS[name];
    if (!field) return undefined;
    return name in this.overrides ? this.overrides[name] : field.base();
  }

  /** Whether this one has been changed away from what `.env` says. */
  changed(name) {
    return name in this.overrides;
  }

  /** Every setting that has been changed, for reporting at startup. */
  get changedNames() {
    return Object.keys(this.overrides).sort();
  }

  /**
   * Validates and stores one setting. Returns what to say back either way, so
   * that a command typed on a phone and one arriving over HTTP answer the same.
   */
  set(name, raw) {
    const field = FIELDS[name];
    if (!field) {
      return { ok: false, reply: `"${name}" is not a setting. Try: ${NAMES.join(', ')}.` };
    }

    const { value, error } = PARSE[field.kind](raw, field);
    if (error) return { ok: false, reply: `${name} ${error}.` };

    this.overrides[name] = value;
    this.write();
    if (this.onChange) this.onChange(name, value);

    return { ok: true, reply: `${name} is now ${this.describe(name)}.`, value };
  }

  /**
   * Puts one setting, or all of them, back to what the environment says.
   *
   * The way out of a bad value typed from a phone, and the reason a change is
   * stored as an override rather than written over the configuration.
   */
  clear(name) {
    if (name === 'all') {
      const had = Object.keys(this.overrides).length;
      this.overrides = {};
      this.write();
      if (this.onChange) for (const known of NAMES) this.onChange(known, this.get(known));
      return { ok: true, reply: `Cleared ${had} setting(s). Back to what .env says.` };
    }

    if (!FIELDS[name]) {
      return { ok: false, reply: `"${name}" is not a setting. Try: ${NAMES.join(', ')}.` };
    }
    if (!(name in this.overrides)) {
      return { ok: true, reply: `${name} was already ${this.describe(name)}, from .env.` };
    }

    delete this.overrides[name];
    this.write();
    if (this.onChange) this.onChange(name, this.get(name));
    return { ok: true, reply: `${name} is back to ${this.describe(name)}, from .env.` };
  }

  /** One value, short enough to read on a phone. */
  describe(name) {
    const value = this.get(name);
    if (Array.isArray(value)) return value.length ? `${value.length} contact(s)` : 'anyone';
    if (value === '' || value === undefined || value === null) return 'empty';
    if (typeof value === 'number') return String(value);

    const text = String(value).replace(/\s+/g, ' ');
    return text.length > 50 ? `"${text.slice(0, 47)}..."` : `"${text}"`;
  }

  /** Everything, marked with whether it came from a command or from `.env`. */
  report() {
    return NAMES.map(
      (name) => `${name} = ${this.describe(name)}${this.changed(name) ? ' (set)' : ''}`
    );
  }

  /** Whether the clock is inside the quiet window. */
  isQuiet(at = new Date()) {
    return insideWindow(this.get('quiet'), at);
  }
}

module.exports = {
  Settings,
  FIELDS,
  NAMES,
  parseWindow,
  insideWindow,
  // One instance, built from config, which is what the bot and the commands
  // both reach for. The simulation builds its own with no file.
  shared: new Settings({ file: settingsCfg.file }),
};
