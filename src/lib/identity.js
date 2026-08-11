const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turns the phone numbers in ALLOWED_CONTACTS into the identifiers WhatsApp
 * actually puts on a message.
 *
 * WhatsApp is moving from phone-number IDs to opaque @lid ones, so the value on
 * an incoming message is not something anyone can work out from a phone number
 * by hand. That used to mean a capture ritual: run the bot, have everyone
 * message you, paste what got logged. whatsapp-web.js can resolve it instead.
 *
 * Only one direction is worth using. Phone to lid is a server query and is
 * reliable. Lid to phone is not: it returns nothing often, and privacy settings
 * blank it outright. So the configured numbers are resolved once and inbound
 * IDs are compared against the result. Nothing ever tries to work backwards
 * from an ID that arrives.
 */
class Identity {
  constructor({ entries = [], cacheFile = '', ttlDays = 30, delayMs = 500 } = {}) {
    this.configured = entries;
    this.cacheFile = cacheFile;
    this.ttlMs = ttlDays * DAY_MS;
    this.delayMs = delayMs;

    // Anything an inbound chat ID may legitimately equal.
    this.matches = new Set();
    // Numbers that could not be turned into a lid, named at startup.
    this.unresolved = [];

    // Written as an ID already, so it is taken at face value and never sent for
    // resolution. Keeps the old configuration style working, and is the way out
    // if resolution is broken for someone.
    this.numbers = [];
    for (const entry of entries) {
      if (entry.includes('@')) {
        this.matches.add(entry);
        continue;
      }

      const digits = digitsOf(entry);
      if (!digits) continue;
      this.numbers.push(digits);
      // The phone-number form still arrives for contacts who have not been
      // migrated, so it counts whether or not the lid lookup ever succeeds.
      this.matches.add(`${digits}@c.us`);
    }

    // Loaded before the client connects, not after. Messages can arrive in the
    // gap between connecting and resolving, and a warm cache is what stops
    // those being dropped, so it is load bearing rather than an optimisation.
    this.cached = this.readCache();
    // Only for numbers still in the config. Seeding from the whole cache meant
    // taking somebody out of ALLOWED_CONTACTS did not take them out of the
    // allowlist: their lid was still cached, so it was still matched, and the
    // cure was deleting a file the docs describe as a speed-up. Their row is
    // left in place, so putting them back costs no lookup.
    const wanted = new Set(this.numbers);
    for (const [number, row] of Object.entries(this.cached)) {
      if (row && row.lid && wanted.has(number)) this.matches.add(row.lid);
    }
  }

  /**
   * Whether this ID was named in the config, rather than merely not excluded.
   *
   * allows() answers "may this person write in", where an empty list means
   * anyone. Sending is the other way round: an empty list has to mean nobody,
   * or SEND_API_ALLOW_ANY=false protects nothing in the configuration most
   * people start from, and a leaked key reaches any number in the world.
   */
  named(chatId) {
    return this.matches.has(chatId);
  }

  /** No allowlist configured means anyone may write in. */
  get open() {
    return this.configured.length === 0;
  }

  allows(chatId) {
    return this.open || this.matches.has(chatId);
  }

  /**
   * Replaces the allowlist while the bot is running.
   *
   * The constructor is where the entries are turned into matchable identifiers,
   * so this rebuilds those from scratch rather than adding to them: taking
   * somebody out of the list has to take them out of the allowlist too, which
   * is the direction that goes wrong if you only ever add. The cache is kept, so
   * a number that was already resolved costs no lookup on the way back in.
   *
   * The lookups run in the background. Anyone who was already matched keeps
   * working throughout, and a number that has not resolved yet is matched by
   * its phone-number form in the meantime, which is the same position a fresh
   * start is in.
   */
  reload(entries, client) {
    const rebuilt = new Identity({
      entries,
      cacheFile: this.cacheFile,
      ttlDays: this.ttlMs / DAY_MS,
      delayMs: this.delayMs,
    });

    this.configured = rebuilt.configured;
    this.numbers = rebuilt.numbers;
    this.matches = rebuilt.matches;
    this.cached = rebuilt.cached;
    this.unresolved = [];

    if (!client) return Promise.resolve();
    return this.resolve(client)
      .then(() => {
        for (const line of this.report()) console.log(line);
      })
      .catch((err) => console.warn('[contacts] could not resolve the new list:', err.message));
  }

  readCache() {
    if (!this.cacheFile) return {};
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      return (data && data.entries) || {};
    } catch {
      // Missing on the first run, and a corrupt one is not worth refusing to
      // start over. Either way it is rebuilt from the numbers in the config.
      return {};
    }
  }

  writeCache() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(
        this.cacheFile,
        JSON.stringify({ version: 1, entries: this.cached }, null, 2)
      );
    } catch (err) {
      console.warn('[contacts] could not write the cache:', err.message);
    }
  }

  /**
   * Looks up whatever is missing or stale, one number at a time.
   *
   * One per call because the library wraps the whole batch in a single
   * Promise.all inside the page, so one bad entry rejects the lot. The
   * maintainers also warn that these lookups are rate limited, hence the pause
   * between them.
   */
  async resolve(client, at = Date.now()) {
    if (this.open || !this.numbers.length) return;

    if (typeof client.getContactLidAndPhone !== 'function') {
      console.warn(
        '[contacts] this version of whatsapp-web.js cannot resolve phone ' +
          'numbers to IDs. Put the @lid values in ALLOWED_CONTACTS instead.'
      );
      return;
    }

    let looked = 0;
    for (const number of this.numbers) {
      const known = this.cached[number];
      if (known && known.lid && at - known.at < this.ttlMs) continue;

      if (looked++) await wait(this.delayMs);

      let row = null;
      try {
        const rows = await client.getContactLidAndPhone([`${number}@c.us`]);
        row = Array.isArray(rows) ? rows[0] : null;
      } catch (err) {
        console.warn(`[contacts] lookup failed for ${number}:`, err.message);
      }

      // A lookup that came back with nothing must not throw away what is
      // already known: a rate-limited refresh would otherwise silence a contact
      // that has been working for weeks.
      if (!row || !row.lid) {
        if (known && known.lid) continue;
        this.unresolved.push(number);
        continue;
      }

      this.cached[number] = { lid: row.lid, pn: row.pn || '', at };
      this.matches.add(row.lid);
    }

    if (looked) this.writeCache();
  }

  /** What to print at startup, so a silent bot is explainable. */
  report() {
    if (this.open) return [];

    const lines = [
      `[contacts] ${this.matches.size} identifier(s) allowed, from ` +
        `${this.configured.length} entr(y/ies)`,
    ];

    if (this.unresolved.length) {
      lines.push(
        `[contacts] could not resolve: ${this.unresolved.join(', ')}. Check the ` +
          'country code and that the number is on WhatsApp. Until it resolves, ' +
          'that contact is only matched if they still write in from a phone-number ID.'
      );
    }

    return lines;
  }
}

module.exports = { Identity };
