# ChatLlama

A self-hosted WhatsApp assistant that messages on your behalf, privately.

It answers messages sent to your WhatsApp account while you are away from your
phone. Everything runs on your own machine, so the messages never leave it. What
the assistant sounds like is a system prompt you write, not something fixed in
the code.

## What it looks like

Generic system prompt with no n8n workflow summary or availability:

```
Sam    22:14  are you around tomorrow evening?
You    22:14  [AI] Not at my phone right now, but I have passed that on.
Sam    22:15  no rush, just wondering about the thing at 7
You    22:15  [AI] I do not want to commit to a time on their behalf. They will
                   get back to you this evening.
```

Tailored system prompt for the AI, including adding in your availability:

```
Sam    19:41  yo you around this weekend? thinking of doing something sat
You    19:41  [AI] hey, it's jack's assistant — he's off his phone right now but
                   i can help. his saturday's open as far as i can see, what were
                   you thinking?
Sam    19:42  climbing at the depot maybe, then food after
You    19:42  [AI] he may be into that.. i can't lock a time
                   for him though — what slot are you looking at and i'll flag it
                   for him to confirm?
Sam    19:43  like 11ish? and can you just book it
You    19:43  [AI] 11 works with his morning. booking + paying's his call not
                   mine, so i'll pass it up — but consider it a soft yes from his
                   end, he just does the final tap himself.
Sam    19:44  haha fair. also is he still skint or can he do the nice food place
You    19:44  [AI] that one's above my pay grade, i'm not touching his budget.
                   i'll let him answer the food question directly.
Sam    19:45  no worries. tell him to text me
You    19:45  [AI] will do.


n8n's summary: climbing sat ~11 at the depot with sam, food after. told sam soft yes on climbing.
waiting on you: confirm+book the 11am slot, and the food question (depot
cafe vs the nice place — sam asked about budget, i didn't answer).
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
git clone https://github.com/jackghx/chatllama
cd ChatLlama
npm install
cp .env.example .env
```

### 3. Point it at Ollama

Edit `.env` and set `OLLAMA_HOST`. If Ollama runs on the same machine:

```
OLLAMA_HOST=http://127.0.0.1:11434
```

### 4. Pick a persona

**Do this before you connect WhatsApp.** `prompts/assistant.md` is the one that
runs by default, and it ships filled in with the author's own details as a
worked example. Left alone, it will tell your friends it works for Jack.

`prompts/scenarios/` holds templates to start from instead. They differ in what
the assistant is allowed to say, not just in tone:

| File | For |
| --- | --- |
| `away-from-phone.md` | The general purpose one. Start here. |
| `strict.md` | Says nothing, agrees to nothing, takes messages only. |
| `scheduling.md` | Collects day, time and place so you can confirm in one go. |
| `annual-leave.md` | Away until a date, with a route for anything urgent. |
| `work-hours.md` | A work number after hours. Businesslike, careful with client detail. |
| `screening.md` | Unknown numbers. Works out who is writing and shuts down sales. |
| `close-contacts.md` | Friends and family. Warmer, same refusals underneath. |
| `as-you.md` | Replies as you rather than as an assistant. A joke, with conditions. |
| `minimal.md` | The shortest one worth running. Small models hold it better. |

Every one contains `[bracketed]` placeholders. Replace all of them, or the
assistant will text people the word `[your name]`.

Point at your choice, and copy it outside the repo first if you do not want a
`git pull` touching your wording:

```
SYSTEM_PROMPT_FILE=prompts/scenarios/away-from-phone.md
```

