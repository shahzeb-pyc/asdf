'use client';

/**
 * WorkspaceBreadcrumb — rebuilt on token-backed utilities only
 * (spec 130 §5.2, PR-130-2a). The `computeBreadcrumbs` mapping is
 * preserved byte-for-byte in behaviour (spec §4.1): tenant root →
 * Home; simple top levels; Facebook › Accounts; Facebook › Pages
 * (› Details, with the Pages crumb a link); platform labels +
 * Accounts; unknown segments fall back to a title-cased label. The
 * last crumb carries `aria-current="page"`.
 */

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { buildTenantHref } from '@/lib/tenant-href';

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

const SIMPLE_TOP_LEVEL_LABELS: Record<string, string> = {
  media: 'Media Library',
  'fdola-studio': 'Fdola Studio',
  settings: 'Settings',
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  threads: 'Threads',
  twitter: 'X (Twitter)',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

export function computeBreadcrumbs(
  pathname: string,
  subdomain: string,
  useCleanPaths: boolean = false
): BreadcrumbSegment[] {
  if (!pathname) return [{ label: 'Home' }];
  const prefix = `/tenant/${subdomain}`;
  if (pathname === prefix || pathname === `${prefix}/`) {
    return [{ label: 'Home' }];
  }

  const subPath = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
  const segments = subPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [{ label: 'Home' }];
  }

  const first = segments[0]?.toLowerCase();
  if (first && SIMPLE_TOP_LEVEL_LABELS[first]) {
    return [{ label: SIMPLE_TOP_LEVEL_LABELS[first] }];
  }
  if (first === 'accounts') {
    return [{ label: 'Facebook' }, { label: 'Accounts' }];
  }
  if (first === 'pages') {
    if (segments.length > 1) {
      return [
        { label: 'Facebook' },
        { label: 'Pages', href: buildTenantHref(subdomain, '/pages', useCleanPaths) },
        { label: 'Details' },
      ];
    }
    return [{ label: 'Facebook' }, { label: 'Pages' }];
  }

  if (first && PLATFORM_LABELS[first]) {
    const platformLabel = PLATFORM_LABELS[first];
    if (segments[1]?.toLowerCase() === 'accounts') {
      return [{ label: platformLabel }, { label: 'Accounts' }];
    }
    if (first === 'instagram' && segments[1]?.toLowerCase() === 'schedule') {
      if (segments.length > 2) {
        return [
          { label: platformLabel },
          { label: 'Schedule', href: buildTenantHref(subdomain, '/instagram/schedule', useCleanPaths) },
          { label: 'Details' },
        ];
      }
      return [{ label: platformLabel }, { label: 'Schedule' }];
    }
    if (first === 'threads' && segments[1]?.toLowerCase() === 'schedule') {
      if (segments.length > 2) {
        return [
          { label: platformLabel },
          {
            label: 'In-app Schedule',
            href: buildTenantHref(subdomain, '/threads/schedule', useCleanPaths),
          },
          { label: 'Details' },
        ];
      }
      return [{ label: platformLabel }, { label: 'In-app Schedule' }];
    }
    return [{ label: platformLabel }];
  }

  return segments.map((seg) => ({
    label: seg.charAt(0).toUpperCase() + seg.slice(1).replaceAll('-', ' '),
  }));
}

export interface WorkspaceBreadcrumbProps {
  subdomain: string;
  /** True when on the tenant's own subdomain: use clean paths (/accounts). */
  useCleanPaths?: boolean | undefined;
}

export function WorkspaceBreadcrumb({
  subdomain,
  useCleanPaths = false,
}: Readonly<WorkspaceBreadcrumbProps>) {
  const pathname = usePathname() || '';
  const crumbs = computeBreadcrumbs(pathname, subdomain, useCleanPaths);

  return (
    <nav
      aria-label="Breadcrumbs"
      data-slot="workspace-breadcrumb"
      data-testid="workspace-breadcrumb"
      className="flex items-center gap-1 overflow-hidden text-body leading-none whitespace-nowrap text-ellipsis text-ink-sub"
    >
      {crumbs.map((crumb, idx) => {
        const isLast = idx === crumbs.length - 1;
        return (
          <React.Fragment key={`${crumb.label}-${idx}`}>
            {idx > 0 && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="shrink-0 text-ink-dim opacity-60"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            )}
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                className="text-ink-sub no-underline transition-colors duration-base ease-standard hover:text-ink"
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                aria-current={isLast ? 'page' : undefined}
                className={cn(isLast ? 'font-medium text-ink' : 'text-ink-sub')}
              >
                {crumb.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
