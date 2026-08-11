# Controlling the assistant from Discord

`docs/n8n-discord.md` covers messages going out. This covers commands coming
back in, and a status light in a channel so you can tell at a glance whether the
thing is still running.

The shape matters more than any single step here. Discord is the control
surface. n8n is the only component with a public address, and the only thing
that ever talks to ChatLlama. ChatLlama itself stays on the LAN and is not
reachable from the internet at any point.

```
            +-----------------------------------+
            |  Discord   (private server)       |
            |                                   |
            |  /chatllama ...        #status    |
            +-----------------------------------+
                |                          ^
       signed   |                          |  incoming webhook
       POST     |                          |  (outbound only)
                v                          |
            +-----------------------------------+
            |  n8n    https://n8n.jackghx.com   |  the only public thing
            +-----------------------------------+
                |                          ^
    x-api-key,  |                          |  N8N_WEBHOOK_URL
    LAN only    v                          |
            +-----------------------------------+
            |  ChatLlama   127.0.0.1:<port>     |  never port forwarded
            |  /send    /health    /command     |
            +-----------------------------------+
```

The reason this needs a document at all is that the Discord webhook you already
have is strictly outbound. An incoming webhook URL is a thing you post to. It
cannot receive, it cannot be subscribed to, and there is no setting that changes
that. So the return path has to come from somewhere else, and that somewhere is
either an interactions endpoint or a gateway bot.

## The endpoints being controlled

ChatLlama's send API gains two endpoints beside the existing `/send`. Same port,
same `x-api-key` header, same SHA-512 digest in `SEND_API_KEY_SHA512`, same
default bind of `127.0.0.1`.

`GET /health` returns:

```json
{
  "status": "up",
  "connection": "ready",
  "connectionNote": "",
  "connectionSince": "2026-08-11T09:02:11.004Z",
  "uptimeSeconds": 84213,
  "lastMessageAt": "2026-08-11T09:14:02.118Z",
  "queueDepth": 0,
  "mode": "auto",
  "away": null,
  "quiet": false,
  "model": "llama3.1:8b"
}
```

`status` is `up` only when the WhatsApp session is connected. `connection` is
the detail behind it: `starting`, `ready`, `disconnected`, `auth_failure` or
`needs_scan`, the last meaning the stored session is gone and no amount of
reconnecting will fix it. `away` is `null` or an object with `until` and
`reason`, where a `null` `until` means away with no end set. `queueDepth` is how
many replies are waiting to be written, which is the number that climbs when
Ollama has become slow rather than unreachable.

It answers 200 when the WhatsApp connection is ready and 503 when it is not.
The status code is the field to branch on, because it is the one thing that
still means something when the body is missing or truncated.

`POST /command` takes the owner commands you would otherwise send over WhatsApp:

```json
{ "text": "away 2h at the dentist" }
```

and returns `{ "reply": "..." }`. The command set is `status`, `off`, `on`,
`away`, `back`, `brief`, `settings`, `set <name> <value>` and `reset <name>`. It
is the same parser reached through the same hooks, so anything that works from
your own phone works from Discord and the reverse, and neither can drift into
doing something the other does not.

Note what is deliberately absent. Nothing that decides how the process is wired
up can be reached from a command: not the port, not the API key digest, not the
webhook URL. A command arriving over the send endpoint must never be able to
reconfigure the endpoint that let it in.

## Receiving commands from Discord

There are two ways to get a command from Discord to n8n, and they have quite
different failure modes.

### Option A: an interactions endpoint URL

You register an application with Discord, define slash commands against it, and
set the application's **Interactions Endpoint URL** to an n8n webhook. Discord
then POSTs every use of those commands to that URL.

The catch is that this URL is public, so Discord will not take your word for
who is calling it. Every request carries an Ed25519 signature over the request
body, and you have to verify it yourself. Discord tests this when you save the
URL: it sends deliberately invalid signatures and expects HTTP 401 back. An
endpoint that returns 200 to everything is rejected at save time, so there is no
way to skip this and fix it later.

#### Getting the raw body

The signature is computed over the timestamp header concatenated with the raw
request body, byte for byte. Parsing the JSON and re-serialising it does not
give you those bytes back: key order, whitespace and number formatting are all
free to change, and every one of them breaks the signature. This is the single
most common reason a correct-looking implementation always returns 401.

In the **Webhook** node, open **Options**, add **Raw Body**, and turn it on. The
untouched bytes then arrive base64-encoded as the binary property `data`, which
is what the code below reads. Whether `$json.body` is still populated alongside
it varies between n8n versions, so parse the interaction out of the raw buffer
rather than trusting it.

