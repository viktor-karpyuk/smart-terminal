#!/usr/bin/env node
'use strict';

/**
 * The Teams app that carries the bot: a manifest and two icons, zipped.
 *
 * This is what gets uploaded in the Teams admin center. Without it the bot
 * exists in Azure but nobody in Teams can find it, and it cannot write to a
 * developer who has not got it installed.
 *
 *   node scripts/make-teams-app.js      → build/code-reviewer-teams.zip
 *
 * Bump TEAMS_APP_VERSION in .env.local whenever the manifest changes: Teams
 * refuses an upload that repeats a version it already has.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { readEnv } = require('./lib');

const root = path.join(__dirname, '..');
const env = { ...readEnv(path.join(root, '.env.local')), ...process.env };
const appId = env.BOT_APP_ID;
if (!/^[0-9a-f-]{36}$/i.test(appId ?? '')) { console.error('BOT_APP_ID is missing or not a GUID.'); process.exit(2); }

const site = 'https://github.com/viktor-karpyuk/smart-terminal';
const manifest = {
  $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
  manifestVersion: '1.17',
  version: env.TEAMS_APP_VERSION || '1.0.0',
  id: appId,
  developer: {
    name: env.TEAMS_DEVELOPER_NAME || 'Kubrik Software',
    websiteUrl: site,
    privacyUrl: site,
    termsOfUseUrl: site,
  },
  name: { short: 'Code Reviewer', full: 'Code Reviewer (Smart Terminal)' },
  description: {
    short: 'Talks with you about the review of your pull requests.',
    full: 'The Code Reviewer in Smart Terminal reviews pull requests. This bot is how it talks with the developer ' +
      'who wrote one: it says what was found, answers questions about it, and can act on the pull request when its author asks.',
  },
  icons: { color: 'color.png', outline: 'outline.png' },
  accentColor: '#4F46E5',
  bots: [{ botId: appId, scopes: ['personal', 'team', 'groupChat'], isNotificationOnly: false, supportsFiles: false }],
  permissions: ['identity', 'messageTeamMembers'],
  validDomains: [],
};

/** A PNG from a function of (x, y) → [r, g, b, a], so no image tool is needed. */
function png(size, pixel) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) Buffer.from(pixel(x, y)).copy(row, 1 + x * 4);
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Two angle brackets, < >, the mark of code, drawn as distance from two strokes. */
function glyph(size, x, y) {
  const u = (x + 0.5) / size, v = (y + 0.5) / size;
  const dist = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(u - (ax + t * dx), v - (ay + t * dy));
  };
  return Math.min(
    dist(0.42, 0.3, 0.24, 0.5), dist(0.24, 0.5, 0.42, 0.7),
    dist(0.58, 0.3, 0.76, 0.5), dist(0.76, 0.5, 0.58, 0.7),
  ) < 0.055;
}

const out = path.join(root, 'build', 'teams-app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(out, 'color.png'), png(192, (x, y) => (glyph(192, x, y) ? [255, 255, 255, 255] : [0x4f, 0x46, 0xe5, 255])));
fs.writeFileSync(path.join(out, 'outline.png'), png(32, (x, y) => (glyph(32, x, y) ? [255, 255, 255, 255] : [0, 0, 0, 0])));

const zip = path.join(root, 'build', 'code-reviewer-teams.zip');
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-j', '-q', zip, 'manifest.json', 'color.png', 'outline.png'], { cwd: out });
console.log(zip);
