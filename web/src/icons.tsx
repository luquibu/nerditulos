// Lucide icons 1.48.0 (https://github.com/lucide-icons/lucide/tree/1.48.0/icons), copied as inline SVG.
// ISC License; text in web/public/licenses/LICENSE-lucide.txt and NOTICE. Always decorative: aria-hidden.
const base = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export function IconRadio() {
  return (
    <svg {...base}>
      <path d="M16.247 7.761a6 6 0 0 1 0 8.478" />
      <path d="M19.075 4.933a10 10 0 0 1 0 14.134" />
      <path d="M4.925 19.067a10 10 0 0 1 0-14.134" />
      <path d="M7.753 16.239a6 6 0 0 1 0-8.478" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

export function IconCheck() {
  return (
    <svg {...base}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconTriangleAlert() {
  return (
    <svg {...base}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function IconCircleX() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

export function IconCircleOff() {
  return (
    <svg {...base}>
      <path d="m2 2 20 20" />
      <path d="M8.35 2.69A10 10 0 0 1 21.3 15.65" />
      <path d="M19.08 19.08A10 10 0 1 1 4.92 4.92" />
    </svg>
  );
}

export function IconMic() {
  return (
    <svg {...base}>
      <path d="M12 19v3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <rect x="9" y="2" width="6" height="13" rx="3" />
    </svg>
  );
}

// Lucide `file-headphone` (`file-audio` is its deprecated alias).
export function IconFileAudio() {
  return (
    <svg {...base}>
      <path d="M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0" />
    </svg>
  );
}

export function IconArrowDown() {
  return (
    <svg {...base}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

export function IconUser() {
  return (
    <svg {...base}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function IconRefresh() {
  return (
    <svg {...base}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

export function StatusIcon({ status }: { status: 'live' | 'ok' | 'warning' | 'error' | 'off' }) {
  switch (status) {
    case 'live':
      return <IconRadio />;
    case 'ok':
      return <IconCheck />;
    case 'warning':
      return <IconTriangleAlert />;
    case 'error':
      return <IconCircleX />;
    default:
      return <IconCircleOff />;
  }
}
