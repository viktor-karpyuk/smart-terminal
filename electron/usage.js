'use strict';
const os = require('node:os');
const { execFile } = require('node:child_process');

const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh';
const TIMEOUT = 60000;

/**
 * Reads an account's plan limits with `claude -p /usage`.
 *
 * It is a local command: no tokens, no turn, no API call, so it can be asked
 * whenever someone opens the panel. Every ceiling is listed — the session window
 * and each weekly one — unlike the rate-limit event attached to a run, which only
 * reports whichever ceiling is currently tightest.
 *
 * The output is plain text and each line is parsed on its own, so a new line added
 * upstream cannot stop the others from being understood.
 */
async function readUsage(profile) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_')) delete env[key];
  delete env.ANTHROPIC_API_KEY;
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;

  const bin = profile.claudeCommand || 'claude';
  // `command` bypasses a user-defined `claude` shell function, which would pick
  // its own config dir and answer for the wrong account.
  const line = `${bin.includes('/') ? '' : 'command '}${bin} -p /usage`;

  const { error, stdout, stderr } = await new Promise((resolve) => {
    execFile(
      profile.shell || DEFAULT_SHELL,
      ['-lc', line],
      { env, cwd: os.homedir(), timeout: TIMEOUT, maxBuffer: 2 * 1024 * 1024 },
      (err, out, errOut) => resolve({ error: err, stdout: out || '', stderr: errOut || '' }),
    );
  });

  const parsed = parseUsage(stdout);
  if (!parsed.session && !parsed.week && !parsed.perModel.length) {
    return {
      ok: false,
      readAt: Date.now(),
      error: (stderr || stdout || error?.message || 'No usage figures came back').trim().slice(0, 600),
      raw: stdout.trim().slice(-2000),
    };
  }
  return { ok: true, readAt: Date.now(), ...parsed, raw: stdout.trim().slice(-2000) };
}

/** `Current week (all models): 45% used · resets Aug 31 at 5pm (America/Edmonton)` */
const LIMIT_LINE =
  /^Current\s+(?:session|week\s*\(([^)]+)\))\s*:\s*(\d+)\s*%\s*used(?:\s*[·:-]\s*resets\s+(.+?))?\s*$/i;

/** `  93% of your usage was at >150k context` */
const BEHAVIOUR_LINE = /^\s{2,}(\d+)%\s+of your usage\s+(.+?)\s*$/i;

/** `  Top skills: /dataviz 2%, /artifact-design 1%` */
const EXTRA_LINE = /^\s{2,}(Top\s+[^:]+):\s*(.+?)\s*$/i;

/** `Last 24h · 3341 requests · 86 sessions` — each window has its own bullets. */
const WINDOW_LINE = /^Last\s+(\S+)\s*·\s*(.+?)\s*$/i;

function parseUsage(text) {
  let session = null;
  let week = null;
  const perModel = [];
  const windows = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');

    const limit = LIMIT_LINE.exec(line.trim());
    if (limit) {
      const scope = limit[1]?.trim() ?? null;
      const entry = {
        percentUsed: Number(limit[2]),
        resets: limit[3]?.trim() ?? null,
      };
      if (!scope) session = entry;
      else if (/^all\s*models$/i.test(scope)) week = { ...entry, model: scope };
      else perModel.push({ ...entry, model: scope });
      continue;
    }

    const windowStart = WINDOW_LINE.exec(line.trim());
    if (windowStart) {
      current = { label: `Last ${windowStart[1]}`, summary: windowStart[2], behaviours: [], extras: [] };
      windows.push(current);
      continue;
    }

    const behaviour = BEHAVIOUR_LINE.exec(line);
    if (behaviour && current) {
      current.behaviours.push({ percent: Number(behaviour[1]), what: behaviour[2] });
      continue;
    }

    const extra = EXTRA_LINE.exec(line);
    if (extra && current) current.extras.push(`${extra[1]}: ${extra[2]}`);
  }

  return { session, week, perModel, windows };
}

module.exports = { readUsage, parseUsage };
