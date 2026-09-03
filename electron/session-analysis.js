'use strict';

const fs = require('node:fs');

/**
 * What a session is costing, and where it is going wrong.
 *
 * Claude Code writes far more about itself than anyone reads. Every assistant
 * message carries the token accounting for that request; every completed turn
 * gets a `turn_duration` row; every compaction records what it threw away and
 * how long it took. All of it sits in the transcript already, on disk, written
 * whether or not anybody looks — so this asks no API, spends no tokens, and can
 * be run as often as a panel is opened.
 *
 * The numbers alone are not the point. A session that is slowly going bad looks
 * completely normal from the inside: the answers still come, only later, and
 * from a model reading four hundred thousand tokens to write six hundred. This
 * module names that, and the handful of other shapes that reliably mean the same
 * thing, in terms of something a person can actually do about it.
 *
 * Pure on purpose: it takes rows and returns a verdict, so the whole catalogue of
 * findings is testable without a session, a file, or an account.
 */

/**
 * A cached token read back is a tenth of the price of a fresh one, and writing
 * one costs a quarter more than not caching at all. Counting raw tokens hides
 * that entirely — a session can double its token count and get *cheaper*. These
 * are the multipliers every Anthropic price list uses, so "effective input" below
 * is the only input figure worth comparing two sessions on.
 */
const CACHE_WRITE_RATE = 1.25;
const CACHE_READ_RATE = 0.1;

/** Above this share of the window, quality and latency both start to give. */
const HIGH_CONTEXT_SHARE = 0.6;

/** The shorter ephemeral cache. Come back later than this and the turn re-primes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** A re-prime smaller than this is ordinary growth, not a lost cache. */
const REPRIME_TOKENS = 20000;

