/**
 * Creator Finder daily upstream-call cap — server-side counter.
 *
 * One row per user per Asia/Karachi calendar day in
 * `creator_finder_daily_usage` (see migration
 * 20261101163000_creator_finder_daily_usage.sql). The routes
 * read the count at the START of a discovery request and block
 * with 429 once it reaches CREATOR_FINDER_DAILY_LIMIT; every
 * upstream HTTP attempt inside a started request increments the
 * counter through the atomic `increment_creator_finder_usage`
 * RPC, so concurrent requests can never lose an increment and
 * a request that crosses the cap mid-flight still completes.
 *
 * Fail loud: every counter read/write failure throws
 * CreatorFinderUsageError and the route fails with a clear 503
 * instead of proceeding ungated or blocking silently. Admins
 * bypass entirely — never gated, never counted, no database
 * touch at all.
 */

import {
  CREATOR_FINDER_DAILY_LIMIT,
  CreatorFinderDailyLimitExceededBodySchema,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const CREATOR_FINDER_USAGE_TABLE = 'creator_finder_daily_usage';
export const CREATOR_FINDER_USAGE_RPC = 'increment_creator_finder_usage';

/** Counter failure: the route maps this to a plain 503, never a silent pass. */
export class CreatorFinderUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorFinderUsageError';
  }
}

/** Log a counter failure server-side (code + reason, never user data). */
function logUsageDbError(context: string, error: unknown): void {
  const record = error as { code?: unknown; message?: unknown } | null;
  const code =
    record && typeof record.code === 'string' ? record.code : 'UNKNOWN';
  const message =
    record && typeof record.message === 'string'
      ? record.message
      : 'unknown database error';
  console.error(
    `[creator-finder] usage ${context} failed: code=${code} message=${message}`,
  );
}

/**
 * Asia/Karachi calendar date (YYYY-MM-DD) for the given moment.
 * Built from formatToParts, never from a locale-ordered string,
 * and never from a client-supplied date: the day boundary is
 * the user's timezone, not UTC.
 */
export function getCreatorFinderUsageDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Calls used today for this user (0 when no row exists yet).
 * Throws CreatorFinderUsageError on any database failure — the
 * caller must fail the request, never treat a failed read as 0.
 */
export async function getCreatorFinderUsageCount(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<number> {
  let data: unknown;
  let error: unknown;
  try {
    const result = await supabase
      .from(CREATOR_FINDER_USAGE_TABLE)
      .select('call_count')
      .eq('user_id', userId)
      .eq('usage_date', date)
      .maybeSingle();
    data = result.data;
    error = result.error;
  } catch (err) {
    logUsageDbError('read', err);
    throw new CreatorFinderUsageError(
      'Creator search usage could not be checked. Please try again.',
    );
  }
  if (error) {
    logUsageDbError('read', error);
    throw new CreatorFinderUsageError(
      'Creator search usage could not be checked. Please try again.',
    );
  }
  const record = data as { call_count?: unknown } | null;
  return typeof record?.call_count === 'number' ? record.call_count : 0;
}

/**
 * Atomically add one upstream call to today's counter and return
 * the new count. Throws CreatorFinderUsageError on any failure —
 * the in-flight request fails loudly rather than proceeding
 * uncounted.
 */
export async function incrementCreatorFinderUsage(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<number> {
  let data: unknown;
  let error: unknown;
  try {
    const result = await supabase.rpc(CREATOR_FINDER_USAGE_RPC, {
      p_user_id: userId,
      p_usage_date: date,
    });
    data = result.data;
    error = result.error;
  } catch (err) {
    logUsageDbError('increment', err);
    throw new CreatorFinderUsageError(
      'Creator search usage could not be recorded. Please try again.',
    );
  }
  if (error) {
    logUsageDbError('increment', error);
    throw new CreatorFinderUsageError(
      'Creator search usage could not be recorded. Please try again.',
    );
  }
  if (typeof data !== 'number') {
    logUsageDbError('increment', new Error('RPC returned a non-number'));
    throw new CreatorFinderUsageError(
      'Creator search usage could not be recorded. Please try again.',
    );
  }
  return data;
}

export type CreatorFinderDiscoveryGate =
  | {
      blocked: true;
      used: number;
      limit: number;
      date: string;
    }
  | {
      blocked: false;
      used: number;
      limit: number;
      date: string;
      /** Increment once per upstream attempt; throws on failure. */
      onUpstreamCall: () => Promise<void>;
    };

/**
 * Gate a discovery request. Admins return ungated with a no-op
 * counter and no database touch. Everyone else: the counter must
 * be readable (a null client or a failed read throws) and the
 * request is blocked exactly at the limit — 99 proceeds, 100
 * blocks with no upstream call made. The returned
 * onUpstreamCall is what the fetcher calls per attempt; a
 * request that crosses the cap mid-flight is never stopped by
 * it, only the next request's gate blocks.
 */
export async function startCreatorFinderDiscovery(args: {
  supabase: SupabaseClient | null;
  userId: string;
  role: string;
  now?: Date | undefined;
}): Promise<CreatorFinderDiscoveryGate> {
  const date = getCreatorFinderUsageDate(args.now);
  if (args.role === 'admin') {
    return {
      blocked: false,
      used: 0,
      limit: CREATOR_FINDER_DAILY_LIMIT,
      date,
      onUpstreamCall: async () => {},
    };
  }
  if (!args.supabase) {
    throw new CreatorFinderUsageError(
      'Creator search is not available right now. Please try again.',
    );
  }
  const supabase = args.supabase;
  const used = await getCreatorFinderUsageCount(supabase, args.userId, date);
  if (used >= CREATOR_FINDER_DAILY_LIMIT) {
    return {
      blocked: true,
      used,
      limit: CREATOR_FINDER_DAILY_LIMIT,
      date,
    };
  }
  return {
    blocked: false,
    used,
    limit: CREATOR_FINDER_DAILY_LIMIT,
    date,
    onUpstreamCall: async () => {
      await incrementCreatorFinderUsage(supabase, args.userId, date);
    },
  };
}

/**
 * 429 for a request blocked by the daily cap: no upstream call
 * was made. The body carries the dailyLimitExceeded flag so the
 * page can show its distinct 'Daily limit exceeded' message
 * instead of a generic error.
 */
export function creatorFinderDailyLimitResponse(): NextResponse {
  return NextResponse.json(
    CreatorFinderDailyLimitExceededBodySchema.parse({
      error: 'DAILY_LIMIT_EXCEEDED',
      message: 'Daily limit exceeded',
      dailyLimitExceeded: true,
    }),
    { status: 429 },
  );
}

/**
 * 503 for a counter failure, or null when the error is not a
 * counter failure (the caller then falls through to its normal
 * error mapping). Counter failures never become silent passes.
 */
export function creatorFinderUsageErrorResponse(
  err: unknown,
): NextResponse | null {
  if (err instanceof CreatorFinderUsageError) {
    return NextResponse.json(
      { error: 'USAGE_UNAVAILABLE', message: err.message },
      { status: 503 },
    );
  }
  return null;
}