Also set the node's **Respond** field to `Using 'Respond to Webhook' Node`.
Without that the webhook answers 200 the moment it receives anything, and you
cannot return 401 at all.

#### The verification code

A Discord application's public key is 32 raw bytes, shown as 64 hex characters
on the application's General Information page. Node's `crypto` will not take
raw bytes directly, so they get wrapped in the fixed 12-byte SPKI DER header for
Ed25519. That prefix is a constant. It is not derived from your key and does not
change.

Put this in a **Code** node, mode `Run Once for All Items`:

```javascript
const crypto = require('crypto');

// The application's public key, 64 hex characters, from the Discord developer
// portal. This is a public value; it is not a secret and not a bot token.
const PUBLIC_KEY_HEX = 'PASTE_YOUR_APPLICATION_PUBLIC_KEY_HERE';

// SPKI DER header for an Ed25519 public key: SEQUENCE, AlgorithmIdentifier
// with OID 1.3.101.112, then a 33-byte BIT STRING with zero unused bits. The
// 32 raw key bytes follow it, giving a 44-byte structure. Fixed for every
// Ed25519 key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const item = $input.first();
const headers = item.json.headers || {};
const signature = headers['x-signature-ed25519'];
const timestamp = headers['x-signature-timestamp'];

// The bytes exactly as Discord sent them. Requires Raw Body on the Webhook node.
if (!item.binary || !item.binary.data) {
  throw new Error('No raw body. Turn on Raw Body in the Webhook node options.');
}
const rawBody = Buffer.from(item.binary.data.data, 'base64');

let verified = false;
try {
  const keyBytes = Buffer.from(PUBLIC_KEY_HEX, 'hex');
  if (keyBytes.length !== 32) throw new Error('public key is not 32 bytes');

  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, keyBytes]),
    format: 'der',
    type: 'spki',
  });

  // A signature is 64 bytes, so 128 hex characters. Checking first keeps a
  // malformed header out of crypto.verify, which throws rather than returning
  // false, and a throw here is a 500 where Discord is waiting for a 401.
  if (
    typeof signature === 'string' &&
    /^[0-9a-f]{128}$/i.test(signature) &&
    typeof timestamp === 'string'
  ) {
    verified = crypto.verify(
      // Must be null. Ed25519 signs the message itself, so there is no digest
      // to name, and passing 'ed25519' or 'sha512' here throws Invalid digest.
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      key,
      Buffer.from(signature, 'hex'),
    );
  }
} catch (err) {
  // Anything malformed is a failed verification, not a workflow error.
  verified = false;
}

let interaction = {};
try {
  interaction = JSON.parse(rawBody.toString('utf8'));
} catch (err) {
  verified = false;
}

return [{ json: { verified, interaction } }];
```

Two things about that code are worth stating plainly, because both are easy to
get wrong and neither fails in a way that points at itself.

The first argument to `crypto.verify` must be `null`. Ed25519 hashes the message
internally as part of the signature scheme, so there is no separate digest to
name. Passing `'ed25519'` throws `Invalid digest: ed25519`, and passing
`'sha512'` throws from OpenSSL. Both surface as a red node rather than as a
rejected request.

Everything is wrapped so that malformed input returns `verified: false` instead
of throwing. A throw in a Code node is an HTTP 500, and Discord reads a 500 as a
broken endpoint rather than as a rejected caller.

`require('crypto')` in a Code node is blocked by default. n8n has to be started
with `NODE_FUNCTION_ALLOW_BUILTIN=crypto` in its environment, otherwise the node
fails on its first line with a message about `crypto` not being defined.

#### Wiring the response

After the Code node, an **IF** node on `{{ $json.verified }}`.

On the false branch, a **Respond to Webhook** node, response code `401`, body
text `invalid request signature`. Discord does not read the body, only the code.

On the true branch, a **Switch** on `{{ $json.interaction.type }}`:

- Type `1` is a PING. Respond with code `200` and JSON `{"type": 1}`. Discord
  sends this when you save the URL and periodically afterwards. An endpoint that
  handles commands but not PING will pass its first save and then be quietly
  disabled later.
- Type `2` is an APPLICATION_COMMAND, which is the interesting one.

#### The three second deadline

Discord gives you three seconds to answer an interaction. Miss it and the user
sees "The application did not respond", and nothing you send afterwards will
replace that.

`GET /health` will come back in milliseconds, so a `/status` command can reply
directly with a type 4 response:

```json
{
  "type": 4,
  "data": { "content": "Connection open, queue 0, away off." }
}
```

`POST /command` is not so safe. A `brief` runs a model generation, and generation
on a local box is measured in tens of seconds. Anything that touches the model
has to be deferred.

Respond immediately with type 5, which tells Discord to show "thinking" and hold
the interaction open:

