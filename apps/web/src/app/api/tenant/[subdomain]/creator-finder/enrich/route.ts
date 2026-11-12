import { type NextRequest, NextResponse } from 'next/server';
import {
  CreatorEnrichRequestSchema,
  CreatorEnrichResponseSchema,
  enrichCreators,
} from '@fbuploadpro/contracts';
import {
  getCreatorFinderSession,
  getCreatorFinderSupabase,
  getCreatorFinderWorkspaceId,
  saveCreatorsToDb,
  startServerTiming,
} from '../lib';

/**
 * Return-first enrichment (spec 169): the page POSTs the creators a search
 * just returned, and this route enriches them, saves the enriched versions,
 * and returns them. The search response itself no longer waits for any of
 * this. Enrichment is bounded (5s per Countik leg, 10s overall budget):
 * a creator not finished inside the budget comes back countikUnavailable,
 * exactly like a per-creator failure — never a failed request. The save
 * reuses the search-time merge semantics; a failed save is reported via
 * saveFailed, never as an error. Not cap-gated: Countik calls were never
 * counted against the daily cap.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const timing = startServerTiming();
  const { session, errorResponse } = await getCreatorFinderSession(
    request,
    subdomain,
  );
  if (errorResponse) return errorResponse;
  timing.split('session');
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = CreatorEnrichRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Creators to enrich are invalid.' },
      { status: 400 },
    );
  }
  const { source, searchTerm, creators } = parsed.data;
  const seen = new Set<string>();
  const unique = creators.filter((creator) => {
    if (seen.has(creator.handle)) return false;
    seen.add(creator.handle);
    return true;
  });
  const enriched = await enrichCreators(unique);
  timing.split('enrich');
  // Auto-save: results still render if the save fails; the response
  // carries saveFailed so the page warns visibly.
  let saveFailed = false;
  try {
    const supabase = getCreatorFinderSupabase();
    const workspaceId = await getCreatorFinderWorkspaceId(
      supabase,
      subdomain,
      session,
    );
    if (!supabase || !workspaceId) {
      saveFailed = true;
    } else {
      saveFailed = !(await saveCreatorsToDb(
        supabase,
        workspaceId,
        session.userId,
        enriched,
        source,
        searchTerm,
      ));
    }
  } catch {
    saveFailed = true;
  }
  timing.split('save');
  return NextResponse.json(
    CreatorEnrichResponseSchema.parse({ creators: enriched, saveFailed }),
    { headers: { 'Server-Timing': timing.header() } },
  );
}
