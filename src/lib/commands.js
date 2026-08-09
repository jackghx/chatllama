const { access } = require('../config');

// 2h, 30m. Deliberately the whole of it.
const DURATION = /^(\d+)\s*([hm])$/i;

function describe(runtime) {
  const mode = runtime.effectiveMode();
  const parts = [`mode ${mode}`];

  if (runtime.awayUntil === Infinity) {
    parts.push('away, no end set');
  } else if (runtime.awayUntil) {
    const left = Math.max(1, Math.round((runtime.awayUntil - Date.now()) / 60000));
    parts.push(`away for another ${left} min`);
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

  const match = parts.length ? DURATION.exec(parts[0]) : null;
  if (!match) return { minutes: null, text: parts.join(' ') };

  parts.shift();
  return {
    minutes: Number(match[1]) * (match[2].toLowerCase() === 'h' ? 60 : 1),
    text: parts.join(' '),
  };
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
      const { minutes, text } = parseAway(arg);
      runtime.awayUntil = minutes === null ? Infinity : Date.now() + minutes * 60000;
      runtime.awayText = text;

      const when = minutes === null ? `until you send ${access.commandPrefix} back` : `for ${minutes} min`;
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

module.exports = { runCommand, parseAway, describe };
