'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');
const { resolvedPath } = require('./cli-env');
const { summarise, oneLine } = require('./session-analysis');

/**
 * A second opinion on a session, from a model that is not in it.
 *
 * The monitor answers everything arithmetic: how full, how fast, how much was
 * dropped. What it cannot answer is the shape of the work — whether a session has
 * drifted from what it was opened to do, whether two of them are digging the same
 * hole, whether the thing to do is compact or start again. Those are judgements,
 * and they want a model.
 *
 * The trap is obvious once said out loud: a *session* watching sessions becomes,
 * within hours, the worst case in its own report — it accumulates context, slows
 * down, and compacts itself while telling everyone else not to. So this is not a
 * session. It is one shot of `claude -p`: no conversation, no history, nothing
 * carried from the last time it was asked. It cannot degrade because there is
 * nothing for it to degrade into.
 *
 * What it is given is equally deliberate: the measurements, in prose, and nothing
 * else. No transcripts, no file contents, no commands. A few hundred tokens in,
 * a paragraph out — and the account it runs on is chosen, so it need not spend
 * the allowance of the work it is reporting on.
 */

const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh';

/** Long enough for a considered answer, short enough that a hang is caught. */
const TIMEOUT = 90000;

/** One reading per session per this long. It is a paragraph, not a subscription. */
const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * What the advisor is asked.
 *
 * Kept here, whole and readable, because it is the part most likely to need
 * changing and the part hardest to reconstruct from its output. The instruction
 * to be brief is not politeness: this answer is going to be read in a small panel
 * and, if the user asks for it, typed into a working session's terminal.
 */
function buildPrompt({ self, others = [], question = null }) {
  const lines = [
    'You are reading measurements taken from a Claude Code session by the tool that runs it.',
    'You are not in that session and cannot see its conversation — only these figures.',
    '',
    'THE SESSION:',
    self,
  ];

  if (others.length) {
    lines.push('', 'OTHER SESSIONS RUNNING ALONGSIDE IT:', ...others.map((line) => `- ${line}`));
  }

  lines.push(
    '',
    question ? `THE QUESTION: ${question}` : 'THE QUESTION: What should this session do next, and why?',
    '',
    'Answer in at most 120 words, as plain prose, addressed to the person running the session.',
    'Say the one thing that matters most first. Be concrete: name the number you are reasoning',
    'from. If the session is fine, say so plainly and stop — do not manufacture advice.',
    'Do not repeat the figures back as a list, do not use headings, and do not offer to help further.',
  );

  return lines.join('\n');
}

/**
 * Ask once, and only about measurements.
 *
 * Rate-limited per session rather than globally: two sessions in trouble at the
 * same time is exactly when both readings are worth having.
 */
class Advisor {
  /**
   * @param {object} deps
   * @param {(profileId: string | null) => object | null} deps.profileFor which account to ask on
   * @param {(sessionId: string) => object | null} deps.verdictFor the monitor's reading
   * @param {(sessionId: string) => string} deps.nameFor what to call a session
   */
  constructor({ profileFor, verdictFor, nameFor, cooldownMs = COOLDOWN_MS }) {
    this.profileFor = profileFor;
    this.verdictFor = verdictFor;
    this.nameFor = nameFor;
    this.cooldownMs = cooldownMs;
    /** sessionId -> when it was last asked, so a panel cannot be leaned on. */
    this.lastAsked = new Map();
    /** sessionId -> the answer, so re-opening a panel does not spend anything. */
    this.answers = new Map();
  }

  /** The last answer for a session, without asking for another. */
  peek(sessionId) {
    return this.answers.get(sessionId) ?? null;
  }

  /**
   * @param {string} sessionId the session to be read
   * @param {object} options
   * @param {string[]} options.alongside ids of the other sessions worth mentioning
   * @param {string | null} options.question something specific to ask instead
   * @param {string | null} options.profileId the account to spend on
   * @param {boolean} options.force ignore the cooldown; the user asked directly
   */
  async ask(sessionId, { alongside = [], question = null, profileId = null, force = false } = {}) {
    const verdict = this.verdictFor(sessionId);
    if (!verdict || verdict.ok === false) {
      return { ok: false, error: 'There is nothing measured for this session yet.' };
    }

    const last = this.lastAsked.get(sessionId) ?? 0;
    const waited = Date.now() - last;
    if (!force && waited < this.cooldownMs) {
      const held = this.answers.get(sessionId);
      if (held) return held;
      return {
        ok: false,
        error: `Asked ${Math.round(waited / 60000)} minutes ago; the next reading is in ${Math.ceil((this.cooldownMs - waited) / 60000)}.`,
      };
    }

    const profile = this.profileFor(profileId);
    if (!profile) return { ok: false, error: 'No account is set for the advisor.' };

    const prompt = buildPrompt({
      self: summarise(verdict, { name: this.nameFor(sessionId) }),
      others: alongside
        .filter((id) => id !== sessionId)
        .map((id) => oneLine(this.verdictFor(id), this.nameFor(id))),
      question,
    });

    this.lastAsked.set(sessionId, Date.now());
    const said = await runOnce(profile, prompt);
    const answer = said.ok
      ? { ok: true, sessionId, text: said.text, at: Date.now(), account: profile.name ?? null }
      : { ok: false, error: said.error };
    if (answer.ok) this.answers.set(sessionId, answer);
    return answer;
  }
}

/**
 * One `claude -p`, on the chosen account.
 *
 * The prompt goes in on stdin rather than on the command line: it contains
 * newlines and the session's own title, and a shell is not a safe place to put
 * either. Every `CLAUDE_*` variable is stripped for the same reason `usage.js`
 * strips them — an inherited one would quietly answer for a different account.
 */
async function runOnce(profile, prompt) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_')) delete env[key];
  delete env.ANTHROPIC_API_KEY;
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  env.PATH = await resolvedPath(profile.shell || DEFAULT_SHELL);

  const bin = profile.claudeCommand || 'claude';
  // `command` bypasses a shell function of the same name, which would pick its
  // own config dir and answer on an account nobody chose.
  const line = `${bin.includes('/') ? '' : 'command '}${bin} -p`;

  return new Promise((resolve) => {
    const child = execFile(
      profile.shell || DEFAULT_SHELL,
      ['-lc', line],
      { env, cwd: os.homedir(), timeout: TIMEOUT, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = (stdout || '').trim();
        if (text) {
          resolve({ ok: true, text });
          return;
        }
        resolve({
          ok: false,
          error: (stderr || error?.message || 'The advisor said nothing.').trim().slice(0, 400),
        });
      },
    );
    try {
      child.stdin.end(prompt);
    } catch {
      /* the process is already gone; the callback will report it */
    }
  });
}

module.exports = { Advisor, buildPrompt, COOLDOWN_MS };
