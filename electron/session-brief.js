'use strict';

/**
 * What a session would need to be told, if it had to start over.
 *
 * Restarting a session today resumes its conversation, which is better than any
 * summary — Claude comes back with the thing itself, not an account of it. This
 * exists for the case that is not that: a session whose context has grown until
 * carrying it is the problem, or one whose conversation cannot be resumed at all
 * because the account changed, the file is gone, or it never wrote a turn.
 *
 * Nothing here is generated. Claude Code already writes down what the session is
 * called, the last thing it was asked, and every task it opened and closed; this
 * only gathers them. That matters for two reasons: it costs nothing, and it
 * cannot invent. A summary written by a model can be confidently wrong about what
 * was happening. A list of the tasks it actually opened cannot.
 *
 * Pure: rows in, brief out. The reading, the storing and the delivering are
 * somebody else's job.
 */

/** Beyond this a prompt is being quoted rather than recalled. */
const PROMPT_LIMIT = 600;

/** Enough open work to know where you are; more is a backlog, not a handover. */
const OPEN_LIMIT = 12;

/** Finished work is context, not instruction, so it gets less room. */
const DONE_LIMIT = 8;

function trim(text, limit) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function blocksOf(row) {
  const content = row?.message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * Read the transcript into the handful of things worth carrying over.
 *
 * @param {Array<object>} rows parsed JSONL entries, in file order
 */
function brief(rows) {
  let title = null;
  let lastPrompt = null;
  let cwd = null;
  let branch = null;
  let at = null;
  let turns = 0;

  /** tool_use id -> tool name, so a result can be attributed to what asked for it. */
  const asked = new Map();
  /** task id -> { subject, status } */
  const tasks = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;

    if (row.cwd) cwd = row.cwd;
    // `HEAD` is what a detached checkout reports, and naming it as the branch
    // would be worse than saying nothing.
    if (row.gitBranch && row.gitBranch !== 'HEAD') branch = row.gitBranch;
    if (row.type === 'ai-title' && row.aiTitle) title = String(row.aiTitle);
    if (row.type === 'last-prompt' && row.lastPrompt) lastPrompt = String(row.lastPrompt);

    const stamp = Date.parse(row.timestamp);
    if (Number.isFinite(stamp)) at = stamp;
    if (row.type === 'assistant' && row.message?.usage) turns += 1;

    for (const block of blocksOf(row)) {
      if (block?.type === 'tool_use') {
        if (block.id) asked.set(block.id, block.name);
        // The update carries the new state; the subject came with the creation.
        if (block.name === 'TaskUpdate' && block.input?.taskId) {
          const id = String(block.input.taskId);
          const existing = tasks.get(id) ?? { subject: null, status: 'open' };
          tasks.set(id, { ...existing, status: block.input.status ?? existing.status });
        }
      }
      if (block?.type === 'tool_result' && asked.get(block.tool_use_id) === 'TaskCreate') {
        const made = row.toolUseResult?.task;
        if (made?.id) {
          const id = String(made.id);
          const existing = tasks.get(id) ?? { status: 'open' };
          tasks.set(id, { ...existing, subject: made.subject ?? existing.subject ?? null });
        }
      }
    }
  }

  const listed = [...tasks.entries()]
    .filter(([, task]) => task.subject)
    .map(([id, task]) => ({ id, subject: trim(task.subject, 160), status: task.status ?? 'open' }));

  return {
    title: title ? trim(title, 120) : null,
    lastPrompt: lastPrompt ? trim(lastPrompt, PROMPT_LIMIT) : null,
    cwd,
    branch,
    at,
    turns,
    open: listed.filter((task) => task.status !== 'completed' && task.status !== 'cancelled'),
    done: listed.filter((task) => task.status === 'completed'),
  };
}

/** Whether there is enough here to be worth handing anyone. */
function worthCarrying(entry) {
  return Boolean(entry && (entry.title || entry.lastPrompt || entry.open?.length));
}

/**
 * The brief as the words a fresh session is opened with.
 *
 * Written as an instruction rather than a report, because that is what it is: the
 * first thing said to a Claude that knows nothing. The closing line is the most
 * important one in it — a summary is lossy by construction, and a session that
 * treats it as complete will act confidently on a partial picture. Being told to
 * go and look is what makes handing over a summary safe at all.
 */
function render(entry, { command = null, name = null } = {}) {
  if (!worthCarrying(entry)) return null;
  const lines = ['Picking up where a previous session left off. Its conversation was deliberately not carried over — only this.'];

  lines.push('');
  if (entry.title) lines.push(`What it was doing: ${entry.title}`);
  if (name && !entry.title) lines.push(`The session is called: ${name}`);
  if (entry.cwd) lines.push(`Working in: ${entry.cwd}${entry.branch ? ` (branch ${entry.branch})` : ''}`);
  if (command) lines.push(`It had been running: ${command}`);
  if (entry.lastPrompt) lines.push('', `The last thing asked of it:`, `"${entry.lastPrompt}"`);

  if (entry.open.length) {
    lines.push('', 'Still open:');
    for (const task of entry.open.slice(0, OPEN_LIMIT)) lines.push(`- ${task.subject}`);
    if (entry.open.length > OPEN_LIMIT) lines.push(`- …and ${entry.open.length - OPEN_LIMIT} more`);
  }

  if (entry.done.length) {
    // The last ones, not the first. A session that has closed a hundred tasks
    // opened most of them long before anything you are about to do, and what
    // helps someone picking it up is what was finished just now.
    const recent = entry.done.slice(-DONE_LIMIT);
    lines.push('', entry.done.length > DONE_LIMIT ? `Finished recently (of ${entry.done.length}):` : 'Already finished:');
    for (const task of recent) lines.push(`- ${task.subject}`);
  }

  lines.push(
    '',
    'That is everything that was carried over, and it is a summary, so treat it as a starting point rather than the truth: read the files before changing them, and ask if it is not enough to go on.',
  );
  return lines.join('\n');
}

module.exports = { brief, render, worthCarrying, PROMPT_LIMIT, OPEN_LIMIT, DONE_LIMIT };
