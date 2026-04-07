import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';

function toLocalTime(utcDateStr: string): string {
  if (!utcDateStr) return '';
  try {
    const d = new Date(utcDateStr + 'Z'); // Treat as UTC
    return d.toLocaleString('da-DK', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return utcDateStr;
  }
}
import { AvailableGroup } from './container-runner.js';
import {
  createLiveScoreSubscription,
  createTask,
  deleteLiveScoreSubscription,
  deleteTask,
  getLiveScoreSubscription,
  getLiveScoreSubscriptionsForGroup,
  getMessageForReaction,
  getTaskById,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { Channel, LiveScoreSubscription, RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

export interface IpcAttachment {
  contentType: string;
  filename: string;
  base64: string;
}

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    attachments?: IpcAttachment[],
  ) => Promise<void>;
  sendReaction: (
    jid: string,
    emoji: string,
    messageId?: string,
  ) => Promise<void>;
  sendPoll: (
    jid: string,
    question: string,
    answers: string[],
    durationHours: number,
    allowMultiselect: boolean,
  ) => Promise<void>;
  getChannel?: (jid: string) => Channel | undefined;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  onLiveScoreSubscribed?: (sub: LiveScoreSubscription) => void;
  onLiveScoreUnsubscribed?: (eventId: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'voice_message' &&
                data.chatJid &&
                data.text
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  try {
                    const ttsArgs = [data.text];
                    if (data.voice) {
                      ttsArgs.unshift('--voice', data.voice);
                    }
                    const { stdout } = await execFileAsync(
                      path.resolve(process.cwd(), 'scripts/tts.sh'),
                      ttsArgs,
                      { maxBuffer: 10 * 1024 * 1024 },
                    );
                    const base64Audio = stdout.trim();
                    await deps.sendMessage(data.chatJid, '', [
                      {
                        contentType: 'audio/mpeg',
                        filename: 'voice.mp3',
                        base64: base64Audio,
                      },
                    ]);
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        textLength: data.text.length,
                      },
                      'IPC voice message sent',
                    );
                  } catch (err) {
                    logger.error(
                      { chatJid: data.chatJid, err, sourceGroup },
                      'IPC voice message TTS failed',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC voice message attempt blocked',
                  );
                }
              } else if (
                data.type === 'reaction' &&
                data.chatJid &&
                data.emoji
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendReaction(
                    data.chatJid,
                    data.emoji,
                    data.messageId,
                  );
                  logger.info(
                    { chatJid: data.chatJid, emoji: data.emoji, sourceGroup },
                    'IPC reaction sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
                  );
                }
              } else if (data.type === 'pin_message' && data.chatJid) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const msg = getMessageForReaction(
                    data.chatJid,
                    data.messageId,
                  );
                  if (msg) {
                    const channel = deps.getChannel?.(data.chatJid);
                    if (channel && 'pinMessage' in channel) {
                      const duration = data.durationSeconds
                        ? parseInt(data.durationSeconds, 10)
                        : -1;
                      await (channel as { pinMessage: Function }).pinMessage(
                        data.chatJid,
                        msg.id,
                        msg.sender,
                        duration,
                      );
                      logger.info(
                        {
                          chatJid: data.chatJid,
                          messageId: msg.id,
                          sourceGroup,
                        },
                        'IPC message pinned',
                      );
                    }
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid },
                      'No message found to pin',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC pin attempt blocked',
                  );
                }
              } else if (
                data.type === 'poll' &&
                data.chatJid &&
                data.question &&
                data.answers
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendPoll(
                    data.chatJid,
                    data.question,
                    data.answers,
                    data.durationHours ?? 24,
                    data.allowMultiselect ?? false,
                  );
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      question: data.question,
                      sourceGroup,
                    },
                    'IPC poll created',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC poll attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For live scores
    event_id?: string;
    match_name?: string;
    scheduled_date?: string;
    subscription_id?: string;
    date?: string;
    event_type?: string;
    notification_level?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'subscribe_live_score':
      if (data.event_id && data.targetJid) {
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot subscribe live score: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized subscribe_live_score attempt blocked',
          );
          break;
        }

        // Dedup: skip if this group already has an active subscription for this event
        const existingSubs = getLiveScoreSubscriptionsForGroup(targetFolder);
        if (existingSubs.some((s) => s.event_id === data.event_id)) {
          logger.info(
            { eventId: data.event_id, targetFolder },
            'Live score subscription already exists, skipping duplicate',
          );
          break;
        }

        const subId = `ls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const status =
          data.scheduled_date &&
          new Date(data.scheduled_date).getTime() > Date.now() + 10 * 60 * 1000
            ? 'scheduled'
            : 'active';

        const sub: LiveScoreSubscription = {
          id: subId,
          chat_jid: targetJid,
          group_folder: targetFolder,
          event_id: data.event_id,
          match_name: (data.match_name as string) || null,
          scheduled_date: (data.scheduled_date as string) || null,
          notification_level:
            (data.notification_level as 'goals' | 'key' | 'all') || 'all',
          status: status as 'active' | 'scheduled',
          pinned_message_id: null,
          created_at: new Date().toISOString(),
          completed_at: null,
        };

        createLiveScoreSubscription(sub);
        logger.info(
          { subId, eventId: data.event_id, sourceGroup, targetFolder, status },
          'Live score subscription created via IPC',
        );
        deps.onLiveScoreSubscribed?.(sub);
      }
      break;

    case 'get_matches':
      if (data.date) {
        // Fetch matches for the given date and write response file
        void (async () => {
          try {
            const { fetchMatchesForDate } = await import('./live-scores.js');
            const matches = await fetchMatchesForDate(data.date as string);
            const result = Array.from(matches.values()).map((m) => ({
              id: m.id,
              sportId: m.sportId,
              status: m.status,
              statusName: m.statusName,
              matchName: m.matchName,
              tournament: m.tournamentName,
              scheduledDate: toLocalTime(m.scheduledDate),
              home: {
                name: m.homeTeam.name,
                short: m.homeTeam.shortName,
                score: m.homeTeam.score,
                ...(m.homeTeam.setScores && {
                  setScores: m.homeTeam.setScores,
                  gameScore: m.homeTeam.gameScore,
                  serving: m.homeTeam.serving,
                }),
              },
              away: {
                name: m.awayTeam.name,
                short: m.awayTeam.shortName,
                score: m.awayTeam.score,
                ...(m.awayTeam.setScores && {
                  setScores: m.awayTeam.setScores,
                  gameScore: m.awayTeam.gameScore,
                  serving: m.awayTeam.serving,
                }),
              },
            }));
            const ipcDir = path.join(DATA_DIR, 'ipc', sourceGroup);
            const responseFile = path.join(ipcDir, `matches_${data.date}.json`);
            fs.writeFileSync(responseFile, JSON.stringify(result, null, 2));
            logger.info(
              { date: data.date, count: result.length, sourceGroup },
              'Matches fetched for date',
            );
          } catch (err) {
            logger.warn(
              { err, date: data.date },
              'Failed to fetch matches for date',
            );
          }
        })();
      }
      break;

    case 'get_match_details':
      if (data.event_id) {
        void (async () => {
          try {
            const { fetchMatchDetails } = await import('./live-scores.js');
            const details = await fetchMatchDetails(data.event_id!);
            if (!details) {
              logger.warn(
                { eventId: data.event_id },
                'Match details not found',
              );
              return;
            }
            const ipcDir = path.join(DATA_DIR, 'ipc', sourceGroup);
            fs.mkdirSync(ipcDir, { recursive: true });
            const responseFile = path.join(
              ipcDir,
              `match_details_${data.event_id}.json`,
            );
            fs.writeFileSync(responseFile, JSON.stringify(details, null, 2));
            logger.info(
              { eventId: data.event_id, sourceGroup },
              'Match details fetched',
            );
          } catch (err) {
            logger.warn(
              { err, eventId: data.event_id },
              'Failed to fetch match details',
            );
          }
        })();
      }
      break;

    case 'send_scorecard':
      if (data.event_id && data.chatJid) {
        void (async () => {
          try {
            const { fetchTodayScores } = await import('./live-scores.js');
            const { generateScorecard } = await import('./scorecard.js');
            const allMatches = await fetchTodayScores();
            const matchState = allMatches.get(data.event_id!);
            if (!matchState) {
              logger.warn(
                { eventId: data.event_id },
                'Match not found for scorecard',
              );
              return;
            }
            const event = {
              type: (data.event_type || 'live') as 'live',
              eventId: data.event_id!,
              match: matchState,
            };
            const buf = await generateScorecard(event);
            if (!buf) {
              logger.warn(
                { eventId: data.event_id },
                'Scorecard generation failed',
              );
              return;
            }
            const attachments = [
              {
                contentType: 'image/png',
                filename: `scorecard-${data.event_id}.png`,
                base64: buf.toString('base64'),
              },
            ];
            const { homeTeam: home, awayTeam: away } = matchState;
            const text = `${home.name} ${home.score}-${away.score} ${away.name}\n_${matchState.tournamentName}_`;
            await deps.sendMessage(data.chatJid!, text, attachments);
            logger.info(
              { eventId: data.event_id, chatJid: data.chatJid },
              'Scorecard sent',
            );
          } catch (err) {
            logger.warn(
              { err, eventId: data.event_id },
              'Failed to send scorecard',
            );
          }
        })();
      }
      break;

    case 'unsubscribe_live_score':
      if (data.subscription_id) {
        const sub = getLiveScoreSubscription(data.subscription_id);
        if (sub && (isMain || sub.group_folder === sourceGroup)) {
          const eventId = sub.event_id;
          deleteLiveScoreSubscription(data.subscription_id);
          logger.info(
            { subscriptionId: data.subscription_id, sourceGroup },
            'Live score subscription removed via IPC',
          );
          deps.onLiveScoreUnsubscribed?.(eventId);
        } else {
          logger.warn(
            { subscriptionId: data.subscription_id, sourceGroup },
            'Unauthorized live score unsubscribe attempt',
          );
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
