---
name: add-live-scores
description: Add live football score tracking to NanoClaw. Groups can subscribe to matches and receive real-time push notifications for goals, kick-off, half-time, and full-time via MQTT WebSocket.
---

# Add Live Scores

This skill adds live football score tracking to NanoClaw via the EnetScores data feed.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/live-scores.ts` exists. If it does, skip to Phase 3 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/live-scores
git merge origin/skill/live-scores || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/live-scores.ts` — Core service: MQTT client, HTTP fetch, AES decryption, match diffing, notification formatting
- `container/skills/live-scores/SKILL.md` — Container agent instructions for MCP tools
- Updated `src/db.ts` — live_score_subscriptions table
- Updated `src/types.ts` — LiveScoreSubscription, MatchState, MatchEvent types
- Updated `src/ipc.ts` — subscribe/unsubscribe IPC handlers
- Updated `src/index.ts` — Live scores service startup
- Updated `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP tools (get_live_scores, get_matches, subscribe_live_score, unsubscribe_live_score)
- `mqtt` npm dependency

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Install and build

```bash
npm install
npm run build
```

## Phase 3: Verify

### Check the service starts

```bash
npm run dev
```

Look for `Live scores service started` in the logs. The MQTT broker is public — no API keys or credentials needed.

### Test from a group

Send a message in any registered group:
- "What matches are on today?" → agent should use get_live_scores
- "Follow [team name]" → agent should subscribe

## How It Works

1. Groups subscribe to matches via the agent (MCP tools)
2. The host-level service connects to the EnetScores MQTT WebSocket for real-time push updates
3. When a goal, kick-off, half-time, or full-time occurs, the service pushes a formatted message to all subscribed groups
4. Subscriptions auto-complete when the match ends
5. Future matches are scheduled — the service connects 5 minutes before kick-off

## Supported Sports

Currently football only. The data pipeline supports handball (sid=20), ice hockey (sid=5), golf (sid=3), and cycling (sid=30) — these can be added later with sport-specific score format parsing.

## Troubleshooting

### No live scores data

1. Check the MQTT connection in logs: look for `MQTT connected`
2. If MQTT fails, the service falls back to HTTP polling every 30 seconds
3. Verify internet connectivity — the service connects to `emqx.enetscores.com`

### Subscription not working

1. Check `live_score_subscriptions` table: `sqlite3 store/messages.db "SELECT * FROM live_score_subscriptions"`
2. Check IPC files are being processed: look for `Live score subscription created via IPC` in logs
