import net from 'net';

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

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6001;
const MAX_MESSAGE_LENGTH = 4000;
const RECONNECT_INTERVAL = 5000;
const MAX_RECONNECT_INTERVAL = 60000;
const RECONNECT_BACKOFF = 1.5;

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

// --- Types for signal-cli JSON-RPC envelopes ---

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

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: Record<string, unknown>;
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private host: string;
  private port: number;
  private account: string;
  private connected = false;
  private opts: SignalChannelOpts;
  /** TCP socket to signal-cli daemon */
  private socket: net.Socket | null = null;
  /** Line buffer for incoming JSON-RPC messages */
  private buffer = '';
  /** Pending RPC requests awaiting responses */
  private pendingRequests = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }
  >();
  /** Auto-incrementing RPC request ID */
  private nextId = 1;
  /** Current reconnect interval (exponential backoff) */
  private reconnectInterval = RECONNECT_INTERVAL;
  /** Timestamps of messages we sent, used for echo prevention (10s TTL). */
  private sentTimestamps = new Set<string>();
  /** Maps Signal UUIDs to display names, built from incoming messages. */
  private nameCache = new Map<string, string>();

  constructor(
    host: string,
    port: number,
    account: string,
    opts: SignalChannelOpts,
  ) {
    this.host = host;
    this.port = port;
    this.account = account;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Seed name cache from DB history
    const dbNames = getSignalSenderNames();
    for (const [uuid, name] of dbNames) {
      this.nameCache.set(uuid, name);
    }
    this.nameCache.set(this.account, 'Claw');
    logger.info({ count: this.nameCache.size }, 'Signal name cache seeded');

    this.connected = true;
    await this.connectSocket();

    console.log(`\n  Signal account: ${this.account}`);
    console.log(`  Signal daemon: ${this.host}:${this.port} (json-rpc)\n`);

    logger.info(
      { account: this.account, host: this.host, port: this.port },
      'Signal channel connected',
    );
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not connected'));

      this.socket = new net.Socket();
      this.buffer = '';
      let resolved = false;

      this.socket.connect(this.port, this.host, () => {
        logger.info('Signal JSON-RPC socket connected');
        this.reconnectInterval = RECONNECT_INTERVAL;
        resolved = true;
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.socket.on('close', () => {
        logger.warn('Signal JSON-RPC socket closed');
        this.socket = null;
        if (this.connected) {
          setTimeout(() => {
            this.connectSocket().catch(() => {});
            this.reconnectInterval = Math.min(
              this.reconnectInterval * RECONNECT_BACKOFF,
              MAX_RECONNECT_INTERVAL,
            );
          }, this.reconnectInterval);
        }
      });

      this.socket.on('error', (err) => {
        logger.debug({ err }, 'Signal JSON-RPC socket error');
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.handleJsonRpcMessage(msg);
      } catch (err) {
        logger.debug({ err, line: line.slice(0, 200) }, 'JSON-RPC parse error');
      }
    }
  }

  private handleJsonRpcMessage(msg: JsonRpcResponse): void {
    // Response to a request we sent
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result || {});
      }
      return;
    }

    // Notification (incoming message)
    if (msg.method === 'receive' && msg.params) {
      this.handleEnvelope(msg.params as unknown as SignalEnvelope);
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  private rpcCall(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new Error('Signal socket not connected'));
      }

      const id = this.nextId++;
      const req = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.socket.write(req);
    });
  }

  handleEnvelope(envelope: SignalEnvelope): void {
    const data = envelope.envelope;
    if (!data) return;

    const dataMessage = data.dataMessage;
    if (!dataMessage) return;

    const timestamp = new Date(data.timestamp || Date.now()).toISOString();
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
      const sorted = [...dataMessage.mentions].sort(
        (a, b) => (b.start ?? 0) - (a.start ?? 0),
      );
      for (const mention of sorted) {
        const name =
          mention.name ||
          (mention.uuid && this.nameCache.get(mention.uuid)) ||
          mention.uuid ||
          'unknown';
        const start = mention.start ?? 0;
        const length = mention.length ?? 1;
        content =
          content.slice(0, start) + `@${name}` + content.slice(start + length);
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
        dataMessage.quote.authorName || dataMessage.quote.author || 'Unknown';
      replyToMessageId =
        dataMessage.quote.id != null ? `${dataMessage.quote.id}` : undefined;
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

  async sendMessage(
    jid: string,
    text: string,
    attachments?: Array<{
      contentType: string;
      filename: string;
      base64: string;
    }>,
    replyTo?: { messageId: string; author: string },
  ): Promise<void> {
    if (!this.connected) {
      logger.warn('Signal channel not connected');
      return;
    }

    try {
      // Extract image/GIF URLs before markdown conversion
      const { urls: imageUrls, cleanedText: textWithoutImages } =
        extractImageUrls(text);

      // Convert markdown to plain text + Signal textStyle ranges
      const { text: plainText, textStyle } =
        parseSignalStyles(textWithoutImages);

      // Build RPC params
      const params: Record<string, unknown> = {
        message: plainText,
      };

      // Text styles (bold, italic, spoiler, etc.)
      if (textStyle.length > 0) {
        params.textStyle = textStyle.map(
          (s) => `${s.start}:${s.length}:${s.style}`,
        );
      }

      // Set recipient (DM) or group
      if (jid.startsWith('signal-group:')) {
        const groupId = jid.replace(/^signal-group:/, '');
        params.groupId = groupId;
      } else {
        params.recipient = [jid.replace(/^signal:/, '')];
      }

      // Quote for reply threading
      if (replyTo) {
        params.quoteTimestamp = parseInt(replyTo.messageId, 10);
        params.quoteAuthor = replyTo.author;
      }

      // Download image URLs and add as attachments
      if (imageUrls.length > 0) {
        const downloads = await Promise.all(
          imageUrls.slice(0, 5).map(downloadAsBase64),
        );
        const base64Attachments = downloads
          .filter((d): d is NonNullable<typeof d> => d !== null)
          .map(
            (d) =>
              `data:${d.contentType};filename=${d.filename};base64,${d.base64}`,
          );
        if (base64Attachments.length > 0) {
          params.attachments = base64Attachments;
        }
      }

      // Explicit attachments (e.g. voice messages)
      if (attachments && attachments.length > 0) {
        const formatted = attachments.map(
          (a) =>
            `data:${a.contentType};filename=${a.filename};base64,${a.base64}`,
        );
        params.attachments = [
          ...((params.attachments as string[]) || []),
          ...formatted,
        ];
      }

      // Split long messages
      if (plainText.length > MAX_MESSAGE_LENGTH) {
        const chunks = splitText(plainText, MAX_MESSAGE_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          const chunkParams = {
            ...params,
            message: chunks[i],
            textStyle: undefined,
            attachments: i === 0 ? params.attachments : undefined,
          };
          const result = await this.rpcCall('send', chunkParams);
          this.cacheTimestamp(result);
        }
      } else {
        const result = await this.rpcCall('send', params);
        this.cacheTimestamp(result);
      }

      logger.info(
        { jid, length: text.length, attachments: imageUrls.length },
        'Signal message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  /** Cache sent timestamp for echo prevention */
  private cacheTimestamp(result: Record<string, unknown>): void {
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
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    // Reject any pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    logger.info('Signal channel stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;

    try {
      const params: Record<string, unknown> = {
        stop: !isTyping,
      };

      if (jid.startsWith('signal-group:')) {
        params.groupId = jid.replace(/^signal-group:/, '');
      } else {
        params.recipient = [jid.replace(/^signal:/, '')];
      }

      await this.rpcCall('sendTyping', params);
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
      const params: Record<string, unknown> = {
        emoji,
        targetTimestamp: messageId ? parseInt(messageId, 10) : undefined,
        targetAuthor: targetAuthor || this.account,
      };

      if (jid.startsWith('signal-group:')) {
        params.groupId = jid.replace(/^signal-group:/, '');
      } else {
        params.recipient = [jid.replace(/^signal:/, '')];
      }

      await this.rpcCall('sendReaction', params);
      logger.info({ jid, emoji }, 'Signal reaction sent');
    } catch (err) {
      logger.error({ jid, emoji, err }, 'Failed to send Signal reaction');
    }
  }

  async sendPoll(
    jid: string,
    question: string,
    answers: string[],
    _durationHours: number,
    allowMultiselect: boolean,
  ): Promise<void> {
    if (!this.connected) return;

    try {
      const params: Record<string, unknown> = {
        question,
        options: answers,
      };

      if (!allowMultiselect) {
        params.multiSelect = false;
      }

      if (jid.startsWith('signal-group:')) {
        params.groupId = jid.replace(/^signal-group:/, '');
      } else {
        params.recipient = [jid.replace(/^signal:/, '')];
      }

      await this.rpcCall('sendPollCreate', params);
      logger.info({ jid, question }, 'Signal poll created');
    } catch (err) {
      logger.error({ jid, question, err }, 'Failed to create Signal poll');
    }
  }

  async pinMessage(
    jid: string,
    messageId: string,
    targetAuthor: string,
    durationSeconds = -1,
  ): Promise<void> {
    if (!this.connected) return;

    try {
      const params: Record<string, unknown> = {
        targetTimestamp: parseInt(messageId, 10),
        targetAuthor,
        pinDuration: durationSeconds,
      };

      if (jid.startsWith('signal-group:')) {
        params.groupId = jid.replace(/^signal-group:/, '');
      } else {
        params.recipient = [jid.replace(/^signal:/, '')];
      }

      await this.rpcCall('sendPinMessage', params);
      logger.info({ jid, messageId }, 'Signal message pinned');
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to pin Signal message');
    }
  }

  async unpinMessage(
    jid: string,
    messageId: string,
    targetAuthor: string,
  ): Promise<void> {
    if (!this.connected) return;

    try {
      const params: Record<string, unknown> = {
        targetTimestamp: parseInt(messageId, 10),
        targetAuthor,
      };

      if (jid.startsWith('signal-group:')) {
        params.groupId = jid.replace(/^signal-group:/, '');
      } else {
        params.recipient = [jid.replace(/^signal:/, '')];
      }

      await this.rpcCall('sendUnpinMessage', params);
      logger.info({ jid, messageId }, 'Signal message unpinned');
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to unpin Signal message');
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
    'SIGNAL_CLI_HOST',
    'SIGNAL_CLI_PORT',
    'SIGNAL_ACCOUNT',
  ]);
  const host =
    process.env.SIGNAL_CLI_HOST || envVars.SIGNAL_CLI_HOST || DEFAULT_HOST;
  const port = parseInt(
    process.env.SIGNAL_CLI_PORT || envVars.SIGNAL_CLI_PORT || `${DEFAULT_PORT}`,
    10,
  );
  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';

  if (!account) {
    logger.warn('Signal: SIGNAL_ACCOUNT not set');
    return null;
  }

  return new SignalChannel(host, port, account, opts);
});
