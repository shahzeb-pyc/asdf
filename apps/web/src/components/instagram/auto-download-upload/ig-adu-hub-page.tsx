'use client';

// Vercel rebuild trigger (comment only, no behaviour change) — PR #43, new Vercel account.
import * as React from 'react';
import Link from 'next/link';
import { PlusIcon } from 'lucide-react';
import { parseAduBulkPaste, parseAduCsv } from '@fbuploadpro/contracts';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { Checkbox } from '@/components/shared/ui/checkbox';
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
import { Textarea } from '@/components/shared/ui/textarea';
import { buildTenantApiPath } from '@/lib/api/client';
import { FeatureCapText, useFeatureCap } from '@/components/billing/feature-cap';

const STATUS_OPTIONS = [
  'All Statuses', 'Active', 'Inactive', 'Verification Req.', 'Rate Limited',
  'Page Not Accessible', 'Invalid Token', 'Invalid Username', 'Creator Suspended',
  'Completed', '2FA Req. on BM', 'Check Dev App', 'Account Suspended',
] as const;
const SORT_OPTIONS = ['Newest First', 'Most Followers', 'Least Followers'] as const;
const PLATFORMS = ['instagram', 'youtube', 'tiktok', 'facebook'] as const;
type Platform = (typeof PLATFORMS)[number];

interface AduConfigView {
  id: string;
  destinationId: string;
  destinationName: string;
  destinationExternalId: string;
  sourcePlatform: Platform;
  sourceUsername: string;
  sourceIdentity: string;
  destinationStatus: string;
  accountName: string | null;
  status: string;
  displayStatus: string;
  followersCount: number;
  followersGained: number;
  createdAt: string;
  postedCount: number;
  pendingCount: number;
  failedCount: number;
  postedToday: number;
  pendingToday: number;
  failedToday: number;
  postsPerDay: number;
}
interface PickerPage { id: string; account_id: string; external_destination_id: string; name: string; avatar_url: string | null; status: string; metadata: Record<string, unknown> | null; }
interface Configured { destination_id: string; source_platform: string; source_username: string; }

function pageAge(createdAt: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000));
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month' : `${months} months`;
}

