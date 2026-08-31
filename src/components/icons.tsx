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
