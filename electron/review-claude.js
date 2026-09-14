'use strict';

const { spawn } = require('node:child_process');

/**
 * Code Reviewer: one `claude -p` run, streamed, on an account that can answer.
 *
 * No API key, ever: the reviewer drives the person's own Claude Code CLI, which
 * uses their subscription login. That is the axis of the design it clones, and
 * it is why every run here is a subprocess and not an HTTP call.
 *
 * Three things about the command line were each learned the hard way:
 *
 * - **Every permission pattern is its own argument.** `Bash(git diff *)` has
 *   spaces; joined with commas the CLI splits it, and the review runs blind to
 *   the diff *without saying so*.
 * - **The prompt goes in on stdin**, never on the command line: it has newlines,
 *   PR titles, and text other people wrote.
 * - **No shell.** The binary is spawned directly with a resolved PATH, so a
 *   `claude` shell function cannot answer on an account nobody chose, and a JSON
 *   schema needs no quoting.
 */

/** What the CLI says when an account can go no further. */
const EXHAUSTED = ['usage limit reached', 'limit reached', 'limit will reset', 'credit balance is too low', 'upgrade to keep using claude code'];
const SIGNED_OUT = ['not logged in', 'please run /login', 'invalid api key'];

/** Twenty minutes: the ceiling the original app put on every run. */
const DEFAULT_TIMEOUT = 20 * 60 * 1000;

function buildArgs({ model, allowedTools = [], disallowedTools = [], schema, resume }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk'];
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
  if (disallowedTools.length) args.push('--disallowedTools', ...disallowedTools);
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  if (schema) args.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema));
  return args;
}

/**
 * One line of stream-json, as the events the reviewer cares about. Anything it
 * does not recognise is `null`, which is not an error: the CLI adds event types.
 */
function parseEvent(line) {
  const text = String(line ?? '').trim();
  if (!text.startsWith('{')) return null;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return null;
  }
  if (event.type === 'system' && event.subtype === 'init') {
    return [{ kind: 'started', sessionId: event.session_id ?? null, model: event.model ?? '' }];
  }
  if (event.type === 'assistant') {
    const content = event.message?.content ?? event.content ?? [];
    const out = [];
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === 'text' && part.text?.trim()) {
        out.push({ kind: 'thinking', text: part.text.trim().split('\n')[0].slice(0, 160) });
      } else if (part?.type === 'tool_use') {
        const input = part.input ?? {};
        const detail = String(input.command ?? input.file_path ?? input.pattern ?? '').slice(0, 160);
        out.push({ kind: 'tool', tool: part.name ?? '?', detail });
      }
    }
    return out;
  }
  if (event.type === 'rate_limit_event') {
    const info = event.rate_limit_info ?? {};
    return [
      {
        kind: 'limit',
        status: info.status ?? '',
        type: info.rateLimitType ?? null,
        utilization: Number(info.utilization ?? 0),
        resetsAt: info.resetsAt ? Number(info.resetsAt) * 1000 : null,
      },
    ];
  }
  if (event.type === 'result') {
    const usage = event.usage ?? {};
    return [
      {
        kind: 'result',
        isError: event.is_error === true,
        text: typeof event.result === 'string' ? event.result : '',
        structured: event.structured_output ?? null,
        sessionId: event.session_id ?? null,
        costUsd: Number(event.total_cost_usd ?? 0),
        tokensIn: Number(usage.input_tokens ?? 0),
        tokensOut: Number(usage.output_tokens ?? 0),
        cacheRead: Number(usage.cache_read_input_tokens ?? 0),
        cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
        denials: (Array.isArray(event.permission_denials) ? event.permission_denials : []).map((denial) => {
          const input = denial.tool_input ?? {};
          const what = input.command ?? input.file_path ?? input.pattern ?? '';
          return what ? `${denial.tool_name}(${what})` : String(denial.tool_name ?? '?');
        }),
      },
    ];
  }
  return null;
}

/**
 * "It finished with nothing" is true and useless: a timeout, an account ceiling
 * and a prompt the model would not answer are three problems with three fixes.
 */
