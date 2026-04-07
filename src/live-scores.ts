/**
 * Live Scores Service
 *
 * Real-time sports score tracking via EnetScores (DR.dk widget data).
 * - MQTT WebSocket for instant push updates (goals, elapsed, incidents)
 * - HTTP endpoint for initial state hydration and on-demand queries
 * - AES-256-CBC decryption of match data
 * - Multi-sport support (football, handball, hockey, cycling, golf)
 */

import { createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

import mqtt from 'mqtt';

import { DATA_DIR } from './config.js';
import {
  completeLiveScoreSubscriptionsForEvent,
  getActiveLiveScoreSubscriptions,
  getSubscribedEventIds,
  getSubscriptionsForEvent,
} from './db.js';
import { logger } from './logger.js';
import type { LiveScoreSubscription, MatchEvent, MatchState } from './types.js';

const inflateRawAsync = promisify(inflateRaw);

// --- EnetScores config ---

const WIDGET_CODE = 'FW2E6DC61A58008DCB';
const DATA_URL_TEMPLATE = `https://es-ds.enetscores.com/11.231/${WIDGET_CODE}/live-da-livescore_tournament-daily-{SID}-{DATE}-0-p0200-t_g-theme_drdk_25-gb_stage-rt_livescore-rb_all-rn_all-clid_1708-sgkd_no-wv_none-pr_o_t_tournament_template`;

const MQTT_URL = 'wss://emqx.enetscores.com:8084/mqtt';
const MQTT_USERNAME = 'emqx_subscribe';
const MQTT_PASSWORD = 'public';

// AES decryption key material
const ENET_PASSWORD = '%RtR8AB&nWsh=AQC+v!=pgAe@dSQG3kQ';
const ENET_SALT = 'orieC_jQQWRmhkPvR6u2kzXeTu6aYupi';
const ENET_ITERATIONS = 100;

// Sport IDs used in data URLs and MQTT topics
export const SPORT_IDS: Record<string, number> = {
  football: 1,
  golf: 3,
  hockey: 5,
  handball: 20,
  cycling: 30,
};

// Derive AES key once at module load
const aesKey = pbkdf2Sync(ENET_PASSWORD, ENET_SALT, ENET_ITERATIONS, 32, 'sha256');

// Polling interval for HTTP fallback when MQTT is disconnected
const FALLBACK_POLL_INTERVAL = 30_000;
// How long before kickoff to activate a scheduled subscription
const PRE_KICKOFF_MS = 5 * 60 * 1000;

// --- Types ---

export interface LiveScoresDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

// Raw event data from the EnetScores JSON
interface RawEvent {
  id: string;
  sd: string; // scheduled date
  st: string; // status
  sn: string; // status name
  sns: string; // status name short
  enm: string; // event name
  nm: string; // tournament name
  et: string; // elapsed time
  par: Record<
    string,
    {
      pi: string;
      pn: string;
      pns: string;
      frs: string;
      rs1: string;
    }
  >;
}

// --- State ---

const matchStateCache = new Map<string, MatchState>();
const kickoffTimers = new Map<string, NodeJS.Timeout>(); // event_id → timer
let mqttClient: mqtt.MqttClient | null = null;
let serviceDeps: LiveScoresDeps | null = null;
let fallbackInterval: NodeJS.Timeout | null = null;
let mqttConnected = false;

// Track which event_ids we're subscribed to on MQTT (to avoid duplicate subs)
const mqttSubscribedEvents = new Set<string>();

// --- Decryption ---

function decryptContent(encrypted: string): string {
  const raw = Buffer.from(encrypted, 'base64').toString('latin1');
  const colonPos = raw.lastIndexOf(':');
  if (colonPos === -1) throw new Error('Invalid encrypted content: no IV separator');

  const ciphertextB64 = raw.slice(0, colonPos);
  const ivHex = raw.slice(colonPos + 1);

  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const iv = Buffer.from(ivHex, 'hex');

  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

// --- HTTP Data Fetching ---

function buildDataUrl(sportId: number, date: string): string {
  return DATA_URL_TEMPLATE.replace('{SID}', String(sportId)).replace('{DATE}', date);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseRawEvent(ev: RawEvent): MatchState {
  const home = ev.par?.['1'] || { pi: '', pn: '?', pns: '?', frs: '0', rs1: '0' };
  const away = ev.par?.['2'] || { pi: '', pn: '?', pns: '?', frs: '0', rs1: '0' };
  return {
    id: ev.id,
    status: ev.st || 'unknown',
    statusName: ev.sn || '',
    statusNameShort: ev.sns || '',
    matchName: ev.enm || `${home.pn}-${away.pn}`,
    tournamentName: ev.nm || '',
    elapsedTime: ev.et || '',
    scheduledDate: ev.sd || '',
    homeTeam: {
      id: home.pi,
      name: home.pn,
      shortName: home.pns,
      score: parseInt(home.frs) || 0,
      halfTimeScore: parseInt(home.rs1) || 0,
    },
    awayTeam: {
      id: away.pi,
      name: away.pn,
      shortName: away.pns,
      score: parseInt(away.frs) || 0,
      halfTimeScore: parseInt(away.rs1) || 0,
    },
  };
}

/**
 * Fetch and decrypt match data for a given sport and date.
 * Returns a map of event_id → MatchState.
 */
export async function fetchMatchData(
  sportId: number,
  date: string,
): Promise<Map<string, MatchState>> {
  const url = buildDataUrl(sportId, date);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

  const json = (await response.json()) as {
    enc?: boolean;
    content?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: any;
  };

  let data: { data: { rows: Record<string, { events?: Record<string, Record<string, RawEvent>> }> } };
  if (json.enc && json.content) {
    const decrypted = decryptContent(json.content);
    data = JSON.parse(decrypted);
  } else {
    data = json as typeof data;
  }

  const matches = new Map<string, MatchState>();
  const rows = data?.data?.rows;
  if (!rows) return matches;

  for (const stage of Object.values(rows)) {
    if (!stage.events || typeof stage.events !== 'object') continue;
    for (const evGroup of Object.values(stage.events)) {
      if (typeof evGroup !== 'object') continue;
      // Events are nested under the 'e' key: events.{group}.e.{event_id}
      const eventDict = (evGroup as Record<string, unknown>).e;
      if (!eventDict || typeof eventDict !== 'object') continue;
      for (const [eid, ev] of Object.entries(eventDict as Record<string, unknown>)) {
        if (typeof ev !== 'object' || !ev || !('par' in ev)) continue;
        matches.set(eid, parseRawEvent(ev as RawEvent));
      }
    }
  }

  return matches;
}

/**
 * Fetch today's matches for all sports.
 */
export async function fetchTodayScores(): Promise<Map<string, MatchState>> {
  const today = formatDate(new Date());
  const all = new Map<string, MatchState>();

  const fetches = Object.values(SPORT_IDS).map(async (sid) => {
    try {
      const matches = await fetchMatchData(sid, today);
      for (const [id, state] of matches) all.set(id, state);
    } catch (err) {
      logger.warn({ err, sportId: sid }, 'Failed to fetch sport data');
    }
  });

  await Promise.all(fetches);
  return all;
}

/**
 * Fetch matches for a specific date (for browsing future fixtures).
 * Returns matches for all sports.
 */
export async function fetchMatchesForDate(
  date: string,
): Promise<Map<string, MatchState>> {
  const all = new Map<string, MatchState>();

  const fetches = Object.values(SPORT_IDS).map(async (sid) => {
    try {
      const matches = await fetchMatchData(sid, date);
      for (const [id, state] of matches) all.set(id, state);
    } catch (err) {
      logger.warn({ err, sportId: sid, date }, 'Failed to fetch sport data for date');
    }
  });

  await Promise.all(fetches);
  return all;
}

// --- Match State Diffing ---

function diffMatchStates(
  prev: MatchState | undefined,
  curr: MatchState,
): MatchEvent[] {
  const events: MatchEvent[] = [];

  if (!prev) {
    // First time seeing this match — if it just kicked off
    if (curr.status === 'inprogress') {
      events.push({ type: 'kickoff', eventId: curr.id, match: curr });
    }
    return events;
  }

  // Score change → goal
  const prevTotal = prev.homeTeam.score + prev.awayTeam.score;
  const currTotal = curr.homeTeam.score + curr.awayTeam.score;
  if (currTotal > prevTotal) {
    events.push({ type: 'goal', eventId: curr.id, match: curr, previousState: prev });
  }

  // Status transitions
  if (prev.status !== curr.status) {
    if (curr.status === 'inprogress' && prev.status !== 'inprogress') {
      events.push({ type: 'kickoff', eventId: curr.id, match: curr });
    } else if (curr.status === 'finished') {
      events.push({ type: 'fulltime', eventId: curr.id, match: curr });
    }
  }

  // Period change (1H → HT → 2H etc.)
  if (
    prev.statusNameShort !== curr.statusNameShort &&
    prev.status === curr.status
  ) {
    const snsLower = curr.statusNameShort.toLowerCase();
    if (snsLower === 'ht' || snsLower === 'pause') {
      events.push({ type: 'halftime', eventId: curr.id, match: curr });
    } else if (!events.some((e) => e.type === 'kickoff')) {
      events.push({ type: 'period_change', eventId: curr.id, match: curr });
    }
  }

  return events;
}

// --- Notification Formatting ---

function formatMatchEvent(event: MatchEvent): string {
  const m = event.match;
  const { homeTeam: home, awayTeam: away } = m;
  const score = `${home.score}-${away.score}`;

  switch (event.type) {
    case 'goal': {
      // Determine who scored
      const prevHome = event.previousState?.homeTeam.score ?? 0;
      const scorer = home.score > prevHome ? home.name : away.name;
      const elapsed = m.elapsedTime ? ` ${m.elapsedTime}'` : '';
      return `⚽ *GOAL!* ${scorer}${elapsed}\n${home.name} ${score} ${away.name}\n_${m.tournamentName}_`;
    }
    case 'kickoff':
      return `🟢 *Kick-off!*\n${home.name} vs ${away.name}\n_${m.tournamentName}_`;
    case 'halftime':
      return `⏸️ *Half-time*\n${home.name} ${score} ${away.name}\n_${m.tournamentName}_`;
    case 'fulltime':
      return `🏁 *Full-time*\n${home.name} ${score} ${away.name}\n_${m.tournamentName}_`;
    case 'red_card': {
      const elapsed = m.elapsedTime ? ` ${m.elapsedTime}'` : '';
      return `🟥 *Red card!*${elapsed}\n${home.name} ${score} ${away.name}`;
    }
    case 'period_change':
      return `▶️ *${m.statusName}*\n${home.name} ${score} ${away.name}`;
    default:
      return `ℹ️ ${home.name} ${score} ${away.name} — ${m.statusName}`;
  }
}

// --- MQTT ---

function mqttTopicsForEvent(eventId: string): string[] {
  // We subscribe to all sport IDs since we don't track sport per event
  // The MQTT broker only sends messages for events that exist
  return Object.values(SPORT_IDS).flatMap((sid) => [
    `results_updates/${sid}/${eventId}`,
    `incidents_updates/${sid}/${eventId}/icf_all/da`,
  ]);
}

function subscribeEventMqtt(eventId: string): void {
  if (!mqttClient || !mqttConnected || mqttSubscribedEvents.has(eventId)) return;

  const topics = mqttTopicsForEvent(eventId);
  for (const topic of topics) {
    mqttClient.subscribe(topic, (err) => {
      if (err) {
        logger.warn({ err, topic }, 'MQTT subscribe failed');
      } else {
        logger.debug({ topic }, 'MQTT subscribed');
      }
    });
  }
  mqttSubscribedEvents.add(eventId);
}

function unsubscribeEventMqtt(eventId: string): void {
  if (!mqttClient || !mqttSubscribedEvents.has(eventId)) return;

  const topics = mqttTopicsForEvent(eventId);
  for (const topic of topics) {
    mqttClient.unsubscribe(topic);
  }
  mqttSubscribedEvents.delete(eventId);
}

async function handleMqttMessage(topic: string, payload: Buffer): Promise<void> {
  if (!serviceDeps) return;

  try {
    // Decompress payload (pako/zlib inflate)
    let jsonStr: string;
    try {
      const decompressed = await inflateRawAsync(payload);
      jsonStr = decompressed.toString('utf-8');
    } catch {
      // Might not be compressed
      jsonStr = payload.toString('utf-8');
    }

    const message = JSON.parse(jsonStr);

    // Extract event ID from topic: results_updates/{sid}/{event_id} or incidents_updates/{sid}/{event_id}/...
    const parts = topic.split('/');
    const eventId = parts[2]; // position 2 is always the event_id
    if (!eventId) return;

    // For results updates, the message contains updated match data
    // Update the cache and check for interesting events
    if (topic.startsWith('results_updates/')) {
      await handleResultsUpdate(eventId, message);
    } else if (topic.startsWith('incidents_updates/')) {
      // Incidents can contain goal details, cards, etc.
      // For now we rely on results_updates for score changes
      logger.debug({ eventId, topic }, 'Incident update received');
    }
  } catch (err) {
    logger.warn({ err, topic }, 'Error processing MQTT message');
  }
}

async function handleResultsUpdate(
  eventId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
): Promise<void> {
  if (!serviceDeps) return;

  // The results update message contains partial match state
  // Try to extract score and status updates
  const prev = matchStateCache.get(eventId);
  if (!prev) return; // We don't have initial state for this event

  // Build updated state from the message
  // Results update format varies — try to merge into existing state
  const updated = { ...prev };

  // Check for score updates in the message
  if (message.par) {
    const homePar = message.par['1'] || message.par[1];
    const awayPar = message.par['2'] || message.par[2];
    if (homePar?.frs !== undefined) {
      updated.homeTeam = { ...updated.homeTeam, score: parseInt(homePar.frs) || 0 };
    }
    if (awayPar?.frs !== undefined) {
      updated.awayTeam = { ...updated.awayTeam, score: parseInt(awayPar.frs) || 0 };
    }
    if (homePar?.rs1 !== undefined) {
      updated.homeTeam = { ...updated.homeTeam, halfTimeScore: parseInt(homePar.rs1) || 0 };
    }
    if (awayPar?.rs1 !== undefined) {
      updated.awayTeam = { ...updated.awayTeam, halfTimeScore: parseInt(awayPar.rs1) || 0 };
    }
  }

  if (message.st) updated.status = message.st;
  if (message.sn) updated.statusName = message.sn;
  if (message.sns) updated.statusNameShort = message.sns;
  if (message.et) updated.elapsedTime = message.et;

  // Diff and notify
  const events = diffMatchStates(prev, updated);
  matchStateCache.set(eventId, updated);

  if (events.length > 0) {
    await notifySubscribers(eventId, events);
  }

  // Auto-complete on match finish
  if (updated.status === 'finished') {
    completeLiveScoreSubscriptionsForEvent(eventId);
    unsubscribeEventMqtt(eventId);
    matchStateCache.delete(eventId);
    logger.info({ eventId }, 'Match finished, subscription completed');
  }
}

async function notifySubscribers(
  eventId: string,
  events: MatchEvent[],
): Promise<void> {
  if (!serviceDeps) return;

  const subscriptions = getSubscriptionsForEvent(eventId);
  for (const sub of subscriptions) {
    for (const event of events) {
      const message = formatMatchEvent(event);
      try {
        await serviceDeps.sendMessage(sub.chat_jid, message);
      } catch (err) {
        logger.warn({ err, chatJid: sub.chat_jid, eventId }, 'Failed to send live score update');
      }
    }
  }
}

// --- HTTP Fallback Polling ---

async function pollFallback(): Promise<void> {
  if (mqttConnected) return; // MQTT is back, skip

  const eventIds = getSubscribedEventIds();
  if (eventIds.length === 0) return;

  try {
    const today = formatDate(new Date());
    // Fetch all sports
    const allMatches = await fetchTodayScores();

    for (const eventId of eventIds) {
      const curr = allMatches.get(eventId);
      if (!curr) continue;

      const prev = matchStateCache.get(eventId);
      const events = diffMatchStates(prev, curr);
      matchStateCache.set(eventId, curr);

      if (events.length > 0) {
        await notifySubscribers(eventId, events);
      }

      if (curr.status === 'finished') {
        completeLiveScoreSubscriptionsForEvent(eventId);
        matchStateCache.delete(eventId);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'HTTP fallback poll error');
  }
}

function startFallbackPolling(): void {
  if (fallbackInterval) return;
  logger.info('Starting HTTP fallback polling');
  fallbackInterval = setInterval(() => void pollFallback(), FALLBACK_POLL_INTERVAL);
}

function stopFallbackPolling(): void {
  if (fallbackInterval) {
    clearInterval(fallbackInterval);
    fallbackInterval = null;
  }
}

// --- Scheduled Subscriptions (Future Matches) ---

function scheduleKickoffTimer(sub: LiveScoreSubscription): void {
  if (!sub.scheduled_date) return;

  const kickoff = new Date(sub.scheduled_date).getTime();
  const activateAt = kickoff - PRE_KICKOFF_MS;
  const delay = activateAt - Date.now();

  if (delay <= 0) {
    // Should already be active
    void activateSubscription(sub);
    return;
  }

  // Clear any existing timer for this event
  const existingTimer = kickoffTimers.get(sub.event_id);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    kickoffTimers.delete(sub.event_id);
    void activateSubscription(sub);
  }, delay);

  kickoffTimers.set(sub.event_id, timer);
  logger.info(
    { eventId: sub.event_id, activateIn: Math.round(delay / 60000) + 'min' },
    'Scheduled kickoff timer',
  );
}

async function activateSubscription(sub: LiveScoreSubscription): Promise<void> {
  if (!serviceDeps) return;

  try {
    // Fetch current match state
    const date = sub.scheduled_date
      ? formatDate(new Date(sub.scheduled_date))
      : formatDate(new Date());

    // Try all sports to find this event
    const allMatches = await fetchMatchesForDate(date);
    const matchState = allMatches.get(sub.event_id);

    if (matchState) {
      matchStateCache.set(sub.event_id, matchState);
    }

    // Subscribe to MQTT
    subscribeEventMqtt(sub.event_id);

    // Update DB status
    const { updateLiveScoreSubscription } = await import('./db.js');
    updateLiveScoreSubscription(sub.id, { status: 'active' });

    // Notify group
    if (matchState) {
      const { homeTeam: home, awayTeam: away } = matchState;
      const msg =
        matchState.status === 'inprogress'
          ? `🟢 *Now live!*\n${home.name} ${home.score}-${away.score} ${away.name}\n_${matchState.tournamentName}_`
          : `🟢 *${home.name} vs ${away.name} kicks off soon!*\n_${matchState.tournamentName}_`;
      await serviceDeps.sendMessage(sub.chat_jid, msg);
    }

    logger.info({ eventId: sub.event_id, chatJid: sub.chat_jid }, 'Subscription activated');
  } catch (err) {
    logger.error({ err, eventId: sub.event_id }, 'Failed to activate subscription');
  }
}

// --- Service Lifecycle ---

function connectMqtt(): void {
  const clientId = `${WIDGET_CODE}_${randomBytes(6).toString('hex')}`;

  mqttClient = mqtt.connect(MQTT_URL, {
    clientId,
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    keepalive: 60,
    clean: true,
    connectTimeout: 30_000,
    reconnectPeriod: 30_000,
  });

  mqttClient.on('connect', () => {
    logger.info('MQTT connected');
    mqttConnected = true;
    stopFallbackPolling();

    // Re-subscribe to all active events
    const eventIds = getSubscribedEventIds();
    for (const eventId of eventIds) {
      mqttSubscribedEvents.delete(eventId); // Force re-subscribe
      subscribeEventMqtt(eventId);
    }
  });

  mqttClient.on('message', (topic, payload) => {
    void handleMqttMessage(topic, payload);
  });

  mqttClient.on('close', () => {
    logger.info('MQTT connection closed');
    mqttConnected = false;
    mqttSubscribedEvents.clear();
    // Start fallback polling if we have active subscriptions
    if (getSubscribedEventIds().length > 0) {
      startFallbackPolling();
    }
  });

  mqttClient.on('error', (err) => {
    logger.warn({ err }, 'MQTT error');
  });

  mqttClient.on('reconnect', () => {
    logger.debug('MQTT reconnecting...');
  });
}

/**
 * Start the live scores service.
 * Call this from the main orchestrator after channels are connected.
 */
export function startLiveScoresService(deps: LiveScoresDeps): void {
  serviceDeps = deps;

  // Connect MQTT
  connectMqtt();

  // Load existing subscriptions
  const subs = getActiveLiveScoreSubscriptions();
  for (const sub of subs) {
    if (sub.status === 'active') {
      // Hydrate cache and subscribe MQTT
      void hydrateAndSubscribe(sub);
    } else if (sub.status === 'scheduled') {
      // Set kickoff timer
      scheduleKickoffTimer(sub);
    }
  }

  logger.info({ count: subs.length }, 'Live scores service started');
}

async function hydrateAndSubscribe(sub: LiveScoreSubscription): Promise<void> {
  try {
    const date = sub.scheduled_date
      ? formatDate(new Date(sub.scheduled_date))
      : formatDate(new Date());

    const allMatches = await fetchMatchesForDate(date);
    const state = allMatches.get(sub.event_id);

    if (state) {
      matchStateCache.set(sub.event_id, state);

      // If match is already finished, complete the subscription
      if (state.status === 'finished') {
        completeLiveScoreSubscriptionsForEvent(sub.event_id);
        return;
      }
    }

    subscribeEventMqtt(sub.event_id);
  } catch (err) {
    logger.warn({ err, eventId: sub.event_id }, 'Failed to hydrate subscription');
  }
}

/**
 * Called when a new subscription is created via IPC.
 * Hydrates the match state and connects to MQTT or schedules a timer.
 */
export async function onSubscriptionCreated(
  sub: LiveScoreSubscription,
): Promise<void> {
  if (sub.status === 'active') {
    await hydrateAndSubscribe(sub);
  } else if (sub.status === 'scheduled') {
    scheduleKickoffTimer(sub);
  }
}

/**
 * Called when a subscription is removed via IPC.
 * Cleans up MQTT subscriptions and timers if no other groups are subscribed.
 */
export function onSubscriptionRemoved(eventId: string): void {
  // Check if any other subscriptions exist for this event
  const remaining = getSubscriptionsForEvent(eventId);
  if (remaining.length === 0) {
    unsubscribeEventMqtt(eventId);
    matchStateCache.delete(eventId);
    const timer = kickoffTimers.get(eventId);
    if (timer) {
      clearTimeout(timer);
      kickoffTimers.delete(eventId);
    }
  }
}

/**
 * Get the current cached match state.
 * Used by MCP tools for on-demand score lookups.
 */
export function getCachedMatchState(eventId: string): MatchState | undefined {
  return matchStateCache.get(eventId);
}

/**
 * Get all cached match states.
 */
export function getAllCachedMatchStates(): Map<string, MatchState> {
  return matchStateCache;
}

/**
 * Write a snapshot of cached match states to each group's IPC directory.
 * The container agent reads this via the get_live_scores MCP tool.
 */
export function writeLiveScoresSnapshot(groupFolders: string[]): void {
  const matches = Array.from(matchStateCache.values()).map((m) => ({
    id: m.id,
    status: m.status,
    statusName: m.statusName,
    matchName: m.matchName,
    tournament: m.tournamentName,
    scheduledDate: m.scheduledDate,
    elapsed: m.elapsedTime,
    home: {
      name: m.homeTeam.name,
      short: m.homeTeam.shortName,
      score: m.homeTeam.score,
    },
    away: {
      name: m.awayTeam.name,
      short: m.awayTeam.shortName,
      score: m.awayTeam.score,
    },
  }));

  const snapshot = JSON.stringify(matches, null, 2);

  for (const folder of groupFolders) {
    try {
      const ipcDir = path.join(DATA_DIR, 'ipc', folder);
      fs.mkdirSync(ipcDir, { recursive: true });
      fs.writeFileSync(path.join(ipcDir, 'live_scores.json'), snapshot);
    } catch {
      // Ignore write errors for individual groups
    }
  }
}

/**
 * Stop the live scores service cleanly.
 */
export function stopLiveScoresService(): void {
  stopFallbackPolling();

  for (const timer of kickoffTimers.values()) {
    clearTimeout(timer);
  }
  kickoffTimers.clear();

  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }

  mqttConnected = false;
  mqttSubscribedEvents.clear();
  matchStateCache.clear();
  serviceDeps = null;

  logger.info('Live scores service stopped');
}
