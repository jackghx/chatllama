# ChatLlama

A self-hosted WhatsApp assistant that messages on your behalf, privately.

By default the person who messages you gets a fixed reply, with no model in the
path. It is instant, it cannot drift, and it cannot say anything in your name
that you did not write. The model works on your side of the fence instead: when
the conversation goes quiet it reads the whole thread and tells you how urgent it
is, what they actually wanted, and what you might send back. If you like the
draft, n8n can hand it to the send endpoint and it goes out for real.

Anyone who does want an answer there and then can send `/ai` and a question,
which is the one job a model is genuinely better at than a canned string:
picking the right answer to the question actually asked.

That is the default. `REPLY_MODE=always` puts the model back in front of every
message if you would rather it answered directly, and what it sounds like is a
system prompt you write.

**Upgrading from 2.x?** Two things changed underneath you. See
[Upgrading to 3.0](#upgrading-to-30).

## What it looks like

The default. A fixed reply goes out instantly, and the briefing that reaches you
is the part the model wrote:

```
Sam    19:41  yo you around this weekend? thinking of doing something sat
You    19:41  [AI] Nobody is watching this number at the moment. Send everything
                   in one go rather than waiting for a reply, and it will get
                   read. If you want an answer now, start a message with /ai.
Sam    19:42  climbing at the depot, 11ish? need to know by friday to book


to you, via n8n, once it goes quiet:
  today | Sam wants to climb at the Depot on Saturday around 11, and needs to
          know by Friday so he can book.
  draft | 11 on Saturday works. Book it and I will send you my half.
                                                        [ send ]  [ edit ]
```

Set `REPLY_MODE=always` instead and the model answers people directly. A generic
system prompt, with no availability given to it:

```
Sam    22:14  are you around tomorrow evening?
You    22:14  [AI] Not at my phone right now, but I have passed that on.
Sam    22:15  no rush, just wondering about the thing at 7
You    22:15  [AI] I do not want to commit to a time on their behalf. They will
                   get back to you this evening.
```

And a tailored one, with your availability written into it:

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
runs by default, and it is mine, filled in rather than left as a template. Leave
it alone and it will tell your friends it works for me.

The persona is what the model says. On the default `auto` mode that is only the
replies to `/ai`, since everything else gets `AUTO_REPLY_TEXT` with no model
involved. On `REPLY_MODE=always` it is every reply, which is what the files
below are written for. Either way it does not affect the briefings that reach
you, which come from `prompts/triage.md`.

`prompts/scenarios/` holds files to start from instead. They differ in what the
assistant is allowed to say rather than only in tone, and the first three are
the ones that do something you could not get by reading the messages later:

| File | For |
| --- | --- |
| `known-answers.md` | Answers a short list of things you have told it, instead of taking a message about them. |
| `intake.md` | Gets the whole question out of people so you can close it in one reply. |
| `holiday.md` | Away until a date, capturing enough that you can answer when you land. |
| `take-a-message.md` | Tells people what the thing is and asks for it all in one go. Nearly a fixed auto reply. |
| `strict.md` | Says nothing and agrees to nothing. For week one, while you are still reading the logs. |
| `work-hours.md` | A work number after hours. No prices, no deadlines, no comment on another client. |
| `screening.md` | Unknown numbers. Treats the sender as unverified and shuts down sales. |
| `close-contacts.md` | Friends and family, who find a formal assistant strange. |

And some that are only for people who are in on it:

| File | Voice |
| --- | --- |
| `as-you.md` | You, not an assistant. Needs `AI_PREFIX_MODE=never`. |
| `annoying.md` | Answers every question with three more. Cheerfully useless. |
| `brainrot.md` | Internet slang, all lower case, no punctuation. |
| `corporate.md` | Treats a pub invitation as a resourcing decision. |
| `noir.md` | 1940s detective. Your Thursday is a case. |
| `victorian.md` | A butler of the 1890s, unruffled by anything. |
| `commentator.md` | Calls the conversation like a live match. |

Set `ALLOWED_CONTACTS` before running any of those, so they only reach people
who will find them funny. They keep the same refusals underneath the voice: no
times, no plans, no money, and nothing invented about where you are.

The personas name nobody and have nothing to fill in, `as-you.md` aside. The
serious templates all contain `[bracketed]` placeholders, and you have to
replace every one or the assistant will text people the word `[your name]`.

Point at your choice, and copy it outside the repo first if you do not want a
`git pull` touching your wording:

```
SYSTEM_PROMPT_FILE=prompts/scenarios/intake.md
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

Write phone numbers, with the country code and no punctuation:

```
ALLOWED_CONTACTS=447700900123,447700900456
```

They are not what arrives on a message. WhatsApp is moving from phone-number
identifiers to opaque `<id>@lid` ones, and a LID does not resemble the number it
belongs to, so a hand-written `447700900000@c.us` may never match. The bot
resolves the numbers for you at startup and reports what it found:

```
[contacts] 4 identifier(s) allowed, from 2 entr(y/ies)
```

The results are cached under `.cache/`, so a restart costs no lookups. Delete
that file to force a fresh resolution. Only the phone-to-LID direction is used;
nothing ever tries to work backwards from an identifier that arrives, because
that lookup fails often enough to be useless.

A number that cannot be resolved is named rather than passed over:

```
[contacts] could not resolve: 447700900999. Check the country code and that the
           number is on WhatsApp.
```

That contact is then only matched if they still write in from a phone-number
identifier. The rest keep working: one bad entry does not lock everybody out,
and a lookup that fails never opens the allowlist up, only narrows it.

If somebody is being ignored and you want to know why, turn on `CAPTURE_IDS`. It
answers nobody and logs each sender once, with whether they matched:

```
[capture] 183765432109876@lid allowed
[capture] 274839201847362@lid not allowed
```

An entry containing an `@` is taken exactly as written and never looked up, so
identifiers collected the old way still work, and it is the way out if
resolution is ever broken for you.

That matters more now WhatsApp has usernames. Somebody who found you by username
may reach you without you ever having their number, and there is no way back
from the identifier on their message to a number to put in the list. They will
be ignored, which is the safe failure but still a failure. Capture their `@lid`
with `CAPTURE_IDS` and paste it in literally, which is the one case the capture
flow is still the right tool for.

## Writing a good prompt

The prompt is loaded from the first of these that exists:

1. `SYSTEM_PROMPT_FILE`, a path to a text or markdown file
2. `SYSTEM_PROMPT`, an inline string
3. `prompts/assistant.md`, the bundled default

Whichever wins is logged at startup, so if your edits appear to do nothing,
check that line first. It is usually the answer.

What to put in yours:

- **How you text.** Length, punctuation, whether you use full stops. The
  templates are plain on purpose, and plain is not the same as sounding like
  you.
- **What it must not do.** They all decline to accept invitations, agree times,
  discuss money or speculate about where you are. Keep that, or decide what
  yours refuses instead. A model that cheerfully accepts a dinner invitation on
  your behalf is not a feature.
- **The handful of things it may say.** This is where the usefulness lives, and
  every exception has to be written down or the model will not make it.
  `known-answers.md` is built around that list. Keep it to facts you would tell
  anyone with your number and that will still be true next week.
- **What to say when it does not know.** They say so plainly and offer to pass a
  message on, which is almost always better than a guess.

HTML comments are stripped before the model sees the prompt, so you can leave
notes to yourself in the file.

Small models drift out of a persona after a few turns, and a long prompt drifts
sooner than a short one. If yours keeps wandering, cut it down before you blame
the model.

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

The prompt hedges rather than agreeing to things, which is funnier and also why
nobody ends up waiting outside a pub for you. Ask it directly whether it is a
bot and it says yes. I put that line in on purpose: someone playing along is in
on it, someone who stops to ask is not, and the joke stops being one at that
point.

Know what you are switching on, though. Friends texting your number get replies
they think are yours, with nothing marking them. Fine for an afternoon. Less so
after a month, and less so again for whoever tells you something that mattered
to them and gets a passable impression of you back.

## Reply modes

| Mode | Behaviour |
| --- | --- |
| `auto` | A fixed reply to everything, and the model only on `COMMAND_PREFIX`. The default. |
| `always` | The model replies to every message that passes the filters. |
| `prefix` | The model replies only to `COMMAND_PREFIX`, and everything else is ignored. |
| `off` | Nothing is answered at all. |

`auto` is the one to run. The fixed reply is instant, so nobody waits eight
seconds for a sentence that was never going to answer their question anyway, and
it cannot say anything you did not write. `AUTO_REPLY_TEXT` holds the wording,
and the default tells people they can send `/ai` if they want a real answer.

Leaving `AUTO_REPLY_TEXT` empty makes `auto` behave exactly as `prefix`, which
is what you want if you would rather send nothing at all than send a canned line.

`always` is the behaviour from 2.x, with the model in front of every message.
`prefix` is useful while you are still tuning a persona, since nothing goes out
unless somebody asks for it by name.

The fixed reply is sent once per fresh burst of contact, not once per message.
The gap is measured from the last time that person wrote, so five messages in a
row get one reply, and somebody coming back tomorrow gets another.
`AUTO_REPLY_GAP_MINUTES` sets it, and `AUTO_REPLY_MAX_PER_DAY` is a floor under
it so a slow trickle of messages cannot text somebody every hour all day.

### The prefix is only needed once

Nobody remembers to type `/ai` on every message, including you. Ask a question
with the prefix, get an answer, then ask the obvious follow-up without it, and
a bot that insisted on the prefix would send the canned line in the middle of
your conversation and make you type the whole thing again.

So once somebody has reached the model, they keep reaching it. Every answered
message restarts a `FOLLOW_UP_MINUTES` window, default 15, measured from their
last answer rather than from the prefix, so a conversation that keeps going
keeps going and one that stops falls back to the fixed reply on its own. It is
per conversation: one person opening up does not open up anybody else.

Set `FOLLOW_UP_MINUTES=0` to require the prefix on every single message.

A plain message that arrives while the model is already writing an answer for
that person joins that answer rather than starting another one, so two messages
in a row get one reply to both. With follow-up off it is recorded and not
replied to instead, because firing the canned line into the middle of a real
answer, seconds before it lands, reads as a glitch.

Everything they send is written into the transcript whether or not it earned a
reply, so the briefing covers the whole conversation rather than only the
message that happened to trigger something.

## Steering it from your own phone

Type a command into your own Note to Self chat and the bot obeys. No SSH, no
n8n, no restart.

| Command | Effect |
| --- | --- |
| `/ai status` | What mode it is in, what the fixed reply says, how many contacts are allowed |
| `/ai off` | Answers nothing, and drops any reply it was in the middle of writing |
| `/ai on` | Back to the configured `REPLY_MODE` |
| `/ai away 2h in a meeting` | Fixed replies for two hours, using that wording instead of `AUTO_REPLY_TEXT` |
| `/ai away` | The same with no end time, until you send `/ai back` |
| `/ai back` | Clears away and returns to the configured mode |

Durations are a number and a unit, spelled however you like:

| Unit | Accepts | Example |
| --- | --- | --- |
| Minutes | `m`, `min`, `mins`, `minute`, `minutes` | `/ai away 30m at the gym` |
| Hours | `h`, `hr`, `hrs`, `hour`, `hours` | `/ai away 2 hours in a meeting` |
| Days | `d`, `day`, `days` | `/ai away 3d in Berlin` |
| Weeks | `w`, `wk`, `wks`, `week`, `weeks` | `/ai away 1w on holiday` |

Months and years are not accepted, and neither are clock times or dates. There
is no parsing of "until 6", because six is in the morning, in the evening, or
tomorrow, in a timezone nobody stated, and getting it wrong means the bot
answers for you when you thought it had stopped. Anything longer than a couple
of weeks is a change to `AUTO_REPLY_TEXT` rather than a temporary state, since
away is held in memory and does not survive a restart.

A duration it cannot read is refused rather than guessed at. `/ai away 2mo` or
`/ai away 6pm` tells you what is valid and changes nothing, because the
alternative is being away with no end date while people are texted the word
"2mo".

Anything after the duration is the wording people get, sent underneath
`AUTO_REPLY_TEXT` rather than instead of it:

```
Nobody is watching this number at the moment. Send everything in one go
rather than waiting for a reply, and it will get read. If you want an
answer now, start a message with /ai.

Reason: at the gym
```

That way setting a reason does not cost people the line telling them how to
reach the model. Leave the duration off entirely and it stays away until you
send `/ai back`.

`OWNER_COMMANDS` defaults to `self`, meaning only your own chat counts. This
matters: `/ai off` typed into a friend's chat is a message you have just sent
that friend, and they can read it. `any` accepts commands from any one-to-one
chat. Commands are never read from a group, where the acknowledgement would be
public. Set `OWNER_COMMAND_ACK=false` if you would rather it obeyed silently.

Commands replayed from the backlog on reconnect are ignored, so an old `/ai off`
in your history does not switch the bot off every time it restarts.

If a command does nothing, the log says why. A message starting with the prefix
that was not accepted prints `command from <id> ignored: <reason>`, and startup
prints a `[commands]` line naming the chat it will read them from.

That line usually names two identifiers. WhatsApp reports your account as a
phone number but keys the chat with yourself by its linked ID, and a message you
sent carries nothing joining the two, so your own ID is resolved at startup and
both forms are accepted. If that lookup fails it says so, and `OWNER_COMMANDS=any`
is the way round it.

## Sending a message from n8n

`SEND_API_PORT` starts a small HTTP endpoint that hands a message to the bot to
send. This is what turns a drafted reply into one you approve with a tap.

```bash
KEY=$(openssl rand -hex 32); echo "$KEY"; printf %s "$KEY" | sha512sum
```

Keep the key, put the digest in `.env`, and the key in whatever calls it:

```
SEND_API_PORT=3111
SEND_API_HOST=0.0.0.0
SEND_API_KEY_SHA512=<the digest>
```

```bash
curl -X POST http://192.168.0.50:3111/send \
  -H 'x-api-key: <the key>' -H 'content-type: application/json' \
  -d '{"to":"183765432109876@lid","text":"yeah 11 works, book it"}'
```

It answers `202` once the message is queued rather than waiting for it to go
out, since the queue can be sitting behind a two-minute generation. A message
sent this way cancels whatever the model was writing for that conversation, so
your reply replaces the machine's rather than arriving alongside it.

It will not start without a key. An endpoint reachable on a LAN with no
credential is a spam relay wired to a real phone number. It also only messages
people already in `ALLOWED_CONTACTS` unless you set `SEND_API_ALLOW_ANY=true`,
so a leaked key cannot message anybody at all from your number. Keep it off any
port forward.

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

When the cap is reached the sender gets one message saying so. Without it the
assistant stops mid-conversation and they are left wondering why. It goes out
once per breach rather than once per message, or it would become the runaway
loop it is there to stop. `RATE_LIMIT_NOTICE` sets the wording, and an empty
value sends nothing.

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
| `OLLAMA_KEEP_ALIVE` | How long Ollama holds the model loaded, e.g. `30m` or `-1`. Empty uses its default |
| `SYSTEM_PROMPT_FILE` / `SYSTEM_PROMPT` | Persona, overriding the bundled default |
| `AI_PREFIX` / `AI_PREFIX_MODE` | Wording and frequency of the marker |
| `REPLY_MODE` | `auto`, `always`, `prefix` or `off`, default `auto` |
| `COMMAND_PREFIX` | What someone sends to reach the model, default `/ai` |
| `AUTO_REPLY_TEXT` | The fixed reply in `auto` mode, empty sends nothing |
| `AUTO_REPLY_GAP_MINUTES` | Silence before the same person gets it again, default 60 |
| `FOLLOW_UP_MINUTES` | How long a conversation keeps reaching the model without the prefix, default 15. 0 requires it every time |
| `AUTO_REPLY_MAX_PER_DAY` | Ceiling per contact per day, default 3, zero removes it |
| `ALLOWED_CONTACTS` | Comma separated phone numbers, empty allows anyone |
| `CONTACT_CACHE_FILE` | Where resolved identifiers are kept, default `.cache/identity.json` |
| `CONTACT_CACHE_TTL_DAYS` | How long before a resolved identifier is looked up again, default 30 |
| `CONTACT_RESOLVE_DELAY_MS` | Pause between lookups, which WhatsApp rate limits, default 500 |
| `CAPTURE_IDS` | Logs each sender and whether they matched, answering nobody |
| `OWNER_COMMANDS` | `off`, `self` or `any`, default `self` |
| `OWNER_COMMAND_ACK` | Whether a command is confirmed back to you, default true |
| `ALLOW_GROUPS` | Reply in group chats, default false |
| `MAX_REPLIES_PER_HOUR` | Per-conversation cap, default 20, zero disables |
| `MAX_INTERRUPTS` | Restarts allowed when a sender adds to a reply in progress, default 3 |
| `RATE_LIMIT_NOTICE` | Sent once when a conversation hits the cap, empty sends nothing |
| `IGNORE_OLDER_THAN_SECONDS` | Drops the backlog replayed on connect |
| `N8N_WEBHOOK_URL` | Optional, empty disables webhook logging |
| `WEBHOOK_IN_SIM` | Fire the webhook from terminal simulation too, default false |
| `SUMMARY_IDLE_MINUTES` | Silence before a conversation is summarised, zero disables |
| `SUMMARY_MAX_MESSAGES` | Summarise anyway at this many exchanges, default 15 |
| `SUMMARY_FORMAT` | `json` for fields n8n can branch on, or `prose`, default `json` |
| `SUMMARY_MODEL` | A better model for the briefing, empty uses `ASSISTANT_MODEL` |
| `SUMMARY_TIMEOUT_MS` | How long a briefing may take, default 300000. Separate from the reply budget |
| `SEND_API_PORT` | Starts the send endpoint, empty disables it |
| `SEND_API_HOST` | What it binds to, default `127.0.0.1` |
| `SEND_API_KEY_SHA512` | SHA-512 of the key, without which it refuses to start |
| `SEND_API_MAX_PER_MINUTE` | Ceiling for the endpoint as a whole, default 30 |
| `SEND_API_ALLOW_ANY` | Let it message people not on the allowlist, default false |

## Upgrading to 3.0

Two things changed that will not carry over on their own.

**`ALLOWED_CONTACTS` now holds phone numbers.** Existing `@lid` values still
work, because any entry containing an `@` is used exactly as written. So you can
leave it alone. Replacing them with plain numbers is worth doing anyway: the
numbers survive WhatsApp reassigning an identifier, and you can read them.

**`REPLY_MODE` now defaults to `auto`.** If you upgrade and change nothing, the
model stops replying to people directly and they get `AUTO_REPLY_TEXT` instead,
with the model reachable on `/ai`. Set `REPLY_MODE=always` for exactly the old
behaviour.

Also worth knowing: `SUMMARY_FORMAT` defaults to `json`, so the summary webhook
gains a `triage` object. Nothing is removed, `summary` is still the string it
was, and `SUMMARY_FORMAT=prose` puts the old briefing back.

`npm install` is needed. The minimum whatsapp-web.js is now 1.34.7, which is the
version that can resolve a phone number to an identifier.

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
| `ai_message` | Every exchange | The message in, the reply as sent, and `automatic` saying whether the model wrote it |
| `conversation_summary` | Once, when the conversation goes quiet | A briefing, the triage fields, the exchange count, the transcript |

Notify yourself on the summary and leave the other one alone. A busy Saturday
becomes one message rather than twenty. Route `ai_message` somewhere quiet, or
drop it.

The summary carries a `triage` object, which is the part worth building on:

```json
{
  "event": "conversation_summary",
  "from": "183765432109876@lid",
  "reason": "idle",
  "messages": 4,
  "summary": "Sam wants to climb on Saturday. Needs an answer by Friday.",
  "triage": {
    "urgency": "today",
    "wants": "Sam wants to climb on Saturday, and the booking is still yours to make.",
    "deadline": "Friday",
    "draftReply": "Saturday works. I will sort the booking tonight."
  },
  "transcript": ["User: ...", "Assistant: ..."]
}
```

Switch on `triage.urgency`, which is always one of `now`, `today` or `whenever`.
Send `now` somewhere that buzzes your watch and `whenever` to a channel you read
on Sunday. That is the thing a fixed auto-reply cannot do for you, and it is why
there is a model here at all: not to talk to your friends, but to work out which
of them actually needs you.

`triage.draftReply` is written as you, in the first person, for you to send. Put
it behind a Discord button wired to the [send endpoint](#sending-a-message-from-n8n)
and answering people becomes one tap. Nothing it drafts is ever sent on its own.

`triage` is `null` when the model failed to produce the fields, so a workflow can
tell "nothing urgent" apart from "no answer". `summary` is always a string, so an
existing workflow reading it keeps working, and `SUMMARY_FORMAT=prose` restores
the old free-text briefing for a model too small to hold a schema.

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
they believe is your phone, and a channel is a lot less private than a one
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

**`[digest] summary generation failed: timeout`, while replies are fine.** The
briefing is the slower of the two jobs even though it looks smaller. A schema
constrains every token it writes, and by the time it runs the conversation has
been idle for `SUMMARY_IDLE_MINUTES`, which on the default of 10 is past
Ollama's own five-minute `keep_alive`, so the model has been unloaded and the
call pays to load it back off disk before generating anything.

Deal with the load first, because it costs nothing and it is usually most of the
time. `OLLAMA_KEEP_ALIVE=30m` pins the model in memory across the idle window,
so the briefing runs warm. It is sent per request, so it holds the model this
bot uses and does not change how that machine treats anything else. Setting
`SUMMARY_IDLE_MINUTES` below 5 does the same job by fitting inside Ollama's own
default, at the cost of briefings that arrive sooner and split a slow
conversation in two.

If it is still tight after that, raise `SUMMARY_TIMEOUT_MS`. Nobody is waiting
on a briefing, so it can have as long as it needs. Raising `OLLAMA_TIMEOUT_MS`
is the wrong lever: that one is how long somebody sits looking at their phone.

Only then start giving things up. `SUMMARY_MODEL` can point at something smaller
than the one answering, and `SUMMARY_FORMAT=prose` drops the schema entirely and
is the fastest option going, at the cost of the fields n8n branches on.

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

Constraints I put in on purpose. Keep them if you fork this:

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
  far more like automation than one that waits to be asked. Consider the
  official Business API for anything real.
- Ollama has no authentication by default. Keep it on an internal interface
  rather than exposing port 11434.
- The people messaging you did not opt into this. That is why the marker exists,
  and why the default prompt refuses to speak for you on anything that matters.

## Licence

MIT.
