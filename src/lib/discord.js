const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { discord: cfg } = require('../config');

/**
 * A single message in a Discord channel, edited in place, that says whether
 * this is working.
 *
 * A Discord webhook can edit messages it sent itself, with no bot token and no
 * inbound connection, which makes this the cheapest honest status light
 * available: one message, pinned by hand once, going green and red on its own
 * afterwards. Posting a new message every minute would bury the channel, and
 * renaming the channel is capped at two changes every ten minutes, which a
 * flapping session would exhaust in seconds and then sit wrong.
 *
 * The timestamp in the footer is not decoration. A green embed that has simply
 * stopped being updated looks exactly like a healthy one, so the message says
 * when it was last written and Discord renders that as "3 minutes ago"
 * client-side. If that number starts climbing, the watcher is what died.
 */

const GREEN = 0x2ecc71;
const RED = 0xe74c3c;

// Discord renders this as a relative time in the reader's own locale.
const relative = (at) => `<t:${Math.floor(at / 1000)}:R>`;

class DiscordStatus {
  constructor({ url = cfg.statusWebhook, intervalMs = cfg.statusIntervalMs, file = cfg.statusFile } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.intervalMs = intervalMs;
    this.file = file;
    this.messageId = this.readId();
    this.timer = null;
    this.name = 'ChatLlama';
  }

  get enabled() {
    return Boolean(this.url);
  }

  readId() {
    if (!this.file) return '';
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return (data && data.messageId) || '';
    } catch {
      return '';
    }
  }

  /**
   * Kept across restarts, so a restart edits the message that is already
   * pinned rather than posting a second one nobody has pinned.
   */
  writeId(id) {
    this.messageId = id;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, messageId: id }, null, 2));
    } catch (err) {
      console.warn('[discord] could not save the status message id:', err.message);
    }
  }

  /** The embed, built from whatever the health check just said. */
  embed(health) {
    const up = health.status === 'up';
    const fields = [
      { name: 'Connection', value: health.connection || 'unknown', inline: true },
      { name: 'Mode', value: String(health.mode || 'unknown'), inline: true },
      { name: 'Queue', value: String(health.queueDepth ?? 0), inline: true },
    ];

    if (health.away) {
      fields.push({
        name: 'Away',
        value: health.away.until ? `until ${health.away.until}` : 'no end set',
        inline: true,
      });
    }
    if (health.quiet) fields.push({ name: 'Quiet hours', value: 'yes', inline: true });
    if (health.lastMessageAt) {
      fields.push({
        name: 'Last message',
        value: relative(Date.parse(health.lastMessageAt)),
        inline: true,
      });
    }

    return {
      title: `${up ? '🟢' : '🔴'} ${this.name}`,
      description: up
        ? 'Answering WhatsApp normally.'
        : `Not answering: ${health.connectionNote || health.connection || 'unknown'}.`,
      color: up ? GREEN : RED,
      fields,
      // Written into the body rather than left to the embed's own timestamp,
      // which renders as an absolute time and does not make a stalled updater
      // obvious at a glance.
      footer: { text: 'ChatLlama' },
    };
  }

  async post(health) {
    const embed = this.embed(health);
    embed.description += `\n\nLast checked: ${relative(Date.now())}`;

    // wait=true is what makes Discord return the message it created, which is
    // the only way to learn the id needed to edit it afterwards.
    const res = await axios.post(
      `${this.url}?wait=true`,
      { embeds: [embed] },
      { timeout: 10000 }
    );
    const id = res.data && res.data.id;
    if (id) {
      this.writeId(id);
      console.log(
        '[discord] status message posted. Pin it by hand once: a webhook cannot pin its own.'
      );
    }
  }

  async patch(health) {
    const embed = this.embed(health);
    embed.description += `\n\nLast checked: ${relative(Date.now())}`;

    await axios.patch(
      `${this.url}/messages/${this.messageId}`,
      { embeds: [embed] },
      { timeout: 10000 }
    );
  }

  /**
   * One update. Falls back to posting a new message if the one being edited has
   * been deleted, which is otherwise a status light that silently stops.
   */
  async update(health) {
    if (!this.enabled) return;

    try {
      if (this.messageId) await this.patch(health);
      else await this.post(health);
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 404 && this.messageId) {
        console.warn('[discord] the status message is gone, posting a new one');
        this.writeId('');
        try {
          await this.post(health);
        } catch (again) {
          console.warn('[discord] status update failed:', again.message);
        }
        return;
      }
      console.warn('[discord] status update failed:', status || err.message);
    }
  }

  /**
   * Starts the heartbeat. `read` is called for each tick rather than a value
   * being passed in, so what is shown is what is true at that moment.
   */
  start(read) {
    if (!this.enabled || this.timer) return;

    console.log(`[discord] status light on, every ${Math.round(this.intervalMs / 1000)}s`);
    const tick = () => this.update(read());
    tick();
    this.timer = setInterval(tick, this.intervalMs).unref();
  }

  /**
   * Stops it, and paints the light red on the way out.
   *
   * A planned shutdown that left the message green would be indistinguishable
   * from a process that is still running, which is the failure this exists to
   * make visible in the first place.
   */
  async stop(read) {
    if (!this.enabled) return;
    clearInterval(this.timer);
    this.timer = null;

    const health = { ...read(), status: 'down', connection: 'stopped', connectionNote: 'shut down' };
    await this.update(health);
  }
}

module.exports = { DiscordStatus, GREEN, RED };
