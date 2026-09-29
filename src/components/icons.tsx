import type { ReactNode } from 'react';

/**
 * Small inline icons for the sidebar's tools. Drawn rather than borrowed from a
 * font so they line up at the same optical weight and follow `currentColor`.
 */
const base = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function AccountsIcon() {
  return (
    <svg {...base} aria-hidden>
      <circle cx="6" cy="5.4" r="2.6" />
      <path d="M1.9 13.4c0-2.3 1.8-3.8 4.1-3.8s4.1 1.5 4.1 3.8" />
      <path d="M10.6 3.2a2.6 2.6 0 0 1 0 4.6M11.6 9.9c1.6.4 2.6 1.7 2.6 3.5" />
    </svg>
  );
}

export function UsageIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M2 11.5a6 6 0 1 1 12 0" />
      <path d="M8 11.5 11 7" />
      <circle cx="8" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A pulse: the line a session's context traces as it fills up. */
export function MonitorIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M1.6 9.2h2.6l1.6-4.4 2.4 6.6 1.7-3.6 1.1 1.4h3" />
    </svg>
  );
}

/**
 * The helm — the wheel Kubernetes is named after, and steers by.
 *
 * Drawn as the wheel rather than as the seven-sided logo, because at 18px the
 * heptagon reads as a circle and the spokes are what make it a helm.
 */
export function ClustersIcon() {
  return (
    <svg {...base} aria-hidden>
      <circle cx="7" cy="7" r="5.1" />
      <circle cx="7" cy="7" r="1.7" />
      <path d="M7 1.9v3.4M7 8.7v3.4M1.9 7h3.4M8.7 7h3.4" />
    </svg>
  );
}

/**
 * What a tab is, in the shape of its mark.
 *
 * The account has always been a coloured dot in front of every session tab, and
 * a dot says one thing. These say two in the same seven pixels: the colour is
 * still the account, and now the shape is what the tab *is* — a conversation, a
 * shell, or a sign-in. With seventeen tabs open that second fact is the one you
 * were squinting for.
 *
 * Filled rather than stroked, deliberately: the colour is doing the account's
 * work and an outline at this size hardly carries one.
 */
export function SessionMark({ kind, color }: { kind: 'claude' | 'shell' | 'login'; color: string }) {
  if (kind === 'shell') {
    // A prompt: the chevron and the line you type on.
    return (
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
        <path d="M1.2 2.2 4 5l-2.8 2.8" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5.4 7.8h3.4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'login') {
    // A key: this tab exists to get an account signed in, and then it is done.
    return (
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
        <circle cx="3.4" cy="3.4" r="2.2" stroke={color} strokeWidth="1.5" />
        <path d="M5 5l3.4 3.4M6.4 6.4l-.9.9M7.6 7.6l-.9.9" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  // A conversation: the spark, filled, so the account's colour still reads.
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
      <path
        d="M5 0.6 6.1 3.9 9.4 5 6.1 6.1 5 9.4 3.9 6.1 0.6 5 3.9 3.9Z"
        fill={color}
      />
    </svg>
  );
}

/** Blocks that fit together — what an extension does to the app. */
export function ExtensionsIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M2 5.2h4.2v4.2H2zM7.8 2.6h4.2v4.2H7.8zM7.8 8.4h4.2v4.2H7.8z" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg {...base} aria-hidden>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" />
      <path d="M2.2 2.6v2.9h2.9" />
      <path d="M8 5.2V8l2 1.4" />
    </svg>
  );
}

export function AppearanceIcon() {
  return (
    <svg {...base} aria-hidden>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 2.3v11.4a5.7 5.7 0 0 0 0-11.4z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Open something in a section of its own: a frame with an arrow leaving it. */
export function OpenInSectionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 1.6h3.9v3.9M10.4 1.6 5.6 6.4" />
      <path d="M8.6 7.2v2.1a1.1 1.1 0 0 1-1.1 1.1H2.7a1.1 1.1 0 0 1-1.1-1.1V4.5a1.1 1.1 0 0 1 1.1-1.1h2.1" />
    </svg>
  );
}

/** Ask again. Turns while the asking is going on. */
export function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={spinning ? 'is-spinning' : undefined}
    >
      <path d="M10.2 5.9A4.2 4.2 0 1 1 8.9 2.9" />
      <path d="M9.4 1.2v2.2H7.2" />
    </svg>
  );
}

/*
 * The toolbar's own marks. They were Unicode arrows and boxes, each drawn by
 * whichever font had the character, so no two were the same size or weight.
 * One grid, one stroke, like the sidebar's.
 */
function ToolIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const SplitRightIcon = () => (
  <ToolIcon><rect x="1.6" y="2.1" width="10.8" height="9.8" rx="1.6" /><path d="M7 2.1v9.8" /></ToolIcon>
);
export const SplitDownIcon = () => (
  <ToolIcon><rect x="1.6" y="2.1" width="10.8" height="9.8" rx="1.6" /><path d="M1.6 7h10.8" /></ToolIcon>
);
export const EvenSplitsIcon = () => (
  <ToolIcon><rect x="1.6" y="2.1" width="10.8" height="9.8" rx="1.6" /><path d="M7 2.1v9.8M1.6 7h10.8" /></ToolIcon>
);
export const MaximizeIcon = ({ restore = false }: { restore?: boolean }) => (
  <ToolIcon>
    {restore ? <path d="M5.4 1.8v3.6H1.8M8.6 12.2V8.6h3.6M5.4 5.4 1.8 1.8M8.6 8.6l3.6 3.6" /> : <path d="M8.4 1.8h3.8v3.8M5.6 12.2H1.8V8.4M12.2 1.8 8.2 5.8M1.8 12.2l4-4" />}
  </ToolIcon>
);
export const PlusIcon = () => <ToolIcon><path d="M7 2.6v8.8M2.6 7h8.8" /></ToolIcon>;
export const ChevronDownIcon = () => <ToolIcon><path d="M4 5.6 7 8.6l3-3" /></ToolIcon>;
export const MinimizeIcon = () => <ToolIcon><path d="M3 7h8" /></ToolIcon>;