```json
{ "type": 5 }
```

Then, in the nodes that run after that response, call ChatLlama and PATCH the
result onto the message Discord is already showing:

```
PATCH https://discord.com/api/v10/webhooks/{application.id}/{interaction.token}/messages/@original
Content-Type: application/json

{ "content": "{{ $json.reply }}" }
```

`{application.id}` is your application's ID, a constant. `{interaction.token}`
is `{{ $json.interaction.token }}` from the request you just verified. No
authorisation header is needed or accepted here: the token in the path is the
credential. It is valid for fifteen minutes, which is far longer than any
command here will take.

Getting n8n to respond before it has finished the workflow means putting the
**Respond to Webhook** node early in the branch and continuing the chain after
it. n8n carries on executing the remaining nodes once the response has gone out.
If you leave the respond node at the end, as you would in a normal workflow, the
three seconds are gone before the model has started.

### Option B: a gateway bot

The alternative is a bot process holding a WebSocket to Discord's gateway.
Discord connects to nothing; the bot dials out. That means no public address, no
signature verification and no three-second deadline in the same shape, because
the bot is already connected when the command arrives.

n8n's Discord trigger works this way, as does any small bot you write yourself.

Two things are worth knowing about intents. Slash commands delivered over the
gateway need no privileged intent at all: the interaction is routed to your
application because it owns the command. Reading ordinary channel messages is
different. Seeing the text of a message that does not mention your bot requires
the **Message Content** privileged intent, which you enable in the developer
portal and which needs review once the bot is in more than a hundred servers.
A bot that is @mentioned receives the content regardless, so "mention the bot
and type a command" avoids the intent entirely.

### Which one to use

Option A. You already run n8n on a public HTTPS address, so the thing that makes
Option B attractive, not needing to expose anything, buys you nothing you do not
already have. Option A also keeps the whole control path inside n8n, where the
credential handling and the existing outbound workflow already live, rather than
adding a second long-running process to keep alive on the same box.

The tradeoff is honest and worth stating: Option A means a publicly reachable
URL whose safety rests entirely on the signature check above being correct. Get
that code wrong in the permissive direction and anyone who learns the URL can
drive the assistant. Option B has no such surface, because there is nothing to
call. If you are not going to verify signatures properly, use Option B.

## Registering the slash commands

Commands are registered over the API, not in the developer portal UI. The call
is a bulk overwrite: whatever you PUT becomes the complete command list for that
guild, and anything you leave out is deleted. That is a feature, in that the
request describes the desired state rather than a diff, but it does mean a
partial body silently removes commands.

Register against a guild rather than globally. Guild commands take effect the
moment the call returns. Global commands propagate on Discord's own schedule and
can take up to an hour to appear, which turns every typo into a long wait for
no visible reason. There is no benefit to global registration for a private
server.

```bash
curl -X PUT \
  "https://discord.com/api/v10/applications/$APPLICATION_ID/guilds/$GUILD_ID/commands" \
  -H "Authorization: Bot $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "chatllama",
      "type": 1,
      "description": "Send an owner command to the assistant",
      "options": [
        {
          "name": "command",
          "type": 3,
          "description": "For example: away 2h at the dentist",
          "required": true
        }
      ]
    },
    {
      "name": "status",
      "type": 1,
      "description": "Is the assistant up, and is it connected"
    }
  ]'
```

`"type": 1` on the command is CHAT_INPUT, an ordinary slash command. `"type": 3`
on the option is STRING. Names must be lower case; the API rejects capitals with
a validation error that does not say which field it means.

The `Authorization: Bot <token>` header is the bot token, which is a secret, and
is a different value from the public key used for verification. Registration is
the only place the bot token is needed if you go with Option A, so it does not
have to live in n8n at all. Run this once from a terminal and forget it.

The text the user typed arrives as the first option's value:

```
{{ $json.interaction.data.options[0].value }}
```

which is what goes into `POST /command` as `text`. For `/status` there are no
options, so read `{{ $json.interaction.data.name }}` in a Switch and route the
two commands separately rather than trying to handle both in one branch.

## A green or red status indicator in a channel

The useful property of an incoming webhook here is that it can edit its own past
messages, with no bot token and no permissions to configure. So a single message
in a channel can be kept current as a status light.

Post once to create the message, with `wait=true` so the API returns the message
object rather than an empty 204:

```
POST https://discord.com/api/v10/webhooks/{webhook.id}/{webhook.token}?wait=true
```

Keep the `id` from the response. That is the message you will be editing from
then on. Store it somewhere that survives a workflow run: `$getWorkflowStaticData('global')`
in a Code node is the simplest place, and means the workflow creates the message
on its first run and edits it on every run after.

