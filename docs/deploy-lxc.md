# Running it in a Proxmox LXC container

Debian 12, unprivileged, with Ollama somewhere else on the network. Node is the
easy part. What tends to go wrong is Chromium: whatsapp-web.js drives a real
browser, and a minimal Debian container has none of the libraries it needs.

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

Only the container is being deployed here. The rest either already exists or is
optional.

The container runs Node and a headless Chromium. There is no WhatsApp API in
play: whatsapp-web.js drives the real web client in a browser, which is why a
Node app that sends short text messages needs 2 GB of RAM.

Ollama stays wherever it already is. The container spends its time waiting on a
browser and a socket, while Ollama wants memory and ideally a GPU, so running
both in one container means sizing that container for the model. Setting
`OLLAMA_HOST` in `.env` is the entire integration.

The WhatsApp session lives in the container, under `.wwebjs_auth/`. Those files
are a working login to your account. Anyone who has them can message people as
you, and they are included in any snapshot of the container.

n8n is optional and only ever receives. ChatLlama posts to it and does not wait
for a reply.

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

Do not skip `--onboot 1`. Without it the container stays down after the host
reboots, and pm2 inside it never gets a chance to start anything.

## Node 20

Debian 12 ships Node 18. ChatLlama needs 20 or later.

```bash
apt update && apt install -y curl ca-certificates gnupg git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
```

## Chromium's libraries

Skip this and the first run dies with "Failed to launch the browser process",
which tells you nothing about which library is missing.

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

`npm install` downloads Chrome for Testing into `~/.cache/puppeteer`, under the
home directory of whoever ran it. Use the same user for the install and for
running the bot. If you install as root, run as root.

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

Try it in the terminal first. No WhatsApp session is involved, and it will tell
you straight away whether the container can reach Ollama:

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

`ecosystem.config.js` raises `kill_timeout` to 15000 on purpose. pm2 defaults to
1600 ms and then sends SIGKILL, which is not long enough for the shutdown flush
to write out a conversation summary that is still pending. You lose it with
nothing in the log.

Reboot the container and check it comes back on its own:

```bash
pct reboot 101
pct enter 101
pm2 list
pm2 logs assistant
```

## Backups, and what is in them

A container snapshot includes `.wwebjs_auth/`, a working login to your WhatsApp
account, and `.env`, which holds your webhook URL. Store those backups the way
you would store a password.

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
