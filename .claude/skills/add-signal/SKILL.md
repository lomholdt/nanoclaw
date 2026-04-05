---
name: add-signal
description: Add Signal as a channel. Can replace WhatsApp entirely or run alongside it. Uses signal-cli-rest-api Docker container for message routing.
---

# Add Signal Channel

This skill adds Signal support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/signal.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Signal account set up with signal-cli, or do you need to set one up from scratch?

Also ask: Do you have a dedicated phone number for the bot? (A VoIP number works — ~$2-5/month.)

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `signal` is missing, add it:

```bash
git remote add signal https://github.com/qwibitai/nanoclaw-signal.git
```

### Merge the skill branch

```bash
git fetch signal main
git merge signal/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/signal.ts` (SignalChannel class with self-registration via `registerChannel`)
- `src/channels/signal.test.ts` (unit tests with fetch mock)
- `import './signal.js'` appended to the channel barrel file `src/channels/index.ts`
- `SIGNAL_CLI_API_URL` and `SIGNAL_ACCOUNT` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/signal.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Start signal-cli-rest-api

The Signal channel uses [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) as a bridge. It runs as a Docker container:

```bash
docker run -d --name signal-cli-rest-api \
  --restart=unless-stopped \
  -p 8080:8080 \
  -v $HOME/.local/share/signal-cli:/home/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api
```

Wait a few seconds, then verify it's running:

```bash
curl -s http://localhost:8080/v1/about | head -c 200
```

### Register or link Signal account

The user needs to either register a new account or link to an existing Signal installation.

#### Option A: Register a new number

```bash
# Start registration (may require CAPTCHA)
curl -X POST 'http://localhost:8080/v1/register/<PHONE_NUMBER>' \
  -H 'Content-Type: application/json' \
  -d '{"use_voice": false}'

# Verify with the SMS code received
curl -X POST 'http://localhost:8080/v1/register/<PHONE_NUMBER>/verify/<CODE>'
```

Replace `<PHONE_NUMBER>` with the E.164 format number (e.g., `+15551234567`).

If CAPTCHA is required, tell the user:

> You may need to solve a CAPTCHA:
> 1. Open https://signalcaptchas.org/registration/generate.html in a browser
> 2. Solve the CAPTCHA
> 3. Copy the `signalcaptcha://` URL from the browser's address bar
> 4. Pass it in the registration request:
>    ```bash
>    curl -X POST 'http://localhost:8080/v1/register/<PHONE_NUMBER>' \
>      -H 'Content-Type: application/json' \
>      -d '{"captcha": "signalcaptcha://signal-hcaptcha...."}'
>    ```

#### Option B: Link to existing Signal account

```bash
# Get a linking URI
curl -s 'http://localhost:8080/v1/qrcodelink?device_name=NanoClaw' --output /tmp/signal-qr.png
```

Tell the user:

> 1. Open the QR code image at `/tmp/signal-qr.png`
> 2. In Signal on your phone: Settings > Linked Devices > Link New Device
> 3. Scan the QR code
>
> If you prefer a text URI instead of a QR image:
> ```bash
> curl -s 'http://localhost:8080/v1/devices/link?device_name=NanoClaw'
> ```
> Then generate the QR code with `qrencode`:
> ```bash
> echo "<URI>" | qrencode -t ansiutf8
> ```

### Configure environment

Add to `.env`:

```bash
SIGNAL_CLI_API_URL=http://localhost:8080
SIGNAL_ACCOUNT=+15551234567
```

Replace with the actual phone number used.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
```

Restart the service:

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> Send a test message to the bot's Signal number from your phone. Then check the logs:
>
> ```bash
> tail -f logs/nanoclaw.log | grep 'unregistered Signal'
> ```
>
> You'll see lines like:
> - DM: `Message from unregistered Signal chat { chatJid: 'signal:+15551234567' }`
> - Group: `Message from unregistered Signal chat { chatJid: 'signal-group:abc123...' }`
>
> Copy the `chatJid` value for registration.

Wait for the user to provide the JID.

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "signal:+<number>" --name "<contact-name>" --folder "signal_main" --trigger "@Andy" --channel signal --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "signal:+<number>" --name "<contact-name>" --folder "signal_<name>" --trigger "@Andy" --channel signal
```

For groups:

```bash
npx tsx setup/index.ts --step register -- --jid "signal-group:<groupId>" --name "<group-name>" --folder "signal_<group>" --trigger "@Andy" --channel signal
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Signal chat:
> - For main chat: Any message works
> - For non-main: Start with `@Andy` (or your configured trigger)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. signal-cli-rest-api is running: `curl -s http://localhost:8080/v1/about`
2. `SIGNAL_ACCOUNT` is set in `.env` AND synced to `data/env/env`
3. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal%'"`
4. For non-main chats: message includes trigger pattern
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### signal-cli-rest-api Docker container issues

```bash
# Check container logs
docker logs signal-cli-rest-api

# Restart container
docker restart signal-cli-rest-api

# Verify account is registered
curl -s http://localhost:8080/v1/accounts
```

### CAPTCHA required for registration

Signal requires CAPTCHA for new registrations. Visit https://signalcaptchas.org/registration/generate.html, solve it, and pass the `signalcaptcha://` URI in the register request.

### Rate limited

Signal may rate-limit message sending. If you see 429 errors in logs, wait a few minutes before retrying.

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Features

The Signal channel supports:
- Text messages (DM and group)
- Rich text formatting (bold, italic, strikethrough, monospace via `parseSignalStyles`)
- Attachment descriptions (images, videos, audio, files as placeholders)
- Reply/quote context
- Emoji reactions
- Message splitting for responses over ~4000 characters
- Echo prevention (won't re-process own sent messages)

## Removal

To remove Signal integration:

1. Delete `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove `import './signal.js'` from `src/channels/index.ts`
3. Remove `SIGNAL_CLI_API_URL` and `SIGNAL_ACCOUNT` from `.env`
4. Remove Signal registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'signal%'"`
5. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
6. Optionally stop the signal-cli-rest-api container: `docker stop signal-cli-rest-api && docker rm signal-cli-rest-api`
