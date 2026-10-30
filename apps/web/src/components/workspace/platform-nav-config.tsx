import React from 'react';

export type PlatformKey =
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'x'
  | 'tiktok'
  | 'youtube';

export interface PlatformNavItemConfig {
  key: PlatformKey;
  label: string;
  tooltip: string;
  routeSlug: string;
  isTesting: boolean;
  icon: React.ReactNode;
}

export function InstagramIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

export function ThreadsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M16 11.5c-.3-1.6-1.5-2.5-3.5-2.5-2.8 0-4.5 2-4.5 4.5s1.7 4.5 4.5 4.5c2.3 0 3.7-1.2 4-2.8" />
      <path d="M13 14c0 1.2-.8 2-2 2s-2-.8-2-2 .8-2 2-2h2v4" />
    </svg>
  );
}

export function XTwitterIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l6.7 7.7L4 20h1.8l5.6-6.4L16.2 20H20l-7-8.1L19.3 4h-1.8l-5.3 6.1L7.8 4H4z" />
    </svg>
  );
}

export function TikTokIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5" />
    </svg>
  );
}

export function YouTubeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="15" x="2" y="4.5" rx="4" />
      <polygon points="10 9 15 12 10 15 10 9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export const UPCOMING_PLATFORMS: PlatformNavItemConfig[] = [
  {
    key: 'instagram',
    label: 'Instagram',
    tooltip: 'Instagram — Accounts & Schedule',
    routeSlug: 'instagram',
    isTesting: false,
    icon: <InstagramIcon />,
  },
  {
    key: 'threads',
    label: 'Threads',
    tooltip: 'Threads — Being tested',
    routeSlug: 'threads',
    isTesting: false,
    icon: <ThreadsIcon />,
  },
  {
    key: 'x',
    label: 'X (Twitter)',
    tooltip: 'X (Twitter) — Being tested',
    routeSlug: 'x',
    isTesting: true,
    icon: <XTwitterIcon />,
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    tooltip: 'TikTok — Being tested',
    routeSlug: 'tiktok',
    isTesting: true,
    icon: <TikTokIcon />,
  },
  {
    key: 'youtube',
    label: 'YouTube',
    tooltip: 'YouTube — Being tested',
    routeSlug: 'youtube',
    isTesting: true,
    icon: <YouTubeIcon />,
  },
];

export const TESTING_PLACEHOLDER_TEXT = 'Being tested — not available for public use';
