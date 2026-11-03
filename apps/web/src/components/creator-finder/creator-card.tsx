'use client';

import * as React from 'react';
import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { CheckIcon } from 'lucide-react';
import type { Creator } from '@fbuploadpro/contracts';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent } from '@/components/shared/ui/card';
import { Tag } from '@/components/shared/ui/tag';

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
 * Engagement rates arrive from Countik as a percent (8.4) or a
 * fraction (0.084); a value in (0, 1] renders as its percent so
 * both shapes read the same. Zero renders as 0%.
 */
function formatRate(value: number): string {
  const percent = value > 0 && value <= 1 ? value * 100 : value;
  const text =
    percent >= 100
      ? String(Math.round(percent))
      : percent.toFixed(1).replace(/\.0$/, '');
  return `${text}%`;
}

/**
 * Enriched creator card v2 — the same card on every tab
 * (Trending, Niche, Similar, Saved), in v2 field order: photo,
 * name with verified tick, handle, follower line, bio, stat grid
 * (Following / Hearts / Videos), Engagement group, Averages
 * group, hashtags & mentions chips, full-width View on TikTok.
 * No earnings field, no video list, no detail view, no new
 * actions: the card shows only what its data actually carries,
 * and a group with no values renders nothing, never a dash.
 *
 * Verified tick source: when Countik enrichment is present, the
 * tick comes ONLY from enrichment.verified (analyze
 * author.verified) — never from the exist response and never
 * from TikWM. Without enrichment, the TikWM verified value is
 * kept (Similar fallback and old saved rows). The tick is a
 * tick in a green circle, never a dot.
 *
 * Without enrichment and without any TikWM follower/verified
 * value, the card is the no-data variant: header and View on
 * TikTok only, plus the visible "Countik data unavailable"
 * note, no detail section, no tick. That covers both a fresh
 * Countik failure on trending/niche and an old saved row that
 * never had data.
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
  const enrichment = creator.enrichment ?? null;
  const verified =
    enrichment !== null
      ? enrichment.verified === true
      : creator.verified === true;
  const followerCount =
    enrichment?.followerCount ?? creator.followerCount;
  const hasFallbackIdentity =
    typeof followerCount === 'number' || verified;
  const showNoDataNote = enrichment === null && !hasFallbackIdentity;
  const statEntries: Array<{ label: string; value: string }> = [];
  if (enrichment) {
    if (enrichment.followingCount !== undefined) {
      statEntries.push({
        label: 'Following',
        value: formatCompactCount(enrichment.followingCount),
      });
    }
    if (enrichment.heartsCount !== undefined) {
      statEntries.push({
        label: 'Hearts',
        value: formatCompactCount(enrichment.heartsCount),
      });
    }
    if (enrichment.videoCount !== undefined) {
      statEntries.push({
        label: 'Videos',
        value: formatCompactCount(enrichment.videoCount),
      });
    }
  }
  const engagementEntries: Array<{ label: string; value: string }> = [];
  if (enrichment) {
    if (enrichment.engagementTotal !== undefined) {
      engagementEntries.push({
        label: 'Total rate',
        value: formatRate(enrichment.engagementTotal),
      });
    }
    if (enrichment.engagementLikes !== undefined) {
      engagementEntries.push({
        label: 'Likes',
        value: formatRate(enrichment.engagementLikes),
      });
    }
    if (enrichment.engagementComments !== undefined) {
      engagementEntries.push({
        label: 'Comments',
        value: formatRate(enrichment.engagementComments),
      });
    }
    if (enrichment.engagementShares !== undefined) {
      engagementEntries.push({
        label: 'Shares',
        value: formatRate(enrichment.engagementShares),
      });
    }
  }
  const averageEntries: Array<{ label: string; value: string }> = [];
  if (enrichment) {
    if (enrichment.averageViews !== undefined) {
      averageEntries.push({
        label: 'Average views',
        value: formatCompactCount(enrichment.averageViews),
      });
    }
    if (enrichment.averageLikes !== undefined) {
      averageEntries.push({
        label: 'Likes',
        value: formatCompactCount(enrichment.averageLikes),
      });
    }
    if (enrichment.averageComments !== undefined) {
      averageEntries.push({
        label: 'Comments',
        value: formatCompactCount(enrichment.averageComments),
      });
    }
    if (enrichment.averageShares !== undefined) {
      averageEntries.push({
        label: 'Shares',
        value: formatCompactCount(enrichment.averageShares),
      });
    }
  }
  const hashtags = enrichment?.hashtags ?? [];
  const mentions = enrichment?.mentions ?? [];
  return (
    <Card className="py-6">
      <CardContent className="flex flex-col items-center text-center">
        {showPhoto ? (
          <Image
            src={creator.avatarUrl ?? ''}
            alt={`${displayName} profile photo`}
            width={64}
            height={64}
            loading="lazy"
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
          {verified ? (
            <span
              aria-label="Verified creator"
              className="flex size-4 shrink-0 items-center justify-center rounded-full bg-signal-operational text-neutral-white"
            >
              <CheckIcon aria-hidden className="size-3" strokeWidth={3} />
            </span>
          ) : null}
        </p>
        <p className="w-full truncate text-metadata text-ink-dim">@{creator.handle}</p>
        {typeof followerCount === 'number' ? (
          <p className="mt-1 w-full truncate text-metadata text-ink-dim">
            {formatCompactCount(followerCount)} followers
          </p>
        ) : null}
        {enrichment?.bio ? (
          <p className="mt-2 w-full text-body text-ink-sub">{enrichment.bio}</p>
        ) : null}
        {statEntries.length > 0 ? (
          <div className="mt-4 grid w-full grid-cols-3 gap-2">
            {statEntries.map((entry) => (
              <div key={entry.label} className="flex flex-col items-center gap-0.5">
                <span className="text-body font-semibold text-ink">{entry.value}</span>
                <span className="text-metadata text-ink-dim">{entry.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {engagementEntries.length > 0 || averageEntries.length > 0 ? (
          <div className="mt-4 grid w-full grid-cols-2 gap-3 text-left">
            {engagementEntries.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-metadata font-semibold text-ink">Engagement</p>
                {engagementEntries.map((entry) => (
                  <p key={entry.label} className="flex items-center justify-between gap-2 text-metadata text-ink-sub">
                    <span>{entry.label}</span>
                    <span className="font-semibold text-ink">{entry.value}</span>
                  </p>
                ))}
              </div>
            ) : null}
            {averageEntries.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-metadata font-semibold text-ink">Averages</p>
                {averageEntries.map((entry) => (
                  <p key={entry.label} className="flex items-center justify-between gap-2 text-metadata text-ink-sub">
                    <span>{entry.label}</span>
                    <span className="font-semibold text-ink">{entry.value}</span>
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {hashtags.length > 0 || mentions.length > 0 ? (
          <div className="mt-4 flex w-full flex-col gap-2 text-left">
            <p className="text-metadata font-semibold text-ink">Hashtags &amp; mentions</p>
            <div className="flex flex-wrap gap-1.5">
              {hashtags.map((tag) => (
                <Tag key={`#${tag}`} variant="secondary">#{tag}</Tag>
              ))}
              {mentions.map((tag) => (
                <Tag key={`@${tag}`} variant="secondary">@{tag}</Tag>
              ))}
            </div>
          </div>
        ) : null}
        <Button asChild variant="outline" className="mt-4 w-full">
          <Link href={creator.profileUrl} target="_blank" rel="noreferrer">
            View on TikTok ↗
          </Link>
        </Button>
        {showNoDataNote ? (
          <p className="mt-3 w-full text-center text-metadata text-ink-dim">
            Countik data unavailable for this creator.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
