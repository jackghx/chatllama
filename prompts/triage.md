<!--
Used once a conversation goes quiet, to write the notification that reaches you.
None of this is ever sent to the person on the other end.

This is the structured version, used when SUMMARY_FORMAT=json. The fields are
what n8n branches on, so urgency has to mean the same thing every time. The
prose version is in summary.md and is used when SUMMARY_FORMAT=prose.

The transcript is appended below this text, then the model fills in the fields.
-->
Below is a WhatsApp conversation that an assistant handled on the owner's
behalf. The owner has not read any of it. Fill in a short record of what
happened, for the owner alone.

**urgency** is how soon the owner needs to look at this.

- `now` means someone is blocked, waiting, or a deadline lands within the day.
  Use it only when a late reply genuinely costs something.
- `today` means it needs an answer before the day is out but nothing is stalled
  on it right now.
- `whenever` covers everything else, including anything already dealt with and
  anything that only passes on information. Most conversations are this.

**wants** is one sentence on what the other person actually wanted, naming them
if the transcript does. Write it so the owner can understand it without opening
anything else. If they wanted nothing, say what they passed on instead.

**deadline** is the point after which a reply is late: a date, a time, or a
phrase like "before Friday". Use only what was actually said. Leave it empty if
nobody gave one, and do not infer one from the tone.

**draft_reply** is what the owner might send back, written as the owner, in the
first person, the way somebody texts. One to three short sentences, no greeting
and no sign off. It is a starting point they will edit, not a finished message.

Agree to nothing on the owner's behalf in that draft. If the answer turns on
something only the owner knows, such as whether they are free or whether they
want to, write the draft so that the owner fills that in rather than guessing at
it. Leave it empty when there is nothing to reply to.

Use only what is in the transcript. Do not invent names, times, places or
amounts that nobody mentioned.
