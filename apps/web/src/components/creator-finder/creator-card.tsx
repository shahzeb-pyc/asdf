'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Creator } from '@fbuploadpro/contracts';
import { Card, CardContent } from '@/components/shared/ui/card';

/**
 * One creator, found — never invented. Fields the API did not
 * return are omitted: no follower count, no bio. The profile photo
 * is rendered with a plain <img> (not next/image, so TikTok's image
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
  return (
    <Card className="py-4">
      <CardContent className="flex items-start gap-3">
        {showPhoto ? (
          <img
            src={creator.avatarUrl ?? ''}
            alt={`${creator.displayName ?? `@${creator.handle}`} profile photo`}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="size-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-panel text-body font-semibold text-ink"
          >
            {initials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-semibold text-ink">
            {creator.displayName ?? `@${creator.handle}`}
          </p>
          <p className="truncate text-metadata text-ink-dim">@{creator.handle}</p>
          {creator.latestVideoTitle ? (
            <p className="mt-2 line-clamp-2 text-body text-ink-sub">
              {creator.latestVideoTitle}
            </p>
          ) : null}
          <Link
            href={creator.profileUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-body font-medium text-link hover:underline"
          >
            View on TikTok
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
