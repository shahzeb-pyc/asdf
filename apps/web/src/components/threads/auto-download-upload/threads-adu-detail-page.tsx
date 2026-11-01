'use client';

import * as React from 'react';
import Link from 'next/link';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shared/ui/card';
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
import { Switch } from '@/components/shared/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { Textarea } from '@/components/shared/ui/textarea';
import { buildTenantApiPath } from '@/lib/api/client';
import { buildTenantHref, isTenantSubdomainHost } from '@/lib/tenant-href';

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

export function ThreadsAduDetailPage({ subdomain, configId }: { subdomain: string; configId: string }) {
  const [config, setConfig] = React.useState<ConfigView | null>(null);
  const [reels, setReels] = React.useState<Reel[]>([]);
  const [postedReels, setPostedReels] = React.useState<Reel[]>([]);
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

  const base = buildTenantApiPath(subdomain, `/threads/auto-download-upload/${configId}`);
  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, reelsRes, failedRes, postedRes] = await Promise.all([
        fetch(base), fetch(`${base}/reels`), fetch(`${base}/failed`), fetch(`${base}/reels?view=posted`),
      ]);
      const configBody = await configRes.json().catch(() => ({}));
      if (!configRes.ok) throw new Error(configBody.error ?? 'Account not found.');
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
      const postedBody = await postedRes.json().catch(() => ({}));
      setPostedReels(postedBody.reels ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account.');
    } finally {
      setLoading(false);
    }
  }, [base]);

  React.useEffect(() => { void load(); }, [load]);

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

  if (loading) return <div className="p-4 sm:p-6"><p className="text-body text-ink-sub">Loading account…</p></div>;
  if (!config) return <div className="p-4 sm:p-6">{error ? <Banner variant="critical" title="Account not found" description={error} /> : null}</div>;

  const automationLocked = config.status === 'fb_rate_limited';
  const selected = selectedReel ?? reels[0] ?? null;

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-metadata text-ink-dim">Agency / Auto Download/Upload / {config.destinationName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-lg leading-heading font-semibold text-ink">{config.destinationName}</h1>
            <span className="rounded-full bg-surface px-2 py-1 text-metadata text-ink">{config.displayStatus}</span>
          </div>
          <p className="text-body text-ink-sub">Internal ID: {config.destinationExternalId}</p>
          <p className="text-body text-ink-sub">
            {config.followersGained} followers · {config.followersGained - config.followersCount} gained · Starting {config.followersCount} · Added {new Date(config.createdAt).toLocaleDateString()}
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            <a className="text-body font-medium text-link" href={config.sourceLink} target="_blank" rel="noreferrer">Source: {config.sourceIdentity}</a>
            {config.accountName ? <span className="text-body text-ink-sub">Owner: {config.accountName}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-body">
            Automation {config.status === 'active' ? 'Active' : 'Paused'}
            <Switch
              checked={config.status === 'active'}
              disabled={automationLocked}
              onCheckedChange={(checked) => void patch({ status: checked ? 'active' : 'inactive' }, 'Automation')}
            />
          </label>
          <Link href={`/tenant/${subdomain}/threads/auto-download-upload`}><Button type="button" variant="outline">Back to Hub</Button></Link>
          <Button type="button" variant="outline" onClick={() => setDeleteOpen(true)}>Delete</Button>
        </div>
      </div>

      {config.alert ? <Banner variant="warning" title={config.displayStatus} description={config.alert} /> : null}
      {error ? <Banner variant="critical" title="Something went wrong" description={error} /> : null}
      {notice ? <Banner variant="success" title="Done" description={notice} onDismiss={() => setNotice(null)} /> : null}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
          <TabsTrigger value="reels">Reels</TabsTrigger>
          <TabsTrigger value="failed">Failed Posts Reasons</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Total Pending', sub: 'Reels ready for posting', value: config.pendingCount },
              { label: 'Total Posted', sub: 'Successful automations', value: config.postedCount },
              { label: 'Failed Posts', sub: 'Require attention', value: config.failedCount },
              { label: 'Followers Gained', sub: 'Net growth since account onboarding', value: config.followersGained - config.followersCount },
            ].map((s) => (
              <Card key={s.label}><CardHeader><CardTitle className="text-metadata font-medium text-ink-dim">{s.label}</CardTitle></CardHeader><CardContent><p className="text-lg font-semibold">{s.value}</p><p className="text-metadata text-ink-dim">{s.sub}</p></CardContent></Card>
            ))}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              { label: 'Pending Today', sub: 'Remaining scheduled posts today', value: config.pendingToday },
              { label: 'Posted Today', sub: 'Published since account local midnight', value: config.postedToday },
              { label: 'Failed Today', sub: 'Errors since account local midnight', value: config.failedToday },
            ].map((s) => (
              <Card key={s.label}><CardHeader><CardTitle className="text-metadata font-medium text-ink-dim">{s.label}</CardTitle></CardHeader><CardContent><p className="text-lg font-semibold">{s.value}</p><p className="text-metadata text-ink-dim">{s.sub}</p></CardContent></Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="insights">
          <ThreadsAduInsights config={config} postedReels={postedReels} />
        </TabsContent>

        <TabsContent value="reels">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Downloaded Queue</h2>
              <p className="text-body text-ink-sub">View, edit captions, skip or purge reels from the automatic publication queue.</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => void runAction('discover', 'Discovery')}>Discover reels</Button>
              <Button type="button" variant="outline" onClick={() => void runAction('discover', 'Refresh')}>Refresh</Button>
            </div>
          </div>
          {reels.length === 0 ? (
            <EmptyState type="first-use" title="No reels in queue" description="The automated buffer downloader has no pending downloads for this account." />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
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
                  <p className="text-metadata text-ink-dim">{new TextEncoder().encode(captionDraft).length} / 500 characters · Reel ID {selected.source_reel_id}</p>
                  {new TextEncoder().encode(captionDraft).length > 500 ? <p className="text-body text-ink-sub">Threads posts allow at most 500 characters. Shorten the caption before saving, or it will fail when posted.</p> : null}
                  <div className="flex flex-wrap gap-1">
                    {QUICK_TAGS.map((tag) => (
                      <Button key={tag} type="button" variant="outline" onClick={() => setCaptionDraft((d) => `${d} ${tag}`.trim())}>{tag}</Button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={async () => {
                      if (new TextEncoder().encode(captionDraft).length > 500) { setError('Threads posts allow at most 500 characters. Shorten the caption and try again.'); return; }
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

        <TabsContent value="failed">
          {failed.length === 0 ? (
            <EmptyState type="first-use" title="No Failed Posts Found" description="All systems are operating normally. There are no failed publish attempts recorded for this account." />
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
                  <p className="text-body text-ink-sub">{job.last_error_message ?? 'No failure message provided.'}</p>
                  <p className="text-metadata text-ink-dim">{new Date(job.created_at).toLocaleString()}</p>
                </CardContent></Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="settings">
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
                <p className="font-medium">Threads Identity</p>
                <p className="text-body text-ink-sub">The Threads account this automation posts to.</p>
                <p className="text-body">Threads account: {config.accountName ?? 'Disconnected'}</p>
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
                  <p className="font-medium">Account Identity</p>
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
      </Tabs>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Permanently Delete</DialogTitle>
          <DialogDescription>This account and its videos will be permanently deleted. This cannot be undone.</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button type="button" onClick={async () => {
              const response = await fetch(base, { method: 'DELETE' });
              if (response.ok) window.location.href = buildTenantHref(subdomain, `/threads/auto-download-upload`, isTenantSubdomainHost(window.location.hostname, subdomain));
              else setError('Could not delete this account.');
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
 * Threads automation insights for one ADU account.
 *
 * Deliberately NOT the Facebook page-insights panel: there is no Threads
 * insights endpoint in this app, and inventing reach/engagement numbers
 * would be fake data. This tab reports only real automation results for
 * the account — posted/pending/failed counts, follower movement recorded
 * on the config, and the posted videos themselves.
 */
function ThreadsAduInsights({ config, postedReels }: {
  config: ConfigView;
  postedReels: Reel[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Total Posted', value: config.postedCount },
          { label: 'Total Pending', value: config.pendingCount },
          { label: 'Failed Posts', value: config.failedCount },
          { label: 'Followers Gained', value: config.followersGained - config.followersCount },
        ].map((s) => (
          <Card key={s.label}><CardHeader><CardTitle className="text-metadata font-medium text-ink-dim">{s.label}</CardTitle></CardHeader><CardContent><p className="text-lg font-semibold">{s.value}</p></CardContent></Card>
        ))}
      </div>
      {postedReels.length === 0 ? (
        <EmptyState type="first-use" title="No videos posted yet" description="Videos posted to this Threads account by this automation will appear here." />
      ) : (
        <div className="flex flex-col gap-3">
          {postedReels.map((reel) => (
            <Card key={reel.id}><CardContent className="flex flex-col gap-1 pt-6">
              <p className="line-clamp-3 text-body">{reel.caption ?? 'No caption'}</p>
              <p className="text-metadata text-ink-dim">Downloaded {reel.downloaded_at ? new Date(reel.downloaded_at).toLocaleString() : '—'} · Source {reel.source_reel_id}</p>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
