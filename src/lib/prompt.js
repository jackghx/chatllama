const fs = require('fs');
const path = require('path');
const { assistant } = require('../config');

const PROMPTS = path.join(__dirname, '..', '..', 'prompts');
const DEFAULT_FILE = path.join(PROMPTS, 'assistant.md');
const SUMMARY_FILE = path.join(PROMPTS, 'summary.md');
const TRIAGE_FILE = path.join(PROMPTS, 'triage.md');

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

/**
 * The bundled briefing prompts, which are read at require time.
 *
 * They are shipped with the repo, so a failure here means a damaged checkout
 * rather than a bad setting. Throwing would still be the wrong answer: it kills
 * the process during module load, before the client exists, and this runs
 * unattended under pm2 where not starting means missed messages. Briefings are
 * worth degrading; answering people is not.
 */
function loadBundled(file, label) {
  try {
    return stripComments(fs.readFileSync(file, 'utf8')).trim();
  } catch (err) {
    console.error(`[prompt] the ${label} prompt could not be read: ${err.message}`);
    return '';
  }
}

// No environment override. These shape a machine-readable briefing rather than
// a persona, so they are edited in place on the rare occasion they need to be.
// summary.md is the prose briefing, triage.md the structured one.
const loadSummaryPrompt = () => loadBundled(SUMMARY_FILE, 'prose briefing');
const loadTriagePrompt = () => loadBundled(TRIAGE_FILE, 'structured briefing');

module.exports = { loadSystemPrompt, loadSummaryPrompt, loadTriagePrompt };