The heartbeat then edits rather than posts:

```
PATCH https://discord.com/api/v10/webhooks/{webhook.id}/{webhook.token}/messages/{message.id}
```

A **Schedule Trigger** on every minute, an **HTTP Request** node to
`http://127.0.0.1:<SEND_API_PORT>/health` with the `x-api-key` header, and a
second HTTP Request node doing the PATCH.

The health request node has to be configured not to fail the workflow on a
non-2xx response, and not to fail on a connection error either. Set **On Error**
to continue. If you leave it on the default, a 503 or a refused connection
aborts the run, the PATCH never happens, and the embed stays green through
exactly the outage it exists to show you. This is the most important setting in
the whole workflow and it is not the default.

The body of the PATCH:

```json
{
  "embeds": [
    {
      "title": "ChatLlama",
      "description": "Connection open, queue 0\nLast checked: <t:1786500000:R>",
      "color": 3066993
    }
  ]
}
```

`3066993` is `0x2ECC71`, green. `15158332` is `0xE74C3C`, red. Discord takes
colours as decimal integers, as in the outbound embeds.

The `<t:UNIX:R>` is not decoration and it is not optional. It renders in the
reader's own timezone as "12 seconds ago", "4 minutes ago", "2 hours ago", and
it is the only part of the message that distinguishes a healthy service from a
heartbeat that died. A green embed that stopped being updated looks exactly like
a green embed that is being updated, forever. With the relative timestamp, a
dead heartbeat announces itself: the number climbs and keeps climbing. Build the
value in a Set or Code node as `Math.floor(Date.now() / 1000)`.

The embed's own `timestamp` field is not a substitute. It renders as a fixed
date in the footer, so it tells you when the message was last edited only if you
work it out yourself, which is precisely the thing nobody does at a glance.

There is no documented rate limit figure for editing a webhook message. Discord
does not publish a number for this route, and the correct way to stay inside it
is to read the response headers, `X-RateLimit-Limit`, `X-RateLimit-Remaining`
and `X-RateLimit-Reset-After`, and back off when `Remaining` reaches zero. In
practice a sixty second heartbeat is orders of magnitude below anything
plausible, so this is a thing to be aware of rather than a thing to engineer
around. It becomes relevant only if you decide to poll every second.

A webhook cannot pin its own message. Pinning requires the Manage Messages
permission, which a webhook does not have, and there is no webhook route for it.
Pin it by hand once, from the client, after the first run creates it. It stays
pinned across every subsequent edit, so this is a one-off at setup and not a
thing to automate.

Renaming the channel to show status is a trap worth naming, because it looks
tidier than a pinned message. Channel updates are limited to two changes per ten
minutes. A service that flaps burns both changes immediately, and the rename
that mattered, the one back to green, is the one that gets dropped. The channel
then sits showing the wrong state for minutes at a time with no indication that
it is stale. Editing a message has no such ceiling in any range you will use.

## Security

The assistant is now steerable from a chat window, which is convenient in
proportion to how carefully the boundary is drawn.

ChatLlama's endpoints stay bound to `127.0.0.1`, or to a LAN address if n8n runs
on a different machine on the same network. They are never port-forwarded and
never given a public DNS name. `/command` can turn the assistant off, mark you
away, and change settings; `/send` can message your contacts from your number.
None of that belongs on the open internet behind a single header. The send API
already warns at startup when it is bound beyond loopback, and that warning is
worth reading rather than dismissing.

n8n is the only public surface, and it stays that way. Everything Discord can
reach, it reaches through n8n. If you find yourself opening a second port to
make something work, the design has gone wrong.

The `x-api-key` lives in an n8n credential and nowhere else. It is never put in
a Discord command, a channel topic, an embed, or a message anyone can read.
Discord retains message history, and a key pasted into a channel once is a key
that has to be rotated.

Anyone who can type in the channel can steer the assistant. There is no
per-user check in any of the above: a slash command from a guild member is a
slash command. So the channel has to be private, restricted to you, and the
server has to stay one you control. If you later want more than one person in
there, add a check on `{{ $json.interaction.member.user.id }}` against your own
ID before the request reaches ChatLlama, and reply with a refusal otherwise.

The signature verification is the only thing standing between the n8n URL and
the outside world. The path is not a secret in the way the outbound webhook path
is: an interactions endpoint gets probed. If the verification is wrong in the
permissive direction, anyone who learns or guesses the URL can issue commands,
and nothing else in the chain will stop them, because n8n holds the API key and
will happily use it. Test it before you rely on it, by sending a POST with a
bogus `X-Signature-Ed25519` header and confirming you get a 401 rather than
anything else.
