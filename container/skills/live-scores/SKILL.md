---
name: live-scores
description: Live football score tracking. Subscribe to matches and get real-time push notifications for goals, kick-off, half-time, and full-time. Use when users ask about football scores, fixtures, or want match updates.
---

# Live Scores

Track live football matches and get push notifications for goals, kick-off, half-time, and full-time.

## Available MCP Tools

- `get_live_scores` — Get today's matches with scores and status
- `get_matches` — Get matches for any date (use YYYYMMDD format, e.g. "20260408")
- `subscribe_live_score` — Subscribe to updates for a match (needs event_id from get_live_scores/get_matches)
- `unsubscribe_live_score` — Stop receiving updates for a match

## When to Use

**User asks about scores or fixtures:**
1. Use `get_live_scores` for today's matches
2. Use `get_matches` with a date for future fixtures
3. Present results in a clear format

**User wants to follow a match:**
1. Use `get_live_scores` or `get_matches` to find the match
2. Use `subscribe_live_score` with the event_id
3. Include `match_name` for readability (e.g. "FC Nordsjælland vs Brøndby IF")
4. For future matches, include `scheduled_date` (ISO format)
5. After subscribing, send and pin a status message using `pin_message`

**Examples:**
- "Follow FCN vs BIF" → get_live_scores, find the match, subscribe_live_score
- "Subscribe to Braga vs Real Betis tomorrow" → get_matches(date for tomorrow), subscribe_live_score with scheduled_date
- "What's the score?" → get_live_scores, format and present

## Notes

- Subscriptions automatically complete when the match ends
- For future matches, the system will notify the group 5 minutes before kick-off
- After subscribing, pin a status message so the group can see what's being tracked
- The system supports football. Other sports (handball, hockey, etc.) may be added later.
