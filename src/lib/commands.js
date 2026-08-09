const { access } = require('../config');

// A number and a unit, and nothing else: no dates, no clock times, no natural
// language. Months and years are deliberately absent. Neither has a fixed
// length, and an away message lasting a year is a change to AUTO_REPLY_TEXT
// rather than a temporary state to hold in memory across restarts it will not
// survive anyway.
const DURATION = /^(\d+)\s*([a-z]+)$/i;

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

// Read on a phone, so "3 days" rather than the 4320 minutes it is held as.
function humanDuration(mins) {
  for (const [size, name] of [[60 * 24 * 7, 'week'], [60 * 24, 'day'], [60, 'hour']]) {
    if (mins >= size && mins % size === 0) {
      const n = mins / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
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

  if (mode === 'auto') {
    const fixed = runtime.awayText || access.autoReplyText;
    // Trimmed because this is read on a phone, and the configured wording runs
    // to a couple of sentences.
    const shown = fixed.length > 60 ? `${fixed.slice(0, 57)}...` : fixed;
    parts.push(fixed ? `saying "${shown}"` : 'no fixed reply set, so nothing is sent');
  }

  parts.push(
    access.allowedContacts.length
      ? `${access.allowedContacts.length} allowed contact(s)`
      : 'anyone can write in'
  );

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
  let match = DURATION.exec(parts[0]);
  if (!match && parts.length > 1 && /^\d+$/.test(parts[0])) {
    match = DURATION.exec(parts[0] + parts[1]);
    if (match) used = 2;
  }

  // Anything starting with a bare number is a duration somebody meant, so a
  // unit that cannot be read is refused rather than sent to people as text.
  // "3 years", "2mo" and "6pm" all land here, and all deserve to be told so.
  if (!match) {
    const numeric = /^\d+$/.test(parts[0]) || /^\d+[a-z]+$/i.test(parts[0]);
    if (!numeric) return { minutes: null, text: parts.join(' '), bad: null };
    return {
      minutes: null,
      text: '',
      bad: parts.slice(0, /^\d+$/.test(parts[0]) ? 2 : 1).join(' '),
    };
  }

  const size = minutesIn(match[2]);
  if (size === null) return { minutes: null, text: '', bad: parts.slice(0, used).join(' ') };

  parts.splice(0, used);
  return { minutes: Number(match[1]) * size, text: parts.join(' '), bad: null };
}

/**
 * Runs one owner command against the runtime state and returns what to say back.
 *
 * cancelAll is how "off" reaches replies already being written. Without it the
 * bot would go quiet for new messages while still finishing, and sending, the
 * answers that were in flight when you switched it off.
 */
function runCommand(runtime, input, { cancelAll } = {}) {
  const [word, ...rest] = String(input || '').trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (word.toLowerCase()) {
    case '':
    case 'status':
      return describe(runtime);

    case 'off':
      runtime.mode = 'off';
      runtime.awayUntil = 0;
      runtime.awayText = '';
      if (cancelAll) cancelAll('switched off');
      return `Off. Nothing gets answered until you send ${access.commandPrefix} on.`;

    case 'on':
      // Falling back to auto matters when REPLY_MODE is itself off, where
      // restoring the configured mode would leave it exactly as it was.
      runtime.mode = access.replyMode === 'off' ? 'auto' : access.replyMode;
      runtime.awayUntil = 0;
      runtime.awayText = '';
      return `On, ${runtime.effectiveMode()} mode.`;

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

      const when = minutes === null ? `until you send ${access.commandPrefix} back` : `for ${humanDuration(minutes)}`;
      const saying = text ? `Saying "${text}".` : 'Using the configured fixed reply.';
      return `Away ${when}. ${saying}`;
    }

    case 'back':
      runtime.awayUntil = 0;
      runtime.awayText = '';
      return `Back, ${runtime.effectiveMode()} mode.`;

    default:
      return `Not a command. Try ${access.commandPrefix} then status, off, on, away 2h, or back.`;
  }
}

module.exports = { runCommand, parseAway, describe, humanDuration };