function whyEmpty(result) {
  if (result.timedOut) return 'It ran past the time limit and had to be stopped.';
  if (result.exitCode !== 0 && result.exitCode !== null) return `The CLI exited with code ${result.exitCode} and said nothing else.`;
  if (!result.text && result.toolUses > 0) return `It worked (${result.toolUses} tool uses) but left no final answer: it stopped before finishing.`;
  if (!result.text) return 'It did nothing at all — no tool, no answer. Usually an account ceiling, or a prompt the model refused.';
  return 'It finished without a usable result.';
}

function accountTrouble(result) {
  const text = `${result.text}\n${result.stderr}`.toLowerCase();
  if (!result.ok && SIGNED_OUT.some((needle) => text.includes(needle))) return 'signed-out';
  if (result.limits.some((limit) => limit.status === 'rejected')) return 'limit';
  if (!result.ok && EXHAUSTED.some((needle) => text.includes(needle))) return 'limit';
  return null;
}

class ClaudeRunner {
  /**
   * @param {object} deps
   * @param {() => Promise<Array<{id,name,configDir,claudeCommand,shell}>>} deps.accounts in the order to try them
   * @param {(shell?: string) => Promise<string>} deps.resolvePath
   * @param {(entry: object) => void} [deps.onUsage]
   * @param {typeof spawn} [deps.spawn]
   */
  constructor({ accounts, resolvePath, onUsage, spawn: spawnImpl, now } = {}) {
    this.accounts = accounts ?? (async () => [{ id: 'default', name: 'Default', configDir: null }]);
    this.resolvePath = resolvePath ?? (async () => process.env.PATH ?? '');
    this.onUsage = onUsage ?? (() => {});
    this.spawn = spawnImpl ?? spawn;
    this.now = now ?? (() => Date.now());
    /** Accounts resting after a ceiling or a missing login, until when. In memory: a restart retries them. */
    this.resting = new Map();
  }

  rest(accountId, until) {
    this.resting.set(accountId, until);
  }

  async pick(tried) {
    const list = await this.accounts();
    const now = this.now();
    return list.find((account) => !tried.has(account.id) && !((this.resting.get(account.id) ?? 0) > now)) ?? null;
  }

  /**
   * Run with the first account that is not resting, and when that one is out of
   * room — a ceiling, or no login at all — rest it and try the next. `tried` is
   * what stops the circle. With every account resting the last real failure is
   * returned, not an invented one, so the caller sees what the CLI said.
   */
  async run(options) {
    const tried = new Set();
    let last = null;
    for (;;) {
      const account = await this.pick(tried);
      if (!account) {
        if (last) return last;
        const list = await this.accounts();
        if (!list.length) return this.failed('No Claude account is configured.');
        // Everything is resting: try the first anyway rather than refuse outright.
        return this.runOnce(options, list[0]);
      }
      tried.add(account.id);
      const result = await this.runOnce(options, account);
      const trouble = accountTrouble(result);
      if (!trouble || result.cancelled) return result;
      const ceiling = result.limits.find((limit) => limit.status === 'rejected' && limit.resetsAt);
      this.rest(account.id, trouble === 'signed-out' ? this.now() + 10 * 60 * 1000 : ceiling?.resetsAt ?? this.now() + 5 * 60 * 60 * 1000);
      last = result;
      const next = await this.pick(tried);
      if (!next) return result;
      options.onEvent?.({ kind: 'account', from: account.name, to: next.name, reason: trouble });
      // A session lives inside its account's config folder; resuming it from another account cannot work.
      options = { ...options, resume: null };
    }
  }

  failed(message) {
    return { ok: false, text: '', stderr: message, structured: null, toolUses: 0, denials: [], limits: [], sessionId: null, costUsd: 0, exitCode: null, timedOut: false, cancelled: false };
  }

