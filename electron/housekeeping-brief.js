'use strict';

/**
 * What a Claude session is told when somebody presses Ask Claude in
 * Housekeeping: the machine as it stands, in the order a person would explain
 * it to a colleague — what is wrong, what is using the memory, what is on the
 * disk and what would come back by itself — and then the question.
 *
 * Plain text, no instructions hidden in it: the session gets facts and is asked
 * for a plan. Nothing here runs anything.
 */

const { formatBytes } = require('./housekeeping-items');

function composeBrief({ report, inventory, processes = [], openSessions = 0, question = null, now = Date.now() }) {
  const lines = [];
  const v = (metric) => report?.latest?.[metric]?.value ?? null;
  const b = (n) => (n === null || n === undefined ? '—' : formatBytes(n));
  lines.push('# Smart Terminal — housekeeping and machine health');
  lines.push('');
  lines.push(`Status: ${report?.status ?? 'unknown'}.`);
  if (report?.conditions?.length) {
    lines.push('');
    lines.push('## Lines crossed');
    for (const one of report.conditions) {
      const show = one.unit === 'bytes' ? formatBytes(one.value) : one.unit === '%' ? `${one.value}%` : one.unit === 'x' ? `${one.value}×` : String(one.value);
      lines.push(`- ${one.label}: ${show} (${one.level}, ${one.direction} ${one.unit === 'bytes' ? formatBytes(one.threshold) : one.threshold}${one.unit === '%' ? '%' : ''}). ${one.why}`);
    }
  }
  lines.push('');
  lines.push('## Memory and swap');
  lines.push(`- Memory free: ${b(v('mem.free.bytes'))} of ${b(v('mem.total.bytes'))}`);
  lines.push(`- Swap used: ${b(v('swap.used.bytes'))} of ${b(v('swap.total.bytes'))}${v('swap.used.pct') !== null ? ` (${v('swap.used.pct')}%)` : ''}`);
  lines.push(`- Load per core (5 min): ${v('load.per.core') ?? '—'}`);
  lines.push(`- Smart Terminal itself: ${b(v('app.rss.bytes'))}, ${openSessions} open session${openSessions === 1 ? '' : 's'}`);
  if (processes.length) {
    lines.push('');
    lines.push('## Processes holding the most memory');
    for (const one of processes) lines.push(`- ${formatBytes(one.bytes).padStart(9)}  pid ${one.pid}  ${one.command}`);
  }
  if (inventory) {
    const t = inventory.totals;
    lines.push('');
    lines.push('## Disk');
    lines.push(`- Free: ${b(inventory.disk?.free)} of ${b(inventory.disk?.total)}${report?.daysUntilFull !== null && report?.daysUntilFull !== undefined ? `; about ${report.daysUntilFull} days until full at the current rate` : ''}`);
    lines.push(`- Sessions (conversations and copies): ${b(t.sessions.bytes)} in ${t.sessions.count}`);
    lines.push(`- Worktrees and build caches: ${b(t.worktrees.bytes)} in ${t.worktrees.count}`);
    lines.push(`- App files (backups, installers, caches): ${b(t.app.bytes)}`);
    lines.push(`- Would come back by itself if removed: ${b(t.all.reversibleBytes)}`);
    const trees = inventory.items.filter((one) => one.kind === 'worktree');
    if (trees.length) {
      const unmerged = trees.filter((one) => one.meta?.work === 'unmerged');
      const done = trees.filter((one) => one.meta?.finished);
      lines.push('');
      lines.push(`## Worktrees: ${trees.length} listed, ${done.length} finished (merged or branch gone), ${unmerged.length} with unmerged work`);
      for (const one of [...trees].sort((a, c) => c.bytes - a.bytes).slice(0, 15)) {
        const idle = one.lastActivityAt ? `${Math.floor((now - one.lastActivityAt) / 86_400_000)}d idle` : 'idle unknown';
        lines.push(`- ${one.label}: ${one.state}; ${idle}; ${b(one.bytes)}${one.blockers.length ? `; blocked: ${one.blockers.join(', ')}` : ''}`);
      }
    }
    const caches = inventory.items.filter((one) => one.kind === 'build-cache').sort((a, c) => c.bytes - a.bytes).slice(0, 8);
    if (caches.length) {
      lines.push('');
      lines.push('## Largest build caches');
      for (const one of caches) lines.push(`- ${one.label}: ${b(one.bytes)}${one.blockers.length ? ` (${one.blockers.join(', ')})` : ''}`);
    }
  }
  lines.push('');
  lines.push('## Question');
  lines.push(
    question ??
      'The machine is slow and swapping. From the numbers above, say which processes or sessions to close first and why, what to free on disk (and in which order) without losing unmerged work, and anything that would stop this happening again. Be concrete: name the processes, the worktrees and the sizes. Do not run anything destructive; propose, and ask before removing.',
  );
  return lines.join('\n');
}

module.exports = { composeBrief };
