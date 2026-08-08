/**
 * pm2 process definitions.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup      # then run the command it prints
 *
 * Run one of these per WhatsApp account. Two pointed at the same account both
 * answer every message, and in always mode neither of them waits to be asked.
 */
module.exports = {
  apps: [
    {
      name: 'assistant',
      script: 'src/bots/assistant.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '500M',
      // Default is 1600ms, which cuts the shutdown summary flush short.
      kill_timeout: 15000,
      out_file: 'logs/assistant-out.log',
      error_file: 'logs/assistant-error.log',
      time: true,
    },
  ],
};
