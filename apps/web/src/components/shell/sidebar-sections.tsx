'use client';

/**
 * Sidebar section configs — the ONE source of section lists for the
 * shared sidebar engine (components/shell/app-sidebar.tsx). Three
 * configs, no components, no fetching, no role branches:
 *
 * - getUserSections(subdomain, useCleanPaths): exactly the user
 *   sidebar list — primary section, Platform section (Facebook group
 *   + one group per UPCOMING_PLATFORMS entry, which stays the user
 *   platform data source), Billing section last with ?view= leaves.
 *   User hrefs resolve through buildTenantHref exactly as before
 *   (clean paths on the tenant's own host, /tenant/<sub> paths
 *   elsewhere), so the config is built per workspace.
 * - SELLER_SECTIONS: one leaf, Dashboard → /seller.
 * - ADMIN_SECTIONS: two leaves, Subscriptions approval →
 *   /admin/subscriptions and Sellers → /admin/sellers. Coupons and
 *   webhook issues are NOT leaves: they stay as sections inside the
 *   approvals view, preserving current IA.
 *
 * Separation matrix (owner hard rule): the three configs' href sets
 * are pairwise disjoint, and no config contains a href belonging to
 * another role's section. Admin/seller links are absolute and never
 * use buildTenantHref.
 */

import React from 'react';
import { buildTenantHref } from '@/lib/tenant-href';
import { UPCOMING_PLATFORMS, TESTING_PLACEHOLDER_TEXT } from '@/components/workspace/platform-nav-config';

export type SidebarLeafMatch = 'exact' | 'prefix' | 'view';

export interface SidebarLeaf {
  kind: 'leaf';
  label: string;
  href: string;
  icon?: React.ReactNode | undefined;
  match: SidebarLeafMatch;
  /** For match 'view': the ?view= value this leaf highlights for. */
  view?: string | undefined;
}

export interface SidebarCollapsibleGroup {
  kind: 'group';
  key: string;
  label: string;
  tooltip?: string | undefined;
  icon?: React.ReactNode | undefined;
  /** Initial open state; when absent, the group opens iff active. */
  defaultOpen?: boolean | undefined;
  /** Collapsed-mode navigation target for the parent toggle. */
  parentHref?: string | undefined;
  /** Extra prefix that marks the group active (platform route slugs). */
  activePrefix?: string | undefined;
  /** Prefix that view-match leaves compare against (Billing route). */
  matchPath?: string | undefined;
  leaves: Omit<SidebarLeaf, 'kind'>[];
  /** Testing platforms render only this note, no leaves. */
  testingNote?: string | undefined;
}

export type SidebarItem = SidebarLeaf | SidebarCollapsibleGroup;

export interface SidebarSection {
  key: string;
  /** Rendered as the section's group label (Platform only). */
  label?: string | undefined;
  items: SidebarItem[];
}

export type SidebarSections = SidebarSection[];

function svgIcon(paths: React.ReactNode): React.ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {paths}
    </svg>
  );
}

const HOME_ICON = svgIcon(
  <>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </>
);

const MEDIA_ICON = svgIcon(
  <>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <polygon points="10 11 16 14 10 17 10 11" />
  </>
);

const FDOLA_ICON = svgIcon(
  <>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </>
);

const PROMPTS_ICON = svgIcon(
  <>
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M12 2a7 7 0 0 0-4 12c.7.6 1 1.4 1 2h6c0-.6.3-1.4 1-2a7 7 0 0 0-4-12z" />
  </>
);

const CREATOR_FINDER_ICON = svgIcon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
    <path d="M11 8.5a2.5 2.5 0 0 1 2.5 2.5" />
  </>
);

const FACEBOOK_ICON = svgIcon(
  <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
);

const BILLING_ICON = svgIcon(
  <>
    <rect width="20" height="14" x="2" y="5" rx="2" />
    <line x1="2" x2="22" y1="10" y2="10" />
  </>
);

const APPROVALS_ICON = svgIcon(<path d="M20 6 9 17l-5-5" />);

const SELLERS_ICON = svgIcon(
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>
);

const DASHBOARD_ICON = svgIcon(
  <>
    <rect width="7" height="9" x="3" y="3" rx="1" />
    <rect width="7" height="5" x="14" y="3" rx="1" />
    <rect width="7" height="9" x="14" y="12" rx="1" />
    <rect width="7" height="5" x="3" y="16" rx="1" />
  </>
);

/**
 * User sections for one workspace. Hrefs resolve through
 * buildTenantHref exactly as the old workspace sidebar did (clean
 * paths on the tenant's own host, /tenant/<sub> paths elsewhere).
 */
