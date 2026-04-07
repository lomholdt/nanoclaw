/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_voice',
  'Send a voice message (text-to-speech). The text will be converted to audio and sent as a voice note. Use for fun, emphasis, or when asked to speak.',
  {
    text: z.string().describe('The text to convert to speech'),
    voice: z
      .string()
      .optional()
      .describe(
        'Voice ID. Defaults to en-US-EmmaNeural. Pick based on user preference:\n' +
        'Women: en-US-EmmaNeural (cheerful, clear), en-US-AvaNeural (expressive, caring), en-US-AriaNeural (confident), en-US-JennyNeural (friendly)\n' +
        'Men: en-US-BrianNeural (casual), en-US-AndrewNeural (warm, confident)\n' +
        'Danish: da-DK-ChristelNeural (female), da-DK-JeppeNeural (male)\n' +
        'Match the voice language to the text language.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'voice_message',
      chatJid,
      text: args.text,
      voice: args.voice || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Voice message queued.' }] };
  },
);

server.tool(
  'react_to_message',
  'React to a message with an emoji. If no message_id is provided, reacts to the most recent message in the chat.',
  {
    emoji: z.string().describe('The emoji to react with (e.g. "👍", "❤️", "🔥", "✅")'),
    message_id: z.string().optional().describe('The message ID to react to. Omit to react to the latest message.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'reaction',
      chatJid,
      emoji: args.emoji,
      messageId: args.message_id || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Reacted with ${args.emoji}` }] };
  },
);

server.tool(
  'pin_message',
  'Pin a message in the chat. Signal only. If no message_id is provided, pins the most recent message.',
  {
    message_id: z
      .string()
      .optional()
      .describe('The message ID to pin. Omit to pin the latest message.'),
    duration_seconds: z
      .number()
      .optional()
      .describe(
        'How long to pin in seconds. Defaults to 86400 (24 hours). Use -1 for forever.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'pin_message',
      chatJid,
      messageId: args.message_id || undefined,
      durationSeconds: `${args.duration_seconds ?? 86400}`,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message pinned.' }] };
  },
);

server.tool(
  'create_poll',
  'Create a poll in the chat. Signal and Discord. Answers are limited to 10 options.',
  {
    question: z.string().describe('The poll question'),
    answers: z.array(z.string()).min(1).max(10).describe('Poll answer options (1-10)'),
    duration_hours: z.number().min(1).max(768).default(24).describe('How long the poll runs in hours (default: 24, max: 768 = 32 days)'),
    allow_multiselect: z.boolean().default(false).describe('Whether users can select multiple answers'),
  },
  async (args) => {
    const data = {
      type: 'poll',
      chatJid,
      question: args.question,
      answers: args.answers,
      durationHours: args.duration_hours,
      allowMultiselect: args.allow_multiselect,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Poll created: "${args.question}" with ${args.answers.length} options` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// --- Live Scores Tools ---

server.tool(
  'get_available_sports',
  'List all available sports that can be tracked for live scores.',
  {},
  async () => {
    const sports = [
      { name: 'Football', id: 1, key: 'football' },
      { name: 'Golf', id: 3, key: 'golf' },
      { name: 'Ice Hockey', id: 5, key: 'hockey' },
      { name: 'Handball', id: 20, key: 'handball' },
      { name: 'Cycling', id: 30, key: 'cycling' },
    ];
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(sports, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'get_live_scores',
  "Get today's live football scores and match status. Returns all matches for today with scores, status (upcoming/live/finished), and tournament info.",
  {},
  async () => {
    // Read the cached scores snapshot written by the host service
    const scoresFile = path.join(IPC_DIR, 'live_scores.json');
    try {
      if (fs.existsSync(scoresFile)) {
        const data = JSON.parse(fs.readFileSync(scoresFile, 'utf-8'));
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }
    } catch {
      // Fall through to not-available message
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Live scores data is not available yet. The live scores service may not be running.',
        },
      ],
    };
  },
);

server.tool(
  'get_matches',
  'Get football matches for a specific date. Use this to find matches for future subscriptions (e.g., tomorrow, next week).',
  {
    date: z
      .string()
      .describe(
        'Date in YYYYMMDD format (e.g., "20260408" for April 8, 2026)',
      ),
  },
  async (args) => {
    // Write a request and read the response - the host will handle the HTTP fetch
    // For simplicity, we fetch directly from the container
    const data = {
      type: 'get_matches',
      date: args.date,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);

    // Read the response file (host writes it after processing)
    const responseFile = path.join(IPC_DIR, `matches_${args.date}.json`);

    // Wait briefly for the host to process
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      if (fs.existsSync(responseFile)) {
        const matches = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(matches, null, 2),
            },
          ],
        };
      }
    } catch {
      // Fall through
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Matches for ${args.date} are being fetched. Try again in a few seconds, or check live_scores.json for today's matches.`,
        },
      ],
    };
  },
);

