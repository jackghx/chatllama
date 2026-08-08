const fs = require('fs');
const path = require('path');
const { assistant } = require('../config');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'prompts', 'assistant.md');

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

// SYSTEM_PROMPT_FILE, then SYSTEM_PROMPT, then the bundled default. An
// unreadable file falls through rather than throwing: this runs unattended
// under pm2, where exiting on boot means missed messages.
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

  return {
    text: stripComments(fs.readFileSync(DEFAULT_FILE, 'utf8')).trim(),
    source: `default ${DEFAULT_FILE}`,
  };
}

module.exports = { loadSystemPrompt };
