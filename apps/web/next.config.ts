import type { NextConfig } from 'next';
import bundleAnalyzer from '@next/bundle-analyzer';

// Bundle visibility and budgets (spec 137 §3.6.2): the analyzer runs
// on a webpack build (`ANALYZE=true npx next build --webpack`) and
// emits its report under .next/analyze/; the CI bundle job uploads the
// analyzer report and the measured budget report as artifacts on PRs.
// D137-3's report-only posture was superseded on 2026-10-24: budgets
// in apps/web/bundle-budgets.json are enforced by the CI bundle job.
// Production builds stay on Turbopack.
const analyzeBuild = process.env.ANALYZE === 'true';
const withBundleAnalyzer = bundleAnalyzer({
  enabled: analyzeBuild,
});

// Baseline security headers. Content-Security-Policy is issued per-request
// by middleware (src/lib/csp.ts, still Report-Only in Phase 1 of spec 114)
// because it carries a per-request nonce, so it is not set here.
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Router-cache reuse for back/forward navigation (perf launch
  // pass): Next's default `dynamic: 0` re-fetches the RSC payload
  // — and re-runs every server prefetch — on EVERY client
  // navigation, even when the React Query cache already holds
  // fresh data. A 30s dynamic window makes back/forward within
  // it instant with zero server calls, while data freshness is
  // still governed by the query staleTimes (60s reference / 15s
  // queue / 5min insights) plus background revalidation — never
  // frozen data. Mutations invalidate query keys, so a mutated
  // list refetches on next view regardless of this window. The
  // only lag this introduces is server-rendered frame text (the
  // workspace name in the layout) showing a up-to-30s-old value
  // on a rapid revisit after a rename. Static segments reuse
  // for 180s (Next's own default is 30s; static content here
  // changes only on deploy).
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
  // Analyzer builds only: webpack builds run Next's route-export type
  // validator, which rejects the test-exported route handlers that
  // exist across the API surface (pre-existing state; the Turbopack
  // production build and `tsc --noEmit` do not run that validator).
  // The measurement build exists to weigh bundles, not to re-litigate
  // types — type safety stays enforced by the typecheck gate and the
  // production build. Never set outside ANALYZE=true.
  typescript: {
    ignoreBuildErrors: analyzeBuild,
  },
  // Image optimisation hosts (spec 137 §3.5 / PR-A4). Every entry is a
  // host the app actually displays images from, derived from a grep of
  // the codebase at build time — no wildcard-everything pattern:
  //   media.fbuploadpro.com        production R2 public media host
  //                                (.env.production.example, tests,
  //                                tests/helpers/mock-storage.ts)
  //   media.dev.fbuploadpro.com    development R2 public host
  //                                (apps/web/.env.example R2_PUBLIC_URL)
  //   media.vinsmokemedia.online   deployed R2 public media host
  //                                (Doppler prd R2_PUBLIC_URL; image
  //                                previews/thumbnails broke until this
  //                                host was allowed — videos already
  //                                played because they bypass next/image)
  //   **.fbcdn.net                 Facebook CDN — Graph picture/media
  //                                URLs (packages/contracts downloader
  //                                domain list; profile_picture_url
  //                                values originate from Graph)
  //   platform-lookaside.fbsbx.com Facebook Graph profile pictures
  //                                (verbatim in API test fixtures)
  //   graph.facebook.com           Graph picture host
  //   storage.e2e.invalid          Playwright fixture storage host
  //                                (tests/e2e/fixtures/tenant.ts +
  //                                fixtures/api.ts serve media items
  //                                from it; added in spec 133 PR-133-2
  //                                per spec §6.7 when the media grid
  //                                converted to next/image — .invalid
  //                                is the RFC 2606 non-resolving TLD,
  //                                so this can never name a real host)
  //   **.tiktokcdn.com              TikTok CDN — creator avatar URLs
  //                                returned by the TikWM API (e.g.
  //                                p16-sign-*.tiktokcdn.com) and shown
  //                                by the Creator Finder card via
  //                                next/image. An avatar from any
  //                                other host fails to optimise and
  //                                the card falls back to initials,
  //                                exactly as for a broken image.
  // YouTube thumbnails (i.ytimg.com) are NOT listed: no surface displays
  // them today (grep: zero hits) — spec §3.5 includes the class only if
  // a surface uses it.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'media.fbuploadpro.com' },
      { protocol: 'https', hostname: 'media.dev.fbuploadpro.com' },
      { protocol: 'https', hostname: 'media.vinsmokemedia.online' },
      { protocol: 'https', hostname: '**.fbcdn.net' },
      { protocol: 'https', hostname: 'platform-lookaside.fbsbx.com' },
      { protocol: 'https', hostname: 'graph.facebook.com' },
      { protocol: 'https', hostname: 'storage.e2e.invalid' },
      { protocol: 'https', hostname: '**.tiktokcdn.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
