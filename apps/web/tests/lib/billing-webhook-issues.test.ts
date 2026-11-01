/**
 * Webhook-issues lib: row mapping and best-effort failure branches.
 * The webhook must never fail because its admin-visible issue row
 * could not be written, and a malformed row must never crash the
 * admin list.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;

class FakeBuilder {
  private op: 'insert' | 'select' | 'update' = 'select';
  private row: Row | null = null;
  private patch: Row | null = null;
  private filters: Array<(r: Row) => boolean> = [];
  private singleMode = false;

  constructor(
    private rows: Row[],
    private errorOnce: { code: string } | null
  ) {}

  insert(row: Row): this {
    this.op = 'insert';
    this.row = row;
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  select(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  order(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  single(): this {
    this.singleMode = true;
    return this;
  }

  then(resolve: (value: { data: unknown; error: { code: string } | null }) => void): void {
    if (this.errorOnce) {
      const error = this.errorOnce;
      this.errorOnce = null;
      resolve({ data: null, error });
      return;
    }
    if (this.op === 'insert' && this.row) {
      this.rows.push(this.row);
      resolve({ data: [this.row], error: null });
      return;
    }
    if (this.op === 'update' && this.patch) {
      const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
      for (const row of matched) Object.assign(row, this.patch);
      resolve({ data: matched.map((r) => ({ id: r['id'] })), error: null });
      return;
    }
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    resolve({ data: this.singleMode ? (matched[0] ?? null) : matched, error: null });
  }
}

function issueRow(overrides: Row = {}): Row {
  return {
    id: 'issue-1',
    provider: 'nowpayments',
    provider_payment_id: 'np-1',
    payment_id: 'payment-1',
    reason: 'unknown_payment',
    detail: 'no payment found',
    dismissed_at: null,
    created_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('webhookIssueFromRow', () => {
  it('maps a valid row', async () => {
    const { webhookIssueFromRow } = await import('@/lib/billing/webhook-issues');
    expect(webhookIssueFromRow(issueRow())).toMatchObject({
      id: 'issue-1',
      providerPaymentId: 'np-1',
      reason: 'unknown_payment',
    });
  });

  it('returns null for a malformed or unknown-reason row', async () => {
    const { webhookIssueFromRow } = await import('@/lib/billing/webhook-issues');
    expect(webhookIssueFromRow({ ...issueRow(), reason: 'bogus' })).toBeNull();
    expect(webhookIssueFromRow({ ...issueRow(), provider_payment_id: null })).toBeNull();
  });
});

describe('recordWebhookIssue failure branches', () => {
  it('a non-duplicate insert error returns false, never throws', async () => {
    const { recordWebhookIssue } = await import('@/lib/billing/webhook-issues');
    const rows: Row[] = [];
    const client = {
      from: () => new FakeBuilder(rows, { code: '500' }),
    } as never;
    await expect(
      recordWebhookIssue(client, {
        providerPaymentId: 'np-1',
        paymentId: null,
        reason: 'unknown_payment',
        detail: null,
      })
    ).resolves.toBe(false);
  });

  it('a duplicate open issue is a no-op success', async () => {
    const { recordWebhookIssue } = await import('@/lib/billing/webhook-issues');
    const rows: Row[] = [];
    const client = {
      from: () => new FakeBuilder(rows, { code: '23505' }),
    } as never;
    await expect(
      recordWebhookIssue(client, {
        providerPaymentId: 'np-1',
        paymentId: null,
        reason: 'unknown_payment',
        detail: null,
      })
    ).resolves.toBe(true);
  });
});

describe('listOpenWebhookIssues failure branch', () => {
  it('a list error returns an empty list, never throws', async () => {
    const { listOpenWebhookIssues } = await import('@/lib/billing/webhook-issues');
    const client = {
      from: () => new FakeBuilder([issueRow()], { code: '500' }),
    } as never;
    await expect(listOpenWebhookIssues(client)).resolves.toEqual([]);
  });
});

describe('dismissWebhookIssue failure branch', () => {
  it('a dismiss error returns false, never throws', async () => {
    const { dismissWebhookIssue } = await import('@/lib/billing/webhook-issues');
    const rows: Row[] = [issueRow()];
    const client = {
      from: () => new FakeBuilder(rows, { code: '500' }),
    } as never;
    await expect(dismissWebhookIssue(client, 'issue-1')).resolves.toBe(false);
    expect(rows[0]['dismissed_at']).toBeNull();
  });
});
