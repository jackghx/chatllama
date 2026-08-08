# Running it in a Proxmox LXC container

Debian 12, unprivileged, with Ollama somewhere else on the network. The thing
that catches people out is not Node. It is that whatsapp-web.js drives a real
Chromium, and a minimal Debian container has none of the libraries it needs.

## What runs where

```
  your phone                    Proxmox host
 +-----------+
 | WhatsApp  |                +--------------------------------------+
 | linked    |                |  LXC 101, Debian 12, unprivileged     |
 | device    |<--- web.whatsapp.com --->|  ChatLlama (Node 20)      |  |
 +-----------+                |         Chromium, headless           |
                              |         pm2, systemd                 |
                              |         .wwebjs_auth/  <- session    |
                              +------------------|-------------------+
                                                 |  HTTP, port 11434
                                                 v
                              +--------------------------------------+
                              |  Ollama, wherever it already lives    |
                              |  (host, another VM, a GPU box)        |
                              +--------------------------------------+
                                                 |
                                     optional    v  HTTPS
                                        +---------------------+
                                        |  n8n, then Discord  |
                                        +---------------------+
```

Four moving parts, and only the middle one is what you are deploying.

**The container** runs Node and a headless Chromium. Chromium is what actually
talks to WhatsApp: whatsapp-web.js drives the real web client rather than any
API, which is why this needs a browser at all and why the container is heavier
than a Node app has any business being.

**Ollama stays where it is.** Nothing here needs it local. The container is
waiting on a browser and a socket, Ollama wants RAM and ideally a GPU, and
putting both in one container means sizing it for the model. `OLLAMA_HOST` in
`.env` points across the network and that is the whole integration.

**The session lives in the container**, in `.wwebjs_auth/`. That directory is a
live credential for your WhatsApp account. Anyone holding it can send messages
as you, and it is in every snapshot you take of the container.

**n8n is optional** and talks outward only. ChatLlama POSTs to it and never
waits for an answer.

## Container

Unprivileged is fine. `src/lib/runner.js` already launches Chromium with
`--no-sandbox`, so it does not need the user namespaces it would otherwise ask
for.

| Setting | Value | Why |
| --- | --- | --- |
| Memory | 2048 MB | Chromium, not the model. 512 will be killed. |
| Swap | 512 MB | Headroom for the browser's spikes. |
| Cores | 2 | One is enough until Chromium and Node both want the CPU. |
| Disk | 8 GB | Chrome is a ~400 MB download, node_modules another ~300 MB. |
| Unprivileged | yes | |
| Nesting | only if needed | See troubleshooting. |

From the Proxmox host, or click the same in the GUI:

```bash
pct create 101 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname chatllama --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:8 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=0 --onboot 1
pct start 101
pct enter 101
```

`--onboot 1` matters. Without it the container does not come back after the host
reboots, and pm2 inside it never gets the chance to.

## Node 20

Debian 12 ships Node 18. ChatLlama needs 20 or later.

```bash
apt update && apt install -y curl ca-certificates gnupg git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
```

## Chromium's libraries

This is the step that is not optional and not obvious. Without it the first run
fails with "Failed to launch the browser process", which says nothing useful.

```bash
apt install -y fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
  libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils
```

## ChatLlama

```bash
git clone https://github.com/jackghx/chatllama.git
cd chatllama
npm install
cp .env.example .env
```

`npm install` downloads Chrome for Testing into `~/.cache/puppeteer` for the
user running it. Install and run as the same user, or Chromium will not be found
later. If you install as root, run as root.

## Configuration

Edit `.env`. The two that matter first:

```
OLLAMA_HOST=http://192.168.0.155:11434
ASSISTANT_MODEL=llama3.1:8b
```

On the Ollama machine, it has to be listening on more than localhost:

```bash
systemctl edit ollama
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0"
systemctl restart ollama
```

Ollama has no authentication. Anything that reaches port 11434 can use your
model, so keep it on the LAN and off any port forward.

Pick a persona before connecting WhatsApp, from `prompts/scenarios/`:

```
SYSTEM_PROMPT_FILE=prompts/scenarios/away-from-phone.md
```

Then hear it before anyone else does. This needs no WhatsApp session, and tells
you immediately whether the container can reach Ollama:

```bash
npm run assistant:sim
```

## Linking WhatsApp

```bash
npm run assistant
```

The QR code renders as text in your SSH session. If it comes out unscannable,
the terminal is too small or the font too wide: make the window bigger, or zoom
out until the whole square fits with a clear margin. The code expires and
refreshes, so a failed scan is not fatal.

Afterwards the session sits in `.wwebjs_auth/` and you do not scan again.

Find the contact IDs before letting it answer anyone. You cannot guess them:

```
CAPTURE_IDS=true
```

Restart, have each person message you once, read the `[capture]` lines, paste
them into `ALLOWED_CONTACTS`, set `CAPTURE_IDS=false`, restart again.

## Keeping it up

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root    # then run the command it prints
```

`ecosystem.config.js` sets `kill_timeout: 15000` deliberately. pm2's default is
1600 ms, which is not long enough for the shutdown flush to finish writing any
conversation summary still pending, and a truncated flush loses it silently.

Check it survives a reboot, because that is the whole point:

```bash
pct reboot 101
pct enter 101
pm2 list
pm2 logs assistant
```

## Backups, and what is in them

Snapshot the container and you have snapshotted `.wwebjs_auth/`, which is a
working login to your WhatsApp account, and `.env`, which holds your webhook
URL. Treat container backups as credentials.

If the session ever leaks, unlink the device from your phone immediately:
WhatsApp, Settings, Linked Devices.

## When it does not work

**"Failed to launch the browser process".** The library list above, almost
always. If it is definitely installed, add `nesting=1` to the container features
and reboot it. Chromium occasionally wants it even with `--no-sandbox`.

**Killed with no message, container restarts.** Out of memory. Chromium plus
Node in 1 GB is tight and 512 MB will not do it. Raise it to 2048.

**`[ollama] unreachable` in the startup log.** Either `OLLAMA_HOST` is wrong, or
Ollama is still bound to localhost on the other machine. From inside the
container: `curl http://192.168.0.155:11434/api/tags`.

**It answers nobody, and the log shows nothing arriving.** Check the clock. The
backlog filter drops anything older than `IGNORE_OLDER_THAN_SECONDS` by
comparing message timestamps against `Date.now()`, so a container whose clock
has drifted behind treats every live message as replayed history. LXC shares the
host's clock, so this means the Proxmox host has drifted: `timedatectl` on both.

**It asks for the QR code again after a rebuild.** `.wwebjs_auth/` went with the
old container. Scan once more, and put it somewhere you are not going to delete
next time.