See [Writing a good prompt](#writing-a-good-prompt) below.

### 5. Hear it before anyone else does

```bash
npm run assistant:sim
```

This runs the assistant against your terminal with no WhatsApp connection. Type
messages as if you were the other person. Go back and edit the prompt until the
replies sound like something you would be happy to have sent in your name.

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
[digest] every 10 quiet minutes, or 15 exchanges
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
`447700900000@c.us` will simply never match. Get the real values from the bot:

```
CAPTURE_IDS=true
```

Restart, have each person message you once, and read the log:

```
[capture] on, logging sender IDs and answering nobody. Turn it off once
          ALLOWED_CONTACTS is filled in.
[capture] 183765432109876@lid
[capture] 274839201847362@lid
```

Capture mode answers nobody, so nothing goes out while you collect the list.
Each sender is logged once per run rather than once per message.

Paste them in as a comma separated list, turn capture off, and restart:

```
ALLOWED_CONTACTS=183765432109876@lid,274839201847362@lid
CAPTURE_IDS=false
```

## Writing a good prompt

The prompt is loaded from the first of these that exists:

1. `SYSTEM_PROMPT_FILE`, a path to a text or markdown file
2. `SYSTEM_PROMPT`, an inline string
3. `prompts/assistant.md`, the bundled default

Whichever wins is logged at startup, so if your edits appear to do nothing,
check that line first. It is usually the answer.

Things worth putting in yours:

- **How you actually text.** Length, punctuation, whether you use full stops.
  The templates are deliberately plain, and plain is not the same as sounding
  like you.
- **What it must not do.** They all decline to accept invitations, agree times,
  discuss money or speculate about where you are. Keep that, or decide what
  yours refuses instead. A model that cheerfully accepts a dinner invitation on
  your behalf is not a feature.
- **The one or two things it may say.** Every exception has to be written down
  or the model will not make it. `scheduling.md` names the days you keep free
  and nothing else about your diary, which is enough to save a round trip
  without letting it invent a slot.
- **What to say when it does not know.** They say so plainly and offer to pass a
  message on, which is almost always better than a guess.

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

### Replying as yourself

`prompts/scenarios/as-you.md` writes in the first person and never mentions an
assistant. It is the one people find funny, and it needs two settings or it does
not work at all:

```
AI_PREFIX_MODE=never
ALLOWED_CONTACTS=<the people in on it>
```

The marker would otherwise prefix every line, and without the allowlist the joke
runs on everyone who has your number rather than on your friends.

The prompt hedges instead of agreeing to things, which is both funnier and the
reason nobody ends up waiting outside a pub for you. It also folds the moment
somebody asks directly whether it is a bot, and says so rather than denying it.
That line is deliberate. Playing along with people who are playing along is a
joke, and lying to someone who has actually stopped to ask is not.

Worth knowing what you are doing: friends texting your number get replies they
believe are yours, with nothing marking them. That is fine for an afternoon and
it is a different thing left running for a month, particularly for whoever tells
you something that mattered to them and gets a decent impression of you back.

## Reply modes

| Mode | Behaviour |
| --- | --- |
| `always` | Replies to every message that passes the filters. The default. |
| `prefix` | Replies only to messages starting with `COMMAND_PREFIX`, default `/ai`. |

`prefix` is useful while you are still tuning, since nothing goes out unless
somebody asks for it by name. `COMMAND_PREFIX` is ignored in `always` mode.

## When someone corrects themselves

People text in fragments, and a reply takes long enough that the next fragment
usually lands mid-generation:

```
Sam    19:41  hey jack are you up on tuesday
Sam    19:41  oh wait actually thursday
```

Generation starts on the first message immediately. When the second arrives, the
in-flight request is cancelled, the two lines are joined into one turn, and the
reply is written again from the top. Sam gets one answer about Thursday rather
than an answer about Tuesday followed by a correction.

Cancelling closes the socket, which stops Ollama generating rather than only
throwing away the result, so an interrupted reply costs the seconds it had run
and no more. Worth confirming on your own host, since it is the assumption the
whole thing rests on:

```bash
curl -s http://<your ollama host>:11434/api/generate -d '{"model":"llama3.1:8b","prompt":"write 800 words about canals","stream":false}' & sleep 3; kill %1
time curl -s http://<your ollama host>:11434/api/generate -d '{"model":"llama3.1:8b","prompt":"hi","stream":false}' -o /dev/null
```

If the second call returns in its usual time, cancellation is working.

`MAX_INTERRUPTS`, default 3, caps how many times one reply may be scrapped and
started again. Without a cap, somebody texting faster than the model generates
would never get an answer at all. Past the cap the reply is finished and sent,
and anything further is answered separately. `0` turns the whole thing off and
answers every message on its own.

A correction does not count against `MAX_REPLIES_PER_HOUR`, because it does not
produce a reply of its own. Look for this in the log:

```
[assistant] <- sam@lid: hey jack are you up on tuesday
[assistant] <- sam@lid: oh wait actually thursday
[assistant] .. sam@lid: amended, writing it again
[assistant] -> sam@lid: [AI] thursday is easier for me to pass on, what time?
```

## What it will not answer

Replying to everything is a much larger surface than replying on request, so
some things are filtered out before the model is ever called.

**Group chats.** Ignored unless `ALLOW_GROUPS=true`. An auto replier in a group
answers every member's every message. Status broadcasts are always ignored.

**Runaway loops.** `MAX_REPLIES_PER_HOUR`, default 20, caps replies per
conversation over a rolling hour, then pauses that conversation and logs it
once. This is what stops two auto repliers, or this one and an out of office
bot, from talking to each other all night. Zero disables it.

When the cap is reached the sender gets one message saying so, since otherwise
the assistant simply stops mid-conversation and they are left wondering. It is
sent once per breach, not once per message, or it would become the runaway loop
it exists to stop. `RATE_LIMIT_NOTICE` sets the wording, and an empty value
sends nothing and returns to plain silence.

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
| `OLLAMA_THINK` | `false` turns reasoning off, empty leaves the field unsent |
| `SYSTEM_PROMPT_FILE` / `SYSTEM_PROMPT` | Persona, overriding the bundled default |
| `AI_PREFIX` / `AI_PREFIX_MODE` | Wording and frequency of the marker |
| `REPLY_MODE` | `always` or `prefix`, default `always` |
| `COMMAND_PREFIX` | Prefix for `prefix` mode, default `/ai` |
| `ALLOWED_CONTACTS` | Comma separated sender IDs, empty allows anyone |
| `CAPTURE_IDS` | Logs sender IDs and answers nobody, for filling in the line above |
| `ALLOW_GROUPS` | Reply in group chats, default false |
| `MAX_REPLIES_PER_HOUR` | Per-conversation cap, default 20, zero disables |
| `MAX_INTERRUPTS` | Restarts allowed when a sender adds to a reply in progress, default 3 |
| `RATE_LIMIT_NOTICE` | Sent once when a conversation hits the cap, empty sends nothing |
| `IGNORE_OLDER_THAN_SECONDS` | Drops the backlog replayed on connect |
| `N8N_WEBHOOK_URL` | Optional, empty disables webhook logging |
| `WEBHOOK_IN_SIM` | Fire the webhook from terminal simulation too, default false |
| `SUMMARY_IDLE_MINUTES` | Silence before a conversation is summarised, zero disables |
| `SUMMARY_MAX_MESSAGES` | Summarise anyway at this many exchanges, default 15 |

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

For a container or a headless server, see
[docs/deploy-lxc.md](docs/deploy-lxc.md). It covers what runs where, the
Chromium libraries a minimal Debian does not have, and the handful of things
that fail with no useful error message.

## Notifications via n8n

Optional, and off until `N8N_WEBHOOK_URL` is set. The assistant POSTs JSON to an
[n8n](https://n8n.io) webhook, which is how you find out what was said in your
name without picking up your phone. n8n self-hosts, so this does not have to
put anything in someone else's cloud.

It sends two kinds of event, told apart by the `event` field on one URL:

| Event | When | Carries |
| --- | --- | --- |
| `ai_message` | Every exchange | The message in, the reply as sent |
| `conversation_summary` | Once, when the conversation goes quiet | A briefing, the exchange count, the transcript |

The summary is the one worth notifying yourself on. A busy Saturday becomes one
message rather than twenty, and the briefing names what the assistant would not
decide for you: the invitation it deferred, the time it would not agree, the
question about money it left alone. Route `ai_message` somewhere quiet, or drop
it on the floor.

Summaries wait for silence. Every reply resets that conversation's timer, and
`SUMMARY_IDLE_MINUTES` of quiet closes it. `SUMMARY_MAX_MESSAGES` forces one for
a conversation that never pauses, and stopping the process flushes whatever was
still waiting. The `reason` field on the event says which of the three it was.

### Asking what you missed

Once summaries are landing you can have a Discord slash command answer "what did
I miss" from them: store each summary as it arrives, and on `/missed` feed the
last day of rows back through Ollama as one briefing. That is a second n8n
workflow and no change to this repo, and the steps are in
[docs/n8n-discord.md](docs/n8n-discord.md).

The history lives wherever that workflow stores it, not here. Both POSTs are
fire and forget with no retry and nothing written locally, so a summary that
fires while n8n is down is gone, and `/missed` cannot know it is missing. Worth
knowing before you rely on it as a record rather than a notification.

### Before you turn it on

This forwards other people's messages into a channel. They are writing to what
they believe is your phone, and a channel is a good deal less private than a one
to one chat. Tell them, or do not run it.

## Troubleshooting

**It never replies to anyone.** Almost always `ALLOWED_CONTACTS` containing a
guessed `@c.us` value, or `CAPTURE_IDS` left on. Set `CAPTURE_IDS=true`, have
the person write in, and compare the ID it prints against what you have.

**It replies "Something went wrong reaching the model".** Ollama is not
reachable. The startup log says so directly, above the ready line. Check
`OLLAMA_HOST`, the port, and that the model in `ASSISTANT_MODEL` is pulled.

**It texts people the words `[your name]`.** You did not edit the prompt. See
step 4.

**Editing the prompt changes nothing.** You are editing a file that is not
winning. Read the `[prompt] loaded from` line at startup.

**It stopped replying to one person mid-conversation.** The hourly cap. There
will be a `[limit]` line in the log, and they will have been sent
`RATE_LIMIT_NOTICE` explaining it. Raise `MAX_REPLIES_PER_HOUR`.

**It ignores a group.** By design, see `ALLOW_GROUPS`.

**It answered a pile of old messages after a restart.** Raise
`IGNORE_OLDER_THAN_SECONDS`, or lower it to be stricter.

**Nothing arrives in Discord.** Check the `[webhook]` line at startup. An empty
or mistyped `N8N_WEBHOOK_URL` is skipped silently by design, and that line is
the only signal.

**Messages arrive but summaries never do.** Summaries wait for silence, so a
conversation still in progress has not produced one yet. Check the `[digest]`
line at startup, and look for `[digest] <id>: n exchange(s)` in the log when a
conversation ends. Summaries are also skipped entirely when there is no webhook
URL, since there would be nowhere to send them.

**It asks for the QR code again.** The session in `.wwebjs_auth/` was removed,
or `clientId` in `src/bots/assistant.js` changed. Scan once more.

**Replies are slow.** CPU inference is the bottleneck, not prompt length. A
smaller model helps more than a shorter prompt. If the model is a reasoning one,
it is thinking before every reply and none of that reasoning is used here. Set
`OLLAMA_THINK=false`.

**It texted someone its own reasoning.** A model whose template writes thinking
into the reply rather than into Ollama's separate field. `<think>` blocks are
stripped in code, so a reply that reached anyone means the model used different
tags. Set `OLLAMA_THINK=false`, or use a model that does not reason.

## Tests

```bash
npm test
```

Runs the real code in `src/` against stubs for axios, dotenv, whatsapp-web.js
and qrcode-terminal, so it needs no WhatsApp session, no Ollama and no
`npm install`. It exits non-zero on any failure. There is no test runner and no
dev dependency.

It covers the filters, both reply modes, contact ID capture, prompt source
priority, the marker in all three modes, per-conversation memory, the summary
debounce, and the webhook when n8n accepts a connection and never answers.

`HARNESS_REPO=/path/to/other/checkout npm test` runs the same checks against a
different copy of the repo, which is how you tell a suite that asserts something
from one that only appears to. Run against the commit before contact capture was
added, these fail 7 of 112, all of them in the section covering it.

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
