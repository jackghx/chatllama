# ChatLlama

A self-hosted WhatsApp auto-reply assistant backed by a local
[Ollama](https://ollama.com) instance.

It answers messages sent to your WhatsApp account while you are away from your
phone. Everything runs on your own machine, so the messages never leave it. What
the assistant sounds like is a system prompt you write, not something fixed in
the code.

## What it looks like

```
Sam    22:14  are you around tomorrow evening?
You    22:14  [AI] Not at my phone right now, but I have passed that on.
Sam    22:15  no rush, just wondering about the thing at 7
You    22:15  [AI] I do not want to commit to a time on their behalf. They will
                   get back to you this evening.
```

The `[AI]` marker is configurable, and can be set to appear once per
conversation or not at all. What the assistant will and will not say is up to
the prompt you write for it.

## Requirements

- Node.js 20 or later
- Ollama, running and reachable, with a model pulled
- A WhatsApp account you are willing to link to a browser session

Automating a personal WhatsApp account is against WhatsApp's terms of service
and accounts do get banned for it. Use a number you can afford to lose. See
[Security](#security).

## Quickstart

### 1. Get Ollama running

```bash
ollama pull llama3.1:8b
ollama serve
```

Any model works. Whatever you pull must match `ASSISTANT_MODEL` in your `.env`.
An 8B model on CPU takes long enough that replies feel like someone typing,
which for this is no bad thing. Time it yourself in step 5 before deciding.

### 2. Install

```bash
git clone <your-repo-url>
cd ChatLlama
npm install
cp .env.example .env
```

### 3. Point it at Ollama

Edit `.env` and set `OLLAMA_HOST`. If Ollama runs on the same machine:

```
OLLAMA_HOST=http://127.0.0.1:11434
```

### 4. Write your persona

**Do this before you connect WhatsApp.** The bundled prompt at
`prompts/assistant.md` contains placeholders:

```
You are answering WhatsApp messages on behalf of [your name], who is away from
their phone at the moment.
```

If you leave those, the assistant will text your friends the words
`[your name]`. Replace every bracketed part.

Better, copy it somewhere outside the repo so a `git pull` cannot overwrite your
wording, and point at it:

```
SYSTEM_PROMPT_FILE=/home/you/persona.md
```

See [Writing a good prompt](#writing-a-good-prompt) below.

### 5. Hear it before anyone else does

```bash
npm run assistant:sim
```

This runs the assistant against your terminal with no WhatsApp connection. Type
messages as if you were the other person. Go back and edit the prompt until the
replies sound like something you would be happy to have sent in your name. This
costs nothing and is the whole point of running a local model.

### 6. Connect WhatsApp

```bash
npm run assistant
```

Scan the QR code with your phone (Settings, Linked Devices, Link a Device). The
session is cached in `.wwebjs_auth/`, so you only do this once.

A healthy start looks like this:

```
[assistant] ready, reply mode: always
[prompt] loaded from SYSTEM_PROMPT_FILE /home/you/persona.md
[notice] "[AI]", mode always
[webhook] logging off, N8N_WEBHOOK_URL is empty
[ollama] reachable. models: llama3.1:8b
[access] ALLOWED_CONTACTS is empty and REPLY_MODE is always, so every message
         from anyone who has this number, including people not in your
         contacts, gets an automated reply.
```

Read those lines. Each one is there because getting it wrong is otherwise
silent.

### 7. Restrict who it answers

That last warning is the one to deal with. Until you set `ALLOWED_CONTACTS`,
anyone who messages the number gets a reply.

You cannot guess the IDs. Recent versions of whatsapp-web.js report senders as
`<id>@lid`, and the LID does not match the phone number, so a hand written
`447700900000@c.us` will simply never match. Get the real value from the bot:

```
LOG_UNMATCHED=true
ALLOWED_CONTACTS=placeholder@lid
```

Restart, have the person message you, and read the log:

```
[access] unmatched sender: 183765432109876@lid
```

Paste that into `ALLOWED_CONTACTS` as a comma separated list, set
`LOG_UNMATCHED=false`, and restart. Setting a placeholder first means the bot
stays quiet while you do this.

## Writing a good prompt

The prompt is loaded from the first of these that exists:

1. `SYSTEM_PROMPT_FILE`, a path to a text or markdown file
2. `SYSTEM_PROMPT`, an inline string
3. `prompts/assistant.md`, the bundled default

Whichever wins is logged at startup, so if your edits appear to do nothing,
check that line first. It is usually the answer.

Things worth putting in yours:

- **How you actually text.** Length, punctuation, whether you use full stops.
  The default is deliberately plain, and plain is not the same as sounding like
  you.
- **What it must not do.** The default declines to accept invitations, agree
  times, discuss money or speculate about where you are. Keep that, or decide
  what yours refuses instead. A model that cheerfully accepts a dinner
  invitation on your behalf is not a feature.
- **What to say when it does not know.** The default says so plainly and offers
  to pass a message on, which is almost always better than a guess.

HTML comments are stripped before the model sees the prompt, so you can leave
notes to yourself in the file.

Small models drift out of a persona after a few turns. Keep the prompt short and
concrete rather than long and literary.

## The `[AI]` marker

Replies carry a marker so people know they are not talking to you.

| Variable | Effect |
| --- | --- |
| `AI_PREFIX` | The wording. Default `[AI]`, set it to anything. |
| `AI_PREFIX_MODE` | `always` every reply, `first` once per conversation, `never` off. |

`first` exists because a marker on all forty lines of a conversation reads
badly, while the disclosure still lands where it matters. `never` is available
because it is your account, but the person on the other end then has no way of
knowing, so make it a decision rather than a default you inherited.

The marker is attached in code after the model has replied, not requested in the
prompt. Models drop instructions like that, and this one failing is invisible.

## Reply modes

| Mode | Behaviour |
| --- | --- |
| `always` | Replies to every message that passes the filters. The default. |
| `prefix` | Replies only to messages starting with `COMMAND_PREFIX`, default `/ai`. |

`prefix` is useful while you are still tuning, since nothing goes out unless
somebody asks for it by name. `COMMAND_PREFIX` is ignored in `always` mode.

## What it will not answer

Replying to everything is a much larger surface than replying on request, so
some things are filtered out before the model is ever called.

**Group chats.** Ignored unless `ALLOW_GROUPS=true`. An auto replier in a group
answers every member's every message. Status broadcasts are always ignored.

**Runaway loops.** `MAX_REPLIES_PER_HOUR`, default 20, caps replies per
conversation over a rolling hour, then pauses that conversation and logs it
once. This is what stops two auto repliers, or this one and an out of office
bot, from talking to each other all night. Zero disables it.

**Images, stickers and voice notes.** Skipped rather than turned into an empty
prompt. A photo with a caption is answered on the caption.

**The backlog.** whatsapp-web.js replays recent history when it connects.
Messages older than `IGNORE_OLDER_THAN_SECONDS`, default 30, are dropped, so a
restart does not answer everything from earlier.

## Configuration

All configuration is environment based. See `.env.example` for the full list
with comments.

| Variable | Purpose |
| --- | --- |
| `OLLAMA_HOST` | Base URL of the Ollama instance |
| `ASSISTANT_MODEL` | Ollama model tag, must be one you have pulled |
| `SYSTEM_PROMPT_FILE` / `SYSTEM_PROMPT` | Persona, overriding the bundled default |
| `AI_PREFIX` / `AI_PREFIX_MODE` | Wording and frequency of the marker |
| `REPLY_MODE` | `always` or `prefix`, default `always` |
| `COMMAND_PREFIX` | Prefix for `prefix` mode, default `/ai` |
| `ALLOWED_CONTACTS` | Comma separated sender IDs, empty allows anyone |
| `ALLOW_GROUPS` | Reply in group chats, default false |
| `MAX_REPLIES_PER_HOUR` | Per-conversation cap, default 20, zero disables |
| `IGNORE_OLDER_THAN_SECONDS` | Drops the backlog replayed on connect |
| `N8N_WEBHOOK_URL` | Optional, empty disables webhook logging |

## Keeping it running

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # then run the command it prints
```

`pm2 startup` installs a systemd unit, so the assistant comes back after a
reboot without anyone logging in. Check with `pm2 list` and `pm2 logs assistant`.

Run one instance per WhatsApp account. Two pointed at the same account both
answer every message.

## Logging to Discord

Optional. The assistant can POST each exchange to an [n8n](https://n8n.io)
webhook, which is a convenient way to watch what it has been saying without
picking up your phone.

See [docs/n8n-discord.md](docs/n8n-discord.md) for the payload shape and a
working Discord embed setup.

This forwards other people's messages into a channel. Tell them, or do not run
it.

## Troubleshooting

**It never replies to anyone.** Almost always `ALLOWED_CONTACTS` containing a
guessed `@c.us` value. Follow step 7 above and use the ID the log prints.

**It replies "Something went wrong reaching the model".** Ollama is not
reachable. The startup log says so directly, above the ready line. Check
`OLLAMA_HOST`, the port, and that the model in `ASSISTANT_MODEL` is pulled.

**It texts people the words `[your name]`.** You did not edit the prompt. See
step 4.

**Editing the prompt changes nothing.** You are editing a file that is not
winning. Read the `[prompt] loaded from` line at startup.

**It stopped replying to one person mid-conversation.** The hourly cap. There
will be a `[limit]` line in the log. Raise `MAX_REPLIES_PER_HOUR`.

**It ignores a group.** By design, see `ALLOW_GROUPS`.

**It answered a pile of old messages after a restart.** Raise
`IGNORE_OLDER_THAN_SECONDS`, or lower it to be stricter.

**Nothing arrives in Discord.** Check the `[webhook]` line at startup. An empty
or mistyped `N8N_WEBHOOK_URL` is skipped silently by design, and that line is
the only signal.

**It asks for the QR code again.** The session in `.wwebjs_auth/` was removed,
or `clientId` in `src/bots/assistant.js` changed. Scan once more.

**Replies are slow.** CPU inference is the bottleneck, not prompt length. A
smaller model helps more than a shorter prompt.

## Tests

```bash
npm test
```

Runs the real code in `src/` against stubs for axios, dotenv, whatsapp-web.js
and qrcode-terminal, so it needs no WhatsApp session, no Ollama and no
`npm install`. It exits non-zero on any failure. There is no test runner and no
dev dependency.

It covers the filters, both reply modes, prompt source priority, the marker in
all three modes, per-conversation memory, and the webhook when n8n accepts a
connection and never answers.

`HARNESS_REPO=/path/to/other/checkout npm test` runs the same checks against a
different copy of the repo, which is how you tell a suite that asserts something
from one that only appears to. Run against the sources from before the fixes
they cover, these failed 10 of 34 checks, all in the areas those fixes touched.

## Notes from building this

Things that cost time, if you fork this:

- `/v1/generate` does not exist. Ollama's `/v1` routes are the OpenAI
  compatibility layer and have no generate endpoint. Use `/api/generate`.
- Without stop sequences the model writes both sides of the conversation. It
  invents the user's next message and then answers it.
- Anything that must appear on every reply belongs in code. An earlier quiz bot
  here asked for a verdict token and scanned the prose for it. The model said
  "spot on" and "afraid not" instead, and the score drifted. Same reason the
  `[AI]` marker is attached after generation.
- Group messages arrive on the same event as direct ones. The `@g.us` suffix on
  the chat ID is the only thing that distinguishes them.
- Two auto repliers will talk to each other until someone notices. Neither is
  doing anything wrong from its own point of view.
- `Number('')` is `0`, so a blank numeric env var silently becomes zero rather
  than the default. A blank `IGNORE_OLDER_THAN_SECONDS` meant the bot answered
  nobody, and took a while to find.
- Five messages in five seconds is five concurrent requests, all reading
  conversation memory before any of them writes to it. Hence the queue.
- A single shared memory array leaks fragments of one person's conversation
  into another's.
- CPU inference is the bottleneck, not prompt length. A GPU only helps if the
  model fits in VRAM, otherwise layers spill back to system memory and the gain
  mostly disappears.
- Some models are better at raw generation than at holding a format, and drift
  out of a persona within a few turns.

## Scope and safeguards

Deliberate constraints, worth keeping if you fork this:

- The marker is applied in code, so it survives the model ignoring its
  instructions. It can be switched off, and that is a choice with someone else
  on the other end of it.
- The allowlist is opt-in per contact, and leaving it empty warns at startup.
- Groups are off by default.
- The system prompt is where the judgement lives. The default declines to make
  commitments on your behalf. If you replace it, decide what yours will not do.

## Security

- Never commit `.wwebjs_auth/`. Those are live session credentials for the
  linked account, and anyone holding them can send messages as you. It is in
  `.gitignore`; leave it there. If it has already been committed, unlink the
  device in WhatsApp immediately and rewrite the history.
- Never commit `.env`. Webhook URLs are unauthenticated endpoints.
- Automating a personal WhatsApp account is against WhatsApp's terms of service
  and accounts do get banned for it. An account that replies to everything looks
  a good deal more like automation than one that waits to be asked. Consider the
  official Business API for anything real.
- Ollama has no authentication by default. Keep it on an internal interface
  rather than exposing port 11434.
- The people messaging you did not opt into this. That is why the marker exists,
  and why the default prompt refuses to speak for you on anything that matters.

## Licence

MIT.