export function IgAduHubPage({ subdomain }: { subdomain: string }) {
  const [configs, setConfigs] = React.useState<AduConfigView[]>([]);
  const [stats, setStats] = React.useState({ totalPages: 0, followersGained: 0, totalFollowers: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<string>('All Statuses');
  const [sort, setSort] = React.useState<string>('Newest First');
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(0);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  // Plan cap: the Add Account button disables at the cap, and the
  // ADU create route enforces the same cap server-side.
  const { cap: instagramCap } = useFeatureCap(subdomain, 'instagram');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: searchQuery, status: statusFilter, sort, page: String(page) });
      const response = await fetch(`${buildTenantApiPath(subdomain, '/instagram/auto-download-upload')}?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Failed to load accounts.');
      setMigrationMissing(Boolean(body.migrationMissing));
      setConfigs(body.configs ?? []);
      setStats(body.stats ?? { totalPages: 0, followersGained: 0, totalFollowers: 0 });
      setTotalPages(body.totalPages ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts.');
    } finally {
      setLoading(false);
    }
  }, [subdomain, searchQuery, statusFilter, sort, page]);

  React.useEffect(() => { void load(); }, [load]);

  const hasActiveFilter = searchQuery.trim() !== '' || statusFilter !== 'All Statuses';

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg leading-heading font-semibold text-ink">Auto Download/Upload</h1>
          <p className="text-body text-ink-sub">Connected Instagram accounts for automated reel download and posting.</p>
          {instagramCap ? (
            <FeatureCapText cap={instagramCap} platform="instagram" />
          ) : null}
        </div>
        <Button type="button" onClick={() => setDialogOpen(true)} disabled={instagramCap?.atCap ?? false}>
          <PlusIcon aria-hidden /><span>+ Add Account</span>
        </Button>
      </div>

      {error ? <Banner variant="critical" title="Could not load accounts" description={error} /> : null}
      {migrationMissing ? (
        <Banner variant="warning" title="ADU tables are not created yet" description="Apply migration 20261030120001_adu.sql to the database, then refresh this page. Until then, no ADU accounts can be added." />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Total Accounts', value: stats.totalPages },
          { label: 'Followers Gained', value: stats.followersGained },
          { label: 'Total Followers', value: stats.totalFollowers },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardHeader><CardTitle className="text-metadata font-medium text-ink-dim">{stat.label}</CardTitle></CardHeader>
            <CardContent><p className="text-lg leading-heading font-semibold text-ink">{stat.value}</p></CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Input type="search" aria-label="Search accounts or sources" placeholder="Search accounts or sources…" value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }} className="min-w-55 flex-1 sm:max-w-80" />
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUS_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => { setSort(v); setPage(1); }}>
          <SelectTrigger aria-label="Sort accounts"><SelectValue /></SelectTrigger>
          <SelectContent>{SORT_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {loading ? (
        <p className="text-body text-ink-sub">Loading accounts…</p>
      ) : migrationMissing ? null : configs.length === 0 ? (
        hasActiveFilter ? (
          <EmptyState type="no-results" title="No accounts match your search or filters." action={<Button type="button" variant="outline" onClick={() => { setSearchQuery(''); setStatusFilter('All Statuses'); setPage(1); }}>Clear filters</Button>} />
        ) : (
          <EmptyState type="first-use" title="No accounts found" description="Connect an Instagram account and add your first account to start automation." />
        )
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {configs.map((config) => (
              <Card key={config.id} className="flex flex-col gap-3">
                <CardHeader className="flex flex-row items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{config.destinationName}</CardTitle>
                    <p className="font-mono text-metadata text-ink-dim">{config.destinationExternalId}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-metadata text-ink">{config.displayStatus}</span>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="text-body text-ink-sub">{config.sourceIdentity} · {config.sourcePlatform}</p>
                  {/* No 'via' line: the Instagram destination IS the account. */}
                  <p className="text-body">Posted {config.postedCount} · Pending {config.pendingCount} · Failed {config.failedCount}</p>
                  <p className="text-body text-ink-sub">Today: Pending {config.pendingToday} · Posted {config.postedToday} · Failed {config.failedToday}</p>
                  <p className="text-metadata text-ink-dim">Starting {config.followersCount} · Added {new Date(config.createdAt).toLocaleDateString()} · {pageAge(config.createdAt)}</p>
                  <Link href={`/tenant/${subdomain}/instagram/auto-download-upload/${config.id}`} className="text-body font-medium text-link">Open account →</Link>
                </CardContent>
              </Card>
            ))}
          </div>
          {totalPages > 1 ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="text-body text-ink-sub">Page {page} of {totalPages}</span>
              <Button type="button" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          ) : null}
        </>
      )}

      <AddAccountDialog
        subdomain={subdomain}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => { setDialogOpen(false); setPage(1); void load(); }}
      />
    </div>
  );
}

function AddAccountDialog({ subdomain, open, onOpenChange, onCreated }: {
  subdomain: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void;
}) {
  const [mode, setMode] = React.useState<'single' | 'bulk' | 'multi'>('single');
  const [step, setStep] = React.useState(1);
  // Instagram destinations ARE the accounts: no separate account picker.
  // The options route returns destinations as `pages` for this dialog,
  // exactly like the Facebook dialog's managed-pages list.
  const [pages, setPages] = React.useState<PickerPage[]>([]);
  const [configured, setConfigured] = React.useState<Configured[]>([]);
  const [pageSearch, setPageSearch] = React.useState('');
  const [selectedPageIds, setSelectedPageIds] = React.useState<string[]>([]);
  const [sources, setSources] = React.useState<Record<string, { platform: Platform; username: string }>>({});
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState('');
  const [pasteFeedback, setPasteFeedback] = React.useState<string | null>(null);
  const [csvFeedback, setCsvFeedback] = React.useState<string | null>(null);
  const [postsPerDay, setPostsPerDay] = React.useState(1);
  const [timezone, setTimezone] = React.useState('Asia/Karachi');
  const [scheduleType, setScheduleType] = React.useState<'dailyrandom' | 'fixed'>('dailyrandom');
  const [fixedTimes, setFixedTimes] = React.useState<string[]>(['09:00']);
  // Bulk / multi only: old 'Apply Schedule' scope. 'all' is the shared
  // schedule above; 'separate' keeps one schedule per selected account,
  // exactly like the old AddAccountDialog (bulkScheduleByPage).
  type PageSchedule = { postsPerDay: number; timezone: string; postingTimes: string[] };
  const [timingScope, setTimingScope] = React.useState<'all' | 'separate'>('all');
  const [schedulesByPage, setSchedulesByPage] = React.useState<Record<string, PageSchedule>>({});
  const defaultPageSchedule = (): PageSchedule => ({ postsPerDay: 1, timezone: 'Asia/Karachi', postingTimes: [] });
  const pageSchedule = (pageId: string): PageSchedule => schedulesByPage[pageId] ?? defaultPageSchedule();
  const ensureTimesLength = (times: string[], n: number): string[] => {
    const next = [...times];
    if (n > next.length) for (let i = next.length; i < n; i++) next.push('');
    else if (n < next.length) next.splice(n);
    return next;
  };
  const updatePageSchedule = (pageId: string, patch: Partial<PageSchedule>) => {
    setSchedulesByPage((prev) => ({ ...prev, [pageId]: { ...(prev[pageId] ?? defaultPageSchedule()), ...patch } }));
  };
  const pageScheduleComplete = (pageId: string): boolean => {
    const s = pageSchedule(pageId);
    if (!s.timezone.trim() || !Number.isInteger(s.postsPerDay) || s.postsPerDay < 1 || s.postsPerDay > 12) return false;
    if (scheduleType === 'fixed') {
      return s.postingTimes.length === s.postsPerDay && s.postingTimes.every((t) => String(t ?? '').trim() !== '');
    }
    return true;
  };
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setStep(1); setError(null); setResult(null);
    void fetch(buildTenantApiPath(subdomain, '/instagram/auto-download-upload/options'))
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        // Fail loud, like the Facebook dialog after #56: a 500 used to
        // render as an empty picker with no error, inviting duplicates.
        if (!r.ok) throw new Error(body.error ?? 'Could not load Instagram accounts.');
        if (body.migrationMissing) throw new Error('The Auto Download/Upload tables have not been created yet. Apply migration 20261030120001_adu.sql, then try again.');
        setPages(body.pages ?? []);
        setConfigured(body.configured ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load Instagram accounts.'));
  }, [open, subdomain]);

  const totalSteps = mode === 'single' ? 2 : 3;
  const visiblePages = pages.filter((p) =>
    p.name.toLowerCase().includes(pageSearch.toLowerCase())
  );
  const selectedPages = pages.filter((p) => selectedPageIds.includes(p.id));
  const isConfigured = (pageId: string) => configured.some((c) => c.destination_id === pageId);
  const allSourcesFilled = selectedPages.every((p) => (sources[p.id]?.username ?? '').trim() !== '');

  const toggle = (list: string[], id: string, set: (v: string[]) => void) => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  const applyPaste = () => {
    const parsed = parseAduBulkPaste(pasteText, 'instagram');
    if (parsed.errors.length > 0) { setPasteFeedback(parsed.errors.join(' ')); return; }
    const empty = selectedPages.filter((p) => !(sources[p.id]?.username ?? '').trim());
    const already = new Set(configured.map((c) => `${c.source_platform}|${c.source_username.toLowerCase()}`));
    const next = { ...sources };
    let assigned = 0;
    const shuffled = [...parsed.sources].sort(() => Math.random() - 0.5);
    for (const source of shuffled) {
      if (assigned >= empty.length) break;
      const key = `${source.platform}|${source.username.toLowerCase()}`;
      if (already.has(key)) continue;
      const page = empty[assigned];
      if (!page) break;
      next[page.id] = { platform: source.platform, username: source.username };
      assigned += 1;
    }
    setSources(next);
    setPasteFeedback(`${assigned} new sources assigned to ${empty.length} empty account slots. ${parsed.warnings.join(' ')}`);
    setPasteOpen(false);
  };

  const applyCsv = async (file: File) => {
    const text = await file.text();
    const parsed = parseAduCsv(text);
    const next = { ...sources };
    let applied = 0;
    for (const row of parsed.rows) {
      const page = selectedPages.find((p) => p.name.trim().replace(/\s+/g, ' ').toLowerCase() === row.pageName.toLowerCase());
      if (page) { next[page.id] = { platform: row.platform, username: row.username }; applied += 1; }
    }
    setSources(next);
    setCsvFeedback(`Applied ${applied} rows. ${parsed.warnings.join(' ')}`);
  };

  const submit = async () => {
    setSubmitting(true); setError(null); setResult(null);
    try {
      if (mode === 'single') {
        const page = selectedPages[0];
        const source = page ? sources[page.id] : undefined;
        if (!page || !source?.username.trim()) throw new Error('Select an account and enter a source username.');
        const response = await fetch(buildTenantApiPath(subdomain, '/instagram/auto-download-upload'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destinationId: page.id, sourcePlatform: source.platform, sourceUsername: source.username,
            timezone, postsPerDay, scheduleType,
            postingTimes: scheduleType === 'fixed' ? fixedTimes.slice(0, postsPerDay) : undefined,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Could not add this account.');
        setResult('Account added. Automation will discover its reels on the next run.');
      } else {
        // Bulk / multi: 'all' uses the shared schedule below; 'separate'
        // sends one schedule per account, exactly like the old dialog.
        // Per-account failures are reported individually.
        if (timingScope === 'separate' && scheduleType === 'fixed') {
          for (const p of selectedPages) {
            const s = pageSchedule(p.id);
            if (s.postingTimes.length !== s.postsPerDay || s.postingTimes.some((t) => !String(t ?? '').trim())) {
              throw new Error(`Fixed posting requires ${s.postsPerDay} posting times for "${p.name}".`);
            }
          }
        }
        if (timingScope === 'separate') {
          for (const p of selectedPages) {
            const s = pageSchedule(p.id);
            if (!s.timezone.trim() || !Number.isInteger(s.postsPerDay) || s.postsPerDay < 1 || s.postsPerDay > 12) {
              throw new Error(`Please complete timezone and posts per day for "${p.name}".`);
            }
          }
        }
        const items = selectedPages.map((p) => {
          const base = {
            destinationId: p.id,
            sourcePlatform: sources[p.id]?.platform ?? 'instagram',
            sourceUsername: sources[p.id]?.username ?? '',
          };
          if (timingScope !== 'separate') return base;
          const s = pageSchedule(p.id);
          return {
            ...base,
            schedule: {
              timezone: s.timezone,
              postsPerDay: s.postsPerDay,
              postingTimes: scheduleType === 'fixed' ? s.postingTimes : undefined,
            },
          };
        });
        const response = await fetch(buildTenantApiPath(subdomain, '/instagram/auto-download-upload'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items, timezone, postsPerDay, scheduleType,
            postingTimes: scheduleType === 'fixed' ? fixedTimes.slice(0, postsPerDay) : undefined,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok && !(body.created ?? []).length) throw new Error(body.error ?? 'Could not add these accounts.');
        const failedText = (body.failed ?? []).map((f: { destinationId: string; error: string }) => f.error).join(' ');
        setResult(`Created ${(body.created ?? []).length} accounts.${failedText ? ` Failed: ${failedText}` : ''}`);
        if ((body.failed ?? []).length === 0) onCreated();
      }
      if (mode === 'single') onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this account.');
    } finally {
      setSubmitting(false);
    }
  };

  const stepSubtitle = mode === 'single'
    ? (step === 1 ? 'Select Account' : 'Configure Settings')
    : (step === 1 ? 'Select Accounts' : step === 2 ? 'Add Source Usernames' : 'Schedule');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add New Account</DialogTitle>
          <DialogDescription>Step {step} of {totalSteps}: {stepSubtitle}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {(['single', 'bulk', 'multi'] as const).map((m) => (
            <Button key={m} type="button" variant={mode === m ? 'default' : 'outline'} onClick={() => { setMode(m); setStep(1); }}>
              {m === 'single' ? 'Single Add' : m === 'bulk' ? 'Bulk Add' : 'Multi-Account + CSV'}
            </Button>
          ))}
        </div>
        <p className="text-body text-ink-sub">{selectedPages.length} accounts selected</p>
        {error ? <Banner variant="critical" title="Could not add accounts" description={error} /> : null}
        {result ? <Banner variant="success" title="Done" description={result} /> : null}

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="font-medium">Select Instagram Account(s)</h3>
              <Input placeholder="Search accounts…" value={pageSearch} onChange={(e) => setPageSearch(e.target.value)} className="mt-2" />
              <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
                {visiblePages.map((page) => {
                  const configuredAlready = isConfigured(page.id);
                  return (
                    <label key={page.id} className="flex items-center gap-2 rounded-md border p-2">
                      <Checkbox
                        disabled={configuredAlready}
                        checked={selectedPageIds.includes(page.id)}
                        onCheckedChange={() => {
                          if (mode === 'single') setSelectedPageIds([page.id]);
                          else toggle(selectedPageIds, page.id, setSelectedPageIds);
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{page.name}</span>
                      <span className="font-mono text-metadata text-ink-dim">{page.external_destination_id}</span>
                      {configuredAlready ? <span className="text-metadata text-ink-dim">Already configured</span> : null}
                    </label>
                  );
                })}
              </div>
              {mode !== 'single' ? (
                <div className="mt-2 flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setSelectedPageIds(visiblePages.filter((p) => !isConfigured(p.id)).map((p) => p.id))}>Select all accounts</Button>
                  <Button type="button" variant="outline" onClick={() => setSelectedPageIds([])}>Clear</Button>
                </div>
              ) : null}
            </div>
            <Button type="button" disabled={selectedPages.length === 0} onClick={() => setStep(2)}>Next</Button>
          </div>
        ) : null}

        {step === 2 && mode === 'single' ? (
          <div className="flex flex-col gap-4">
            <div>
              <label className="font-medium" htmlFor="adu-source-platform">Source platform</label>
              <Select value={sources[selectedPages[0]?.id ?? '']?.platform ?? 'instagram'} onValueChange={(v) => {
                const page = selectedPages[0]; if (!page) return;
                setSources({ ...sources, [page.id]: { platform: v as Platform, username: sources[page.id]?.username ?? '' } });
              }}>
                <SelectTrigger id="adu-source-platform"><SelectValue /></SelectTrigger>
                <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="font-medium" htmlFor="adu-source-username">Source Identity</label>
              <Input id="adu-source-username" placeholder={sources[selectedPages[0]?.id ?? '']?.platform === 'youtube' ? 'channel_id' : sources[selectedPages[0]?.id ?? '']?.platform === 'facebook' ? 'page_or_user_id' : '@username'} value={sources[selectedPages[0]?.id ?? '']?.username ?? ''} onChange={(e) => {
                const page = selectedPages[0]; if (!page) return;
                setSources({ ...sources, [page.id]: { platform: sources[page.id]?.platform ?? 'instagram', username: e.target.value } });
              }} />
            </div>
            <div>
              <label className="font-medium" htmlFor="adu-single-posts-per-day">Posts Per Day</label>
              <Input id="adu-single-posts-per-day" type="number" min={1} max={12} value={postsPerDay} onChange={(e) => { const n = Math.max(1, Math.min(12, Number(e.target.value) || 1)); setPostsPerDay(n); setFixedTimes(Array.from({ length: n }, (_, i) => fixedTimes[i] ?? '09:00')); }} />
            </div>
            <div>
              <label className="font-medium" htmlFor="adu-single-timezone">Posting Timezone</label>
              <Input id="adu-single-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant={scheduleType === 'dailyrandom' ? 'default' : 'outline'} onClick={() => setScheduleType('dailyrandom')}>Random Posting Times</Button>
              <Button type="button" variant={scheduleType === 'fixed' ? 'default' : 'outline'} onClick={() => setScheduleType('fixed')}>Fixed Posting Times</Button>
            </div>
            {scheduleType === 'fixed' ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: postsPerDay }, (_, i) => (
                  <Input key={i} type="time" value={fixedTimes[i] ?? '09:00'} onChange={(e) => { const next = [...fixedTimes]; next[i] = e.target.value; setFixedTimes(next); }} />
                ))}
              </div>
            ) : (
              <p className="text-body text-ink-sub">Balanced random times will be automatically generated upon saving to ensure a minimum 5-hour gap between posts.</p>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button type="button" disabled={submitting || !(sources[selectedPages[0]?.id ?? '']?.username ?? '').trim()} onClick={() => void submit()}>Start Automation</Button>
            </div>
          </div>
        ) : null}

        {step === 2 && mode !== 'single' ? (
          <div className="flex flex-col gap-4">
            <h3 className="font-medium">Per-Account Source Mapping</h3>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setPasteOpen(true)}>Paste sources (random assign)</Button>
              {mode === 'multi' ? (
                <label className="inline-flex cursor-pointer items-center rounded-md border px-3 py-2 text-body">
                  Import CSV
                  <input type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void applyCsv(f); }} />
                </label>
              ) : null}
            </div>
            {pasteFeedback ? <p className="text-body text-ink-sub">{pasteFeedback}</p> : null}
            {csvFeedback ? <p className="text-body text-ink-sub">{csvFeedback}</p> : null}
            {pasteOpen ? (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <p className="text-body">One source per line, platform|username — for example instagram|ronaldo, facebook|messi. Sources are assigned randomly to empty account slots only.</p>
                <Textarea rows={6} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'instagram|ronaldo\nfacebook|messi'} />
                <div className="flex gap-2">
                  <Button type="button" onClick={applyPaste}>Apply assignment</Button>
                  <Button type="button" variant="outline" onClick={() => setPasteOpen(false)}>Cancel</Button>
                </div>
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              {selectedPages.map((page) => (
                <div key={page.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span className="min-w-0 flex-1 truncate">{page.name}</span>
                  <Select value={sources[page.id]?.platform ?? 'instagram'} onValueChange={(v) => setSources({ ...sources, [page.id]: { platform: v as Platform, username: sources[page.id]?.username ?? '' } })}>
                    <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input placeholder="@username" value={sources[page.id]?.username ?? ''} onChange={(e) => setSources({ ...sources, [page.id]: { platform: sources[page.id]?.platform ?? 'instagram', username: e.target.value } })} className="w-48" />
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button type="button" disabled={!allSourcesFilled} onClick={() => setStep(3)}>Next</Button>
            </div>
          </div>
        ) : null}

        {(mode !== 'single' && step === 3) ? (
          <div className="flex flex-col gap-4">
            <h3 className="font-medium">Schedule</h3>
            <div className="flex gap-2">
              <Button type="button" variant={scheduleType === 'dailyrandom' ? 'default' : 'outline'} onClick={() => {
                setScheduleType('dailyrandom');
                setSchedulesByPage((prev) => {
                  const next: Record<string, { postsPerDay: number; timezone: string; postingTimes: string[] }> = {};
                  for (const [k, v] of Object.entries(prev)) next[k] = { ...v, postingTimes: [] };
                  return next;
                });
              }}>Random Posting Times</Button>
              <Button type="button" variant={scheduleType === 'fixed' ? 'default' : 'outline'} onClick={() => {
                setScheduleType('fixed');
                setSchedulesByPage((prev) => {
                  const next: Record<string, { postsPerDay: number; timezone: string; postingTimes: string[] }> = {};
                  for (const [k, v] of Object.entries(prev)) next[k] = { ...v, postingTimes: ensureTimesLength(v.postingTimes, v.postsPerDay) };
                  return next;
                });
              }}>Fixed Posting Times</Button>
            </div>
            <div>
              <p className="font-medium">Apply Schedule</p>
              <div className="mt-2 flex items-center gap-2">
                <Button type="button" variant={timingScope === 'all' ? 'default' : 'outline'} onClick={() => setTimingScope('all')}>One for all accounts</Button>
                <Button type="button" variant={timingScope === 'separate' ? 'default' : 'outline'} onClick={() => setTimingScope('separate')}>Set separately</Button>
              </div>
            </div>
            {timingScope === 'all' ? (
              <>
                <p className="text-body text-ink-sub">These settings will be used for all selected accounts.</p>
                <div>
                  <label className="font-medium" htmlFor="adu-posts-per-day">Posts Per Day</label>
                  <Input id="adu-posts-per-day" type="number" min={1} max={12} value={postsPerDay} onChange={(e) => {
                    const n = Math.max(1, Math.min(12, Number(e.target.value) || 1));
                    setPostsPerDay(n);
                    setFixedTimes(Array.from({ length: n }, (_, i) => fixedTimes[i] ?? '09:00'));
                  }} />
                </div>
                <div>
                  <label className="font-medium" htmlFor="adu-timezone">Posting Timezone</label>
                  <Input id="adu-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </div>
                {scheduleType === 'dailyrandom' ? (
                  <p className="text-body text-ink-sub">Balanced random times will be automatically generated upon saving to ensure a minimum 5-hour gap between posts.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-body">One time per post, per day:</p>
                    {Array.from({ length: postsPerDay }, (_, i) => (
                      <Input key={i} type="time" value={fixedTimes[i] ?? '09:00'} onChange={(e) => {
                        const next = [...fixedTimes]; next[i] = e.target.value; setFixedTimes(next);
                      }} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {scheduleType === 'dailyrandom' ? (
                  <p className="text-body text-ink-sub">Balanced random times will be automatically generated upon saving to ensure a minimum 5-hour gap between posts.</p>
                ) : null}
                <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-2">
                  {selectedPages.map((page) => {
                    const s = pageSchedule(page.id);
                    const label = page.name;
                    return (
                      <div key={`schedule-${page.id}`} className="flex flex-col gap-3 rounded-lg border p-3">
                        <p className="text-body font-semibold">{label}</p>
                        <div>
                          <label className="font-medium" htmlFor={`adu-bulk-${page.id}-posts-per-day`}>Posts Per Day</label>
                          <Input id={`adu-bulk-${page.id}-posts-per-day`} type="number" min={1} max={12} value={s.postsPerDay} onChange={(e) => {
                            const n = Math.max(1, Math.min(12, Number(e.target.value) || 1));
                            updatePageSchedule(page.id, {
                              postsPerDay: n,
                              postingTimes: scheduleType === 'fixed' ? ensureTimesLength(s.postingTimes, n) : [],
                            });
                          }} />
                        </div>
                        <div>
                          <label className="font-medium" htmlFor={`adu-bulk-${page.id}-timezone`}>Posting Timezone</label>
                          <Input id={`adu-bulk-${page.id}-timezone`} value={s.timezone} onChange={(e) => updatePageSchedule(page.id, { timezone: e.target.value })} />
                        </div>
                        {scheduleType === 'fixed' ? (
                          <div className="flex flex-col gap-2">
                            <p className="text-body">Fixed Posting Times</p>
                            {ensureTimesLength(s.postingTimes, s.postsPerDay).map((time, index) => (
                              <Input key={index} type="time" value={time} onChange={(e) => {
                                const next = ensureTimesLength(s.postingTimes, s.postsPerDay);
                                next[index] = e.target.value;
                                updatePageSchedule(page.id, { postingTimes: next });
                              }} />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(2)}>Back</Button>
              <Button
                type="button"
                disabled={submitting || (timingScope === 'separate' && !selectedPages.every((p) => pageScheduleComplete(p.id)))}
                onClick={() => void submit()}
              >
                Create Selected Accounts
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
