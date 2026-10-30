'use client';

import * as React from 'react';
import { useState } from 'react';
import Link from 'next/link';
import { CheckIcon } from 'lucide-react';
import type { Creator } from '@fbuploadpro/contracts';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent } from '@/components/shared/ui/card';

/**
 * Compact, readable follower count: 999 stays "999", 12400 becomes
 * "12.4K", 1200000 becomes "1.2M". No existing compact-count helper
 * lives in the codebase (other counts use full toLocaleString), so
 * this small formatter lives here, next to its only use.
 */
function formatCompactCount(count: number): string {
  if (count < 1000) return String(count);
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [divisor, suffix] of units) {
    if (count >= divisor) {
      const value = count / divisor;
      const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
      return `${text}${suffix}`;
    }
  }
  return String(count);
}

/**
 * One creator, found — never invented. The card shows only user
 * details: profile photo, display name, handle, and the profile
 * link. Two similar-only details are added when — and only when —
 * the source actually returned them: a verified tick next to the
 * name (verified === true only, never a cross or placeholder) and
 * a follower count under the handle. Trending and niche creators
 * carry neither field, so their cards look exactly as before.
 * No video title, no bio. The photo is a plain <img> (not
 * next/image, so TikTok's image host needs no allowlist entry)
 * and falls back to initials when there is no avatar URL or the
 * photo fails to load.
 */
export function CreatorCard({ creator }: Readonly<{ creator: Creator }>) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = creator.displayName
    ? creator.displayName
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase()
    : creator.handle.slice(0, 2).toUpperCase();
  const showPhoto = Boolean(creator.avatarUrl) && !imageFailed;
  const displayName = creator.displayName ?? `@${creator.handle}`;
  return (
    <Card className="py-6">
      <CardContent className="flex flex-col items-center text-center">
        {showPhoto ? (
          <img
            src={creator.avatarUrl ?? ''}
            alt={`${displayName} profile photo`}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="size-16 shrink-0 rounded-full border border-line object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="flex size-16 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-body font-semibold text-ink"
          >
            {initials}
          </div>
        )}
        <p className="mt-3 flex w-full items-center justify-center gap-1 text-body font-semibold text-ink">
          <span className="truncate">{displayName}</span>
          {creator.verified === true ? (
            <CheckIcon
              aria-label="Verified creator"
              className="size-4 shrink-0"
              strokeWidth={3}
            />
          ) : null}
        </p>
        <p className="w-full truncate text-metadata text-ink-dim">@{creator.handle}</p>
        {typeof creator.followerCount === 'number' ? (
          <p className="mt-1 w-full truncate text-metadata text-ink-dim">
            {formatCompactCount(creator.followerCount)} followers
          </p>
        ) : null}
        <Button asChild variant="outline" className="mt-4 w-full">
          <Link href={creator.profileUrl} target="_blank" rel="noreferrer">
            View on TikTok ↗
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
