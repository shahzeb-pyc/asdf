import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/data/query-keys';

describe('queryKeys factory (spec 137 §3.2.3)', () => {
  it('roots the cache at the tenant scope', () => {
    expect(queryKeys.all).toEqual(['tenant']);
    expect(queryKeys.tenant('acme').all).toEqual(['tenant', 'acme']);
  });

  it('scopes every resource under its tenant', () => {
    const tenant = queryKeys.tenant('acme');
    for (const key of [
      tenant.accounts.list,
      tenant.pages.list,
      tenant.queue.items('page-1'),
      tenant.media.list,
      tenant.settings.byoc,
      tenant.insights.page('page-1', '28d'),
      tenant.workspaces.list,
    ]) {
      expect(key.slice(0, 2)).toEqual(['tenant', 'acme']);
    }
  });

  it('isolates tenants from each other', () => {
    expect(queryKeys.tenant('acme').pages.list).not.toEqual(
      queryKeys.tenant('globex').pages.list
    );
  });

  it('builds hierarchical keys — detail and child keys extend their parents', () => {
    const tenant = queryKeys.tenant('acme');
    expect(tenant.pages.detail('page-1')).toEqual(['tenant', 'acme', 'pages', 'page-1']);
    expect(tenant.pages.slots('page-1')).toEqual(['tenant', 'acme', 'pages', 'page-1', 'slots']);
    expect(tenant.pages.slots('page-1').slice(0, tenant.pages.all.length)).toEqual([
      ...tenant.pages.all,
    ]);
    expect(tenant.queue.items('page-1')).toEqual(['tenant', 'acme', 'queue', 'page-1', 'items']);
    expect(tenant.queue.statusCounts('page-1')).toEqual([
      'tenant',
      'acme',
      'queue',
      'page-1',
      'status-counts',
    ]);
    expect(tenant.accounts.detail('acc-1')).toEqual(['tenant', 'acme', 'accounts', 'acc-1']);
    expect(tenant.accounts.socialList).toEqual(['tenant', 'acme', 'accounts', 'social']);
    expect(tenant.destinations.detail('dest-1')).toEqual([
      'tenant',
      'acme',
      'destinations',
      'dest-1',
    ]);
    // K10: destinations.queue was deleted with the destinations
    // queue-list route (the Pages section uses queue.items).
    expect(tenant.destinations.slots('dest-1')).toEqual([
      'tenant',
      'acme',
      'destinations',
      'dest-1',
      'posting-slots',
    ]);
    expect(tenant.media.detail('media-1')).toEqual(['tenant', 'acme', 'media', 'media-1']);
    expect(tenant.media.folders).toEqual(['tenant', 'acme', 'media', 'folders']);
    expect(tenant.settings.platformCredentials('instagram')).toEqual([
      'tenant',
      'acme',
      'settings',
      'platform-credentials',
      'instagram',
    ]);
    expect(tenant.insights.page('page-1', '7d')).toEqual([
      'tenant',
      'acme',
      'insights',
      'page-1',
      '7d',
    ]);
    expect(tenant.downloader.all).toEqual(['tenant', 'acme', 'downloader']);
    expect(tenant.downloader.jobs).toEqual(['tenant', 'acme', 'downloader', 'jobs']);
    expect(tenant.downloader.job('job-1')).toEqual([
      'tenant',
      'acme',
      'downloader',
      'jobs',
      'job-1',
    ]);
    expect(
      tenant.downloader.job('job-1').slice(0, tenant.downloader.jobs.length)
    ).toEqual([...tenant.downloader.jobs]);
  });

  it('builds Instagram Schedule keys under their own namespace', () => {
    const tenant = queryKeys.tenant('acme');
    const schedule = tenant.instagramSchedule;
    expect(schedule.all).toEqual(['tenant', 'acme', 'instagram', 'schedule']);
    expect(schedule.list).toEqual(['tenant', 'acme', 'instagram', 'schedule', 'list']);
    expect(
      schedule.listPage({
        page: 2,
        limit: 30,
        search: '',
        status: 'all',
        account: 'all',
      })
    ).toEqual([
      'tenant',
      'acme',
      'instagram',
      'schedule',
      'list',
      { page: 2, limit: 30, search: '', status: 'all', account: 'all' },
    ]);
    expect(schedule.detail('dest-1')).toEqual([
      'tenant',
      'acme',
      'instagram',
      'schedule',
      'dest-1',
    ]);
    expect(schedule.slots('dest-1')).toEqual([
      'tenant',
      'acme',
      'instagram',
      'schedule',
      'dest-1',
      'slots',
    ]);
    expect(schedule.queue('dest-1', { status: 'queued' })).toEqual([
      'tenant',
      'acme',
      'instagram',
      'schedule',
      'dest-1',
      'queue',
      { status: 'queued' },
    ]);
    expect(schedule.detail('dest-1').slice(0, schedule.all.length)).toEqual([
      ...schedule.all,
    ]);
  });

  it('builds Threads In-app Schedule keys in their own namespace', () => {
    const tenant = queryKeys.tenant('acme');
    const schedule = tenant.threadsSchedule;
    expect(schedule.all).toEqual(['tenant', 'acme', 'threads', 'schedule']);
    expect(schedule.list).toEqual(['tenant', 'acme', 'threads', 'schedule', 'list']);
    expect(
      schedule.listPage({ page: 2, limit: 20, search: 'x', status: 'active', account: 'all' })
    ).toEqual([
      'tenant',
      'acme',
      'threads',
      'schedule',
      'list',
      { page: 2, limit: 20, search: 'x', status: 'active', account: 'all' },
    ]);
    expect(schedule.candidates).toEqual([
      'tenant',
      'acme',
      'threads',
      'schedule',
      'candidates',
    ]);
    expect(schedule.detail('sched-1')).toEqual(['tenant', 'acme', 'threads', 'schedule', 'sched-1']);
    expect(schedule.slots('sched-1')).toEqual([
      'tenant',
      'acme',
      'threads',
      'schedule',
      'sched-1',
      'slots',
    ]);
    expect(schedule.queue('sched-1')).toEqual([
      'tenant',
      'acme',
      'threads',
      'schedule',
      'sched-1',
      'queue',
    ]);
    expect(schedule.insights('sched-1')).toEqual([
      'tenant',
      'acme',
      'threads',
      'schedule',
      'sched-1',
      'insights',
    ]);
    // Separate namespace from Threads accounts: invalidating Schedule
    // must never invalidate the Accounts list, and vice versa.
    expect(schedule.all).not.toEqual(tenant.threadsAccounts.all);
    expect(schedule.list).not.toEqual(tenant.threadsAccounts.list);
  });

  it('is deterministic — the same inputs produce equal keys for invalidation', () => {
    expect(queryKeys.tenant('acme').queue.items('p1')).toEqual(
      queryKeys.tenant('acme').queue.items('p1')
    );
    expect(queryKeys.tenant('acme').queue.items('p1')).not.toEqual(
      queryKeys.tenant('acme').queue.items('p2')
    );
  });
});
