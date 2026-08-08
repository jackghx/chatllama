const fs = require('fs');
const path = require('path');
const { assistant } = require('../config');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'prompts', 'assistant.md');

/** Editor notes in the prompt file are not instructions for the model. */
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

/**
 * Resolve the system prompt, in priority order:
 *
 *   1. SYSTEM_PROMPT_FILE, a path to a text or markdown file
 *   2. SYSTEM_PROMPT, an inline string
 *   3. the bundled default at prompts/assistant.md
 *
 * Returns { text, source }. The source is logged at startup: editing the wrong
 * one and seeing no change in behaviour is otherwise silent, and the operator
 * has no way to tell which of the three won.
 *
 * An unreadable SYSTEM_PROMPT_FILE falls through to the next source rather than
 * throwing. This runs unattended under pm2, where a crash on boot means missed
 * messages, and the startup line still reports what was actually loaded.
 */
function loadSystemPrompt() {
  if (assistant.systemPromptFile) {
    const file = path.resolve(assistant.systemPromptFile);
    try {
      const text = stripComments(fs.readFileSync(file, 'utf8')).trim();
      if (text) return { text, source: `SYSTEM_PROMPT_FILE ${file}` };
      console.error(`[prompt] SYSTEM_PROMPT_FILE is empty: ${file}`);
    } catch (err) {
      console.error(`[prompt] SYSTEM_PROMPT_FILE could not be read: ${err.message}`);
    }
  }

  if (assistant.systemPrompt.trim()) {
    return { text: assistant.systemPrompt.trim(), source: 'SYSTEM_PROMPT' };
  }

  const text = stripComments(fs.readFileSync(DEFAULT_FILE, 'utf8')).trim();
  return { text, source: `default ${DEFAULT_FILE}` };
}

module.exports = { loadSystemPrompt };
