import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Image file extensions that Discord can render inline */
const IMAGE_EXTENSIONS = /\.(gif|png|jpe?g|webp|svg)(\?[^\s)]*)?$/i;

/** Hosts that serve embeddable images even without a file extension */
const IMAGE_HOSTS = /(?:giphy\.com|tenor\.com|imgur\.com)/i;

/**
 * Extract image/GIF URLs from text, return AttachmentBuilder objects
 * and cleaned text with those URLs removed.
 * Handles bare URLs and markdown [text](url).
 * Discord caps attachments at 10 per message.
 */
export function extractImageAttachments(text: string): {
  attachments: AttachmentBuilder[];
  cleanedText: string;
} {
  const urlPattern =
    /(?:\[(?:[^\]]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)>\]]+))/g;
  const seen = new Set<string>();
  const attachments: AttachmentBuilder[] = [];
  const imageMatches: string[] = []; // full match strings to strip

  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[1] || match[2];
    if (seen.has(url)) continue;
    seen.add(url);

    if (IMAGE_EXTENSIONS.test(url) || IMAGE_HOSTS.test(url)) {
      attachments.push(new AttachmentBuilder(url));
      imageMatches.push(match[0]);
    }
  }

  // Strip matched image URLs/links from the text
  let cleaned = text;
  for (const m of imageMatches) {
    cleaned = cleaned.replace(m, '');
  }
  // Collapse leftover whitespace (double newlines, trailing spaces)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { attachments: attachments.slice(0, 10), cleanedText: cleaned };
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Extract image/GIF URLs and build attachments, strip URLs from text
      const { attachments, cleanedText } = extractImageAttachments(text);
      const content = attachments.length > 0 ? cleanedText : text;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (content.length <= MAX_LENGTH) {
        if (attachments.length > 0) {
          await textChannel.send({
            content: content || undefined,
            files: attachments,
          });
        } else {
          await textChannel.send(content);
        }
      } else {
        const chunks: string[] = [];
        for (let i = 0; i < content.length; i += MAX_LENGTH) {
          chunks.push(content.slice(i, i + MAX_LENGTH));
        }
        // Send all chunks except the last as plain text
        for (let i = 0; i < chunks.length - 1; i++) {
          await textChannel.send(chunks[i]);
        }
        // Attach files to the last chunk
        const last = chunks[chunks.length - 1];
        if (attachments.length > 0) {
          await textChannel.send({ content: last, files: attachments });
        } else {
          await textChannel.send(last);
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async sendReaction(
    jid: string,
    emoji: string,
    messageId?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('messages' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // If no messageId, react to the most recent message
      let targetMessage: Message;
      if (messageId) {
        targetMessage = await textChannel.messages.fetch(messageId);
      } else {
        const recent = await textChannel.messages.fetch({ limit: 1 });
        const latest = recent.first();
        if (!latest) {
          logger.warn({ jid }, 'No messages found to react to');
          return;
        }
        targetMessage = latest;
      }

      // Resolve custom guild emoji by name (e.g. "nice" → guild emoji object)
      let resolvedEmoji: string | import('discord.js').GuildEmoji = emoji;
      if (!/^\p{Emoji}/u.test(emoji) && !emoji.startsWith('<')) {
        const guild = targetMessage.guild;
        if (guild) {
          const custom = guild.emojis.cache.find(
            (e) => e.name?.toLowerCase() === emoji.toLowerCase(),
          );
          if (custom) {
            resolvedEmoji = custom;
          } else {
            logger.warn({ jid, emoji }, 'Custom emoji not found in guild');
            return;
          }
        }
      }

      await targetMessage.react(resolvedEmoji);
      logger.info(
        { jid, emoji, messageId: targetMessage.id },
        'Discord reaction sent',
      );
    } catch (err) {
      logger.error({ jid, emoji, err }, 'Failed to send Discord reaction');
    }
  }

  async sendPoll(
    jid: string,
    question: string,
    answers: string[],
    durationHours: number,
    allowMultiselect: boolean,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;
      await textChannel.send({
        poll: {
          question: { text: question },
          answers: answers.map((a) => ({ text: a })),
          duration: durationHours,
          allowMultiselect,
        },
      });
      logger.info({ jid, question }, 'Discord poll created');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to create Discord poll');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
