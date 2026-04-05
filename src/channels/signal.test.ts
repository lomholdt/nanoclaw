import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- fetch mock ---

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  SignalChannel,
  SignalChannelOpts,
  SignalEnvelope,
} from './signal.js';

// --- Helpers ---

function createOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+15551234567': {
        name: 'Alice',
        folder: 'signal_alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal-group:abc123groupId': {
        name: 'Test Group',
        folder: 'signal_group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeEnvelope(overrides?: Partial<{
  source: string;
  sourceNumber: string;
  sourceName: string;
  timestamp: number;
  message: string;
  groupId: string;
  groupName: string;
  attachments: Array<{ contentType?: string; filename?: string; id?: string }>;
  quote: { author?: string; authorName?: string; text?: string };
}>): SignalEnvelope {
  return {
    envelope: {
      source: overrides?.source ?? '+15551234567',
      sourceNumber: overrides?.sourceNumber ?? overrides?.source ?? '+15551234567',
      sourceName: overrides?.sourceName ?? 'Alice',
      timestamp: overrides?.timestamp ?? 1700000000000,
      dataMessage: {
        message: overrides?.message ?? 'Hello',
        timestamp: overrides?.timestamp ?? 1700000000000,
        groupInfo: overrides?.groupId
          ? { groupId: overrides.groupId, groupName: overrides.groupName }
          : undefined,
        attachments: overrides?.attachments,
        quote: overrides?.quote,
      },
    },
  };
}

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects when signal-cli-rest-api is reachable', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ versions: ['v1'] })) // /v1/about
        .mockResolvedValue(jsonResponse([])); // /v1/receive

      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/v1/about',
      );

      await channel.disconnect();
    });

    it('throws when signal-cli-rest-api is unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'Cannot connect to signal-cli-rest-api',
      );
      expect(channel.isConnected()).toBe(false);
    });

    it('throws when /v1/about returns non-OK', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'signal-cli-rest-api returned 500',
      );
    });

    it('disconnects cleanly', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValue(jsonResponse([]));

      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      expect(channel.isConnected()).toBe(false);
    });

    it('strips trailing slash from API URL', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValue(jsonResponse([]));

      const channel = new SignalChannel(
        'http://localhost:8080/',
        '+15559999999',
        createOpts(),
      );
      await channel.connect();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/v1/about',
      );

      await channel.disconnect();
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers DM message for registered chat', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      // Manually set connected to test handleEnvelope in isolation
      (channel as any).connected = true;

      channel.handleEnvelope(makeEnvelope({ message: 'Hi there' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.any(String),
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          chat_jid: 'signal:+15551234567',
          sender: '+15551234567',
          sender_name: 'Alice',
          content: 'Hi there',
          is_from_me: false,
        }),
      );
    });

    it('delivers group message for registered group', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: 'Group hello',
          groupId: 'abc123groupId',
          groupName: 'Test Group',
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal-group:abc123groupId',
        expect.any(String),
        'Test Group',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal-group:abc123groupId',
        expect.objectContaining({
          chat_jid: 'signal-group:abc123groupId',
          content: 'Group hello',
        }),
      );
    });

    it('only emits metadata for unregistered chats', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({ source: '+19999999999', sourceNumber: '+19999999999', sourceName: 'Bob' }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+19999999999',
        expect.any(String),
        'Bob',
        'signal',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips envelopes without dataMessage', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope({ envelope: { source: '+15551234567' } } as any);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses sourceNumber over source when both present', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          source: 'uuid-form',
          sourceNumber: '+15551234567',
          sourceName: 'Alice',
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ sender: '+15551234567' }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('describes image attachments', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: '',
          attachments: [{ contentType: 'image/png', filename: 'photo.png' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: '[Image: photo.png]' }),
      );
    });

    it('describes video attachments', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: '',
          attachments: [{ contentType: 'video/mp4', filename: 'clip.mp4' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: '[Video: clip.mp4]' }),
      );
    });

    it('describes audio attachments', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: '',
          attachments: [{ contentType: 'audio/ogg', filename: 'voice.ogg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: '[Audio: voice.ogg]' }),
      );
    });

    it('describes generic file attachments', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: '',
          attachments: [
            { contentType: 'application/pdf', filename: 'doc.pdf' },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: '[File: doc.pdf]' }),
      );
    });

    it('appends attachments to text content', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: 'Check this',
          attachments: [{ contentType: 'image/jpeg', filename: 'pic.jpg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          content: 'Check this\n[Image: pic.jpg]',
        }),
      );
    });

    it('falls back to attachment id when filename missing', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: '',
          attachments: [{ contentType: 'image/png', id: 'att-42' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: '[Image: att-42]' }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('prepends reply author name', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: 'I agree',
          quote: { authorName: 'Bob', text: 'original' },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: '[Reply to Bob] I agree' }),
      );
    });

    it('falls back to quote author number', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      channel.handleEnvelope(
        makeEnvelope({
          message: 'Same',
          quote: { author: '+15559998888' },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          content: '[Reply to +15559998888] Same',
        }),
      );
    });
  });

  // --- Echo prevention ---

  describe('echo prevention', () => {
    it('skips messages with timestamps in sentTimestamps cache', () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      // Simulate a sent message timestamp
      (channel as any).sentTimestamps.add('1700000000000');

      channel.handleEnvelope(makeEnvelope({ timestamp: 1700000000000 }));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends DM via /v2/send with recipients', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ timestamp: 1700000001000 }),
      );

      await channel.sendMessage('signal:+15551234567', 'Hello');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as any).body,
      );
      expect(body.message).toBe('Hello');
      expect(body.number).toBe('+15559999999');
      expect(body.recipients).toEqual(['+15551234567']);
      expect(body.group_id).toBeUndefined();
    });

    it('sends group message via /v2/send with group_id', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ timestamp: 1700000001000 }),
      );

      await channel.sendMessage('signal-group:abc123', 'Group msg');

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as any).body,
      );
      expect(body.group_id).toBe('abc123');
      expect(body.recipients).toEqual([]);
    });

    it('includes textStyle for markdown content', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ timestamp: 1700000001000 }),
      );

      await channel.sendMessage('signal:+15551234567', '**bold text**');

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as any).body,
      );
      expect(body.message).toBe('bold text');
      expect(body.text_style).toEqual([
        { style: 'BOLD', start: 0, length: 9 },
      ]);
    });

    it('does not include text_style when no markdown', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ timestamp: 1700000001000 }),
      );

      await channel.sendMessage('signal:+15551234567', 'plain text');

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as any).body,
      );
      expect(body.text_style).toBeUndefined();
    });

    it('splits messages exceeding 4000 characters', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValue(
        jsonResponse({ timestamp: 1700000001000 }),
      );

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('signal:+15551234567', longText);

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const body1 = JSON.parse(
        (fetchMock.mock.calls[0][1] as any).body,
      );
      const body2 = JSON.parse(
        (fetchMock.mock.calls[1][1] as any).body,
      );
      expect(body1.message.length).toBe(4000);
      expect(body2.message.length).toBe(1000);
      // Styles dropped when splitting
      expect(body1.text_style).toBeUndefined();
    });

    it('does nothing when not connected', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );

      await channel.sendMessage('signal:+15551234567', 'Will not send');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('handles send failure gracefully', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'fail' }, 500));

      // Should not throw
      await expect(
        channel.sendMessage('signal:+15551234567', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('caches sent timestamp for echo prevention', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ timestamp: 1700000005000 }),
      );

      await channel.sendMessage('signal:+15551234567', 'test');

      expect((channel as any).sentTimestamps.has('1700000005000')).toBe(
        true,
      );
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns signal: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      expect(channel.ownsJid('signal:+15551234567')).toBe(true);
    });

    it('owns signal-group: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      expect(channel.ownsJid('signal-group:abc123')).toBe(true);
    });

    it('does not own Discord JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      expect(channel.ownsJid('dc:1234567890')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });
  });

  // --- sendReaction ---

  describe('sendReaction', () => {
    it('sends reaction via /v1/reactions for DM', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      await channel.sendReaction(
        'signal:+15551234567',
        '👍',
        '1700000000000',
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/v1/reactions/%2B15559999999',
        expect.objectContaining({ method: 'POST' }),
      );

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as any).body,
      );
      expect(body.reaction).toBe('👍');
      expect(body.recipient).toBe('+15551234567');
      expect(body.target_timestamp).toBe(1700000000000);
    });

    it('sends reaction via /v1/reactions for group', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      await channel.sendReaction(
        'signal-group:abc123',
        '❤️',
        '1700000000000',
      );

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as any).body,
      );
      expect(body.group_id).toBe('abc123');
      expect(body.recipient).toBeUndefined();
    });

    it('does nothing when not connected', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );

      await channel.sendReaction('signal:+15551234567', '👍');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('does nothing (no-op)', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      (channel as any).connected = true;

      await channel.setTyping('signal:+15551234567', true);
      await channel.setTyping('signal:+15551234567', false);

      // No fetch calls for typing
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );
      expect(channel.name).toBe('signal');
    });
  });

  // --- Polling ---

  describe('polling', () => {
    it('processes multiple envelopes from a single poll', async () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          makeEnvelope({ message: 'First', timestamp: 1700000001000 }),
          makeEnvelope({ message: 'Second', timestamp: 1700000002000 }),
        ]),
      );

      await channel.pollMessages();

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });

    it('handles poll error gracefully', async () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
      );
      (channel as any).connected = true;

      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(channel.pollMessages()).resolves.toBeUndefined();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips poll when not connected', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        createOpts(),
      );

      await channel.pollMessages();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('backs off when polls return no messages', async () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
        5000,
      );
      (channel as any).connected = true;

      // Empty poll → should increase interval
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await channel.pollMessages();
      expect((channel as any).currentPollInterval).toBeGreaterThan(5000);
      expect((channel as any).idlePolls).toBe(1);

      // Another empty poll → should increase further
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await channel.pollMessages();
      expect((channel as any).currentPollInterval).toBeGreaterThan(7000);
      expect((channel as any).idlePolls).toBe(2);
    });

    it('resets to base interval when messages arrive', async () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
        5000,
      );
      (channel as any).connected = true;

      // Back off first
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await channel.pollMessages();
      expect((channel as any).currentPollInterval).toBeGreaterThan(5000);

      // Message arrives → reset
      fetchMock.mockResolvedValueOnce(
        jsonResponse([makeEnvelope({ message: 'Hi', timestamp: 1700000001000 })]),
      );
      await channel.pollMessages();
      expect((channel as any).currentPollInterval).toBe(5000);
      expect((channel as any).idlePolls).toBe(0);
    });

    it('caps backoff at MAX_POLL_INTERVAL (30s)', async () => {
      const opts = createOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15559999999',
        opts,
        5000,
      );
      (channel as any).connected = true;

      // Many empty polls
      for (let i = 0; i < 20; i++) {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        await channel.pollMessages();
      }
      expect((channel as any).currentPollInterval).toBeLessThanOrEqual(30000);
    });
  });
});
