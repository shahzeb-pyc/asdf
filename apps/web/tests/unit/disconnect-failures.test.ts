/**
 * Failure-path tests for the spec 174 2A disconnect helper
 * (`lib/connect/disconnect.ts`) and the account-sourced ADU cap-key
 * lookup (`aduAccountKeysForCap` in `lib/server/adu.ts`).
 *
 * Sonar's new-code gate (80%) counts these fail-loud throws: every
 * database failure in the new Supabase paths must throw loudly, and
 * the only way to prove a throw is to force the failure. The fake
 * below returns a configured error per (table, mode) so each throw
 * is exercised exactly once. The legacy paths throw inside
 * `legacy.query` itself and are covered by the disconnect route
 * tests; these tests pin the Supabase paths.
 */
import { describe, expect, it } from 'vitest';
import {
  disconnectAccountRow,
  stripDestinationCopiesForAccount,
} from '@/lib/connect/disconnect';
import { aduAccountKeysForCap } from '@/lib/server/adu';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

interface FailSpec {
  table: string;
  mode: 'select' | 'update' | 'delete';
  message: string;
}

class FailingBuilder {
  private mode: 'select' | 'update' | 'delete' = 'select';

  constructor(
    private readonly table: string,
    private readonly rows: Row[],
    private readonly failOn: FailSpec[]
  ) {}

  select(): this {
    return this;
  }

  eq(): this {
    return this;
  }

  in(): this {
    return this;
  }

  order(): this {
    return this;
  }

  range(): this {
    return this;
  }

  update(): this {
    this.mode = 'update';
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  then<TResult>(
    onFulfilled: (value: {
      data: Row[] | Row | null;
      error: { message: string } | null;
    }) => TResult
  ): Promise<TResult> {
    const fail = this.failOn.find(
      (f) => f.table === this.table && f.mode === this.mode
    );
    if (fail) {
      return Promise.resolve({ data: null, error: { message: fail.message } }).then(
        onFulfilled
      );
    }
    // Selects return the seeded rows; updates/deletes return them as
    // the affected set (the strip counts `data.length`).
    return Promise.resolve({ data: [...this.rows], error: null }).then(onFulfilled);
  }
}

function makeSupabaseFake(opts: {
  destinations?: Row[];
  failOn?: FailSpec[];
}) {
  const destinations = opts.destinations ?? [];
  const failOn = opts.failOn ?? [];
  return {
    from: (table: string) =>
      new FailingBuilder(
        table,
        table === 'destinations' ? destinations : [],
        failOn
      ),
  } as unknown as SupabaseClient;
}

const COPY: Row = {
  id: 'copy-1',
  metadata: { fb_status: 'paused', tasks: ['x'] },
};

describe('disconnect helper — Supabase failure paths (spec 174 2A)', () => {
  it('strip throws Database service unavailable when no Supabase client resolves', async () => {
    // A client that is neither legacy (no .query) nor Supabase-shaped
    // (no .from): getRouteSupabase falls back to the admin client,
    // which is null in tests — so the helper must fail loud.
    await expect(
      stripDestinationCopiesForAccount(
        {} as never,
        'ws-1',
        'acct-1',
        'facebook'
      )
    ).rejects.toThrow('Database service unavailable');
  });

  it('strip throws when loading the account copies fails', async () => {
    const fake = makeSupabaseFake({
      failOn: [{ table: 'destinations', mode: 'select', message: 'db down' }],
    });
    await expect(
      stripDestinationCopiesForAccount(fake as never, 'ws-1', 'acct-1', 'facebook')
    ).rejects.toThrow('Failed to load account destinations: db down');
  });

  it('strip throws when cancelling queued posts fails (copies untouched)', async () => {
    const fake = makeSupabaseFake({
      destinations: [COPY],
      failOn: [{ table: 'queue_items', mode: 'update', message: 'cancel boom' }],
    });
    await expect(
      stripDestinationCopiesForAccount(fake as never, 'ws-1', 'acct-1', 'facebook')
    ).rejects.toThrow('Failed to cancel queued posts: cancel boom');
  });

  it('strip throws when deleting posting times fails', async () => {
    const fake = makeSupabaseFake({
      destinations: [COPY],
      failOn: [{ table: 'posting_slots', mode: 'delete', message: 'slots boom' }],
    });
    await expect(
      stripDestinationCopiesForAccount(fake as never, 'ws-1', 'acct-1', 'facebook')
    ).rejects.toThrow('Failed to delete posting times: slots boom');
  });

  it('strip throws when disconnecting one copy fails', async () => {
    const fake = makeSupabaseFake({
      destinations: [COPY],
      failOn: [{ table: 'destinations', mode: 'update', message: 'strip boom' }],
    });
    await expect(
      stripDestinationCopiesForAccount(fake as never, 'ws-1', 'acct-1', 'facebook')
    ).rejects.toThrow('Failed to disconnect destination: strip boom');
  });

  it('disconnectAccountRow throws Database service unavailable when no Supabase client resolves', async () => {
    await expect(
      disconnectAccountRow({} as never, 'ws-1', 'acct-1', 'facebook')
    ).rejects.toThrow('Database service unavailable');
  });

  it('disconnectAccountRow throws when the account update fails', async () => {
    const fake = makeSupabaseFake({
      failOn: [{ table: 'social_accounts', mode: 'update', message: 'acct boom' }],
    });
    await expect(
      disconnectAccountRow(fake as never, 'ws-1', 'acct-1', 'facebook')
    ).rejects.toThrow('Failed to disconnect account: acct boom');
  });
});

describe('aduAccountKeysForCap — failure path (spec 174 2A)', () => {
  it('throws when the account lookup fails (never a silent pass)', async () => {
    const fake = makeSupabaseFake({
      failOn: [{ table: 'social_accounts', mode: 'select', message: 'lookup boom' }],
    });
    await expect(
      aduAccountKeysForCap(fake, 'ws-1', 'threads', ['acct-1'])
    ).rejects.toThrow('ADU cap key lookup failed: lookup boom');
  });

  it('returns [] without touching the database for an empty account list', async () => {
    const fake = makeSupabaseFake({
      failOn: [{ table: 'social_accounts', mode: 'select', message: 'must not run' }],
    });
    await expect(aduAccountKeysForCap(fake, 'ws-1', 'threads', [])).resolves.toEqual([]);
  });
});
