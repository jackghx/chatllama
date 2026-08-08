# ChatLlama

A self-hosted WhatsApp auto-reply assistant backed by a local
[Ollama](https://ollama.com) instance, with optional [n8n](https://n8n.io)
webhook logging.

It answers messages sent to your WhatsApp account while you are not at your
phone. What it sounds like is up to you: the persona is a system prompt you
write, not something baked into the code.

## How it works

```
WhatsApp  ->  whatsapp-web.js  ->  filters  ->  queue  ->  Ollama  ->  reply
                                                  |
                                                  +--->  n8n webhook  ->  Discord
```

The filters are the interesting part, and they are covered below. In order: age,
group and broadcast, allowlist, empty body, reply mode, hourly cap.

## Requirements

- Node.js 20 or later
- A reachable Ollama instance with at least one model pulled
- A WhatsApp account you are willing to link to a browser session

## Setup

```bash
git clone <your-repo-url>
cd ChatLlama
npm install
cp .env.example .env
```

Edit `.env`, set `OLLAMA_HOST`, and set `ALLOWED_CONTACTS` unless you really do
want to answer everyone. Then:

```bash
npm run assistant
```

Scan the QR code with WhatsApp on your phone (Settings, Linked Devices, Link a
Device). The session is cached in `.wwebjs_auth/`, so you only do this once.

## Reply modes

`REPLY_MODE` decides when the assistant speaks.

| Mode | Behaviour |
| --- | --- |
| `always` | Replies to every message that gets through the filters. The default. |
| `prefix` | Replies only to messages starting with `COMMAND_PREFIX`, default `/ai`. |

`always` is the point of the project. `prefix` is quieter and worth using while
you are still tuning the system prompt, since nothing goes out unless someone
asks for it by name. `COMMAND_PREFIX` is ignored in `always` mode.

## The system prompt

The prompt is loaded from the first of these that exists:

1. `SYSTEM_PROMPT_FILE`, a path to a text or markdown file
2. `SYSTEM_PROMPT`, an inline string
3. `prompts/assistant.md`, the bundled default

Whichever wins is logged at startup:

```
[prompt] loaded from SYSTEM_PROMPT_FILE /home/you/persona.md
```

That line exists because editing the wrong source is otherwise silent. You
change a file, restart, and the replies come out exactly as before with nothing
to say why.

Point `SYSTEM_PROMPT_FILE` at a copy outside the repo. Editing
`prompts/assistant.md` in place works, but a `git pull` will overwrite it.

The bundled default is a starting point rather than a finished persona. It is
deliberately plain, and plain is not the same as sounding like you. It also sets
some limits worth keeping: it does not agree to plans, commit to times, discuss
money or invent details about where you are. A model that will happily accept a
dinner invitation on your behalf is not a feature.

HTML comments in a prompt file are stripped before the model sees them, so you
can leave notes for yourself in there.

## The self-disclosure notice

Replies carry a notice, `[AI]` by default, so people know they are not talking
to you.

| Variable | Effect |
| --- | --- |
| `AI_PREFIX` | The wording. Anything you like. |
| `AI_PREFIX_MODE` | `always` on every reply, `first` once per conversation, `never` off. |

It is attached in code, not asked for in the system prompt. There is a
precedent for that in this repo, recorded below: a bot that asked the model to
emit a fixed token on every reply got a model that dropped it, often enough to
matter. The same failure here does not show up in a log. It shows up as someone
believing they are talking to you.

`first` exists because `[AI]` on all forty lines of a long conversation reads
badly, and the notice mostly does its work at the start. `never` is there
because it is your account. If you use it, the person on the other end has no
way of knowing, so make that a decision rather than a default you inherited.

## Guards

`prefix` mode was doing more safety work than it looked. A human had to type
`/ai` before anything happened. Removing that exposes three things, all of which
the assistant now handles.

**Group chats.** whatsapp-web.js delivers group messages too, and an auto
replier in a group answers every member's every message. Chats ending in
`@g.us` are ignored unless `ALLOW_GROUPS=true`. Status broadcasts are ignored
outright.

**Reply loops.** Two auto repliers pointed at each other will talk until
someone notices. `MAX_REPLIES_PER_HOUR`, default 20, caps replies per
conversation over a rolling hour. On breach the conversation is paused and it
is logged once. Zero disables it.

**Non-text messages.** Images, stickers, voice notes and system events arrive
with an empty body. They are skipped rather than turned into an empty prompt. A
captioned image is answered on its caption.

The allowlist matters more here than it used to. In `prefix` mode an empty
`ALLOWED_CONTACTS` meant anyone who knew the prefix could use the bot. In
`always` mode it means everyone who has your number gets a reply, including
people who are not in your contacts. Leaving it empty logs a warning that says
so.

### Finding your contact IDs

Recent versions of whatsapp-web.js report senders as `<id>@lid` rather than the
older `<number>@c.us`, and the LID does not match the phone number. Hardcoding a
guessed `@c.us` value is the most common reason a bot never replies.

To find the right value, leave `ALLOWED_CONTACTS` empty, set `LOG_UNMATCHED=true`,
start the assistant in `prefix` mode, and have the person send a message. The
sender ID appears in the log. Paste it into `ALLOWED_CONTACTS`, set
`LOG_UNMATCHED=false`, switch the mode back, and restart.

`ALLOWED_CONTACTS` takes a comma separated list.

## Simulation mode

```bash
npm run assistant:sim
```

Runs the same handler against your terminal, no WhatsApp connection involved.
Type messages as if you were the other person. This is the cheapest way to hear
what a system prompt actually sounds like before anyone else does.

The filters do not apply in simulation, since they operate on real messages.

## Tests

```bash
npm test
```

`test/harness.js` runs the real code in `src/` against stubs for axios, dotenv,
whatsapp-web.js and qrcode-terminal, swapped in through a `Module._load` hook.
There is no test runner and no dev dependency, so this works on a fresh clone
before `npm install`, without a WhatsApp session and without Ollama running. It
exits non-zero if any check fails.

It covers the filters, both reply modes, prompt source priority, the notice in
all three modes, per-conversation memory, and the webhook when n8n accepts the
connection and never replies.

To compare two copies of the repo, point the harness at another checkout:

```bash
HARNESS_REPO=/path/to/other/checkout npm test
```

Worth doing when tests were written after the fixes they cover, which is the
case here. A suite that asserts nothing also passes. When the earlier round of
fixes landed, this harness run against the sources from before them failed 10 of
34 checks, and all 10 sat in the areas those fixes touched: prefix boundary
matching, the doubled reply marker, the blocking webhook and the missing startup
log. That is the part a green run cannot tell you on its own.

That particular comparison no longer runs, since this round renamed the modules
it loads. The variable stays for the next time.

## Running under pm2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # then run the command it prints
```

`pm2 startup` installs a systemd unit, so the assistant comes back after a
reboot without anyone logging in. Check with `pm2 list` and `pm2 logs assistant`.

Run one instance per WhatsApp account. Two pointed at the same account both
answer every message, and in `always` mode neither waits to be asked.

## Configuration

All configuration is environment based. See `.env.example` for the full list.

| Variable | Purpose |
| --- | --- |
| `OLLAMA_HOST` | Base URL of the Ollama instance |
| `REPLY_MODE` | `always` or `prefix`, default `always` |
| `COMMAND_PREFIX` | Prefix for `prefix` mode, default `/ai` |
| `ALLOWED_CONTACTS` | Comma separated sender IDs, empty allows anyone |
| `ALLOW_GROUPS` | Reply in group chats, default false |
| `MAX_REPLIES_PER_HOUR` | Per-conversation cap, default 20, zero disables |
| `IGNORE_OLDER_THAN_SECONDS` | Drops the backlog replayed on connect |
| `SYSTEM_PROMPT_FILE` / `SYSTEM_PROMPT` | Persona, overriding the bundled default |
| `AI_PREFIX` / `AI_PREFIX_MODE` | Wording and frequency of the notice |
| `ASSISTANT_MODEL` | Ollama model tag |
| `N8N_WEBHOOK_URL` | Optional, empty disables webhook logging |

## Webhook logging

See [docs/n8n-discord.md](docs/n8n-discord.md) for the payload shape and a
working Discord embed setup.

Whether logging is on is reported at startup, next to the Ollama check:

```
[webhook] logging off, N8N_WEBHOOK_URL is empty
```

An empty or mistyped URL is otherwise invisible. The POST is skipped, the
assistant carries on replying as normal, and nothing arrives in Discord.

## Notes from building this

Things that cost time and are worth knowing:

- **Use `/api/generate`, not `/v1/generate`.** Ollama's `/v1` routes are the
  OpenAI compatibility layer and do not include a generate endpoint. Hitting it
  returns 404.
- **Stop sequences are not optional.** Without them the model happily writes both
  sides of the conversation, inventing the user's next message and answering it.
- **Do not depend on the model emitting a fixed string.** An earlier quiz bot in
  this repo asked for a verdict token on every reply and scanned the prose for
  it. The model said "spot on" and "afraid not" instead, and the score drifted.
  Anything that must be present on every reply belongs in code. That is why the
  `[AI]` notice is attached after generation rather than requested in the prompt.
- **Group chats arrive through the same event as direct messages.** Nothing
  marks them as different except the `@g.us` suffix on the chat ID. An auto
  replier that does not check answers every member of every group it is in, and
  you will hear about it.
- **Two auto repliers will talk to each other indefinitely.** There is no
  natural end to it, and neither side is doing anything wrong from its own point
  of view. A per-conversation cap is the cheapest way out.
- **Serialise requests.** Five messages in five seconds means five concurrent
  requests, all reading conversation memory before any of them writes to it.
- **Memory is per conversation.** A single shared array leaks fragments of one
  person's conversation into another's.
- **CPU inference is the bottleneck, not prompt length.** Swapping between models
  of a similar size changes little. A GPU only helps if the model fits in VRAM,
  otherwise layers spill back to system memory and the gain mostly disappears.
- **Instruction following varies more than benchmarks suggest.** Some models are
  better at raw generation than at holding a format, and will drift out of a
  structured reply within a few turns.

## Scope and safeguards

A few deliberate constraints, worth keeping if you fork this:

- **The notice is applied in code.** It survives the model ignoring its
  instructions. It can be switched off, and that is a choice with someone else
  on the other end of it.
- **The allowlist is opt-in per contact.** Leaving it empty logs a warning at
  startup, worded according to the reply mode.
- **Groups are off by default.** The blast radius of getting this wrong in a
  group is much larger than in a one to one chat.
- **If you enable webhook logging, tell the people using it.** Forwarding their
  messages to a Discord channel is not obvious from their side, and a channel is
  a lot less private than a one to one chat.
- **The system prompt is where the judgement lives.** The bundled default
  declines to make commitments on your behalf. If you replace it, decide what
  yours will not do.

## Security

- **Never commit `.wwebjs_auth/`.** It contains live session credentials for the
  linked WhatsApp account. Anyone with those files can send messages as you. It
  is in `.gitignore`; leave it there. If it has already been committed, unlink the
  device in WhatsApp immediately and rewrite the history.
- **Never commit `.env`.** Webhook URLs are unauthenticated endpoints.
- **Automating a personal WhatsApp account is against WhatsApp's terms of
  service.** Accounts do get banned for it, and an account that replies to
  everything looks a good deal more like automation than one that waits to be
  asked. Use a number you can afford to lose, and consider the official Business
  API for anything real.
- Ollama has no authentication by default. Keep it on an internal interface
  rather than exposing port 11434.

## Upgrading from the two-bot version

The quiz bot is gone, and `freechat` is now `assistant`. If you are coming from
that version:

- `npm run freechat` becomes `npm run assistant`
- `FREECHAT_MODEL` becomes `ASSISTANT_MODEL`, `FREECHAT_MEMORY_WINDOW` becomes
  `ASSISTANT_MEMORY_WINDOW`
- `QUIZ_*` variables can be deleted
- `REPLY_MODE=prefix` restores the old behaviour, which was prefix-gated
- The pm2 app is now `assistant`, so `pm2 delete freechat` before starting it

The `clientId` changed from `freechat-bot` to `assistant`, which orphans the
existing session directory under `.wwebjs_auth/`. You will scan the QR code once
more. The old directory can be deleted once you have.

## Licence

MIT.