/** Tool output past this, from a single call, is a design problem not a big file. */
const FLOOD_BYTES = 40000;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function blocksOf(row) {
  const content = row?.message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * How big the model's context actually was on this request.
 *
 * The three input figures are disjoint — fresh, newly cached, and read from
 * cache — so their sum is what the model was handed, which is the number the
 * `/context` command shows and the one that governs degradation.
 */
function contextOf(usage) {
  return num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
}

/**
 * Guess the window from the traffic rather than the model name.
 *
 * Model ids change faster than this file will, and a session that has genuinely
 * carried 400k tokens has told us more about its window than any lookup table
 * would. Only the two sizes that exist are worth distinguishing.
 */
function windowFor(peak) {
  return peak > 200000 ? 1000000 : 200000;
}

function bytesOfResult(result) {
  if (result == null) return 0;
  if (typeof result === 'string') return result.length;
  if (typeof result !== 'object') return 0;
  let total = 0;
  for (const key of ['stdout', 'stderr', 'content', 'originalFile', 'text', 'file']) {
    const value = result[key];
    if (typeof value === 'string') total += value.length;
    else if (value && typeof value === 'object') total += JSON.stringify(value).length;
  }
  if (Array.isArray(result.structuredPatch)) total += JSON.stringify(result.structuredPatch).length;
  return total;
}

/** Rough, and only used for "how much of the context is this tool" comparisons. */
function tokensFromBytes(bytes) {
  return Math.round(bytes / 4);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Read a transcript's rows into everything worth knowing about the session.
 *
 * @param {Array<object>} rows parsed JSONL entries, in file order
 */
function measure(rows) {
  const samples = []; // the context curve: one point per request
  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const durations = [];
  const compactions = [];
  const tools = new Map(); // name -> { calls, bytes, fails }
  const toolNames = new Map(); // tool_use id -> name, so a result can be attributed
  const repeats = new Map(); // name + input -> times asked
  const errors = [];
  let reprimedTokens = 0;
  let reprimes = 0;
  let lastAt = null;
  let firstAt = null;
  let model = null;
  let turnsAbove = 0;

  let index = -1;
  for (const row of rows) {
    index += 1;
    if (!row || typeof row !== 'object') continue;
    const at = Date.parse(row.timestamp) || null;
    if (at) {
      if (firstAt === null) firstAt = at;
      lastAt = at;
    }

    if (row.compactMetadata) {
      const meta = row.compactMetadata;
      compactions.push({
        at,
        // Where it happened in the file, so the state just before it can be
        // reconstructed exactly rather than guessed at afterwards.
        index,
        contextBefore: samples.length ? samples[samples.length - 1].context : 0,
        requestsBefore: samples.length,
        trigger: meta.trigger ?? 'unknown',
        preTokens: num(meta.preTokens),
        postTokens: num(meta.postTokens),
        // What *this* compaction let go of. `cumulativeDroppedTokens` is the
        // running total for the whole session, so reporting it per compaction
        // gives every one of them the same figure — the sum of all of them.
        droppedTokens: Math.max(0, num(meta.preTokens) - num(meta.postTokens)),
        droppedSoFar: num(meta.cumulativeDroppedTokens),
        durationMs: num(meta.durationMs),
      });
    }

    if (row.type === 'system' && row.subtype === 'turn_duration') {
      durations.push({ ms: num(row.durationMs), messages: num(row.messageCount), at });
      continue;
    }

    if (row.isApiErrorMessage || (row.type === 'assistant' && typeof row.error === 'string')) {
      errors.push({ at, kind: row.apiErrorStatus ?? row.error ?? 'error' });
    }

    if (row.type === 'assistant') {
      const usage = row.message?.usage;
      if (usage && typeof usage === 'object') {
        if (row.message?.model) model = row.message.model;
        const write = num(usage.cache_creation_input_tokens);
        totals.input += num(usage.input_tokens);
        totals.output += num(usage.output_tokens);
        totals.cacheWrite += write;
        totals.cacheRead += num(usage.cache_read_input_tokens);

        // A big cache write after a long silence is the session paying again for
        // context it already had. Growth alone does not qualify — the gap does.
        const previous = samples.length ? samples[samples.length - 1].at : null;
        if (write >= REPRIME_TOKENS && previous && at && at - previous > CACHE_TTL_MS) {
          reprimes += 1;
          reprimedTokens += write;
        }

        // A request with no input at all is not a measurement of anything — an
        // errored turn, or a row written without its accounting. Counting it
        // would put a zero in the curve and make the session look emptied.
        const size = contextOf(usage);
        if (size > 0) samples.push({ at, context: size, output: num(usage.output_tokens) });
      }

      for (const block of blocksOf(row)) {
        if (block?.type !== 'tool_use') continue;
        const name = block.name || 'unknown';
        if (block.id) toolNames.set(block.id, name);
        const entry = tools.get(name) || { calls: 0, bytes: 0, fails: 0 };
        entry.calls += 1;
        tools.set(name, entry);

        // The same question asked over and over is the clearest form of waste
        // there is: every repeat pays full price for an answer already in the
        // context. Truncated because a key only has to be stable, not readable.
        const key = `${name}:${JSON.stringify(block.input ?? null).slice(0, 400)}`;
        repeats.set(key, (repeats.get(key) ?? 0) + 1);
      }
    }

    if (row.type === 'user' && row.toolUseResult != null) {
      const id = blocksOf(row).find((b) => b?.type === 'tool_result')?.tool_use_id ?? null;
      const name = (id && toolNames.get(id)) || 'unknown';
      const entry = tools.get(name) || { calls: 0, bytes: 0, fails: 0 };
      entry.bytes += bytesOfResult(row.toolUseResult);
      const failed = blocksOf(row).some((b) => b?.type === 'tool_result' && b.is_error);
      if (failed) entry.fails += 1;
      tools.set(name, entry);
    }
  }

  const contexts = samples.map((s) => s.context);
  const peak = contexts.length ? Math.max(...contexts) : 0;
  const window = windowFor(peak);
  for (const value of contexts) if (value >= window * HIGH_CONTEXT_SHARE) turnsAbove += 1;

  const ms = durations.map((d) => d.ms).sort((a, b) => a - b);
  const effectiveInput = Math.round(
    totals.input + totals.cacheWrite * CACHE_WRITE_RATE + totals.cacheRead * CACHE_READ_RATE,
  );

  const toolList = [...tools.entries()]
    .map(([name, entry]) => ({ name, ...entry, tokens: tokensFromBytes(entry.bytes) }))
    .sort((a, b) => b.bytes - a.bytes);

  const repeated = [...repeats.entries()]
    .filter(([, times]) => times >= 3)
    .map(([key, times]) => ({ tool: key.slice(0, key.indexOf(':')), times }))
    .sort((a, b) => b.times - a.times);

  return {
    model,
    projection: project(samples, window),
    requests: samples.length,
    firstAt,
    lastAt,
    spanMs: firstAt && lastAt ? lastAt - firstAt : 0,
    totals,
    effectiveInput,
    context: {
      window,
      peak,
      last: contexts.length ? contexts[contexts.length - 1] : 0,
      mean: contexts.length ? Math.round(contexts.reduce((a, b) => a + b, 0) / contexts.length) : 0,
      turnsAbove,
      share: contexts.length ? turnsAbove / contexts.length : 0,
      curve: samples,
    },
    latency: {
      turns: durations.length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      totalMs: ms.reduce((a, b) => a + b, 0),
    },
    compactions,
    reprimes: { count: reprimes, tokens: reprimedTokens },
    tools: toolList,
    repeated,
    errors,
  };
}

/** How many recent requests a trend is drawn from. Enough to smooth, few enough to be current. */
const TREND_SAMPLES = 12;

/**
 * Where this session is heading, at the rate it has been going.
 *
 * A straight line through the recent requests, extended to the ceiling. Crude on
 * purpose: the useful question is not "exactly when" but "is this a session with
 * hours of room left, or one that will be compacting itself before lunch" — and a
 * straight line answers that honestly, while anything cleverer would only look
 * more certain than it is.
 *
 * `null` when the context is flat or falling, which is most sessions and is not a
 * prediction worth making.
 */
function project(samples, window) {
  if (samples.length < TREND_SAMPLES) return null;
  const recent = samples.slice(-TREND_SAMPLES);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const grew = last.context - first.context;
  if (grew <= 0) return null;

  const perRequest = grew / (recent.length - 1);
  const headroom = window - last.context;
  if (headroom <= 0) return { requests: 0, ms: 0, perRequest: Math.round(perRequest) };

  const requests = Math.ceil(headroom / perRequest);
  // Wall clock from the *median* gap, not the average. A session resumed after a
  // weekend has one three-day gap among its recent requests, and an average would
  // hand that weekend back as the estimate.
  const gaps = [];
  for (let i = 1; i < recent.length; i += 1) {
    const a = recent[i - 1].at;
    const b = recent[i].at;
    if (a && b && b > a) gaps.push(b - a);
  }
  gaps.sort((a, b) => a - b);
  const perMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  return {
    requests,
    ms: perMs ? Math.round(requests * perMs) : 0,
    perRequest: Math.round(perRequest),
  };
}

function minutes(ms) {
  return Math.round(ms / 60000);
}

/** A span in the largest unit that still says something: 3 days, not 4320 min. */
function elapsed(ms) {
  if (ms >= 48 * 3600000) return `${Math.round(ms / 86400000)} days`;
  if (ms >= 90 * 60000) return `${Math.round(ms / 3600000)} hours`;
  return `${minutes(ms)} min`;
}

/** Token counts run to nine figures in a long session; nobody reads those. */
function thousands(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value < 10000000 ? 1 : 0)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

/**
 * Turn the measurements into the few things worth saying out loud.
 *
 * Every finding earns its place by being actionable: it names what was observed,
 * in this session's own numbers, and what to do instead. A finding that would
 * only make someone feel watched is not written.
 */
function findingsFor(m) {
  const out = [];
  const { context } = m;

  // Two different things, and saying them in the same tense was wrong: a session
  // that spent all morning against the ceiling and has since compacted is not
  // "running near the top" any more, however much of its history was.
  const nowShare = context.window ? context.last / context.window : 0;
  if (context.turnsAbove >= 3) {
    const spent = Math.round(context.share * 100);
    const heavyNow = nowShare >= HIGH_CONTEXT_SHARE;
    out.push({
      id: 'high-context',
      severity: heavyNow ? (context.share > 0.5 ? 'high' : 'medium') : 'low',
      title: heavyNow ? 'Running near the top of the window' : 'Spent much of its life near the top',
      detail: heavyNow
        ? `At ${Math.round(nowShare * 100)}% of the ${thousands(context.window)} window now, and above ${Math.round(HIGH_CONTEXT_SHARE * 100)}% for ${context.turnsAbove} of ${m.requests} requests — ${spent}% of the session. Peak ${thousands(context.peak)}.`
        : `Down to ${Math.round(nowShare * 100)}% now, but ${context.turnsAbove} of ${m.requests} requests ran above ${Math.round(HIGH_CONTEXT_SHARE * 100)}% of the window. Peak ${thousands(context.peak)}.`,
      suggestion: heavyNow
        ? 'Compact at a point you choose — the end of a task, before starting the next — rather than waiting for it to happen mid-step. A finished piece of work is also a good place to hand over to a fresh session.'
        : 'Nothing to do right now. Worth knowing because it will climb back, and the descent was probably a compaction choosing what to forget.',
    });
  }

  const auto = m.compactions.filter((c) => c.trigger === 'auto');
  if (auto.length) {
    // Each one's own drop, added up — the cumulative figure would count the
    // earlier compactions again inside every later one.
    const dropped = auto.reduce((sum, c) => sum + c.droppedTokens, 0);
    const lost = auto.reduce((sum, c) => sum + c.durationMs, 0);
    out.push({
      id: 'auto-compaction',
      severity: auto.length > 1 ? 'high' : 'medium',
      title: auto.length > 1 ? `Compacted itself ${auto.length} times` : 'Compacted itself',
      detail: `${thousands(dropped)} tokens dropped, ${minutes(lost) || '<1'} min spent doing it. An automatic compaction happens where the context runs out, not where the work pauses, so it chooses what to forget in the middle of a step.`,
      suggestion: 'Compact deliberately at a checkpoint, so what survives is what you would have kept.',
    });
  }

  if (m.reprimes.count >= 2) {
    out.push({
      id: 'cache-reprime',
      severity: m.reprimes.tokens > 200000 ? 'medium' : 'low',
      title: 'Paying for the same context again',
      detail: `${m.reprimes.count} returns after more than ${minutes(CACHE_TTL_MS)} minutes away re-primed ${thousands(m.reprimes.tokens)} tokens. Cached input is read back at a tenth of the price; once the cache lapses the next turn buys it at full price.`,
      suggestion: 'Work on a session in stretches rather than dipping in — or let a long-idle session go and start fresh.',
    });
  }

  const flood = m.tools.find((t) => t.calls && t.bytes / t.calls > FLOOD_BYTES);
  if (flood) {
    out.push({
      id: 'tool-flood',
      severity: 'medium',
      title: `${flood.name} is filling the context`,
      detail: `${flood.calls} calls returned about ${thousands(flood.tokens)} tokens — roughly ${thousands(Math.round(flood.tokens / flood.calls))} each, and every one of them stays in the context for the rest of the session.`,
      suggestion:
        'Narrow what comes back at the source — head, grep, a count instead of a dump — or send the wide reading to a subagent and keep only its conclusion.',
    });
  }

  const worstRepeat = m.repeated[0];
  if (worstRepeat && worstRepeat.times >= 4) {
    out.push({
      id: 'repeated-calls',
      severity: 'low',
      title: 'Asking the same thing repeatedly',
      detail: `The same ${worstRepeat.tool} call was made ${worstRepeat.times} times. The answer was already in the context each time after the first.`,
      suggestion: 'Worth a look — usually a loop that re-checks instead of remembering.',
    });
  }

  if (m.latency.turns >= 5 && m.latency.p95 > 120000) {
    out.push({
      id: 'slow-turns',
      severity: 'low',
      title: 'Turns are getting slow',
      detail: `Half of them finish inside ${minutes(m.latency.p50) || '<1'} min, but the slowest twentieth take over ${minutes(m.latency.p95)} min. Time per turn rises with how much context is being read back.`,
      suggestion: 'The usual cause is the context, not the task — the fix is the same as for a full window.',
    });
  }

  // What the session is actually producing for what it is reading. This is the
  // one number that says "this conversation has stopped being worth its size".
  if (m.totals.output > 0 && m.requests >= 20) {
    const perOutput = m.effectiveInput / m.totals.output;
    if (perOutput > 150) {
      out.push({
        id: 'thin-returns',
        severity: 'medium',
        title: 'Reading a lot to say a little',
        detail: `${thousands(m.effectiveInput)} tokens of input, weighted for cache, against ${thousands(m.totals.output)} of output — about ${Math.round(perOutput)} in for every one out.`,
        suggestion: 'A session that has drifted far from what it is now doing carries all of it on every turn. Starting the next task fresh usually costs less than continuing.',
      });
    }
  }

  // Only worth saying while there is still time to act on it. A session already
  // running against the ceiling gets the high-context finding, which says the
  // same thing in the present tense and says it better.
  if (m.projection && m.projection.requests > 0 && m.projection.requests <= 40 && m.context.turnsAbove < 3) {
    const when = m.projection.ms ? ` — about ${elapsed(m.projection.ms)} at this pace` : '';
    out.push({
      id: 'filling-up',
      severity: 'medium',
      title: 'On course to fill the window',
      detail: `Context is growing about ${thousands(m.projection.perRequest)} tokens a request. At that rate it reaches ${thousands(m.context.window)} in roughly ${m.projection.requests} more requests${when}.`,
      suggestion:
        'Still early enough to choose. Finish what is open, compact there, and carry on — rather than being compacted somewhere you did not pick.',
    });
  }

  if (m.errors.length >= 3) {
    out.push({
      id: 'api-errors',
      severity: 'low',
      title: `${m.errors.length} requests came back as errors`,
      detail: 'Each one was retried, and every retry pays for the context again.',
      suggestion: 'Usually upstream and temporary. Worth noticing only if it keeps happening.',
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The whole verdict for one session's transcript rows. */
function analyze(rows) {
  const metrics = measure(Array.isArray(rows) ? rows : []);
  const verdict = { ...metrics, findings: findingsFor(metrics) };
  return { ...verdict, quality: quality(verdict) };
}

/**
 * The verdict as plain prose.
 *
 * Written for a reader that has no screen: the MCP tool a session calls about
 * itself, and the one-shot advisor. Every figure carries its unit and its
 * comparison, because a number with nothing beside it cannot be acted on — "977k"
 * means nothing, "98% of the window" means stop and compact.
 *
 * Deliberately short. It is going into somebody's context.
 */
function summarise(verdict, { name = 'This session', suggestions = true } = {}) {
  if (!verdict || verdict.reason || !verdict.requests) {
    return `${name} has written nothing to read yet.`;
  }
  const context = verdict.context;
  const share = context.window ? Math.round((context.last / context.window) * 100) : 0;
  const lines = [
    `${name}: ${thousands(context.last)} tokens of context, ${share}% of the ${thousands(context.window)} window, ` +
      `across ${verdict.requests} request${verdict.requests === 1 ? '' : 's'}` +
      `${verdict.spanMs ? ` over ${elapsed(verdict.spanMs)}` : ''}.`,
    `Peak ${thousands(context.peak)}. Input ${thousands(verdict.effectiveInput)} weighted for cache, ` +
      `output ${thousands(verdict.totals.output)}.`,
  ];

  const auto = verdict.compactions.filter((c) => c.trigger === 'auto');
  if (auto.length) {
    lines.push(
      `Compacted automatically ${auto.length} time${auto.length === 1 ? '' : 's'}, dropping ` +
        `${thousands(auto.reduce((sum, c) => sum + c.droppedTokens, 0))} tokens.`,
    );
  }
  if (verdict.latency.turns >= 3) {
    lines.push(`Typical turn ${minutes(verdict.latency.p50) || '<1'} min, slowest ${minutes(verdict.latency.p95)} min.`);
  }

  if (!verdict.findings.length) {
    lines.push('Nothing stands out: it is working within its means.');
    return lines.join('\n');
  }

  lines.push('', 'What stands out:');
  for (const finding of verdict.findings) {
    lines.push(`- [${finding.severity}] ${finding.title}. ${finding.detail}`);
    if (suggestions) lines.push(`  What helps: ${finding.suggestion}`);
  }
  return lines.join('\n');
}

/** One line, for listing a fleet rather than examining one session. */
function oneLine(verdict, name) {
  // Judged on whether there is anything to say, not on a flag: `analyze` returns
  // a verdict with no `ok` on it, and only the reader adds one.
  if (!verdict || verdict.reason || !verdict.requests) return `${name}: nothing written yet.`;
  const share = verdict.context.window
    ? Math.round((verdict.context.last / verdict.context.window) * 100)
    : 0;
  const worst = worstSeverity(verdict.findings);
  return (
    `${name}: ${share}% of window, ${verdict.requests} requests` +
    `${worst ? ` — ${verdict.findings.length} finding${verdict.findings.length === 1 ? '' : 's'}, worst ${worst}: ${verdict.findings[0].title}` : ' — nothing to report'}`
  );
}

/**
 * How well this session is being used, as one number.
 *
 * The findings say what is wrong. This says how much it matters, which is a
 * different question and the one usually being asked — nobody reads seven
 * findings to decide whether to keep going.
 *
 * Built out of named penalties rather than a formula, so the number can always
 * be justified: every point off has a sentence attached, and the sentences are
 * what is shown. A score with no account of itself is a horoscope.
 *
 * It measures *use*, not the work: a session can be doing excellent work badly,
 * carrying nine hundred thousand tokens to write a line of CSS, and that is
 * exactly what this is meant to notice.
 */
function quality(verdict) {
  if (!verdict || !verdict.requests) return null;
  const reasons = [];
  const context = verdict.context;

  const share = context.window ? context.last / context.window : 0;
  if (share >= 0.85) reasons.push({ cost: 30, label: `Running at ${Math.round(share * 100)}% of the window` });
  else if (share >= 0.6) reasons.push({ cost: 15, label: `Past ${Math.round(share * 100)}% of the window` });

  const auto = verdict.compactions.filter((c) => c.trigger === 'auto').length;
  if (auto) reasons.push({ cost: Math.min(30, 15 * auto), label: `Compacted itself ${auto} time${auto === 1 ? '' : 's'}` });

  if (verdict.reprimes.count >= 2) {
    reasons.push({
      cost: Math.min(12, 3 * verdict.reprimes.count),
      label: `Paid for ${thousands(verdict.reprimes.tokens)} of context twice`,
    });
  }

  const flood = verdict.tools.find((t) => t.calls && t.bytes / t.calls > FLOOD_BYTES);
  if (flood) reasons.push({ cost: 10, label: `${flood.name} is filling the context` });

  const repeats = verdict.repeated[0];
  if (repeats && repeats.times >= 4) {
    reasons.push({ cost: 6, label: `The same ${repeats.tool} call ${repeats.times} times` });
  }

  // What it produces for what it reads. Only meaningful once a session has run
  // long enough to have a shape; before that it is noise about a warm-up.
  if (verdict.requests >= 20 && verdict.totals.output > 0) {
    const perOutput = verdict.effectiveInput / verdict.totals.output;
    if (perOutput > 300) reasons.push({ cost: 15, label: `${Math.round(perOutput)} tokens read for every one written` });
    else if (perOutput > 150) reasons.push({ cost: 8, label: `${Math.round(perOutput)} tokens read for every one written` });
  }

  if (verdict.errors.length >= 3) reasons.push({ cost: 5, label: `${verdict.errors.length} failed requests` });

  const score = Math.max(0, 100 - reasons.reduce((sum, reason) => sum + reason.cost, 0));
  reasons.sort((a, b) => b.cost - a.cost);
  return { score, grade: gradeFor(score), reasons };
}

/**
 * Four words, not a hundred numbers.
 *
 * The boundaries are where the advice changes, not where the arithmetic is
 * tidy: below 50 the thing to do is start something fresh, and above 85 there is
 * nothing to do at all.
 */
function gradeFor(score) {
  if (score >= 85) return 'healthy';
  if (score >= 65) return 'fine';
  if (score >= 50) return 'strained';
  return 'struggling';
}

/** Highest severity present, or null — what a badge on a tab needs to know. */
function worstSeverity(findings = []) {
  for (const level of ['high', 'medium', 'low']) {
    if (findings.some((f) => f.severity === level)) return level;
  }
  return null;
}

/**
 * Read a transcript file and analyse it.
 *
 * Whole-file rather than incremental: a sixteen-thousand-line transcript parses
 * in about a tenth of a second, which is far below the cost of getting a partial
 * read wrong — and the panel that asks for this opens, at most, a few times an
 * hour. A row that will not parse is skipped rather than fatal; the file is being
 * appended to by another process while we read it, and the last line is often
 * half-written.
 */
function readRows(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // half-written tail, or a row from a newer format than this one
    }
  }
  return rows;
}

function analyzeFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const rows = readRows(file);
  if (!rows.length) return null;
  return { ...analyze(rows), file, size: stat.size, readAt: Date.now() };
}

module.exports = {
  analyze,
  analyzeFile,
  readRows,
  summarise,
  oneLine,
  quality,
  gradeFor,
  measure,
  findingsFor,
  worstSeverity,
  contextOf,
  windowFor,
  CACHE_WRITE_RATE,
  CACHE_READ_RATE,
  HIGH_CONTEXT_SHARE,
};
