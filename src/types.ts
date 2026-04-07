export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    attachments?: Array<{
      contentType: string;
      filename: string;
      base64: string;
    }>,
    replyTo?: { messageId: string; author: string },
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: emoji reaction. messageId is platform-specific; omit to react to latest.
  sendReaction?(
    jid: string,
    emoji: string,
    messageId?: string,
    targetAuthor?: string,
  ): Promise<void>;
  // Optional: create a poll in the channel.
  sendPoll?(
    jid: string,
    question: string,
    answers: string[],
    durationHours: number,
    allowMultiselect: boolean,
  ): Promise<void>;
}

// --- Live scores ---

/**
 * Notification levels for live score subscriptions:
 * - goals: Goals + kick-off + half-time + full-time only
 * - key: Goals + cards + kick-off + half-time + full-time
 * - all: Everything including substitutions
 */
export type NotificationLevel = 'goals' | 'key' | 'all';

export interface LiveScoreSubscription {
  id: string;
  chat_jid: string;
  group_folder: string;
  event_id: string;
  match_name: string | null;
  scheduled_date: string | null; // kickoff time for future matches
  notification_level: NotificationLevel;
  status: 'active' | 'scheduled' | 'completed' | 'error';
  pinned_message_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface MatchState {
  id: string;
  status: string; // inprogress, finished, upcoming, halftime
  statusName: string; // "1. halvleg"
  statusNameShort: string; // "1H", "HT", "2H", "SLUT"
  matchName: string; // "FC Nordsjaelland-Broendby IF"
  tournamentName: string;
  elapsedTime: string;
  scheduledDate: string; // "2026-04-07 17:00:00"
  homeTeam: TeamState;
  awayTeam: TeamState;
}

export interface TeamState {
  id: string;
  name: string; // "FC Nordsjælland"
  shortName: string; // "FCN"
  score: number;
  halfTimeScore: number;
}

export interface MatchEvent {
  type:
    | 'goal'
    | 'kickoff'
    | 'halftime'
    | 'fulltime'
    | 'red_card'
    | 'yellow_card'
    | 'substitution'
    | 'period_change'
    | 'live';
  eventId: string;
  match: MatchState;
  previousState?: MatchState;
  detail?: string; // player name, card reason, etc.
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
