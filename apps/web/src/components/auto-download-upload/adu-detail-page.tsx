'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { PlayIcon, XIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent } from '@/components/shared/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Input } from '@/components/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { Switch } from '@/components/shared/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { Textarea } from '@/components/shared/ui/textarea';
import { PageTabInsights } from '@/components/pages/dedicated';
import { buildTenantApiPath } from '@/lib/api/client';
import { buildTenantHref, isTenantSubdomainHost } from '@/lib/tenant-href';
import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import { formatFollowersUpdatedAt } from '@/lib/format-followers-updated-at';

interface ConfigView {
  id: string;
  destinationId: string;
  destinationName: string;
  destinationExternalId: string;
  destinationAvatarUrl: string | null;
  accountName: string | null;
  accountAvatarUrl: string | null;
  sourcePlatform: string;
  sourceUsername: string;
  sourceLink: string;
  sourceIdentity: string;
  timezone: string;
  postsPerDay: number;
  scheduleType: string;
  postingTimes: string[];
  status: string;
  syncStatus: string;
  displayStatus: string;
  alert: string | null;
  followersCount: number;
  followersGained: number;
  /** Spec 162: last successful follower check (daily worker or ADU
   *  creation); null when no check has ever stamped it. */
  followersUpdatedAt: string | null;
  createdAt: string;
  postedCount: number;
  pendingCount: number;
  failedCount: number;
  postedToday: number;
  pendingToday: number;
  failedToday: number;
}
interface Reel {
  id: string; source_reel_id: string; caption: string | null; media_url: string | null;
  status: string; downloaded_at: string | null;
}
interface FailedJob {
  id: string; reel_id: string; status: string; last_error_code: string | null;
  last_error_message: string | null; created_at: string;
  adu_reels?: { source_reel_id: string; caption: string | null } | null;
}

const QUICK_TAGS = ['#reels', '#viral', '#trending', '#foryou', '#shorts'];

/** Reels page size (owner decision) — must match the reels route. */
const REELS_PAGE_SIZE = 24;

/**
 * Added date, "2 Nov 2026" — the same rule as the hub cards'
 * `formatAduAddedDate`. Returns '' for an unparseable date so the
 * header simply omits the line instead of rendering garbage.
 */
function formatAduDetailAddedDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * Video duration as m:ss ("0:12") for the card preview badge, read from
 * the video element's own metadata. Null when the duration is unknown
 * or not positive — no badge renders then, never a faked "0:00".
 */
