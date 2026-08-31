import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { HistorySession, TranscriptEntry } from '../global';
import { compactPath, formatBytes } from '../lib/labels';

const ROLE_LABEL: Record<TranscriptEntry['role'], string> = {
  user: 'You',
  assistant: 'Claude',
  thinking: 'Thinking',
  tool: 'Ran',
  result: 'Output',
};

/**
 * Reads a kept conversation back: what was asked, what was answered, and every
 * command that ran in between. This is the point of keeping it — a session whose
 * tab is long gone can still be gone through.
 */
export function TranscriptViewer({ session, onBack }: { session: HistorySession; onBack(): void }) {
  const homedir = useStore((s) => s.homedir);
  const reopenSession = useStore((s) => s.reopenSession);
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    window.api.history.transcript(session.id).then(setEntries);
  }, [session.id]);

  const visible = (entries ?? []).filter(
    (entry) => showDetail || entry.role === 'user' || entry.role === 'assistant',
  );

  return (
    <>
      <div className="transcript-head">
        <button className="ghost-btn tiny" onClick={onBack}>
          &larr; History
        </button>
        <div className="transcript-title">
          <strong>
            {session.title ||
              compactPath(session.lastCwd || session.startCwd, homedir).split('/').pop()}
          </strong>
          <small>
            {session.profileName} · {compactPath(session.lastCwd || session.startCwd, homedir)}
            {entries && entries.length > 0 && (
              <>
                {' · '}
                {entries.length} entries ·{' '}
                {formatBytes(entries.reduce((total, entry) => total + entry.text.length, 0))}
              </>
            )}
          </small>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showDetail}
            onChange={(event) => setShowDetail(event.target.checked)}
          />
          <span>Commands</span>
        </label>
        {session.claudeSessionId && (
          <button className="ghost-btn tiny is-primary" onClick={() => reopenSession(session.id)}>
            Continue
          </button>
        )}
      </div>

      <div className="transcript">
        {entries === null && <p className="usage-note">Reading…</p>}
        {entries?.length === 0 && (
          <p className="usage-note">
            Nothing was kept for this session. Recording is per session — turn it on from a tab&rsquo;s
            right-click menu, or for everything in Appearance.
          </p>
        )}
        {visible.map((entry) => (
          <article className={`turn turn-${entry.role}`} key={entry.seq}>
            <header>
              <span>{ROLE_LABEL[entry.role]}</span>
              {entry.at && <time>{new Date(entry.at).toLocaleTimeString()}</time>}
            </header>
            <pre>{entry.text}</pre>
          </article>
        ))}
      </div>
    </>
  );
}
