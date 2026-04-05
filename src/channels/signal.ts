import { getSignalSenderNames } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { parseSignalStyles } from '../text-styles.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import WebSocket from 'ws';

const DEFAULT_API_URL = 'http://localhost:8080';
const DEFAULT_POLL_INTERVAL = 2000;
const MAX_POLL_INTERVAL = 5000;
const BACKOFF_MULTIPLIER = 1.2;
const MAX_MESSAGE_LENGTH = 4000;
const WS_RECONNECT_INTERVAL = 5000;

/** Image file extensions that Signal can render inline */
const IMAGE_EXTENSIONS = /\.(gif|png|jpe?g|webp)(\?[^\s)]*)?$/i;

/** Hosts that serve embeddable images even without a file extension */
const IMAGE_HOSTS = /(?:giphy\.com|tenor\.com|imgur\.com)/i;

/**
 * Extract image/GIF URLs from text and return cleaned text + URLs.
 */
function extractImageUrls(text: string): {
  urls: string[];
  cleanedText: string;
} {
  const urlPattern =
    /(?:\[(?:[^\]]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)>\]]+))/g;
  const seen = new Set<string>();
  const urls: string[] = [];
  const imageMatches: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[1] || match[2];
    if (seen.has(url)) continue;
    seen.add(url);

    if (IMAGE_EXTENSIONS.test(url) || IMAGE_HOSTS.test(url)) {
      urls.push(url);
      imageMatches.push(match[0]);
    }
  }

  let cleaned = text;
  for (const m of imageMatches) {
    cleaned = cleaned.replace(m, '');
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { urls, cleanedText: cleaned };
}

/**
 * Download a URL and return a base64-encoded string with content type.
 */
async function downloadAsBase64(
  url: string,
): Promise<{ base64: string; contentType: string; filename: string } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/gif';
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString('base64');
    const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
    const filename = `image.${ext}`;
    return { base64, contentType, filename };
  } catch {
    return null;
  }
}

// --- Types for signal-cli-rest-api envelopes ---

interface SignalAttachment {
  contentType?: string;
  filename?: string;
  id?: string;
}

interface SignalQuote {
  id?: number;
  author?: string;
  authorName?: string;
  text?: string;
}

interface SignalGroupInfo {
  groupId?: string;
  groupName?: string;
}

interface SignalMention {
  uuid?: string;
  start?: number;
  length?: number;
  name?: string;
}

interface SignalDataMessage {
  message?: string;
  timestamp?: number;
  groupInfo?: SignalGroupInfo;
  attachments?: SignalAttachment[];
  quote?: SignalQuote;
  mentions?: SignalMention[];
}

interface SignalEnvelopeData {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
}

export interface SignalEnvelope {
  envelope: SignalEnvelopeData;
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private apiUrl: string;
  private account: string;
  private basePollInterval: number;
  private currentPollInterval: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private opts: SignalChannelOpts;
  /** Timestamps of messages we sent, used for echo prevention (10s TTL). */
  private sentTimestamps = new Set<string>();
  /** Maps Signal UUIDs to display names, built from incoming messages. */
  private nameCache = new Map<string, string>();
  /** True while a poll request is in-flight — prevents stacking. */
  private polling = false;
  /** Consecutive polls with no messages — drives backoff. */
  private idlePolls = 0;
  /** WebSocket connection for json-rpc mode. */
  private ws: WebSocket | null = null;
  /** Whether the API is running in json-rpc mode. */
  private jsonRpcMode = false;
  /** Maps internal group IDs to encoded group IDs for sending. */
  private groupIdMap = new Map<string, string>();

  constructor(
    apiUrl: string,
    account: string,
    opts: SignalChannelOpts,
    pollInterval = DEFAULT_POLL_INTERVAL,
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.account = account;
    this.opts = opts;
    this.basePollInterval = pollInterval;
    this.currentPollInterval = pollInterval;
  }

