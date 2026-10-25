import type { Metadata, Viewport } from 'next';
import React, { type ReactNode } from 'react';
import './globals.css';
import { DesktopTitleBar } from '@/components/desktop';
import { WhatsAppSupportButton } from '@/components/support';
import { Analytics } from '@vercel/analytics/next';
import { PostHogProvider } from '@/components/posthog-provider';
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

const themeInitScript = `
  (function() {
    try {
      var theme = localStorage.getItem('theme');
      if (!theme) {
        var match = document.cookie.match(/(?:^|;\\s*)fbup_theme=([^;]+)/);
        if (match) theme = match[1];
      }
      if (!theme && window.matchMedia('(prefers-color-scheme: light)').matches) {
        theme = 'light';
      }
      var resolved = theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = resolved;
      document.documentElement.classList.remove('dark', 'light');
      document.documentElement.classList.add(resolved);
    } catch (e) {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.classList.add('dark');
    }
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={fontSansClassName}>
        <PostHogProvider
          apiKey={process.env.POSTHOG_KEY}
          host={process.env.POSTHOG_HOST || 'https://us.i.posthog.com'}
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
