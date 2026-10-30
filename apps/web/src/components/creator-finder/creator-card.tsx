'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Creator } from '@fbuploadpro/contracts';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent } from '@/components/shared/ui/card';

/**
 * One creator, found — never invented. The card shows only user
 * details the feed returns: profile photo, display name, handle,
 * and the profile link. No video title, no follower count, no bio.
 * The photo is a plain <img> (not next/image, so TikTok's image
 * host needs no allowlist entry) and falls back to initials when
 * there is no avatar URL or the photo fails to load.
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
        <p className="mt-3 w-full truncate text-body font-semibold text-ink">
          {displayName}
        </p>
        <p className="w-full truncate text-metadata text-ink-dim">@{creator.handle}</p>
        <Button asChild variant="outline" className="mt-4 w-full">
          <Link href={creator.profileUrl} target="_blank" rel="noreferrer">
            View on TikTok ↗
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
