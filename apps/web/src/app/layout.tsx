import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import React, { type ReactNode } from 'react';
import './globals.css';
import { DesktopTitleBar } from '@/components/desktop';
import { WhatsAppSupportButton } from '@/components/support';
import { Analytics } from '@vercel/analytics/next';
import { PostHogProvider } from '@/components/posthog-provider';
import { getServerSessionContext } from '@/lib/auth';
import { fontSansClassName } from './fonts';

export const metadata: Metadata = {
  title: 'FBUploadPro',
  description: 'publishing automation platform',
  icons: {
    icon: [
      { url: '/icon.svg?v=3', type: 'image/svg+xml' },
      { url: '/favicon.ico?v=3', sizes: 'any' },
    ],
    shortcut: '/favicon.ico?v=3',
    apple: '/icon.svg?v=3',
  },
};

/**
 * Viewport (spec 142, F03): `viewportFit: 'cover'` opts the page into the
 * full screen area on notched devices, which is what makes the
 * `env(safe-area-inset-*)` values behind the globals.css safe-area
 * utilities (pt-safe / pb-safe / pl-safe / pr-safe / pb-safe-offset)
 * non-zero. Without it those insets stay 0 and bottom-anchored UI can sit
 * under the home indicator. Deliberately NO maximumScale /
 * userScalable: false — pinch zoom stays available (accessibility).
 * This must stay a separate `viewport` export: Next ignores a
 * `viewportFit` key placed inside `metadata`.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * Inter (Direction 4, 2026-10-29) — loaded via next/font/google so the
 * token pipeline can reference it: tokens/primitive.json font.family.sans
 * is `var(--font-inter), system-ui, ...`, and globals.css @theme maps
 * --font-sans to that generated variable. Stored-theme precedence is
 * unchanged (localStorage 'theme', then fbup_theme cookie); only the
 * fallback when neither is set changes from dark to light (light-first).
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const themeInitScript = `
  (function() {
    try {
      var theme = localStorage.getItem('theme');
      if (!theme) {
        var match = document.cookie.match(/(?:^|;\\s*)fbup_theme=([^;]+)/);
        if (match) theme = match[1];
      }
      if (!theme) {
        theme = 'light';
      }
      var resolved = theme === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = resolved;
      document.documentElement.classList.remove('dark', 'light');
      document.documentElement.classList.add(resolved);
    } catch (e) {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.classList.add('light');
    }
  })();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  // Session ids for PostHog identify only — userId + tenant subdomain,
  // never email or name. Any failure (no cookie, bad token, missing
  // secret) falls back to anonymous: analytics degrades, the page
  // must not. This runs on public pages too, where it is simply null.
  let session: { userId: string; subdomain: string } | null = null;
  try {
    session = await getServerSessionContext();
  } catch {
    session = null;
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${inter.variable} ${fontSansClassName}`}>
        <PostHogProvider
          apiKey={process.env.POSTHOG_KEY}
          host={process.env.POSTHOG_HOST || 'https://us.i.posthog.com'}
          userId={session?.userId}
          tenantId={session?.subdomain}
        >
          <DesktopTitleBar />
          <main>{children}</main>
          <WhatsAppSupportButton />
          <Analytics />
        </PostHogProvider>
      </body>
    </html>
  );
}
