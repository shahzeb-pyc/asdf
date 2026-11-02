'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
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

interface ConfigView {
  id: string;
  destinationId: string;
  destinationName: string;
  destinationExternalId: string;
  destinationAvatarUrl: string | null;
  accountName: string | null;
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
  status: string; downloaded_at: string | null; created_at: string;
}
interface FailedJob {
  id: string; reel_id: string; status: string; last_error_code: string | null;
  last_error_message: string | null; created_at: string;
  adu_reels?: { source_reel_id: string; caption: string | null } | null;
}

const QUICK_TAGS = ['#reels', '#viral', '#trending', '#foryou', '#shorts'];

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
    displayStatus === 'Posting inactive'
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
    case 'inactive':
      return {
        title: 'Posting Inactive',
        description: 'Posting is inactive. Activate automation using the toggle in the header.',
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
          'This page may have been removed or your account may no longer have admin access. Confirm the page exists and you have admin rights, then reconnect your Facebook account and enable automation.',
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
          'The connected Facebook user must be an admin/editor/moderator on this page and complete required Business Manager two-factor authentication. Update role/2FA, then reconnect the account.',
        variant: 'critical',
      };
    case 'check_developer_app':
      return {
        title: 'Developer App Access Blocked',
        description:
          'Facebook API access is blocked for this page/app combination. Review your Meta Developer app status, app mode, permissions, and policy compliance, then reconnect.',
        variant: 'critical',
      };
    case 'account_suspended':
      return {
        title: 'Facebook Account Suspended',
        description:
          'The connected Facebook user is not allowed to create valid sessions right now. Confirm the account is active/verified in Facebook and reconnect from the Facebook Accounts section.',
        variant: 'critical',
      };
    case 'creator_suspended':
      return {
        title: 'Source Creator Unavailable',
        description:
          'Too many reels failed to download from this source in the last 24 hours. The source creator may be suspended or unavailable. Update Settings > Source to a different account, then reactivate posting.',
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
  const [selectedReel, setSelectedReel] = React.useState<Reel | null>(null);
  const [captionDraft, setCaptionDraft] = React.useState('');
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteReelOpen, setDeleteReelOpen] = React.useState(false);
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

  const base = buildTenantApiPath(subdomain, `/auto-download-upload/${configId}`);
  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, reelsRes, failedRes] = await Promise.all([
        fetch(base), fetch(`${base}/reels`), fetch(`${base}/failed`),
      ]);
      const configBody = await configRes.json().catch(() => ({}));
      if (!configRes.ok) throw new Error(configBody.error ?? 'Page not found.');
      setConfig(configBody.config);
      setEditPosts(configBody.config.postsPerDay);
      setEditTimezone(configBody.config.timezone);
      setEditLogic(configBody.config.scheduleType);
      setEditTimes(configBody.config.postingTimes ?? []);
      setDisplayName(configBody.config.destinationName);
      const reelsBody = await reelsRes.json().catch(() => ({}));
      setReels(reelsBody.reels ?? []);
      const failedBody = await failedRes.json().catch(() => ({}));
      setFailed(failedBody.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load page.');
    } finally {
      setLoading(false);
    }
  }, [base]);

  React.useEffect(() => { void load(); }, [load]);

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
    setNotice(`${label} saved.`);
    await load();
    return true;
  };

  const runAction = async (action: string, label: string) => {
    setError(null);
    const response = await fetch(`${base}/reels`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { setError(result.error ?? `${label} failed.`); return; }
    setNotice(`${label} done.`);
    await load();
  };

  if (loading) return <AduDetailSkeleton />;
  if (!config) return <div className="mx-auto w-full max-w-7xl px-6 py-6">{error ? <Banner variant="critical" title="Page not found" description={error} /> : null}</div>;

  const automationLocked = config.status === 'fb_rate_limited';
  const selected = selectedReel ?? reels[0] ?? null;
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
  const hubHref = `/tenant/${subdomain}/auto-download-upload`;

  const metaItems: React.ReactNode[] = [
    <StatusMark key="status" kind={statusKind} label={config.displayStatus} testId="adu-detail-status-mark" />,
  ];
  if (config.accountName) {
    metaItems.push(<span key="account">Connected via {config.accountName}</span>);
  }
  if (addedDate) {
    metaItems.push(<span key="added">Added {addedDate}</span>);
  }
  metaItems.push(
    <span key="followers"><strong className="font-bold text-ink">{currentFollowers.toLocaleString('en-US')}</strong> followers</span>
  );
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
              onCheckedChange={(checked) => void patch({ status: checked ? 'active' : 'inactive' }, 'Automation')}
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
            <PageTabInsights page={{ id: config.destinationId }} subdomain={subdomain} />
          </TabsContent>
        )}

        {visitedTabs.has('reels') && (
          <TabsContent value="reels" forceMount className="data-[state=inactive]:hidden">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Downloaded Queue</h2>
                <p className="text-body text-ink-sub">View, edit captions, skip or purge reels from the automatic publication queue.</p>
              </div>
              <Button type="button" variant="outline" onClick={() => void runAction('discover', 'Discovery')}>Discover reels</Button>
            </div>
            {reels.length === 0 ? (
              <EmptyState type="first-use" title="No reels in queue" description="The automated buffer downloader has no pending downloads for this page." />
            ) : (
              <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {reels.map((reel) => (
                    <Card key={reel.id} className={selected?.id === reel.id ? 'border-2' : ''}>
                      <button type="button" className="flex w-full flex-col gap-2 p-4 text-left" onClick={() => { setSelectedReel(reel); setCaptionDraft(reel.caption ?? ''); }}>
                        <span className="aspect-9/16 w-full rounded-md bg-surface" />
                        <span className="line-clamp-3 text-body">{reel.caption ?? 'No caption'}</span>
                        <span className="text-metadata text-ink-dim">Downloaded {reel.downloaded_at ? new Date(reel.downloaded_at).toLocaleString() : '—'}</span>
                      </button>
                    </Card>
                  ))}
                </div>
                {selected ? (
                  <Card><CardContent className="flex flex-col gap-3 pt-6">
                    <p className="font-medium">Interactive Workspace</p>
                    {selected.media_url ? <video src={selected.media_url} controls className="aspect-9/16 w-full rounded-md bg-black" /> : <p className="text-body text-ink-sub">No media URL for this reel yet.</p>}
                    <p className="text-body text-ink-sub">{config.sourceIdentity} · Reel {selected.source_reel_id}</p>
                    <label className="font-medium" htmlFor="adu-caption">Caption Editor</label>
                    <Textarea id="adu-caption" rows={5} value={captionDraft} onChange={(e) => setCaptionDraft(e.target.value)} />
                    <p className="text-metadata text-ink-dim">{captionDraft.length} characters · Reel ID {selected.source_reel_id}</p>
                    <div className="flex flex-wrap gap-1">
                      {QUICK_TAGS.map((tag) => (
                        <Button key={tag} type="button" variant="outline" onClick={() => setCaptionDraft((d) => `${d} ${tag}`.trim())}>{tag}</Button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" onClick={async () => {
                        const response = await fetch(`${base}/reels/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caption: captionDraft }) });
                        if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? 'Could not save caption.'); } else { setNotice('Caption saved.'); await load(); }
                      }}>Save Caption</Button>
                      <Button type="button" variant="outline" onClick={async () => {
                        const response = await fetch(`${base}/reels/${selected.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'skip' }) });
                        if (response.ok) { setNotice('Reel skipped.'); await load(); }
                      }}>Skip</Button>
                      <Button type="button" variant="outline" onClick={() => setDeleteReelOpen(true)}>Delete</Button>
                      <AlertDialog open={deleteReelOpen} onOpenChange={(open) => { if (!open) setDeleteReelOpen(false); }}>
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
                                const response = await fetch(`${base}/reels/${selected.id}`, { method: 'DELETE' });
                                if (response.ok) { setNotice('Reel removed.'); setSelectedReel(null); await load(); }
                                setDeleteReelOpen(false);
                              }}
                            >Remove reel</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                    <p className="text-metadata text-ink-dim">Downloaded {selected.downloaded_at ? new Date(selected.downloaded_at).toLocaleString() : '—'}</p>
                  </CardContent></Card>
                ) : null}
              </div>
            )}
          </TabsContent>
        )}

        {visitedTabs.has('failed') && (
          <TabsContent value="failed" forceMount className="data-[state=inactive]:hidden">
            {failed.length === 0 ? (
              <EmptyState type="first-use" title="No Failed Posts Found" description="All systems are operating normally. There are no failed publish attempts recorded for this page." />
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