server.tool(
  'subscribe_live_score',
  'Subscribe this group to live score updates for a football match. You will receive push notifications for goals, kick-off, half-time, and full-time. Use get_live_scores or get_matches first to find the event ID.',
  {
    event_id: z
      .string()
      .describe(
        'The event ID from get_live_scores or get_matches (e.g., "5222358")',
      ),
    match_name: z
      .string()
      .optional()
      .describe(
        'Display name for the match (e.g., "FC Nordsjælland vs Brøndby IF")',
      ),
    scheduled_date: z
      .string()
      .optional()
      .describe(
        'Kickoff time for future matches in ISO format (e.g., "2026-04-08T20:00:00"). If omitted, assumes the match is today/live.',
      ),
    notification_level: z
      .enum(['goals', 'key', 'all'])
      .optional()
      .describe(
        'What to notify about. "goals" = goals + kick-off/half-time/full-time only. "key" = also cards. "all" = everything including substitutions. Default: "all"',
      ),
  },
  async (args) => {
    const data = {
      type: 'subscribe_live_score',
      event_id: args.event_id,
      match_name: args.match_name || null,
      scheduled_date: args.scheduled_date || null,
      notification_level: args.notification_level || 'all',
      targetJid: chatJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const status = args.scheduled_date
      ? `Subscription scheduled. You'll get a notification before kick-off.`
      : `Subscribed! You'll receive live updates for this match.`;

    return {
      content: [
        {
          type: 'text' as const,
          text: `${status}\nMatch: ${args.match_name || args.event_id}`,
        },
      ],
    };
  },
);

server.tool(
  'unsubscribe_live_score',
  'Unsubscribe from live score updates for a match.',
  {
    subscription_id: z
      .string()
      .describe('The subscription ID to cancel'),
  },
  async (args) => {
    const data = {
      type: 'unsubscribe_live_score',
      subscription_id: args.subscription_id,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Unsubscribed from live score updates.',
        },
      ],
    };
  },
);

server.tool(
  'get_match_details',
  'Get detailed match information including goal scorers, cards, and substitutions for a specific match.',
  {
    event_id: z
      .string()
      .describe('The event ID from get_live_scores (e.g., "5205791")'),
  },
  async (args) => {
    const data = {
      type: 'get_match_details',
      event_id: args.event_id,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);

    // Wait for the host to process and write response
    const responseFile = path.join(IPC_DIR, `match_details_${args.event_id}.json`);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      if (fs.existsSync(responseFile)) {
        const details = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      }
    } catch {
      // Fall through
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Match details for ${args.event_id} are being fetched. Try again in a few seconds.`,
        },
      ],
    };
  },
);

server.tool(
  'send_scorecard',
  'Generate and send a scorecard image for a match. Shows team logos, score, and event type. Use after get_live_scores to get the event_id.',
  {
    event_id: z
      .string()
      .describe('The event ID from get_live_scores (e.g., "5205791")'),
    event_type: z
      .enum(['live', 'goal', 'kickoff', 'halftime', 'fulltime', 'red_card', 'yellow_card', 'substitution', 'period_change'])
      .optional()
      .describe('Type of event for the card label. Default: "live" (shows current match status)'),
  },
  async (args) => {
    const data = {
      type: 'send_scorecard',
      event_id: args.event_id,
      event_type: args.event_type || 'live',
      chatJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Scorecard for event ${args.event_id} is being generated and sent.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