  async connect(): Promise<void> {
    // Verify signal-cli-rest-api is reachable and detect mode
    try {
      const res = await fetch(`${this.apiUrl}/v1/about`);
      if (!res.ok) {
        throw new Error(`signal-cli-rest-api returned ${res.status}`);
      }
      const about = (await res.json()) as { mode?: string };
      this.jsonRpcMode = about.mode === 'json-rpc';
    } catch (err) {
      throw new Error(
        `Cannot connect to signal-cli-rest-api at ${this.apiUrl}: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Build group ID map (internal_id → encoded id for sending)
    try {
      const groupsRes = await fetch(
        `${this.apiUrl}/v1/groups/${encodeURIComponent(this.account)}`,
      );
      if (groupsRes.ok) {
        const groups = (await groupsRes.json()) as Array<{
          id?: string;
          internal_id?: string;
        }>;
        for (const g of groups) {
          if (g.internal_id && g.id) {
            this.groupIdMap.set(g.internal_id, g.id);
          }
        }
        logger.info(
          { count: this.groupIdMap.size },
          'Signal group ID map loaded',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load Signal group list');
    }

    // Seed name cache from DB history + own account
    const dbNames = getSignalSenderNames();
    for (const [uuid, name] of dbNames) {
      this.nameCache.set(uuid, name);
    }
    this.nameCache.set(this.account, 'Claw');
    logger.info({ count: this.nameCache.size }, 'Signal name cache seeded');

    this.connected = true;

    if (this.jsonRpcMode) {
      this.connectWebSocket();
    } else {
      this.schedulePoll();
      this.pollMessages();
    }

    const modeLabel = this.jsonRpcMode ? 'websocket' : 'polling';
    console.log(`\n  Signal account: ${this.account}`);
    console.log(`  Signal API: ${this.apiUrl} (${modeLabel})\n`);

    logger.info({ account: this.account, mode: modeLabel }, 'Signal channel connected');
  }

  private connectWebSocket(): void {
    if (!this.connected) return;

    const wsUrl = this.apiUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
    const url = `${wsUrl}/v1/receive/${encodeURIComponent(this.account)}`;

    this.ws = new WebSocket(url);

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const envelope = JSON.parse(data.toString()) as SignalEnvelope;
        this.handleEnvelope(envelope);
      } catch (err) {
        logger.debug({ err }, 'Signal websocket message parse error');
      }
    });

    this.ws.on('open', () => {
      logger.info('Signal websocket connected');
    });

    this.ws.on('close', () => {
      logger.warn('Signal websocket closed');
      if (this.connected) {
        setTimeout(() => this.connectWebSocket(), WS_RECONNECT_INTERVAL);
      }
    });

    this.ws.on('error', (err) => {
      logger.debug({ err }, 'Signal websocket error');
    });
  }

  private schedulePoll(): void {
    if (!this.connected) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.pollMessages(), this.currentPollInterval);
  }

  async pollMessages(): Promise<void> {
    if (!this.connected) return;
    if (this.polling) {
      this.schedulePoll();
      return;
    }
    this.polling = true;

    try {
      const res = await fetch(
        `${this.apiUrl}/v1/receive/${encodeURIComponent(this.account)}`,
      );
      if (!res.ok) {
        logger.warn(
          { status: res.status },
          'Signal receive endpoint returned error',
        );
        this.backoff();
        return;
      }

      const envelopes = (await res.json()) as SignalEnvelope[];

      if (envelopes.length > 0) {
        // Messages received — reset to fast polling
        this.idlePolls = 0;
        this.currentPollInterval = this.basePollInterval;
      } else {
        this.backoff();
      }

      for (const envelope of envelopes) {
        this.handleEnvelope(envelope);
      }
    } catch (err) {
      logger.debug({ err }, 'Signal poll error');
      this.backoff();
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }

  private backoff(): void {
    this.idlePolls++;
    this.currentPollInterval = Math.min(
      this.basePollInterval * Math.pow(BACKOFF_MULTIPLIER, this.idlePolls),
      MAX_POLL_INTERVAL,
    );
  }

  handleEnvelope(envelope: SignalEnvelope): void {
    const data = envelope.envelope;
    if (!data) return;

    const dataMessage = data.dataMessage;
    if (!dataMessage) return;

    const timestamp = new Date(
      data.timestamp || Date.now(),
    ).toISOString();
    const sender = data.sourceNumber || data.source || '';
    const senderName = data.sourceName || sender;
    const msgId = `${data.timestamp}`;

    // Cache sender name for mention resolution
    if (data.source && data.sourceName) {
      this.nameCache.set(data.source, data.sourceName);
    }

    // Echo prevention — skip messages we sent ourselves
    if (this.sentTimestamps.has(msgId)) {
      this.sentTimestamps.delete(msgId);
      return;
    }

    // Determine chat JID and whether this is a group
    let chatJid: string;
    let chatName: string;
    let isGroup: boolean;

    if (dataMessage.groupInfo?.groupId) {
      chatJid = `signal-group:${dataMessage.groupInfo.groupId}`;
      chatName = dataMessage.groupInfo.groupName || chatJid;
      isGroup = true;
    } else {
      chatJid = `signal:${sender}`;
      chatName = senderName;
      isGroup = false;
    }

    // Build message content — resolve mentions (U+FFFC placeholders)
    let content = dataMessage.message || '';
    if (dataMessage.mentions && dataMessage.mentions.length > 0) {
      // Sort mentions by start position descending so replacements don't shift offsets
      const sorted = [...dataMessage.mentions].sort(
        (a, b) => (b.start ?? 0) - (a.start ?? 0),
      );
      for (const mention of sorted) {
        const name = mention.name || (mention.uuid && this.nameCache.get(mention.uuid)) || mention.uuid || 'unknown';
        const start = mention.start ?? 0;
        const length = mention.length ?? 1;
        content =
          content.slice(0, start) +
          `@${name}` +
          content.slice(start + length);
      }
    }

    // Attachments
    if (dataMessage.attachments && dataMessage.attachments.length > 0) {
      const descriptions = dataMessage.attachments.map((att) => {
        const ct = att.contentType || '';
        const name = att.filename || att.id || 'attachment';
        if (ct.startsWith('image/')) return `[Image: ${name}]`;
        if (ct.startsWith('video/')) return `[Video: ${name}]`;
        if (ct.startsWith('audio/')) return `[Audio: ${name}]`;
        return `[File: ${name}]`;
      });
      content = content
        ? `${content}\n${descriptions.join('\n')}`
        : descriptions.join('\n');
    }

    // Reply / quote context
    let replyToMessageId: string | undefined;
    let replyToContent: string | undefined;
    let replyToSenderName: string | undefined;

    if (dataMessage.quote) {
      const quoteSender =
        dataMessage.quote.authorName ||
        dataMessage.quote.author ||
        'Unknown';
      replyToMessageId = dataMessage.quote.id != null ? `${dataMessage.quote.id}` : undefined;
      replyToContent = dataMessage.quote.text || undefined;
      replyToSenderName = quoteSender;
      content = `[Reply to ${quoteSender}] ${content}`;
    }

    // Emit metadata for all incoming messages (registered or not)
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    // Only deliver messages for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Signal chat',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      reply_to_message_id: replyToMessageId,
      reply_to_message_content: replyToContent,
      reply_to_sender_name: replyToSenderName,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Signal message stored',
    );
  }

  async sendMessage(jid: string, text: string, attachments?: Array<{ contentType: string; filename: string; base64: string }>, replyTo?: { messageId: string; author: string }): Promise<void> {
    if (!this.connected) {
      logger.warn('Signal channel not connected');
      return;
    }

    try {
      // Extract image/GIF URLs before markdown conversion
      const { urls: imageUrls, cleanedText: textWithoutImages } =
        extractImageUrls(text);

      // Convert markdown to plain text + Signal textStyle ranges
      const { text: plainText, textStyle } = parseSignalStyles(textWithoutImages);

      // Build base request body
      const body: Record<string, unknown> = {
        message: plainText,
        number: this.account,
      };

      if (textStyle.length > 0) {
        body.text_style = textStyle.map(
          (s) => `${s.start}:${s.length}:${s.style}`,
        );
      }

      // Set recipient (DM) or group
      if (jid.startsWith('signal-group:')) {
        const internalId = jid.replace(/^signal-group:/, '');
        const encodedId = this.groupIdMap.get(internalId);
        if (!encodedId) {
          throw new Error(`No encoded group ID found for ${internalId}`);
        }
        body.recipients = [encodedId];
      } else {
        body.recipients = [jid.replace(/^signal:/, '')];
      }

      // Add quote for reply threading
      if (replyTo) {
        body.quote_timestamp = parseInt(replyTo.messageId, 10);
        body.quote_author = replyTo.author;
      }

      // Download images and attach as base64
      if (imageUrls.length > 0) {
        const downloads = await Promise.all(
          imageUrls.slice(0, 5).map(downloadAsBase64),
        );
        const attachments = downloads
          .filter((d): d is NonNullable<typeof d> => d !== null)
          .map((d) => `data:${d.contentType};filename=${d.filename};base64,${d.base64}`);
        if (attachments.length > 0) {
          body.base64_attachments = attachments;
        }
      }

      // Add explicit attachments (e.g. voice messages)
      if (attachments && attachments.length > 0) {
        const formatted = attachments.map(
          (a) => `data:${a.contentType};filename=${a.filename};base64,${a.base64}`,
        );
        body.base64_attachments = [
          ...((body.base64_attachments as string[]) || []),
          ...formatted,
        ];
      }

      // Split long messages — textStyle offsets won't be valid across
      // chunks, so we drop styles when splitting. Attachments go with first chunk.
      if (plainText.length > MAX_MESSAGE_LENGTH) {
        const chunks = splitText(plainText, MAX_MESSAGE_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          await this.sendApiMessage({
            ...body,
            message: chunks[i],
            text_style: undefined,
            // Only attach images to the first chunk
            base64_attachments: i === 0 ? body.base64_attachments : undefined,
          });
        }
      } else {
        await this.sendApiMessage(body);
      }

      logger.info({ jid, length: text.length, attachments: imageUrls.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  /**
   * Find known names in outbound text and convert them to Signal mentions.
   * Matches both @Name and bare Name occurrences at word boundaries.
   * Returns the modified text (with U+FFFC placeholders) and a mentions array.
   */
  private extractOutboundMentions(text: string): {
    text: string;
    mentions: Array<{ start: number; length: number; uuid: string }>;
  } {
    // Build reverse map: lowercase name → uuid (skip 'Claw' to avoid self-mentions)
    const nameToUuid = new Map<string, string>();
    for (const [uuid, name] of this.nameCache) {
      if (uuid === this.account) continue;
      nameToUuid.set(name.toLowerCase(), uuid);
    }
    if (nameToUuid.size === 0) return { text, mentions: [] };

    // Build a regex that matches @Name or bare Name at word boundaries
    // Sort by length descending to match longer names first
    const names = [...nameToUuid.keys()].sort((a, b) => b.length - a.length);
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`@?(${escaped.join('|')})\\b`, 'gi');

    const matches: Array<{ index: number; length: number; uuid: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const uuid = nameToUuid.get(match[1].toLowerCase());
      if (!uuid) continue;
      matches.push({ index: match.index, length: match[0].length, uuid });
    }

    if (matches.length === 0) return { text, mentions: [] };

    // Replace matches in reverse order to preserve offsets
    const mentions: Array<{ start: number; length: number; uuid: string }> = [];
    let result = text;
    let offset = 0;

    for (const m of matches.reverse()) {
      const placeholder = '\uFFFC';
      result =
        result.slice(0, m.index) + placeholder + result.slice(m.index + m.length);
    }

    // Now find placeholder positions in the result for the mentions array
    let pos = 0;
    for (const m of [...matches].reverse()) {
      const idx = result.indexOf('\uFFFC', pos);
      if (idx === -1) break;
      mentions.push({ start: idx, length: 1, uuid: m.uuid });
      pos = idx + 1;
    }

    return { text: result, mentions };
  }

  private async sendApiMessage(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Signal send failed (${res.status}): ${errText}`);
    }

    // Cache the response timestamp for echo prevention
    const result = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (result?.timestamp) {
      const ts = `${result.timestamp}`;
      this.sentTimestamps.add(ts);
      setTimeout(() => this.sentTimestamps.delete(ts), 10_000);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:') || jid.startsWith('signal-group:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('Signal channel stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;

    try {
      const body: Record<string, unknown> = {};

      if (jid.startsWith('signal-group:')) {
        const internalId = jid.replace(/^signal-group:/, '');
        const encodedId = this.groupIdMap.get(internalId);
        if (!encodedId) return;
        body.recipient = encodedId;
      } else {
        body.recipient = jid.replace(/^signal:/, '');
      }

      const method = isTyping ? 'PUT' : 'DELETE';
      await fetch(
        `${this.apiUrl}/v1/typing-indicator/${encodeURIComponent(this.account)}`,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } catch {
      // Typing indicators are best-effort
    }
  }

  async sendReaction(
    jid: string,
    emoji: string,
    messageId?: string,
    targetAuthor?: string,
  ): Promise<void> {
    if (!this.connected) return;

    try {
      const body: Record<string, unknown> = {
        reaction: emoji,
        timestamp: messageId ? parseInt(messageId, 10) : undefined,
        target_author: targetAuthor || this.account,
      };

      if (jid.startsWith('signal-group:')) {
        const internalId = jid.replace(/^signal-group:/, '');
        const encodedId = this.groupIdMap.get(internalId);
        if (!encodedId) {
          logger.warn({ jid }, 'No encoded group ID for reaction');
          return;
        }
        body.recipient = encodedId;
      } else {
        body.recipient = jid.replace(/^signal:/, '');
      }

      const res = await fetch(
        `${this.apiUrl}/v1/reactions/${encodeURIComponent(this.account)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        logger.warn(
          { jid, emoji, status: res.status, body, errBody },
          'Signal reaction failed',
        );
      } else {
        logger.info({ jid, emoji }, 'Signal reaction sent');
      }
    } catch (err) {
      logger.error({ jid, emoji, err }, 'Failed to send Signal reaction');
    }
  }
}

// --- Helpers ---

function splitText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

// --- Self-registration ---

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SIGNAL_CLI_API_URL',
    'SIGNAL_ACCOUNT',
    'SIGNAL_POLL_INTERVAL_MS',
  ]);
  const apiUrl =
    process.env.SIGNAL_CLI_API_URL || envVars.SIGNAL_CLI_API_URL || '';
  const account =
    process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';

  if (!account) {
    logger.warn('Signal: SIGNAL_ACCOUNT not set');
    return null;
  }

  const pollInterval = parseInt(
    process.env.SIGNAL_POLL_INTERVAL_MS ||
      envVars.SIGNAL_POLL_INTERVAL_MS ||
      `${DEFAULT_POLL_INTERVAL}`,
    10,
  );

  return new SignalChannel(
    apiUrl || DEFAULT_API_URL,
    account,
    opts,
    pollInterval,
  );
});
