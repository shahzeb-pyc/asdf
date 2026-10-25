'use client';

/**
 * AuthShowcasePanel — the login showcase panel, rebuilt for spec 136
 * (PR-136A) on design tokens + token-backed utilities only, and
 * redesigned on login-fixes as the approved Option 1 — typographic
 * only (mockup: login-showcase-options.html, Option 1 section),
 * revised per login-showcase-option1-v2.html (which supersedes the
 * first mockup for the showcase): the content is a centred block
 * (max-w-100, i.e. 400px on the numeric spacing scale) vertically
 * centred in the panel, so brand, headline, features, and trust
 * line all share one left edge inside that block; feature rows
 * have no divider lines (spacing alone separates them); icons are
 * the real Lucide icons at 18px (size-4.5), gold, no circle
 * backgrounds, aligned to the first line of the feature title,
 * with title and description in one column under each other.
 *
 * No visual, no cards, no dashboard preview, no timeline: hierarchy
 * and whitespace only. The panel content is centred in the panel
 * (items-center + justify-center on the outer flex), not stretched
 * with a footer pinned to the bottom edge.
 *
 * The copy is the approved block of 2026-10-16 (spec 136 §3.1),
 * carried verbatim: the eyebrow, the three-line headline (this panel
 * renders the login page's sole top-level heading, with the final
 * segment in the accent gold), the subhead, and the three feature
 * rows, plus the trust line. Dropped in the Option 1 redesign, per
 * the approved mockup: the brand-row tagline ("Content automation
 * for creators" — it repeats the headline) and the separate
 * platform line ("Facebook · Instagram · …" — the subhead already
 * lists the platforms). The trust line is now a quiet line under
 * the content, not a bordered footer row. Nothing from the approved
 * record's absent list is added: no first-comments row, no
 * testimonial, no "See how it works" link.
 *
 * The panel follows the theme (bg-canvas on the showcase section in
 * auth-split-layout.tsx): it is never forced black and carries no
 * glow/halo, so it reads in both light and dark themes.
 */

import React from 'react';
import Link from 'next/link';
import { ClockIcon, LayoutGridIcon, LockIcon } from 'lucide-react';
import { BrandMark } from '@/components/brand';

interface FeatureItem {
  icon: React.ReactNode;
  title: string;
  desc: string;
}

const FEATURES: readonly FeatureItem[] = [
  {
    icon: <ClockIcon className="mt-px size-4.5 shrink-0 text-primary" aria-hidden="true" />,
    title: 'Post from anywhere',
    desc: 'Schedule from your phone or laptop — your posts publish from the cloud.',
  },
  {
    icon: <LayoutGridIcon className="mt-px size-4.5 shrink-0 text-primary" aria-hidden="true" />,
    title: 'Every platform, one dashboard',
    desc: 'Connect each account once, then run everything from a single place.',
  },
  {
    icon: <LockIcon className="mt-px size-4.5 shrink-0 text-primary" aria-hidden="true" />,
    title: 'Your accounts stay yours',
    desc: 'You sign in through each platform directly — your passwords never leave them.',
  },
] as const;

export function AuthShowcasePanel() {
  return (
    <div className="flex h-full flex-1 items-center justify-center">
      {/* Centred block: brand, headline, features, and trust line share
          one left edge inside this 400px block, vertically centred. */}
      <div className="w-full max-w-100">
      {/* Brand row — mark + name only; the tagline repeated the headline. */}
      <Link href="/login" className="inline-flex items-center gap-3 self-start no-underline">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-line bg-subtle">
          <BrandMark size={24} />
        </div>
        <span className="text-lg leading-heading font-bold tracking-h3 text-ink">
          FBUploadPro
        </span>
      </Link>

      {/* Showcase content */}
      <div className="mt-10">
        {/* Eyebrow */}
        <div className="mb-3 text-xs font-semibold tracking-caption text-primary uppercase">
          CREATE · SCHEDULE · GROW
        </div>

        {/* Headline — three lines, final segment in the accent gold. */}
        <h1 className="mb-4 text-xxl leading-heading font-bold tracking-h1 text-ink">
          Your pages,
          <br />
          posting themselves —
          <br />
          <span className="text-primary">100% on the cloud.</span>
        </h1>

        {/* Subhead */}
        <p className="mb-6 text-body leading-body text-ink-dim">
          Schedule reels and posts across Facebook, Instagram, TikTok, YouTube, Threads, and X —
          they go live while you sleep, even when your laptop is closed.
        </p>

        {/* Feature list — three rows, spacing alone separates them:
            no divider lines. Icon + one text column per row, so the
            description aligns under its title, not under the icon. */}
        <div className="flex w-full flex-col gap-5">
          {FEATURES.map((item) => (
            <div key={item.title} className="flex items-start gap-3">
              {item.icon}
              <div className="flex-1">
                <div className="text-body leading-heading-loose font-semibold text-ink">
                  {item.title}
                </div>
                <div className="mt-1 text-metadata leading-body text-ink-dim">{item.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Trust line — a quiet line under the content, not a bordered footer. */}
        <p className="mt-6 text-xs text-ink-dim">
          Official platform logins · Encrypted end-to-end
        </p>
      </div>
      </div>
    </div>
  );
}
export const LoginShowcasePanel = AuthShowcasePanel;
