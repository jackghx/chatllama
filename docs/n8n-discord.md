# Discord notifications via n8n

The assistant POSTs JSON to `N8N_WEBHOOK_URL`. If the variable is empty the
webhook is skipped entirely, so this is optional. Whether it is on is logged at
startup.

Two events arrive on the same URL, told apart by the `event` field. Branch on it
with a Switch node.

## ai_message

One per exchange, the full log.

```json
{
  "event": "ai_message",
  "bot": "assistant",
  "from": "1234567890@lid",
  "userMessage": "are you around this evening",
  "botReply": "[AI] Not at my phone right now, I have passed it on.",
  "automatic": false,
  "timestamp": "2026-08-08T20:09:10.460Z"
}
```

`botReply` is the message as sent, so it includes the self-disclosure notice if
one was attached. In `first` mode most lines in a conversation will not carry
it.

`automatic` is true when the fixed reply went out with no model involved, which
in `auto` mode is most of them. Filter on it if you only want to see what the
model actually wrote.

## conversation_summary

One per conversation, written when it goes quiet. This is the one to notify
yourself with.

```json
{
  "event": "conversation_summary",
  "bot": "assistant",
  "from": "1234567890@lid",
  "reason": "idle",
  "messages": 5,
  "summary": "Sam wants to climb at the Depot on Saturday around 11. Needs an answer by Friday.",
  "triage": {
    "urgency": "today",
    "wants": "Sam wants to climb at the Depot on Saturday around 11.",
    "deadline": "Friday",
    "draftReply": "11 on Saturday works. Book it and I will send you my half."
  },
  "transcript": ["User: yo you around this weekend?", "Assistant: ..."],
  "timestamp": "2026-08-08T20:21:44.117Z"
}
```

`reason` is `idle` when the conversation went quiet, `cap` when it hit
`SUMMARY_MAX_MESSAGES` without pausing, and `shutdown` when the process was
stopped with a summary still pending.

`summary` is empty if the model could not be reached. `transcript` still holds
the exchange, so the notification is worth sending either way.

### The triage fields

`triage.urgency` is always one of `now`, `today` or `whenever`, so a Switch node
can branch on it without a fallback for something the model made up. Send `now`
to a channel that notifies you and `whenever` to one you read on Sunday. This is
the field worth building the workflow around: deciding what actually needs you
is the job a fixed auto-reply cannot do.

`triage.draftReply` is written as you, in the first person, ready to send. Wire
a Discord button to the send endpoint and replying becomes one tap:

```
POST http://<host>:<SEND_API_PORT>/send
x-api-key: <the key, not the digest>

{ "to": "{{ $json.body.from }}", "text": "{{ $json.body.triage.draftReply }}" }
```

Nothing drafted is ever sent on its own. The endpoint only moves when something
calls it.

`triage` is `null` when the model did not produce usable fields, so check for it
before reading into it. `summary` is a string either way, which is why the nodes
below still read that rather than the object. Set `SUMMARY_FORMAT=prose` to turn
the whole thing off and get the old free-text briefing back.

## Timing

Every reply resets that conversation's timer. The summary fires only once the
other person has stopped writing for `SUMMARY_IDLE_MINUTES`, so a back and
forth produces one notification at the end rather than one per message.

Both POSTs are fire and forget. Handlers run inside a serial queue, so waiting
on n8n would hold up the reply to the person on their phone.

## n8n workflow

1. **Webhook** node, method `POST`. Use the `/webhook-test/` URL while building,
   which only listens while the editor is open and "Listen for test event" is
   active. Switch to the `/webhook/` URL and activate the workflow once it works.
2. **Switch** node on `{{ $json.body.event }}`, one output per event name. Skip
   this if you only want summaries, and use an IF node instead.
3. **Discord** node, connection type `Webhook`, operation `Send a Message`.

## Building the embed

The common mistake is pasting embed JSON into the node's **Message** field. That
field is plain message content, so the JSON arrives in Discord as literal text.

Leave **Message** empty and use **Add Embeds** instead. Fill the embed fields in
the n8n UI:

| Field | Value |
| --- | --- |
| Title | `Auto-reply sent` |
| Description | `**To**\n{{ $json.body.from }}` |
| Color | `#FF0000` |

Then add fields under the embed's own **Fields** section:

| Name | Value | Inline |
| --- | --- | --- |
| Message | `{{ $json.body.userMessage }}` | false |
| Reply | `{{ $json.body.botReply }}` | false |

Note the `body.` prefix. n8n nests the incoming webhook payload under `body`,
so `{{ $json.userMessage }}` resolves to nothing.

For the summary branch, a second Discord node on the other output of the Switch:

| Field | Value |
| --- | --- |
| Title | `Conversation ended` |
| Description | `{{ $json.body.summary }}` |
| Color | `#5865F2` |

| Name | Value | Inline |
| --- | --- | --- |
| With | `{{ $json.body.from }}` | true |
| Messages | `{{ $json.body.messages }}` | true |

If you want the raw exchange underneath, `{{ $json.body.transcript.join("\n") }}`
in a field value works, but mind the 1024 character limit below.

## If you would rather use an HTTP Request node

Point it at the Discord webhook URL, method `POST`, body type JSON:

```json
{
  "embeds": [
    {
      "title": "Auto-reply sent",
      "color": 16711680,
      "fields": [
        { "name": "To", "value": "={{ $json.body.from }}", "inline": true },
        { "name": "Message", "value": "={{ $json.body.userMessage }}", "inline": false },
        { "name": "Reply", "value": "={{ $json.body.botReply }}", "inline": false }
      ]
    }
  ]
}
```

`16711680` is red as a decimal integer, which is the format Discord's API takes.

Discord truncates embed field values at 1024 characters. Long model replies will
be cut off, so add a Set or Code node to trim them first if that matters.

## A "what did I miss" command

Once summaries are landing, asking for them on demand is a second n8n workflow
and no change to the assistant.

1. On the summary branch above, add a node that stores the row rather than only
   posting it. n8n's own data store, a Google Sheet and a SQLite table all work.
   Keep `timestamp`, `from`, `messages` and `summary`.
2. New workflow, triggered by a Discord slash command such as `/missed`. n8n's
   Discord trigger or an interactions webhook both reach it.
3. Read the rows from the last 24 hours.
4. HTTP Request node to `http://<your ollama host>:11434/api/generate`, method
   POST, body `{"model": "llama3.1:8b", "prompt": "...", "stream": false}`,
   with the rows pasted into the prompt and an instruction to merge them into
   one briefing. The answer is in `response`.
5. Discord node to reply.

Make `/missed` mean a fixed window rather than "since I last asked". Tracking a
read marker means storing state and keeping it correct, and the fixed window
needs neither.

## Testing without a second person

Set `WEBHOOK_IN_SIM=true` in `.env` and run `npm run assistant:sim`. The webhook
then fires from terminal simulation too, with `from` set to `simulation`. Turn it
back off afterwards so test chatter does not reach the channel.

## Before you turn this on

This forwards other people's messages to a Discord channel. They are talking to
what they think is your phone, and a channel is a good deal less private than a
one to one chat. Tell them, or do not run it.
