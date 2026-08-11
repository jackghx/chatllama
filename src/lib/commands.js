const { access } = require('../config');
const { shared: settings, NAMES } = require('./settings');

// A number and a unit, and nothing else: no dates, no clock times, no natural
// language. Months and years are deliberately absent. Neither has a fixed
// length, and an away message lasting a year is a change to AUTO_REPLY_TEXT
// rather than a temporary state to hold in memory across restarts it will not
// survive anyway.
// One number and one unit. Repeated to make "2h30m", and decimal so that
// "2.5h" is not a trap for anyone who types it.
const CHUNK = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

const UNITS = [
  [/^(m|min|mins|minute|minutes)$/i, 1],
  [/^(h|hr|hrs|hour|hours)$/i, 60],
  [/^(d|day|days)$/i, 60 * 24],
  [/^(w|wk|wks|week|weeks)$/i, 60 * 24 * 7],
];

const minutesIn = (unit) => {
  for (const [pattern, size] of UNITS) if (pattern.test(unit)) return size;
  return null;
};

/**
 * The whole of one token as minutes, or null if it is not a duration.
 *
 * Every chunk has to sit flush against the last and the last has to reach the
 * end, so "2h30m" reads as 150 while "2hsomething" is refused rather than
 * quietly taken as two hours.
 */
function durationOf(token) {
  CHUNK.lastIndex = 0;
  let total = 0;
  let consumed = 0;
  let match;

  while ((match = CHUNK.exec(token)) !== null) {
    if (match.index !== consumed) return null;
    const size = minutesIn(match[2]);
    if (size === null) return null;
    total += Number(match[1]) * size;
    consumed = CHUNK.lastIndex;
  }

  if (!consumed || consumed !== token.length) return null;
  return Math.round(total);
}

