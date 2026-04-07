/**
 * Scorecard image generator for live score notifications.
 * Creates a composited image with team logos, names, score, and event info.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │              ⚽ GOAL!                     │
 *   │  [logo] Home Name   0 - 2   Away Name [logo] │
 *   │              Champions League             │
 *   └──────────────────────────────────────────┘
 */

import fs from 'fs';
import path from 'path';

import sharp from 'sharp';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { MatchEvent, MatchState } from './types.js';

const LOGO_SIZE = 96;
const LOGO_PADDING = 8; // Extra padding so logos don't clip
const CARD_WIDTH = 700;
const CARD_HEIGHT = 180;
const LOGO_CACHE_DIR = path.join(DATA_DIR, 'logo-cache');
const LOGO_BASE_URL = 'https://es-img.enetscores.com/logos/';

// --- Logo fetching with cache ---

async function fetchLogo(teamId: string): Promise<Buffer | null> {
  if (!teamId) return null;

  fs.mkdirSync(LOGO_CACHE_DIR, { recursive: true });
  const cachePath = path.join(LOGO_CACHE_DIR, `${teamId}.png`);

  // Check cache
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  try {
    const response = await fetch(`${LOGO_BASE_URL}${teamId}o`);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    // Resize to standard size and convert to PNG
    const resized = await sharp(buffer)
      .resize(LOGO_SIZE, LOGO_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    fs.writeFileSync(cachePath, resized);
    return resized;
  } catch (err) {
    logger.debug({ err, teamId }, 'Failed to fetch team logo');
    return null;
  }
}

// --- SVG scorecard ---

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function eventLabel(event: MatchEvent): { text: string; emoji: string } {
  switch (event.type) {
    case 'goal':
      return { text: 'GOAL!', emoji: '⚽' };
    case 'kickoff':
      return { text: 'KICK-OFF', emoji: '🟢' };
    case 'halftime':
      return { text: 'HALF-TIME', emoji: '⏸️' };
    case 'fulltime':
      return { text: 'FULL-TIME', emoji: '🏁' };
    case 'red_card':
      return { text: 'RED CARD', emoji: '🟥' };
    case 'yellow_card':
      return { text: 'YELLOW CARD', emoji: '🟨' };
    case 'substitution':
      return { text: 'SUBSTITUTION', emoji: '🔄' };
    case 'period_change':
      return { text: event.match.statusName.toUpperCase(), emoji: '▶️' };
    case 'live': {
      const status = event.match.status === 'finished' ? 'FULL-TIME' :
        event.match.status === 'inprogress' ? 'LIVE' : 'UPCOMING';
      const emoji = event.match.status === 'finished' ? '🏁' :
        event.match.status === 'inprogress' ? '🔴' : '⏳';
      return { text: status, emoji };
    }
    default:
      return { text: 'UPDATE', emoji: 'ℹ️' };
  }
}

function buildSvg(
  match: MatchState,
  label: { text: string; emoji: string },
  elapsed: string,
): string {
  const homeName = escapeXml(match.homeTeam.name);
  const awayName = escapeXml(match.awayTeam.name);
  const tournament = escapeXml(match.tournamentName);
  const score = `${match.homeTeam.score} - ${match.awayTeam.score}`;
  const elapsedText = elapsed ? escapeXml(`${elapsed}'`) : '';

  return `<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#16213e"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="12" fill="url(#bg)"/>

  <!-- Event label -->
  <text x="${CARD_WIDTH / 2}" y="34" text-anchor="middle" fill="#e94560" font-family="Arial,sans-serif" font-weight="bold" font-size="20">${label.emoji} ${escapeXml(label.text)}</text>

  <!-- Score -->
  <text x="${CARD_WIDTH / 2}" y="100" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-weight="bold" font-size="42">${escapeXml(score)}</text>

  <!-- Elapsed time -->
  ${elapsedText ? `<text x="${CARD_WIDTH / 2}" y="122" text-anchor="middle" fill="#888888" font-family="Arial,sans-serif" font-size="15">${elapsedText}</text>` : ''}

  <!-- Home team name (right-aligned before center) -->
  <text x="${CARD_WIDTH / 2 - 75}" y="100" text-anchor="end" fill="#cccccc" font-family="Arial,sans-serif" font-size="18">${homeName}</text>

  <!-- Away team name (left-aligned after center) -->
  <text x="${CARD_WIDTH / 2 + 75}" y="100" text-anchor="start" fill="#cccccc" font-family="Arial,sans-serif" font-size="18">${awayName}</text>

  <!-- Tournament -->
  <text x="${CARD_WIDTH / 2}" y="158" text-anchor="middle" fill="#666666" font-family="Arial,sans-serif" font-size="15">${tournament}</text>
</svg>`;
}

// --- Public API ---

/**
 * Generate a scorecard image for a match event.
 * Returns the image as a Buffer (PNG), or null on failure.
 */
export async function generateScorecard(
  event: MatchEvent,
): Promise<Buffer | null> {
  try {
    const match = event.match;
    const label = eventLabel(event);
    const elapsed = match.elapsedTime;

    // Fetch logos
    const [homeLogo, awayLogo] = await Promise.all([
      fetchLogo(match.homeTeam.id),
      fetchLogo(match.awayTeam.id),
    ]);

    // Build SVG base
    const svg = buildSvg(match, label, elapsed);
    const svgBuffer = Buffer.from(svg);

    // Composite: SVG base + logos
    const composites: sharp.OverlayOptions[] = [];

    // Center logos vertically with padding to prevent clipping
    const logoTop = Math.max(LOGO_PADDING, Math.round((CARD_HEIGHT - LOGO_SIZE) / 2));

    if (homeLogo) {
      composites.push({
        input: homeLogo,
        left: 20,
        top: logoTop,
      });
    }

    if (awayLogo) {
      composites.push({
        input: awayLogo,
        left: CARD_WIDTH - LOGO_SIZE - 20,
        top: logoTop,
      });
    }

    let image = sharp(svgBuffer);
    if (composites.length > 0) {
      image = image.composite(composites);
    }

    return await image.png().toBuffer();
  } catch (err) {
    logger.warn({ err }, 'Failed to generate scorecard');
    return null;
  }
}

/**
 * Generate a scorecard and save it to a temp file.
 * Returns the file path, or null on failure.
 */
export async function generateScorecardFile(
  event: MatchEvent,
): Promise<string | null> {
  const buffer = await generateScorecard(event);
  if (!buffer) return null;

  const filename = `scorecard-${event.eventId}-${Date.now()}.png`;
  const filepath = path.join('/tmp', filename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}