export function getUserSections(subdomain: string, useCleanPaths = false): SidebarSections {
  const href = (path: string) => buildTenantHref(subdomain, path, useCleanPaths);

  const platformGroups: SidebarCollapsibleGroup[] = UPCOMING_PLATFORMS.map((platform) => {
    const platformAccountsHref = href(`/${platform.routeSlug}/accounts`);
    if (platform.isTesting) {
      return {
        kind: 'group',
        key: platform.key,
        label: platform.label,
        tooltip: platform.tooltip,
        icon: platform.icon,
        parentHref: undefined,
        activePrefix: `/${platform.routeSlug}`,
        leaves: [],
        testingNote: TESTING_PLACEHOLDER_TEXT,
      };
    }
    const leaves: Omit<SidebarLeaf, 'kind'>[] = [
      { label: 'Accounts', href: platformAccountsHref, match: 'prefix' },
    ];
    if (platform.key === 'threads') {
      leaves.push(
        { label: 'In-app Schedule', href: href('/threads/schedule'), match: 'prefix' },
        { label: 'Publish Now', href: href('/threads/publish-now'), match: 'prefix' },
        { label: 'Auto Repost', href: href('/threads/auto-repost'), match: 'prefix' },
        { label: 'Auto Download/Upload', href: href('/threads/auto-download-upload'), match: 'prefix' }
      );
    }
    if (platform.key === 'instagram') {
      leaves.push(
        { label: 'Schedule', href: href('/instagram/schedule'), match: 'prefix' },
        { label: 'Publish Now', href: href('/instagram/publish-now'), match: 'prefix' },
        { label: 'Auto Repost', href: href('/instagram/auto-repost'), match: 'prefix' },
        { label: 'Auto Download/Upload', href: href('/instagram/auto-download-upload'), match: 'prefix' }
      );
    }
    return {
      kind: 'group',
      key: platform.key,
      label: platform.label,
      tooltip: platform.tooltip,
      icon: platform.icon,
      parentHref: platformAccountsHref,
      activePrefix: `/${platform.routeSlug}`,
      leaves,
    };
  });

  return [
    {
      key: 'primary',
      items: [
        { kind: 'leaf', label: 'Home', href: href('/'), icon: HOME_ICON, match: 'exact' },
        { kind: 'leaf', label: 'Media Library', href: href('/media'), icon: MEDIA_ICON, match: 'prefix' },
        { kind: 'leaf', label: 'Fdola Studio', href: href('/fdola-studio'), icon: FDOLA_ICON, match: 'prefix' },
        { kind: 'leaf', label: 'Prompt Library', href: href('/prompts'), icon: PROMPTS_ICON, match: 'prefix' },
        { kind: 'leaf', label: 'Creator Finder', href: href('/creator-finder'), icon: CREATOR_FINDER_ICON, match: 'prefix' },
      ],
    },
    {
      key: 'platform',
      label: 'Platform',
      items: [
        {
          kind: 'group',
          key: 'facebook',
          label: 'Facebook',
          tooltip: 'Facebook — Accounts, Pages, Publish Now, Auto Repost & Auto Download/Upload',
          icon: FACEBOOK_ICON,
          defaultOpen: true,
          parentHref: href('/accounts'),
          leaves: [
            { label: 'Accounts', href: href('/accounts'), match: 'prefix' },
            { label: 'Pages', href: href('/pages'), match: 'prefix' },
            { label: 'Publish Now', href: href('/publish-now'), match: 'prefix' },
            { label: 'Auto Repost', href: href('/tiktok-mirrors'), match: 'prefix' },
            { label: 'Auto Download/Upload', href: href('/auto-download-upload'), match: 'prefix' },
          ],
        },
        ...platformGroups,
      ],
    },
    {
      key: 'billing',
      items: [
        {
          kind: 'group',
          key: 'billing',
          label: 'Billing',
          tooltip: 'Billing — My Plan, Purchase & Payments',
          icon: BILLING_ICON,
          defaultOpen: true,
          parentHref: href('/billing?view=my-plan'),
          matchPath: href('/billing'),
          leaves: [
            { label: 'My Plan', href: href('/billing?view=my-plan'), match: 'view', view: 'my-plan' },
            { label: 'Purchase', href: href('/billing?view=purchase'), match: 'view', view: 'purchase' },
            { label: 'Payments', href: href('/billing?view=payments'), match: 'view', view: 'payments' },
          ],
        },
      ],
    },
  ];
}

export const SELLER_SECTIONS: SidebarSections = [
  {
    key: 'seller',
    items: [{ kind: 'leaf', label: 'Dashboard', href: '/seller', icon: DASHBOARD_ICON, match: 'exact' }],
  },
];

export const ADMIN_SECTIONS: SidebarSections = [
  {
    key: 'admin',
    items: [
      {
        kind: 'leaf',
        label: 'Subscriptions approval',
        href: '/admin/subscriptions',
        icon: APPROVALS_ICON,
        match: 'prefix',
      },
      { kind: 'leaf', label: 'Sellers', href: '/admin/sellers', icon: SELLERS_ICON, match: 'prefix' },
    ],
  },
];
