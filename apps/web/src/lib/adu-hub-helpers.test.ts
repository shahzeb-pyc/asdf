/**
 * Shared ADU hub helpers (Stream D, F22 + F23).
 *
 * - statusFilterToValue: all 14 filter labels map to the same status
 *   values the three hub routes used inline; unknown labels map to
 *   null (no filter, never a wrong filter).
 * - getAduStatusMarkKind: every mapped display status keeps its kind;
 *   unknown labels map to critical, never healthy.
 * - loadAduOptionsListsForPlatform: range-pages past 1,000 rows
 *   (2,500 fixture accounts all come back), a missing adu_configs
 *   table is a flagged non-fatal result, an accounts failure throws.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  statusFilterToValue,
  getAduStatusMarkKind,
  loadAduOptionsListsForPlatform,
} from './adu-hub-helpers';

describe('statusFilterToValue', () => {
  it.each([
    ['Active', 'active'],
    ['Paused', 'paused'],
    ['Verification Req.', 'fb_verification_required'],
    ['Rate Limited', 'fb_rate_limited'],
    ['Page Not Accessible', 'page_not_accessible'],
    ['Invalid Token', 'invalid_token'],
    ['Invalid Username', 'invalid_username'],
    ['Creator Suspended', 'creator_suspended'],
    ['Completed', 'completed'],
    ['2FA Req. on BM', '2fa_required_on_BM'],
    ['Check Dev App', 'check_developer_app'],
    ['Account Suspended', 'account_suspended'],
    ['Missing Page Access', 'missing_page_access'],
    ['Missing Permission', 'missing_permission'],
  ] as const)('maps %s to %s', (label, value) => {
    expect(statusFilterToValue(label)).toBe(value);
  });

  it('maps an unknown label (and All Statuses) to null', () => {
    expect(statusFilterToValue('All Statuses')).toBeNull();
    expect(statusFilterToValue('Bogus')).toBeNull();
    expect(statusFilterToValue('')).toBeNull();
  });
});

describe('getAduStatusMarkKind', () => {
  it.each(['Active posting', 'All reels posted'] as const)(
    'maps %s to operational',
    (label) => {
      expect(getAduStatusMarkKind(label)).toBe('operational');
    },
  );

  it.each(['Scrape pending', 'Scraping reels', 'Paused'] as const)(
    'maps %s to queued',
    (label) => {
      expect(getAduStatusMarkKind(label)).toBe('queued');
    },
  );

  it.each([
    'Source not found',
    'Verification required',
    'Invalid token',
    'Rate limited',
    'Page not accessible',
    'Source disabled',
    'Creator suspended',
    'BM 2FA required',
    'Check developer app',
    'Account suspended',
    'Missing page access',
    'Missing permission',
  ] as const)('maps %s to critical', (label) => {
    expect(getAduStatusMarkKind(label)).toBe('critical');
  });

  it('maps an unknown label to critical, never healthy', () => {
    expect(getAduStatusMarkKind('Something new')).toBe('critical');
    expect(getAduStatusMarkKind('')).toBe('critical');
  });
});

type Row = Record<string, unknown>;

interface FakeOptions {
  accountsError?: { message: string; code?: string } | null;
  destinationsError?: { message: string; code?: string } | null;
  configuredError?: { message: string; code?: string } | null;
}

class FakeOptionsQuery {
  private rows: Row[];

  constructor(
    rows: Row[],
    private readonly rangeCalls: Array<[number, number]>,
  ) {
    this.rows = [...rows];
  }

  select(): this {
    return this;
  }

  eq(key: string, value: unknown): this {
    this.rows = this.rows.filter((row) => row[key] === value);
    return this;
  }

  order(key: string): this {
    this.rows = [...this.rows].sort((a, b) =>
      String(a[key] ?? '').localeCompare(String(b[key] ?? '')),
    );
    return this;
  }

  async range(from: number, to: number): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }> {
    this.rangeCalls.push([from, to]);
    return { data: this.rows.slice(from, to + 1), error: null };
  }

}

function makeOptionsFake(options: FakeOptions = {}, platform = 'instagram') {
  const accountRows: Row[] = Array.from({ length: 2500 }, (_, i) => ({
    id: `acc-${String(i).padStart(4, '0')}`,
    workspace_id: 'ws-1',
    platform,
    display_name: `Account ${String(i).padStart(4, '0')}`,
  }));
  const destinationRows: Row[] = [
    { id: 'dest-1', workspace_id: 'ws-1', platform, section: 'adu', name: 'A', account_id: 'acc-0000' },
    { id: 'dest-2', workspace_id: 'ws-1', platform, section: null, name: 'B', account_id: 'acc-0001' },
  ];
  const configuredRows: Row[] = [
    { workspace_id: 'ws-1', destination_id: 'dest-1', source_platform: platform, source_username: 'a' },
  ];
  const rangeCalls: Record<string, Array<[number, number]>> = {
    social_accounts: [],
    destinations: [],
    adu_configs: [],
  };
  const fake = {
    rangeCalls,
    from(table: string) {
      const q =
        table === 'social_accounts'
          ? new FakeOptionsQuery(accountRows, rangeCalls['social_accounts'])
          : table === 'destinations'
            ? new FakeOptionsQuery(destinationRows, rangeCalls['destinations'])
            : new FakeOptionsQuery(configuredRows, rangeCalls['adu_configs']);
      // Errors are delivered on the first range call of that table.
      const error =
        table === 'social_accounts'
          ? options.accountsError ?? null
          : table === 'destinations'
            ? options.destinationsError ?? null
            : table === 'adu_configs'
              ? options.configuredError ?? null
              : null;
      if (error) {
        const failing = q as unknown as { range: FakeOptionsQuery['range'] };
        failing.range = async () => ({ data: null, error });
      }
      return q;
    },
  };
  return fake as unknown as SupabaseClient & {
    rangeCalls: Record<string, Array<[number, number]>>;
  };
}

describe('loadAduOptionsListsForPlatform', () => {
  it('range-pages past 1,000 rows: all 2,500 accounts come back in order', async () => {
    const fake = makeOptionsFake();
    const lists = await loadAduOptionsListsForPlatform(fake, 'ws-1', 'instagram');
    expect(lists.accounts).toHaveLength(2500);
    expect(lists.accounts[0]).toMatchObject({ id: 'acc-0000' });
    expect(lists.accounts[2499]).toMatchObject({ id: 'acc-2499' });
    // Three 1,000-row range calls: the pager never stops early.
    expect(fake.rangeCalls['social_accounts']).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(lists.destinations).toHaveLength(2);
    expect(lists.configured).toHaveLength(1);
    expect(lists.migrationMissing).toBe(false);
  });

  it('a missing adu_configs table is flagged, not fatal', async () => {
    const fake = makeOptionsFake(
      {
        configuredError: { message: 'relation "adu_configs" does not exist', code: '42P01' },
      },
      'threads',
    );
    const lists = await loadAduOptionsListsForPlatform(fake, 'ws-1', 'threads');
    expect(lists.migrationMissing).toBe(true);
    expect(lists.configured).toEqual([]);
    expect(lists.accounts).toHaveLength(2500);
    expect(lists.destinations).toHaveLength(2);
  });

  it('an accounts failure throws instead of returning an empty picker', async () => {
    const fake = makeOptionsFake({
      accountsError: { message: 'boom', code: 'XX000' },
    });
    await expect(
      loadAduOptionsListsForPlatform(fake, 'ws-1', 'instagram'),
    ).rejects.toThrow('boom');
  });
});

describe('loadAduOptionsListsForPlatform — facebook (F21 collapse)', () => {
  it('facebook: only adu-section destinations are returned', async () => {
    const fake = makeOptionsFake({}, 'facebook');
    const lists = await loadAduOptionsListsForPlatform(fake, 'ws-1', 'facebook');
    expect(lists.accounts).toHaveLength(2500);
    // The section filter drops the schedule-section row (dest-2);
    // the old per-platform loader did the same for Facebook.
    expect(lists.destinations).toHaveLength(1);
    expect(lists.destinations[0]).toMatchObject({ id: 'dest-1', section: 'adu' });
    expect(lists.configured).toHaveLength(1);
    expect(lists.migrationMissing).toBe(false);
  });

  it('facebook: an accounts failure throws the Facebook message when the error carries none', async () => {
    const fake = makeOptionsFake(
      { accountsError: { code: 'XX000' } as { message: string; code?: string } },
      'facebook',
    );
    await expect(
      loadAduOptionsListsForPlatform(fake, 'ws-1', 'facebook'),
    ).rejects.toThrow('Could not load Facebook accounts.');
  });

  it('facebook: a destinations failure throws the Facebook pages message', async () => {
    const fake = makeOptionsFake(
      { destinationsError: { code: 'XX000' } as { message: string; code?: string } },
      'facebook',
    );
    await expect(
      loadAduOptionsListsForPlatform(fake, 'ws-1', 'facebook'),
    ).rejects.toThrow('Could not load Facebook pages.');
  });

  it('facebook: a missing adu_configs table is flagged, not fatal', async () => {
    const fake = makeOptionsFake(
      {
        configuredError: { message: 'relation "adu_configs" does not exist', code: '42P01' },
      },
      'facebook',
    );
    const lists = await loadAduOptionsListsForPlatform(fake, 'ws-1', 'facebook');
    expect(lists.migrationMissing).toBe(true);
    expect(lists.configured).toEqual([]);
    expect(lists.accounts).toHaveLength(2500);
    expect(lists.destinations).toHaveLength(1);
  });

  it('facebook: a non-missing-table configs error throws instead of an empty list', async () => {
    const fake = makeOptionsFake(
      { configuredError: { message: 'db boom', code: '500' } },
      'facebook',
    );
    await expect(
      loadAduOptionsListsForPlatform(fake, 'ws-1', 'facebook'),
    ).rejects.toThrow('db boom');
  });

  it('facebook: error precedence is accounts, then destinations, then configured', async () => {
    const all = makeOptionsFake(
      {
        accountsError: { message: 'accounts boom', code: 'XX000' },
        destinationsError: { message: 'pages boom', code: 'XX000' },
        configuredError: { message: 'configured boom', code: 'XX000' },
      },
      'facebook',
    );
    await expect(
      loadAduOptionsListsForPlatform(all, 'ws-1', 'facebook'),
    ).rejects.toThrow('accounts boom');
    const pages = makeOptionsFake(
      {
        destinationsError: { message: 'pages boom', code: 'XX000' },
        configuredError: { message: 'configured boom', code: 'XX000' },
      },
      'facebook',
    );
    await expect(
      loadAduOptionsListsForPlatform(pages, 'ws-1', 'facebook'),
    ).rejects.toThrow('pages boom');
  });
});