function formatReelDuration(totalSeconds: number | null | undefined): string | null {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return null;
  }
  const totalSec = Math.round(totalSeconds);
  return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, '0')}`;
}

type AduStatusMarkKind = 'operational' | 'queued' | 'critical';

/**
 * Maps an ADU display status to a shared `StatusMark` kind — the same
 * mapping the hub cards use (`getAduStatusMarkKind` there): operational
 * = healthy, queued = waiting, critical = needs attention. Unknown
 * labels map to critical — an unexpected value must never read as
 * healthy.
 */
function getAduDetailStatusMarkKind(displayStatus: string): AduStatusMarkKind {
  if (displayStatus === 'Active posting' || displayStatus === 'All reels posted') {
    return 'operational';
  }
  if (
    displayStatus === 'Scrape pending' ||
    displayStatus === 'Scraping reels' ||
    displayStatus === 'Paused'
  ) {
    return 'queued';
  }
  return 'critical';
}

const ADU_DETAIL_RING_CLASSES: Record<AduStatusMarkKind, string> = {
  operational: 'border-2 border-signal-operational',
  queued: 'border-2 border-signal-queued',
  critical: 'border-2 border-signal-critical',
};

interface AduDetailStatusAlert {
  title: string;
  description: string;
  variant: 'warning' | 'critical';
}

/**
 * Per-status alert banner, adapted from the old app's
 * `lib/adu-page-detail-status.ts` (`getAduPageStatusAlert`). Sync state
 * is checked first, exactly as the old mapping did: a pending or
 * processing scrape shows its banner even while the page status itself
 * is active. Nothing renders when active-and-synced or unknown.
 * This banner replaces the previous `config.alert` banner — keeping
 * both would render two near-identical banners for every non-active
 * status.
 */
function getAduDetailStatusAlert(status: string, syncStatus: string): AduDetailStatusAlert | null {
  if (syncStatus === 'error') {
    return {
      title: 'Username Not Found',
      description: 'Unable to find the username. Please check if the username exists.',
      variant: 'critical',
    };
  }
  if (syncStatus === 'processing') {
    return {
      title: 'Scraping in Progress',
      description: 'Your reels are being scraped.',
      variant: 'warning',
    };
  }
  if (syncStatus === 'pending' || syncStatus === 'browser_pending') {
    return {
      title: 'Scraping Pending',
      description: 'Your reels will be scraped soon. Please wait.',
      variant: 'warning',
    };
  }
  switch (status) {
    case 'active':
      return null;
    case 'paused':
      return {
        title: 'Posting Paused',
        description: 'Posting is paused. Turn automation on to resume.',
        variant: 'warning',
      };
    case 'fb_verification_required':
      return {
        title: 'Facebook Verification Required',
        description:
          'Complete identity or phone verification in the Meta app on your mobile device. This is not a token error — do not reconnect. After verification, turn automation on using the toggle.',
        variant: 'critical',
      };
    case 'fb_rate_limited':
      return {
        title: 'Facebook Rate Limited',
        description:
          'Meta is limiting how often this page can post. Automation pauses for about 3 days and will resume automatically when the cooldown ends.',
        variant: 'critical',
      };
    case 'page_not_accessible':
      return {
        title: 'Facebook Page Not Accessible',
        description:
          'This page may have been removed, or your account may no longer have access to it. Confirm the page still exists and reconnect your Facebook account if needed, then turn automation back on.',
        variant: 'critical',
      };
    case 'missing_page_access':
      return {
        title: 'Missing Page Access',
        description:
          'Your account no longer has a role on this page, so posting is paused. Ask an admin to restore your role in Business Manager, then turn automation back on.',
        variant: 'critical',
      };
    case 'missing_permission':
      return {
        title: 'Missing Permission',
        description:
          'A permission this page needs is missing, so posting is paused. Ask an admin to grant the permission, then turn automation back on.',
        variant: 'critical',
      };
    case 'invalid_token':
      return {
        title: 'Access Token Expired',
        description:
          'Reconnect your Facebook account in Facebook Accounts. Your page access token has expired or been revoked.',
        variant: 'critical',
      };
    case '2fa_required_on_BM':
      return {
        title: 'Business 2FA Required',
        description:
          'The connected Facebook account must have an admin, editor, or moderator role on this page, and Business Manager two-factor authentication must be complete. Once that is done, turn automation back on.',
        variant: 'critical',
      };
    case 'check_developer_app':
      return {
        title: 'Developer App Access Blocked',
        description:
          'Access is blocked for this page. Fix the problem in your developer app, then turn automation back on. Posting stays paused until then.',
        variant: 'critical',
      };
    case 'account_suspended':
      return {
        title: 'Facebook Account Suspended',
        description:
          'The connected Facebook account is suspended. Once Facebook clears the restriction, turn automation back on.',
        variant: 'critical',
      };
    case 'creator_suspended':
      return {
        title: 'Source Creator Unavailable',
        description:
          'This source is unavailable after more than 50 failed downloads. Turn automation on to check whether the creator is available again.',
        variant: 'critical',
      };
    case 'invalid_username':
      return {
        title: 'Source Account Disabled',
        description:
          'Your selected source account may be disabled or inaccessible. Verify the source account is active, then update source details in Settings > Source if needed.',
        variant: 'critical',
      };
    case 'completed':
      return {
        title: 'All Reels Posted',
        description:
          'All reels posted. You can update Settings > Source to a different source account to continue posting.',
        variant: 'warning',
      };
    default:
      return null;
  }
}

const ADU_DETAIL_TAB_IDS = ['overview', 'insights', 'reels', 'failed', 'settings'] as const;
type AduDetailTab = (typeof ADU_DETAIL_TAB_IDS)[number];

/**
 * Tab state lives in the URL (`?tab=`), Pages-detail pattern: a valid
 * value wins, anything else (including a missing value) falls back to
 * overview — never a 404.
 */
export function resolveAduDetailTab(value: string | null): AduDetailTab {
  return (ADU_DETAIL_TAB_IDS as readonly string[]).includes(value ?? '')
    ? (value as AduDetailTab)
    : 'overview';
}

const ADU_DETAIL_TAB_ITEMS: ReadonlyArray<{ id: AduDetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'insights', label: 'Insights' },
  { id: 'reels', label: 'Reels' },
  { id: 'failed', label: 'Failed Posts Reasons' },
  { id: 'settings', label: 'Settings' },
];

/** Skeleton mirroring the rebuilt layout (header + tab bar + stat cards). */
function AduDetailSkeleton() {
  return (
    <div
      data-testid="adu-detail-loading"
      aria-busy="true"
      className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6"
    >
      <div className="flex items-start gap-4">
        <Skeleton className="size-14 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-32" />
        <Skeleton className="h-11 w-24" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    </div>
  );
}

function AduDetailPageInner({ subdomain, configId }: { subdomain: string; configId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = React.useState<AduDetailTab>(() => resolveAduDetailTab(urlTab));
  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<AduDetailTab>>(
    () => new Set([resolveAduDetailTab(urlTab)])
  );
  const activeTabRef = React.useRef<AduDetailTab>(activeTab);

  const [config, setConfig] = React.useState<ConfigView | null>(null);
  const [reels, setReels] = React.useState<Reel[]>([]);
  const [failed, setFailed] = React.useState<FailedJob[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  // F15: paginated reels state — the page holds one page of rows at a
  // time, never the whole queue.
  const [reelsPage, setReelsPage] = React.useState(1);
  const [reelsTotal, setReelsTotal] = React.useState(0);
  const [reelsTotalPages, setReelsTotalPages] = React.useState(1);
  const [reelsLoading, setReelsLoading] = React.useState(false);
  const [reelsError, setReelsError] = React.useState<string | null>(null);
  const [failedLoading, setFailedLoading] = React.useState(false);
  const [failedError, setFailedError] = React.useState<string | null>(null);
  // F13: pages already fetched for the current queue (revisits never
  // refetch) and whether failed jobs were ever loaded. Cleared only
  // when the queue itself changes (source switch), never on a tab
  // switch.
  const reelsLoadedPagesRef = React.useRef(new Set<number>());
  const failedLoadedRef = React.useRef(false);
  // Spec 179: one card expanded at a time, in place — the expanded
  // card is the editor; there is no side panel anymore. `durations`
  // holds each preview's length once its metadata loads (badge only).
  const [expandedReelId, setExpandedReelId] = React.useState<string | null>(null);
  const [durations, setDurations] = React.useState<Record<string, number>>({});
  const [captionDraft, setCaptionDraft] = React.useState('');
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteReelId, setDeleteReelId] = React.useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = React.useState(false);
  const [newPlatform, setNewPlatform] = React.useState('instagram');
  const [newUsername, setNewUsername] = React.useState('');
  const [editAutomation, setEditAutomation] = React.useState(false);
  const [editPosts, setEditPosts] = React.useState(1);
  const [editTimezone, setEditTimezone] = React.useState('Asia/Karachi');
  const [editLogic, setEditLogic] = React.useState<'dailyrandom' | 'fixed'>('dailyrandom');
  const [editTimes, setEditTimes] = React.useState<string[]>([]);
  const [editIdentity, setEditIdentity] = React.useState(false);
  const [displayName, setDisplayName] = React.useState('');
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);
  const [failedAccountAvatarUrl, setFailedAccountAvatarUrl] = React.useState<string | null>(null);

  // Return links carry the hub query state (pagination step 3): the
  // hub card carries `?q=&status=&sort=&page=` through to this page's
  // URL, and the breadcrumb / "Back to Hub" links re-attach it, so
  // opening a page from hub page 2 returns to hub page 2 — not page 1.
  // Only the four hub keys are carried (`tab` and anything else are
  // dropped); the hub re-validates them on mount, so no validation is
  // needed here. Tab switches already preserve the full query string.
  // This hook sits above the loading early-returns below: hooks must
  // run unconditionally on every render.
  const hubQuery = React.useMemo(() => {
    const params = new URLSearchParams();
    for (const key of ['q', 'status', 'sort', 'page'] as const) {
      const value = searchParams.get(key);
      if (value !== null && value !== '') params.set(key, value);
    }
    return params.toString();
  }, [searchParams]);

  const base = buildTenantApiPath(subdomain, `/auto-download-upload/${configId}`);

  const applyConfig = React.useCallback((next: ConfigView) => {
    setConfig(next);
    setEditPosts(next.postsPerDay);
    setEditTimezone(next.timezone);
    // The server only ever sends 'fixed' | 'dailyrandom'; anything
    // else falls back to the default, exactly as the edit form does.
    setEditLogic(next.scheduleType === 'fixed' ? 'fixed' : 'dailyrandom');
    setEditTimes(next.postingTimes ?? []);
    setDisplayName(next.destinationName);
  }, []);

  // F13/F17: the config is fetched on its own — the skeleton gates on
  // it alone. A config failure sets the page error but never touches
  // reels/failed state, and a reels/failed failure never touches the
  // config: paid-for data is not discarded on an error path.
  const loadConfig = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const configRes = await fetch(base);
      const configBody = await configRes.json().catch(() => ({}));
      if (!configRes.ok) throw new Error(configBody.error ?? 'Page not found.');
      applyConfig(configBody.config);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load page.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [base, applyConfig]);

  // F13/F15: one page of the queue, fetched on first visit to the
  // Reels tab (or a page turn). keepPreviousData: only a successful
  // response replaces the rows — a failed page turn leaves the
  // previous page on screen.
  const loadReels = React.useCallback(async (page: number, force = false) => {
    if (!force && reelsLoadedPagesRef.current.has(page)) return;
    setReelsLoading(true);
    setReelsError(null);
    try {
      const res = await fetch(`${base}/reels?page=${page}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not load reels.');
      setReels(body.reels ?? []);
      setReelsPage(body.page ?? page);
      setReelsTotal(typeof body.total === 'number' ? body.total : 0);
      setReelsTotalPages(typeof body.totalPages === 'number' ? body.totalPages : 1);
      reelsLoadedPagesRef.current.add(page);
    } catch (err) {
      setReelsError(err instanceof Error ? err.message : 'Could not load reels.');
    } finally {
      setReelsLoading(false);
    }
  }, [base]);

  // F13: failed jobs fetch once, on first visit to the Failed tab.
  const loadFailed = React.useCallback(async () => {
    if (failedLoadedRef.current) return;
    setFailedLoading(true);
    setFailedError(null);
    try {
      const res = await fetch(`${base}/failed`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not load failed posts.');
      setFailed(body.jobs ?? []);
      failedLoadedRef.current = true;
    } catch (err) {
      setFailedError(err instanceof Error ? err.message : 'Could not load failed posts.');
    } finally {
      setFailedLoading(false);
    }
  }, [base]);

  // Spec 179 / F19: the draft is prefilled from the reel when its
  // card expands — never empty for a captioned reel, so Save can
  // never wipe a real caption. Collapsing clears it; expanding
  // always re-prefills from the reel, so no stale draft can leak
  // into another reel's save.
  const expandReel = React.useCallback((reel: Reel) => {
    setExpandedReelId(reel.id);
    setCaptionDraft(reel.caption ?? '');
  }, []);
  const collapseExpanded = React.useCallback(() => {
    setExpandedReelId(null);
    setCaptionDraft('');
  }, []);

  React.useEffect(() => { void loadConfig(); }, [loadConfig]);

  // F13: reels/failed fetch on first visit to their tab only — never
  // on an Overview/Settings landing. The initial tab is already in
  // visitedTabs, so a ?tab=reels / ?tab=failed landing fetches too.
  React.useEffect(() => {
    if (activeTab === 'reels') void loadReels(reelsPage);
    else if (activeTab === 'failed') void loadFailed();
  }, [activeTab, reelsPage, loadReels, loadFailed]);

  // Back/forward navigation: when the URL's ?tab= changes without a
  // click (popstate), adopt it — including its visited mount — so the
  // back button returns to the previously viewed tab.
  React.useEffect(() => {
    const next = resolveAduDetailTab(urlTab);
    if (next === activeTabRef.current) return;
    activeTabRef.current = next;
    setActiveTab(next);
    setVisitedTabs((prev) => {
      if (prev.has(next)) return prev;
      const copy = new Set(prev);
      copy.add(next);
      return copy;
    });
  }, [urlTab]);

  // An unknown ?tab= falls back to the current tab in state but used
  // to leave the bogus value in the URL — a copied link then
  // re-triggered the fallback on every open. Normalise with replace
  // (never push: a bogus value is not a history entry). Other query
  // params are preserved; a missing ?tab= is already clean and is
  // left alone.
  React.useEffect(() => {
    if (urlTab === null || (ADU_DETAIL_TAB_IDS as readonly string[]).includes(urlTab)) return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('tab', activeTabRef.current);
    router.replace(`/tenant/${subdomain}/auto-download-upload/${configId}?${nextParams.toString()}`, {
      scroll: false,
    });
  }, [urlTab, router, searchParams, subdomain, configId]);

  const handleTabChange = React.useCallback((tab: AduDetailTab) => {
    if (tab === activeTabRef.current) return;
    activeTabRef.current = tab;
    setActiveTab(tab);
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const copy = new Set(prev);
      copy.add(tab);
      return copy;
    });
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('tab', tab);
    router.push(`/tenant/${subdomain}/auto-download-upload/${configId}?${nextParams.toString()}`, {
      scroll: false,
    });
  }, [router, searchParams, subdomain, configId]);

  const patch = async (body: Record<string, unknown>, label: string) => {
    setError(null);
    const response = await fetch(base, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { setError(result.error ?? `Could not save ${label}.`); return false; }
    // F14: apply the fresh config the PATCH route already returned —
    // no full reload, no skeleton flash.
    if (result.config) applyConfig(result.config);
    setNotice(`${label} saved.`);
    // A source change deletes the old source's queue server-side, so
    // the cached reels are gone with it: drop the cache + selection
    // and refetch page 1 (the tab effect covers the active-tab case;
    // a visited-but-inactive tab needs the explicit fetch).
    if (body.sourcePlatform || body.sourceUsername) {
      reelsLoadedPagesRef.current.clear();
      setExpandedReelId(null);
      setCaptionDraft('');
      setReelsPage(1);
      if (activeTab === 'reels' && reelsPage === 1) await loadReels(1, true);
      else if (visitedTabs.has('reels') && activeTab !== 'reels') await loadReels(1, true);
    }
    return true;
  };

  // F14/F19: skip/delete update local state only — the row leaves the
  // list, the pending tile drops by one, and the next reel expands
  // with its own caption prefilled (spec 179: no stale expanded state
  // may point at a removed reel). No full reload. If the page empties,
  // step back a page (its rows are refetched: the loaded-set entry is
  // dropped first) and nothing expands — the new page loads fresh.
  const handleReelRemoved = (reelId: string) => {
    const wasLastOnPage = reels.length <= 1;
    const removedIndex = reels.findIndex((r) => r.id === reelId);
    // Expand the next reel in line — the one after the removed row,
    // or the one before it when the last row goes. (wasLastOnPage
    // means there is no next reel, so the index math below only runs
    // when at least two rows exist and the fallback index is >= 0.)
    const nextIndex = removedIndex + 1 < reels.length ? removedIndex + 1 : removedIndex - 1;
    const nextReel = wasLastOnPage ? null : reels[nextIndex];
    setReels((prev) => prev.filter((r) => r.id !== reelId));
    if (nextReel) {
      setExpandedReelId(nextReel.id);
      setCaptionDraft(nextReel.caption ?? '');
    } else {
      setExpandedReelId(null);
      setCaptionDraft('');
    }
    setConfig((prev) => (prev ? { ...prev, pendingCount: Math.max(0, prev.pendingCount - 1) } : prev));
    const nextTotal = Math.max(0, reelsTotal - 1);
    setReelsTotal(nextTotal);
    setReelsTotalPages(Math.max(1, Math.ceil(nextTotal / REELS_PAGE_SIZE)));
    if (wasLastOnPage && reelsPage > 1) {
      reelsLoadedPagesRef.current.delete(reelsPage - 1);
      setReelsPage(reelsPage - 1);
    }
  };

  // Spec 179: the expanded card's actions, all targeted (no reload).
  const saveReelCaption = async (reel: Reel) => {
    const response = await fetch(`${base}/reels/${reel.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caption: captionDraft }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? 'Could not save caption.'); } else { setNotice('Caption saved.'); setReels((prev) => prev.map((r) => (r.id === reel.id ? { ...r, caption: captionDraft } : r))); }
  };
  const skipReel = async (reel: Reel) => {
    const response = await fetch(`${base}/reels/${reel.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'skip' }) });
    if (response.ok) { setNotice('Reel skipped.'); handleReelRemoved(reel.id); }
  };
  const deleteReel = async (reelId: string) => {
    const response = await fetch(`${base}/reels/${reelId}`, { method: 'DELETE' });
    if (response.ok) { setNotice('Reel removed.'); handleReelRemoved(reelId); }
    setDeleteReelId(null);
  };

  if (loading) return <AduDetailSkeleton />;
  if (!config) return <div className="mx-auto w-full max-w-7xl px-6 py-6">{error ? <Banner variant="critical" title="Page not found" description={error} /> : null}</div>;

  const automationLocked =
    config.status === 'fb_rate_limited' ||
    config.status === 'invalid_token' ||
    config.status === 'completed' ||
    config.status === 'invalid_username';
  const statusKind = getAduDetailStatusMarkKind(config.displayStatus);
  const ringClass = ADU_DETAIL_RING_CLASSES[statusKind];
  const initials = getUserInitials(config.destinationName);
  const showAvatarImg =
    Boolean(config.destinationAvatarUrl) &&
    failedAvatarUrl !== config.destinationAvatarUrl;
  const addedDate = formatAduDetailAddedDate(config.createdAt);
  // Followers semantics, verified from code (same as the hub cards):
  // `followersGained` is the CURRENT count and `followersCount` the
  // starting baseline; net gained is current minus starting.
  const currentFollowers = config.followersGained;
  const netGained = currentFollowers - config.followersCount;
  const statusAlert = getAduDetailStatusAlert(config.status, config.syncStatus);
  const hubHref = `/tenant/${subdomain}/auto-download-upload${hubQuery ? `?${hubQuery}` : ''}`;

  const metaItems: React.ReactNode[] = [
    <StatusMark key="status" kind={statusKind} label={config.displayStatus} testId="adu-detail-status-mark" />,
  ];
  if (config.accountName) {
    metaItems.push(
      <span key="account" className="inline-flex items-center gap-1.5">
        <span
          data-testid="adu-detail-account-avatar"
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-subtle text-xs font-bold text-link"
        >
          {config.accountAvatarUrl &&
          failedAccountAvatarUrl !== config.accountAvatarUrl ? (
            <Image
              src={config.accountAvatarUrl}
              alt=""
              width={20}
              height={20}
              data-testid="adu-detail-account-avatar-img"
              onError={() =>
                setFailedAccountAvatarUrl(config.accountAvatarUrl ?? '__error__')
              }
              className="size-5 shrink-0 rounded-full object-cover"
            />
          ) : (
            getUserInitials(config.accountName)
          )}
        </span>
        <span>Connected via {config.accountName}</span>
      </span>
    );
  }
  if (addedDate) {
    metaItems.push(<span key="added">Added {addedDate}</span>);
  }
  metaItems.push(
    <span key="followers"><strong className="font-bold text-ink">{currentFollowers.toLocaleString('en-US')}</strong> followers</span>
  );
  {
    // Spec 162: when the stored total was last updated (daily worker
    // or ADU creation), in the posting timezone. Nothing renders
    // when no check has ever stamped it — never a faked time.
    const updated = formatFollowersUpdatedAt(config.followersUpdatedAt, config.timezone);
    if (updated) {
      metaItems.push(<span key="followers-updated" data-testid="adu-detail-followers-updated">Updated {updated}</span>);
    }
  }
  if (netGained !== 0) {
    metaItems.push(
      <span key="gained">{netGained > 0 ? '+' : ''}{netGained.toLocaleString('en-US')} gained</span>
    );
  }

  const totalTiles = [
    { label: 'Total Pending', sub: 'Reels ready for posting', value: config.pendingCount, valueClass: 'text-ink' },
    { label: 'Total Posted', sub: 'Successful automations', value: config.postedCount, valueClass: 'text-primary' },
    { label: 'Failed Posts', sub: 'Require attention', value: config.failedCount, valueClass: 'text-destructive' },
    { label: 'Followers Gained', sub: 'Net growth since page onboarding', value: netGained, valueClass: 'text-ink' },
  ];
  const todayTiles = [
    { label: 'Pending Today', sub: 'Remaining scheduled posts today', value: config.pendingToday, valueClass: 'text-ink' },
    { label: 'Posted Today', sub: 'Published since page local midnight', value: config.postedToday, valueClass: 'text-primary' },
    { label: 'Failed Today', sub: 'Errors since page local midnight', value: config.failedToday, valueClass: 'text-destructive' },
  ];
  const statCardClass = 'rounded-md border border-line bg-panel p-6 shadow-card';

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {showAvatarImg ? (
            <Image
              src={config.destinationAvatarUrl!}
              alt={config.destinationName}
              width={56}
              height={56}
              data-testid="adu-detail-avatar-img"
              onError={() =>
                setFailedAvatarUrl(config.destinationAvatarUrl ?? '__error__')
              }
              className={cn('size-14 shrink-0 rounded-full object-cover', ringClass)}
            />
          ) : (
            <div
              data-testid="adu-detail-avatar-initials"
              className={cn(
                'flex size-14 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink',
                ringClass
              )}
            >
              {initials}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-metadata text-ink-dim">
              <Link className="font-medium text-link" href={hubHref}>Auto Download/Upload</Link>
              {' / '}{config.destinationName}
            </p>
            <h1 className="mt-1 truncate text-xxl leading-heading font-bold text-ink">{config.destinationName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-body text-ink-sub">
              {metaItems.map((item, index) => (
                <React.Fragment key={index}>
                  {index > 0 ? <span aria-hidden className="h-3 w-px bg-line" /> : null}
                  {item}
                </React.Fragment>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-3">
              <a className="text-body font-medium text-link" href={`https://www.facebook.com/${config.destinationExternalId}`} target="_blank" rel="noreferrer">Facebook Page</a>
              <a className="text-body font-medium text-link" href={config.sourceLink} target="_blank" rel="noreferrer">Source: {config.sourceIdentity}</a>
              {config.accountName ? <span className="text-body text-ink-sub">Owner: {config.accountName}</span> : null}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-body">
            Automation {config.status === 'active' ? 'Active' : 'Paused'}
            <Switch
              checked={config.status === 'active'}
              disabled={automationLocked}
              onCheckedChange={(checked) => void patch({ status: checked ? 'active' : 'paused' }, 'Automation')}
            />
          </label>
          <Link href={hubHref}><Button type="button" variant="outline">Back to Hub</Button></Link>
          <Button type="button" variant="outline" onClick={() => setDeleteOpen(true)}>Delete</Button>
        </div>
      </div>

      {statusAlert ? <Banner variant={statusAlert.variant} title={statusAlert.title} description={statusAlert.description} /> : null}
      {error ? <Banner variant="critical" title="Something went wrong" description={error} /> : null}
      {notice ? <Banner variant="success" title="Done" description={notice} onDismiss={() => setNotice(null)} /> : null}

      <Tabs value={activeTab} onValueChange={(value) => handleTabChange(value as AduDetailTab)}>
        <div className="sticky top-0 z-sticky bg-canvas">
          <TabsList
            variant="line"
            aria-label="Page sections"
            data-testid="adu-detail-tabs-nav"
            className="w-full justify-start overflow-x-auto"
          >
            {ADU_DETAIL_TAB_ITEMS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                variant="line-gold"
                data-testid={`adu-detail-tab-${tab.id}-btn`}
                className="min-h-11 shrink-0"
              >
                <span>{tab.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {visitedTabs.has('overview') && (
          <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
            <h2 className="text-metadata font-semibold uppercase text-ink-dim">Total Statistics</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {totalTiles.map((tile) => (
                <div key={tile.label} className={statCardClass}>
                  <p className="text-body text-ink-sub">{tile.label}</p>
                  <p className={cn('mt-1 text-xxl font-bold', tile.valueClass)}>{tile.value.toLocaleString('en-US')}</p>
                  <p className="text-metadata text-ink-dim">{tile.sub}</p>
                </div>
              ))}
            </div>
            <h2 className="mt-6 text-metadata font-semibold uppercase text-ink-dim">Today&apos;s Statistics</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              {todayTiles.map((tile) => (
                <div key={tile.label} className={statCardClass}>
                  <p className="text-body text-ink-sub">{tile.label}</p>
                  <p className={cn('mt-1 text-xxl font-bold', tile.valueClass)}>{tile.value.toLocaleString('en-US')}</p>
                  <p className="text-metadata text-ink-dim">{tile.sub}</p>
                </div>
              ))}
            </div>
          </TabsContent>
        )}

        {visitedTabs.has('insights') && (
          <TabsContent value="insights" forceMount className="data-[state=inactive]:hidden">
            <PageTabInsights page={{ id: config.destinationId }} subdomain={subdomain} pageTimezone={config.timezone} />
          </TabsContent>
        )}

        {visitedTabs.has('reels') && (
          <TabsContent value="reels" forceMount className="data-[state=inactive]:hidden">
            <div>
              <h2 className="font-semibold">Downloaded Queue</h2>
              <p className="text-body text-ink-sub">View, edit captions, skip or purge reels from the automatic publication queue.</p>
            </div>
            {reelsError && reels.length === 0 ? (
              <Banner variant="critical" title="Could not load reels" description={reelsError} />
            ) : reels.length === 0 ? (
              reelsLoading ? (
                <p className="mt-4 text-body text-ink-sub">Loading reels…</p>
              ) : (
                <EmptyState type="first-use" title="No reels in queue" description="The automated buffer downloader has no pending downloads for this page." />
              )
            ) : (
              <>
              {reelsError ? <Banner variant="critical" title="Could not load reels" description={reelsError} /> : null}
              <div
                className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3"
                data-testid="adu-reels-grid"
                onKeyDown={(e) => {
                  // Escape collapses the expanded card. The handler
                  // sits on the grid so it works from the textarea
                  // too — the draft is re-prefilled on the next
                  // expand, so nothing is lost silently.
                  if (e.key === 'Escape' && expandedReelId !== null) collapseExpanded();
                }}
              >
                {reels.map((reel) => {
                  const expanded = expandedReelId === reel.id;
                  const duration = formatReelDuration(durations[reel.id]);
                  // Spec 179: the compact view always sizes the card.
                  // When a card expands, this same content stays in
                  // flow (invisible) and the editor overlays it, so
                  // the expanded card keeps exactly the compact
                  // card's outer dimensions and the grid cannot move.
                  const cardBody = (
                    <>
                      <span className="relative block aspect-9/16 w-full overflow-hidden rounded-md bg-surface">
                        {reel.media_url ? (
                          <>
                            <video
                              src={reel.media_url}
                              preload="metadata"
                              muted
                              playsInline
                              data-testid={`adu-reel-preview-${reel.id}`}
                              onLoadedMetadata={(e) => {
                                const seconds = e.currentTarget.duration;
                                setDurations((prev) => (prev[reel.id] === seconds ? prev : { ...prev, [reel.id]: seconds }));
                              }}
                              className="absolute inset-0 h-full w-full bg-black object-cover"
                            />
                            <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
                              <span className="flex size-10 items-center justify-center rounded-full bg-black/60 text-white">
                                <PlayIcon className="size-5" aria-hidden />
                              </span>
                            </span>
                            {duration ? (
                              <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">{duration}</span>
                            ) : null}
                          </>
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center p-4 text-center text-body text-ink-sub">No media URL for this reel yet.</span>
                        )}
                      </span>
                      <span className="line-clamp-2 text-body">{reel.caption ?? 'No caption'}</span>
                      <span className="mt-auto text-metadata text-ink-dim">Downloaded {reel.downloaded_at ? new Date(reel.downloaded_at).toLocaleString() : '—'}</span>
                    </>
                  );
                  return (
                    <Card
                      key={reel.id}
                      data-testid={`adu-reel-card-${reel.id}`}
                      className={cn('relative gap-0 overflow-hidden py-0', expanded && 'ring-2 ring-primary')}
                    >
                      {expanded ? (
                        <div aria-hidden className="invisible flex w-full flex-1 flex-col gap-2 p-4 text-left">
                          {cardBody}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="flex w-full flex-1 flex-col gap-2 p-4 text-left"
                          aria-expanded={false}
                          onClick={() => expandReel(reel)}
                        >
                          {cardBody}
                        </button>
                      )}
                      {expanded ? (
                        <div
                          className="absolute inset-0 flex flex-col overflow-y-auto bg-panel"
                          onClick={(e) => {
                            // Clicking the card again collapses it —
                            // but never from an interactive descendant
                            // (textarea, buttons, video controls),
                            // which keep their own behaviour.
                            if ((e.target as HTMLElement).closest('button, textarea, input, select, a, video')) return;
                            collapseExpanded();
                          }}
                        >
                          <div className="my-auto flex w-full flex-col items-center gap-3 p-4 text-center">
                            <div className="flex w-full items-start justify-between gap-2 text-left">
                              <span className="text-metadata text-ink-dim">{config.sourceIdentity} · Reel {reel.source_reel_id}</span>
                              <button
                                type="button"
                                aria-label="Close editor"
                                onClick={collapseExpanded}
                                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-sub outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                              >
                                <XIcon className="size-4" aria-hidden />
                              </button>
                            </div>
                            {reel.media_url ? (
                              <video
                                src={reel.media_url}
                                controls
                                preload="metadata"
                                muted
                                playsInline
                                data-testid="adu-reel-editor-video"
                                className="aspect-video w-3/4 rounded-md bg-black object-cover"
                              />
                            ) : (
                              <p className="text-body text-ink-sub">No media URL for this reel yet.</p>
                            )}
                            <label className="font-medium" htmlFor="adu-caption">Caption Editor</label>
                            <Textarea id="adu-caption" rows={3} value={captionDraft} onChange={(e) => setCaptionDraft(e.target.value)} />
                            <p className="text-metadata text-ink-dim">{captionDraft.length} characters · Reel ID {reel.source_reel_id}</p>
                            <div className="flex flex-wrap justify-center gap-1">
                              {QUICK_TAGS.map((tag) => (
                                <Button key={tag} type="button" variant="outline" onClick={() => setCaptionDraft((d) => `${d} ${tag}`.trim())}>{tag}</Button>
                              ))}
                            </div>
                            <div className="flex flex-wrap justify-center gap-2">
                              <Button type="button" onClick={() => void saveReelCaption(reel)}>Save Caption</Button>
                              <Button type="button" variant="outline" onClick={() => void skipReel(reel)}>Skip</Button>
                              <Button type="button" variant="outline" onClick={() => setDeleteReelId(reel.id)}>Delete</Button>
                            </div>
                            <p className="text-metadata text-ink-dim">Downloaded {reel.downloaded_at ? new Date(reel.downloaded_at).toLocaleString() : '—'}</p>
                          </div>
                        </div>
                      ) : null}
                    </Card>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-body text-ink-sub" data-testid="adu-reels-page-label">
                  Page {reelsPage} of {reelsTotalPages} · {reelsTotal.toLocaleString('en-US')} reels
                </p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" disabled={reelsPage <= 1 || reelsLoading} data-testid="adu-reels-prev-page" onClick={() => setReelsPage((p) => Math.max(1, p - 1))}>Previous</Button>
                  <Button type="button" variant="outline" disabled={reelsPage >= reelsTotalPages || reelsLoading} data-testid="adu-reels-next-page" onClick={() => setReelsPage((p) => Math.min(reelsTotalPages, p + 1))}>Next</Button>
                </div>
              </div>
              {reelsLoading ? <p className="mt-2 text-body text-ink-sub">Loading reels…</p> : null}
              <AlertDialog open={deleteReelId !== null} onOpenChange={(open) => { if (!open) setDeleteReelId(null); }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove reel?</AlertDialogTitle>
                    <AlertDialogDescription>Remove this reel from the queue? This cannot be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={async (event) => {
                        event.preventDefault();
                        if (deleteReelId !== null) await deleteReel(deleteReelId);
                      }}
                    >Remove reel</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              </>
            )}
          </TabsContent>
        )}

        {visitedTabs.has('failed') && (
          <TabsContent value="failed" forceMount className="data-[state=inactive]:hidden">
            {failedError && failed.length === 0 ? (
              <Banner variant="critical" title="Could not load failed posts" description={failedError} />
            ) : failed.length === 0 ? (
              failedLoading ? (
                <p className="mt-4 text-body text-ink-sub">Loading failed posts…</p>
              ) : (
                <EmptyState type="first-use" title="No Failed Posts Found" description="All systems are operating normally. There are no failed publish attempts recorded for this page." />
              )
            ) : (
              <div className="flex flex-col gap-3">
                {failed.map((job) => (
                  <Card key={job.id}><CardContent className="flex flex-col gap-2 pt-6">
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-surface px-2 py-1 text-metadata">{job.status.replace(/_/g, ' ')}</span>
                      <button type="button" className="text-metadata text-link" onClick={() => { void navigator.clipboard?.writeText(job.reel_id); setNotice('Reel ID copied.'); }}>Copy Reel ID</button>
                      <button type="button" className="text-metadata text-link" onClick={() => { void navigator.clipboard?.writeText(job.id); setNotice('Job ID copied.'); }}>Copy Job ID</button>
                    </div>
                    {job.adu_reels?.caption ? <p className="text-body">“{job.adu_reels.caption}”</p> : null}
                    <p className="text-body">Code: {job.last_error_code ?? 'UNKNOWN_ERROR'}</p>
                    <p className="text-body text-ink-sub">{job.last_error_message ?? 'No failure message provided by Graph API.'}</p>
                    <p className="text-metadata text-ink-dim">{new Date(job.created_at).toLocaleString()}</p>
                  </CardContent></Card>
                ))}
              </div>
            )}
          </TabsContent>
        )}

        {visitedTabs.has('settings') && (
          <TabsContent value="settings" forceMount className="data-[state=inactive]:hidden">
            <Tabs defaultValue="automation">
              <TabsList>
                <TabsTrigger value="automation">Automation</TabsTrigger>
                <TabsTrigger value="connections">Connections</TabsTrigger>
                <TabsTrigger value="source">Source</TabsTrigger>
                <TabsTrigger value="identity">Identity</TabsTrigger>
              </TabsList>
              <TabsContent value="automation">
                {!editAutomation ? (
                  <Card><CardContent className="flex flex-col gap-2 pt-6">
                    <p className="text-body">Posts Per Day: {config.postsPerDay} Posts</p>
                    <p className="text-body">Logic: {config.scheduleType === 'fixed' ? 'Fixed Timestamps' : 'Daily Random'}</p>
                    <p className="text-body">Timezone: {config.timezone}</p>
                    <p className="text-body">Scheduled Times (Local): {config.postingTimes.join(', ') || '—'}</p>
                    <Button type="button" onClick={() => setEditAutomation(true)}>Edit</Button>
                  </CardContent></Card>
                ) : (
                  <Card><CardContent className="flex flex-col gap-3 pt-6">
                    <label className="font-medium" htmlFor="adu-edit-schedule-logic">Schedule Logic</label>
                    <Select value={editLogic} onValueChange={(v) => setEditLogic(v as 'dailyrandom' | 'fixed')}>
                      <SelectTrigger id="adu-edit-schedule-logic"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dailyrandom">Daily Random</SelectItem>
                        <SelectItem value="fixed">Fixed Timestamps</SelectItem>
                      </SelectContent>
                    </Select>
                    <label className="font-medium" htmlFor="adu-edit-timezone">Posting Timezone</label>
                    <Input id="adu-edit-timezone" value={editTimezone} onChange={(e) => setEditTimezone(e.target.value)} />
                    <label className="font-medium" htmlFor="adu-edit-posts-per-day">Posts Per Day</label>
                    <Input id="adu-edit-posts-per-day" type="number" min={0} max={12} value={editPosts} onChange={(e) => { const n = Math.max(0, Math.min(12, Number(e.target.value) || 0)); setEditPosts(n); setEditTimes(Array.from({ length: n }, (_, i) => editTimes[i] ?? '09:00')); }} />
                    {editLogic === 'dailyrandom' ? (
                      <p className="text-body text-ink-sub">Balanced random times will be automatically generated upon saving to ensure a minimum 5-hour gap between posts.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {Array.from({ length: editPosts }, (_, i) => (
                          <Input key={i} type="time" value={editTimes[i] ?? '09:00'} onChange={(e) => { const next = [...editTimes]; next[i] = e.target.value; setEditTimes(next); }} />
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button type="button" onClick={async () => {
                        if (editLogic === 'fixed' && editTimes.slice(0, editPosts).some((t) => !t)) { setError('Please select a time for all posting slots.'); return; }
                        const ok = await patch({ postsPerDay: editPosts, timezone: editTimezone, scheduleType: editLogic, postingTimes: editLogic === 'fixed' ? editTimes.slice(0, editPosts) : undefined }, 'Automation');
                        if (ok) setEditAutomation(false);
                      }}>Save Changes</Button>
                      <Button type="button" variant="outline" onClick={() => setEditAutomation(false)}>Cancel</Button>
                    </div>
                  </CardContent></Card>
                )}
              </TabsContent>
              <TabsContent value="connections">
                <Card><CardContent className="flex flex-col gap-2 pt-6">
                  <p className="font-medium">Facebook Identity</p>
                  <p className="text-body text-ink-sub">The Facebook account used to manage this page.</p>
                  <p className="text-body">Associated Facebook Identity: {config.accountName ?? 'Disconnected'}</p>
                </CardContent></Card>
              </TabsContent>
              <TabsContent value="source">
                <Card><CardContent className="flex flex-col gap-3 pt-6">
                  <p className="font-medium">Content Source Management</p>
                  <p className="text-body text-ink-sub">Define where the automation scrapes content from.</p>
                  <p className="text-body">Current Source: {config.sourcePlatform} {config.sourceIdentity}</p>
                  <Button type="button" onClick={() => { setNewPlatform(config.sourcePlatform); setNewUsername(config.sourceUsername); setSourceOpen(true); }}>Update Content Source</Button>
                </CardContent></Card>
              </TabsContent>
              <TabsContent value="identity">
                {!editIdentity ? (
                  <Card><CardContent className="flex flex-col gap-2 pt-6">
                    <p className="font-medium">Page Identity</p>
                    <p className="text-body text-ink-sub">Internal identifiers and display names.</p>
                    <p className="text-body">Display Name: {config.destinationName}</p>
                    <Button type="button" onClick={() => setEditIdentity(true)}>Edit</Button>
                  </CardContent></Card>
                ) : (
                  <Card><CardContent className="flex flex-col gap-2 pt-6">
                    <label className="font-medium" htmlFor="adu-edit-display-name">Display Name</label>
                    <Input id="adu-edit-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                    <div className="flex gap-2">
                      <Button type="button" onClick={async () => { const ok = await patch({ displayName }, 'Identity'); if (ok) setEditIdentity(false); }}>Save Changes</Button>
                      <Button type="button" variant="outline" onClick={() => setEditIdentity(false)}>Cancel</Button>
                    </div>
                  </CardContent></Card>
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Permanently Delete</DialogTitle>
          <DialogDescription>This page and its reels will be permanently deleted. This cannot be undone.</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button type="button" onClick={async () => {
              const response = await fetch(base, { method: 'DELETE' });
              if (response.ok) window.location.href = buildTenantHref(subdomain, `/auto-download-upload`, isTenantSubdomainHost(window.location.hostname, subdomain));
              else setError('Could not delete this page.');
            }}>Permanently Delete</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Switch {newPlatform} Source</DialogTitle>
          <DialogDescription>Update the target source identity to re-sync the automation queue with new content.</DialogDescription></DialogHeader>
          <Select value={newPlatform} onValueChange={setNewPlatform}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {['instagram', 'youtube', 'tiktok', 'facebook'].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input placeholder={newPlatform === 'youtube' ? 'channel_id' : newPlatform === 'facebook' ? 'page_or_user_id' : '@username'} value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setSourceOpen(false)}>Cancel</Button>
            <Button type="button" onClick={async () => {
              const ok = await patch({ sourcePlatform: newPlatform, sourceUsername: newUsername }, 'Source');
              if (ok) setSourceOpen(false);
            }}>Confirm Transition</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary for prerendering, so
 * the tab-syncing inner component sits behind one. The route wrapper
 * itself is untouched.
 */
export function AduDetailPage({ subdomain, configId }: { subdomain: string; configId: string }) {
  return (
    <React.Suspense fallback={<AduDetailSkeleton />}>
      <AduDetailPageInner subdomain={subdomain} configId={configId} />
    </React.Suspense>
  );
}