// Read on a phone, so "3 days" rather than the 4320 minutes it is held as.
function humanDuration(mins) {
  for (const [size, name] of [[60 * 24 * 7, 'week'], [60 * 24, 'day'], [60, 'hour']]) {
    if (mins >= size && mins % size === 0) {
      const n = mins / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  // Compound, so "2 hours 30 min" rather than the 150 it is held as.
  if (mins > 60) {
    const hours = Math.floor(mins / 60);
    return `${hours} hour${hours === 1 ? '' : 's'} ${mins % 60} min`;
  }
  return `${mins} min`;
}

function describe(runtime) {
  const mode = runtime.effectiveMode();
  const parts = [`mode ${mode}`];

  if (runtime.awayUntil === Infinity) {
    parts.push('away, no end set');
  } else if (runtime.awayUntil) {
    const left = Math.max(1, Math.round((runtime.awayUntil - Date.now()) / 60000));
    parts.push(`away for another ${humanDuration(left)}`);
  }

  if (runtime.isQuiet && runtime.isQuiet()) {
    parts.push(`inside quiet hours (${settings.get('quiet')}), so ${runtime.quietMode}`);
  } else if (settings.get('quiet')) {
    parts.push(`quiet hours ${settings.get('quiet')}`);
  }

  if (mode === 'auto') {
    const fixed = runtime.awayText || settings.get('auto_reply');
    // Trimmed because this is read on a phone, and the configured wording runs
    // to a couple of sentences.
    const shown = fixed.length > 60 ? `${fixed.slice(0, 57)}...` : fixed;
    parts.push(fixed ? `saying "${shown}"` : 'no fixed reply set, so nothing is sent');
  }

  const contacts = settings.get('contacts');
  parts.push(contacts.length ? `${contacts.length} allowed contact(s)` : 'anyone can write in');

  const changed = settings.changedNames;
  if (changed.length) parts.push(`${changed.length} setting(s) changed: ${changed.join(', ')}`);

  return `${parts.join('. ')}.`;
}

/**
 * Splits "2h in a meeting" into a duration and a message.
 *
 * No natural language. "until 6" is six in the morning, six in the evening, or
 * tomorrow, and in whose timezone, and reading it wrong means the bot answers
 * for you when you thought it had stopped. A model could parse it, but then
 * switching the bot off would depend on Ollama being reachable.
 */
function parseAway(arg) {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { minutes: null, text: '', bad: null };

  // "30 mins" as readily as "30m", because putting the space in is the natural
  // way to type it. Getting this wrong used to fail silently and in the worst
  // possible direction: no end time set at all, and the duration itself texted
  // to people as the away message.
  let used = 1;
  let minutes = durationOf(parts[0]);
  if (minutes === null && parts.length > 1 && /^\d+(\.\d+)?$/.test(parts[0])) {
    minutes = durationOf(parts[0] + parts[1]);
    if (minutes !== null) used = 2;
  }

  // Anything starting with a digit is a duration somebody meant, so one that
  // cannot be read is refused rather than sent to people as text. "2mo",
  // "3 years", "6pm" and "1h30" all land here, and all deserve to be told so.
  // Matching only the shapes that were expected is what let "2h30m" through as
  // an away message with no end date on it.
  if (minutes === null) {
    if (!/^\d/.test(parts[0])) return { minutes: null, text: parts.join(' '), bad: null };
    const span = /^\d+(\.\d+)?$/.test(parts[0]) ? 2 : 1;
    return { minutes: null, text: '', bad: parts.slice(0, span).join(' ') };
  }

  parts.splice(0, used);
  return { minutes, text: parts.join(' '), bad: null };
}

/**
 * Runs one owner command against the runtime state and returns what to say back.
 *
 * cancelAll is how "off" reaches replies already being written. Without it the
 * bot would go quiet for new messages while still finishing, and sending, the
 * answers that were in flight when you switched it off.
 */
function runCommand(runtime, input, { cancelAll, brief } = {}) {
  const [word, ...rest] = String(input || '').trim().split(/\s+/);
  const arg = rest.join(' ');

  // Every branch below that changes anything ends by writing it out, so that a
  // restart does not undo an away you set days ago. Wrapping the switch is what
  // stops a branch added later forgetting to.
  const saving = (reply) => {
    runtime.save();
    return reply;
  };

  switch (word.toLowerCase()) {
    case '':
    case 'status':
      return describe(runtime);

    case 'off':
      runtime.mode = 'off';
      runtime.awayUntil = 0;
      runtime.awayText = '';
      if (cancelAll) cancelAll('switched off');
      return saving(`Off. Nothing gets answered until you send ${access.commandPrefix} on.`);

    case 'on':
      // Falling back to auto matters when REPLY_MODE is itself off, where
      // restoring the configured mode would leave it exactly as it was.
      runtime.mode = access.replyMode === 'off' ? 'auto' : access.replyMode;
      runtime.awayUntil = 0;
      runtime.awayText = '';
      return saving(`On, ${runtime.effectiveMode()} mode.`);

    case 'away': {
      const { minutes, text, bad } = parseAway(arg);

      // Refused rather than guessed at. Reading it as the message instead left
      // the bot away with no end date and texting people the word "2mo".
      if (bad) {
        return (
          `"${bad}" is not a duration I can read. Use a number and a unit: ` +
          '30m, 2h, 3d, 1w. Months and years are not supported. Leave the ' +
          `duration off entirely and it stays away until you send ${access.commandPrefix} back.`
        );
      }

      runtime.awayUntil = minutes === null ? Infinity : Date.now() + minutes * 60000;
      runtime.awayText = text;

      // Saying you have gone outranks anything inferred from you having replied
      // to somebody twenty minutes ago. Without this, the conversations you
      // were most recently part of are the ones that would go unanswered.
      runtime.clearHandovers();

      const when = minutes === null ? `until you send ${access.commandPrefix} back` : `for ${humanDuration(minutes)}`;
      const saying = text ? `Saying "${text}".` : 'Using the configured fixed reply.';
      return saving(`Away ${when}. ${saying}`);
    }

    case 'back':
      runtime.awayUntil = 0;
      runtime.awayText = '';
      return saving(`Back, ${runtime.effectiveMode()} mode.`);

    // Everything pending, now, rather than waiting for each conversation to go
    // quiet on its own. What you send when you land, or come out of a meeting.
    case 'brief': {
      if (!brief) return 'Briefings are not available here.';
      const count = brief();
      if (!count) return 'Nothing waiting. Every conversation has already been briefed.';
      return `Writing ${count} briefing(s) now. They will arrive as they finish.`;
    }

    // The settings that can be changed without editing .env and restarting.
    case 'set': {
      const [name, ...value] = rest;
      if (!name) return `Settings: ${NAMES.join(', ')}. Send "set <name>" to see one.`;

      const key = name.toLowerCase();
      // No value is a question rather than a mistake, and answering it is more
      // use than refusing it.
      if (!value.length) {
        if (!NAMES.includes(key)) return `"${key}" is not a setting. Try: ${NAMES.join(', ')}.`;
        return `${key} = ${settings.describe(key)}${settings.changed(key) ? ' (set)' : ' (from .env)'}`;
      }

      return settings.set(key, value.join(' ')).reply;
    }

    // The way back from a value typed wrong on a phone, which is why a change
    // is stored on top of the configuration rather than over it.
    case 'unset':
    case 'reset':
      return settings.clear((rest[0] || '').toLowerCase() || 'all').reply;

    case 'settings':
      return settings.report().join('\n');

    default:
      return (
        `Not a command. Try ${access.commandPrefix} then status, off, on, away 2h, ` +
        'back, brief, settings, set <name> <value>, or reset <name>.'
      );
  }
}

const WORDS = [
  'status',
  'off',
  'on',
  'away',
  'back',
  'brief',
  'set',
  'unset',
  'reset',
  'settings',
];

/**
 * Whether what follows the prefix is one of the commands rather than a question.
 *
 * Over WhatsApp the two are told apart by who sent it, and the simulation has
 * nobody to be. Matching on the first word is what runCommand itself switches
 * on, so the simulation reads a line exactly as your own chat would. Reading it
 * any other way would be worse than either reading, since the simulation is
 * where the real thing gets rehearsed.
 */
const isCommand = (text) => {
  const word = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  return word === '' || WORDS.includes(word);
};

module.exports = { runCommand, parseAway, describe, humanDuration, isCommand };
