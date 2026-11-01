import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as listIssues, POST as dismissIssue } from '@/app/api/tenant/[subdomain]/billing/admin/webhook-issues/route';

/**
 * Admin webhook-issues route (audit fix 2026-11-01, fix 22):
 * unknown/mismatched/underpaid webhook events surface in an
 * admin-visible list instead of being swallowed, and dismissing
 * one removes it from the open list.
 */

const authState = vi.hoisted(() => ({ role: 'admin' }));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
      subdomain: 'acme',
      role: authState.role,
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;

let issues: Row[];

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  private orderDesc: string | null = null;

  constructor(private table: string) {}

  select(): this {
    return this;
  }

  insert(row: Row): this {
    if (this.table === 'subscription_webhook_issues') {
      issues.push({ ...row });
    }
    return this;
  }

  update(patch: Row): this {
    this.patch = patch;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    if (opts?.ascending === false) this.orderDesc = col;
    return this;
  }

  limit(): this {
    return this;
  }

  single(): this {
    return this;
  }

  maybeSingle(): this {
    return this;
  }

  private matched(): Row[] {
    let rows = issues.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderDesc) {
      rows = [...rows].sort((a, b) =>
        String(b[this.orderDesc as string]).localeCompare(String(a[this.orderDesc as string]))
      );
    }
    return rows;
  }

  then(resolve: (value: { data: unknown; error: null }) => void): void {
    if (this.patch) {
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.patch);
      resolve({ data: matched.map((r) => ({ id: r['id'] })), error: null });
      return;
    }
    resolve({ data: this.matched(), error: null });
  }
}

const fakeClient = {
  from(table: string): FakeBuilder {
    return new FakeBuilder(table);
  },
};

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => fakeClient,
  };
});

function issueRow(overrides: Row = {}): Row {
  return {
    id: 'issue-1',
    provider: 'nowpayments',
    provider_payment_id: 'np-1',
    payment_id: null,
    reason: 'unknown_payment',
    detail: 'No payment matches this provider id.',
    dismissed_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const ctx = { params: Promise.resolve({ subdomain: 'acme' }) } as never;

describe('admin webhook-issues route', () => {
  beforeEach(() => {
    authState.role = 'admin';
    issues = [
      issueRow({ id: 'issue-old', created_at: '2026-06-01T00:00:00.000Z' }),
      issueRow({ id: 'issue-new', created_at: '2026-06-02T00:00:00.000Z' }),
      issueRow({ id: 'issue-dismissed', dismissed_at: '2026-06-03T00:00:00.000Z' }),
    ];
  });

  it('refuses non-admins with 403', async () => {
    authState.role = 'user';
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/webhook-issues');
    const res = await listIssues(req, ctx);
    expect(res.status).toBe(403);
  });

  it('lists open issues newest first, excluding dismissed ones', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/webhook-issues');
    const res = await listIssues(req, ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { issues: Array<{ id: string; reason: string }> };
    expect(json.issues.map((i) => i.id)).toEqual(['issue-new', 'issue-old']);
    expect(json.issues[0]?.reason).toBe('unknown_payment');
  });

  it('dismisses an open issue', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/billing/admin/webhook-issues',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueId: 'issue-old' }),
      }
    );
    const res = await dismissIssue(req, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()) as { dismissed: boolean }).toEqual({ dismissed: true });
    expect(issues.find((i) => i.id === 'issue-old')).toMatchObject({ dismissed_at: expect.any(String) });
  });

  it('dismissing a missing issue returns 404', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/billing/admin/webhook-issues',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueId: 'no-such-issue' }),
      }
    );
    const res = await dismissIssue(req, ctx);
    expect(res.status).toBe(404);
  });

  it('dismissing without an issueId returns 400', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/billing/admin/webhook-issues',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    );
    const res = await dismissIssue(req, ctx);
    expect(res.status).toBe(400);
  });
});
