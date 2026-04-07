---
name: live-scores
description: Live football score tracking. Subscribe to matches and get real-time push notifications for goals, kick-off, half-time, and full-time. Use when users ask about football scores, fixtures, or want match updates.
---

# Live Scores

Track live football matches and get push notifications for goals, kick-off, half-time, and full-time. Includes scorecard images with team logos.

## Available MCP Tools

- `get_live_scores` — Get today's matches with scores and status
- `get_matches` — Get matches for any date (use YYYYMMDD format, e.g. "20260408")
- `subscribe_live_score` — Subscribe to updates for a match (needs event_id from get_live_scores/get_matches)
- `unsubscribe_live_score` — Stop receiving updates for a match
- `get_match_details` — Get goal scorers, cards, and substitutions for a specific match
- `send_scorecard` — Generate and send a scorecard image with team logos and current score

## Important: Only Subscribe to What Was Asked

When a user asks to follow a specific match, ONLY subscribe to that exact match. Do NOT subscribe to other matches happening at the same time, even if they seem related (e.g., same tournament). If the user says "follow Real Madrid vs Bayern", subscribe to that one match only.

If the user wants multiple matches, they will ask explicitly (e.g., "follow all Champions League matches tonight").

## When to Use

**User asks about scores or fixtures:**
1. Use `get_live_scores` for today's matches
2. Use `get_matches` with a date for future fixtures
3. Only show the matches the user asked about — don't dump the entire list

**User wants to follow a match:**
1. Use `get_live_scores` or `get_matches` to find the specific match
2. Use `subscribe_live_score` with the event_id of ONLY the requested match
3. Include `match_name` for readability (e.g. "FC Nordsjælland vs Brøndby IF")
4. For future matches, include `scheduled_date` (ISO format)
5. After subscribing, send and pin a status message using `pin_message`

**User wants to see a scorecard:**
1. Use `get_live_scores` to find the match event_id
2. Use `send_scorecard` with the event_id to generate and send the image

## Notes

- Subscriptions automatically complete when the match ends
- For future matches, the system will notify the group 5 minutes before kick-off
- After subscribing, pin a status message so the group can see what's being tracked
- Scorecard images include team logos fetched from EnetScores
- The system supports football, tennis, handball, ice hockey, golf, and cycling.
