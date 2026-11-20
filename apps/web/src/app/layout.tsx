import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import React, { type ReactNode } from 'react';
import './globals.css';
import { NEXTRISE_DISPLAY_NAME, NEXTRISE_LOGO_PATH } from '@fbuploadpro/contracts';
import { DesktopTitleBar } from '@/components/desktop';
import { DeferredWhatsAppSupportButton } from '@/components/support/deferred-whatsapp-support-button';
import { BrandProvider } from '@/components/brand';
import { getRequestBrand } from '@/lib/brand-server';
import { PostHogProvider } from '@/components/posthog-provider';
import { fontSansClassName } from './fonts';

/**
 * Spec 191: the document title and icon follow the request's brand.
 * Our brand keeps today's metadata exactly; the white-label brand
 * gets its own name and logo.
 */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getRequestBrand();
  if (brand === 'nextrise') {
    return {
      title: NEXTRISE_DISPLAY_NAME,
      description: 'publishing automation platform',
      icons: {
        icon: [{ url: NEXTRISE_LOGO_PATH, type: 'image/svg+xml' }],
        shortcut: NEXTRISE_LOGO_PATH,
        apple: NEXTRISE_LOGO_PATH,
      },
    };
  }
  return {
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
}

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
 * Manrope (spec 177, 2026-11-13) — loaded via next/font/google so the
 * token pipeline can reference it: tokens/primitive.json font.family.sans
 * is `var(--font-manrope), system-ui, ...`, and globals.css @theme maps
 * --font-sans to that generated variable. Stored-theme precedence is
 * unchanged (localStorage 'theme', then fbup_theme cookie); only the
 * fallback when neither is set changes from dark to light (light-first).
 */
const manrope = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-manrope',
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
  // Spec 191: the brand comes from the request host and is provided
  // to every client component below.
  const brand = await getRequestBrand();
  return (
    <html lang="en" suppressHydrationWarning className={manrope.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={fontSansClassName}>
        <PostHogProvider
          apiKey={process.env.POSTHOG_KEY}
          host={process.env.POSTHOG_HOST || 'https://us.i.posthog.com'}
        >
          <BrandProvider brand={brand}>
            <DesktopTitleBar />
            <main>{children}</main>
            <DeferredWhatsAppSupportButton />
          </BrandProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