  /**
   * One subprocess. `options.register(handle)` receives `{ cancel() }` as soon as
   * the process exists, so a cancel pressed while it starts is not lost.
   */
  async runOnce(options, account) {
    const { cwd, prompt, kind = 'other', timeout = DEFAULT_TIMEOUT, onEvent = () => {}, register = () => {} } = options;
    const env = { ...process.env };
    // An inherited CLAUDE_* variable would quietly answer for a different account.
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_')) delete env[key];
    delete env.ANTHROPIC_API_KEY;
    if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
    env.PATH = await this.resolvePath(account.shell);
    const binary = account.claudeCommand && account.claudeCommand.trim() ? account.claudeCommand.trim() : 'claude';
    const args = buildArgs(options);
    const started = this.now();

    return new Promise((resolve) => {
      const result = {
        ok: false,
        text: '',
        stderr: '',
        structured: null,
        toolUses: 0,
        denials: [],
        limits: [],
        sessionId: null,
        model: options.model ?? null,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
        exitCode: null,
        timedOut: false,
        cancelled: false,
        isError: false,
        finished: false,
        accountId: account.id,
        accountName: account.name,
      };
      let child;
      try {
        child = this.spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        result.stderr = `Could not start ${binary}: ${error?.message ?? error}`;
        resolve(result);
        return;
      }
      let settledOnce = false;
      let buffer = '';
      const handle = {
        cancel: () => {
          result.cancelled = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        },
      };
      register(handle);
      const timer = setTimeout(() => {
        result.timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, timeout);

      const take = (line) => {
        const events = parseEvent(line);
        if (!events) return;
        for (const event of events) {
          if (event.kind === 'started') {
            result.sessionId = event.sessionId;
            if (event.model) result.model = event.model;
          } else if (event.kind === 'tool') {
            result.toolUses++;
          } else if (event.kind === 'limit') {
            result.limits.push(event);
          } else if (event.kind === 'result') {
            result.finished = true;
            result.isError = event.isError;
            result.text = event.text;
            result.structured = event.structured;
            result.sessionId = event.sessionId ?? result.sessionId;
            result.costUsd = event.costUsd;
            result.tokensIn = event.tokensIn;
            result.tokensOut = event.tokensOut;
            result.cacheRead = event.cacheRead;
            result.cacheWrite = event.cacheWrite;
            result.denials = event.denials;
          }
          if (event.kind !== 'result') {
            try {
              onEvent(event);
            } catch {
              /* a listener's problem is not the run's */
            }
          }
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          take(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (result.stderr.length < 20000) result.stderr += chunk;
      });
      child.stdin.on('error', () => {
        /* the process went away before reading; its exit says why */
      });
      const finish = (code) => {
        if (settledOnce) return;
        settledOnce = true;
        clearTimeout(timer);
        if (buffer.trim()) take(buffer);
        result.exitCode = code;
        const answered = Boolean(result.text.trim()) || result.structured !== null;
        result.ok = result.finished && code === 0 && !result.isError && answered && !result.timedOut && !result.cancelled;
        result.stderr = result.stderr.trim();
        if (!result.ok && !result.stderr && !result.cancelled) result.stderr = whyEmpty(result);
        try {
          this.onUsage({
            at: new Date(started).toISOString(),
            kind,
            model: result.model,
            sessionId: result.sessionId,
            ok: result.ok,
            seconds: Math.round((this.now() - started) / 1000),
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            cacheRead: result.cacheRead,
            cacheWrite: result.cacheWrite,
            costUsd: result.costUsd,
            accountId: account.id,
          });
        } catch {
          /* bookkeeping must never cost a result */
        }
        resolve(result);
      };
      child.on('error', (error) => {
        result.stderr += `\n${error?.code === 'ENOENT' ? `The Claude Code CLI (${binary}) was not found on the PATH.` : String(error?.message ?? error)}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
      child.stdin.end(prompt);
    });
  }
}

/** The account list the runner walks: the chosen one first, then its fallback, then everyone else. */
function orderAccounts(profiles, preferredId) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const out = [];
  const add = (profile) => {
    if (profile && !out.includes(profile)) out.push(profile);
  };
  let cursor = byId.get(preferredId) ?? profiles[0];
  while (cursor && !out.includes(cursor)) {
    add(cursor);
    cursor = cursor.fallbackProfileId ? byId.get(cursor.fallbackProfileId) : null;
  }
  for (const profile of profiles) add(profile);
  return out;
}

module.exports = { ClaudeRunner, buildArgs, parseEvent, whyEmpty, accountTrouble, orderAccounts, DEFAULT_TIMEOUT };
