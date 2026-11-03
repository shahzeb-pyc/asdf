import { type NextRequest, NextResponse } from 'next/server';
import { MuseActivityResponseSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute, getRouteSupabase } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import type { SupabaseClient } from '@supabase/supabase-js';

function dayLabel(date: Date, now: Date): string {
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round(
    (startOf(now) - startOf(date)) / (24 * 60 * 60 * 1000)
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/**
 * Muse activity — Media Library only, Muse-key uploads only.
 * Counts today by type and rows grouped by day, all from
 * agent_activity rows written server-side on media confirm.
 * No browser, queue, or publish activity is included here.
 * The tenant gate is a workspace the user owns (checked by
 * authenticateTenantRoute's cookie session); the data itself
 * is per-user, matching Media Library scoping.
 */
export async function handleMuseActivity(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient,
  now: Date = new Date()
): Promise<NextResponse> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 500 }
    );
  }
  const { data, error } = await supabase
    .from('agent_activity')
    .select('id, media_id, name, media_type, folder_id, created_at')
    .eq('user_id', auth.session.userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    if (error.code === '42P01') {
      return NextResponse.json(
        { error: 'Muse activity is not set up yet' },
        { status: 500 }
      );
    }
    logServerError('[muse/activity] Failed to list activity', error, {
      source: 'muse-activity',
      subdomain,
    });
    return NextResponse.json(
      { error: 'Failed to list activity' },
      { status: 500 }
    );
  }
  const rows = (data ?? []).map((row) => ({
    id: row.id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    folderId: row.folder_id,
    name: row.name,
    createdAt: row.created_at,
  }));
  const todayKey = toISODate(now);
  let videos = 0;
  let images = 0;
  const daysMap = new Map<
    string,
    { label: string; date: string; rows: typeof rows }
  >();
  for (const row of rows) {
    const created = new Date(row.createdAt);
    if (toISODate(created) === todayKey) {
      if (row.mediaType === 'video') videos += 1;
      if (row.mediaType === 'image') images += 1;
    }
    const key = toISODate(created);
    const existing = daysMap.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      daysMap.set(key, {
        label: dayLabel(created, now),
        date: key,
        rows: [row],
      });
    }
  }
  return NextResponse.json(
    MuseActivityResponseSchema.parse({
      today: { videos, images, total: videos + images },
      days: [...daysMap.values()],
    })
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleMuseActivity(request, subdomain);
}
