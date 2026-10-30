/**
 * @file media-check-duplicates.test.ts
 * @description Supabase-path duplicate detection past the 1,000-row
 * PostgREST cap (P1-20): the old Supabase query filtered only by
 * folder + file size with no paging, so past 1,000 same-size rows
 * the JS name match silently missed the duplicate. The mock below
 * mirrors the cap (an unpaged select returns at most 1,000 rows)
 * while .range() pages return exact windows.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleCheckDuplicates } from '../../src/app/api/tenant/[subdomain]/media/check-duplicates/route';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-0123456789';
const userId = '11111111-1111-4111-a111-111111111111';
const folderId = '22222222-2222-4222-a222-222222222222';

type MockRow = Record<string, unknown>;

function createCappedSupabaseMock(rows: MockRow[]) {
  function builder() {
    const eqs: [string, unknown][] = [];
    const ins: [string, unknown[]][] = [];
    const orders: [string, boolean][] = [];
    let range: [number, number] | null = null;
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        eqs.push([col, val]);
        return chain;
      },
      in: (col: string, vals: unknown[]) => {
        ins.push([col, vals]);
        return chain;
      },
      is: (col: string, val: unknown) => {
        eqs.push([col, val]);
        return chain;
      },
      or: () => chain,
      order: (col: string, opts: { ascending: boolean }) => {
        orders.push([col, opts.ascending]);
        return chain;
      },
      range: (from: number, to: number) => {
        range = [from, to];
        return resolve();
      },
      then: (resolveFn: (v: unknown) => void) => {
        resolveFn(resolve());
      },
    };
    function resolve() {
      let out = [...rows];
      for (const [col, val] of eqs) out = out.filter((r) => r[col] === val);
      for (const [col, vals] of ins) out = out.filter((r) => vals.includes(r[col]));
      for (const [col, asc] of orders) {
        out = [...out].sort((a, b) => {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          return asc ? cmp : -cmp;
        });
      }
      const page =
        range !== null ? out.slice(range[0], range[1] + 1) : out.slice(0, 1000);
      return { data: page, error: null };
    }
    return chain;
  }
  return { from: () => builder() };
}

describe('Supabase-path duplicate detection past the 1,000-row cap', () => {
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  it('finds a duplicate whose row sits past the first 1,000 same-size rows', async () => {
    const fileSize = 10485760;
    const rows: MockRow[] = Array.from({ length: 1001 }, (_, i) => ({
      id: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`,
      user_id: userId,
      folder_id: folderId,
      name: `file-${i}.jpg`,
      file_size: fileSize,
      mime_type: 'image/jpeg',
      media_type: 'image',
      storage_key: `users/${userId}/media/${i}.jpg`,
      url: `https://example.com/${i}.jpg`,
      thumbnail_key: null,
      thumbnail_url: null,
      duration_seconds: null,
      aspect_ratio: '1:1',
      caption_text: null,
      width: 100,
      height: 100,
      created_at: '2026-10-07T10:00:00.000Z',
      updated_at: '2026-10-07T10:00:00.000Z',
    }));
    const supabase = createCappedSupabaseMock(rows);
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/check-duplicates', {
      method: 'POST',
      headers: {
        cookie: validSessionCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folderId,
        entries: [{ clientKey: 'c1', name: 'FILE-1000.JPG', fileSize }],
      }),
    });
    const res = await handleCheckDuplicates(req, 'acme', supabase as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.duplicates).toHaveLength(1);
    expect(data.duplicates[0].clientKey).toBe('c1');
    expect(data.duplicates[0].existingItem.name).toBe('file-1000.jpg');
  });
});
