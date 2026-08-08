# Logging to Discord via n8n

The assistant POSTs a JSON body to `N8N_WEBHOOK_URL` for each message it
answers. If the variable is empty the webhook is skipped entirely, so this is
optional. Whether it is on is logged at startup.

## Payload

```json
{
  "event": "ai_message",
  "bot": "assistant",
  "from": "1234567890@lid",
  "userMessage": "are you around this evening",
  "botReply": "[AI] Not at my phone right now, I have passed it on.",
  "timestamp": "2026-08-08T20:09:10.460Z"
}
```

`botReply` is the message as sent, so it includes the self-disclosure notice if
one was attached. In `first` mode most lines in a conversation will not carry
it.

The POST is fire and forget. Handlers run inside a serial queue, so waiting on
n8n would hold up the reply to the person who is waiting on their phone.

## n8n workflow

1. **Webhook** node, method `POST`. Use the `/webhook-test/` URL while building,
   which only listens while the editor is open and "Listen for test event" is
   active. Switch to the `/webhook/` URL and activate the workflow once it works.
2. **Discord** node, connection type `Webhook`, operation `Send a Message`.

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

## Testing without a second person

Set `WEBHOOK_IN_SIM=true` in `.env` and run `npm run assistant:sim`. The webhook
then fires from terminal simulation too, with `from` set to `simulation`. Turn it
back off afterwards so test chatter does not reach the channel.

## Before you turn this on

This forwards other people's messages to a Discord channel. They are talking to
what they think is your phone, and a channel is a good deal less private than a
one to one chat. Tell them, or do not run it.
