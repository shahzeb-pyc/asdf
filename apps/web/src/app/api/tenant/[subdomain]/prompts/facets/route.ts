import { type NextRequest, NextResponse } from 'next/server';
import { PromptFacetsSchema } from '@fbuploadpro/contracts';
import {
  authenticatePromptRequest,
  getPromptAdminClient,
  logPromptError,
} from '@/lib/server/prompt-library';

/**
 * Prompt Library facets — GET only.
 *
 * Returns, for published prompts ONLY, the distinct values actually
 * present, with counts, for Category, Tool, Language, and Length.
 * Draft prompts never contribute, and a value no published prompt
 * uses simply does not appear — empty categories disappear on
 * their own, and a value appears automatically once a prompt uses
 * it. The facets are computed from ALL published prompts,
 * unfiltered by the current search/filters, so selecting one
 * filter never hides the other options.
 *
 * Ordering: count descending, then value alphabetically on ties.
 * The frontend preserves this order; it does not re-sort.
 *
 * Bounded reads only: rows are fetched in pages of 1,000 (never
 * one unbounded SELECT — PostgREST silently truncates at 1,000
 * rows), looping until a short page ends the scan. The catalogue
 * is admin-curated and small, so this loop is short in practice.
 *
 * LIMIT (not changed here): the DB CHECK constraints still gate
 * which values an admin can insert. A brand-new value needs a
 * migration to the CHECK before any prompt can use it; facets are
 * dynamic only within the values the DB already allows.
 */

type RouteParams = { params: Promise<{ subdomain: string }> };

type FacetRow = {
  category: string;
  tool: string;
  language: string;
  video_length_bucket: string;
};

function tally(
  rows: readonly FacetRow[],
  pick: (row: FacetRow) => string,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = pick(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
}

export async function GET(
  request: NextRequest,
  context: RouteParams,
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticatePromptRequest(request, subdomain);
  if ('error' in auth) return auth.error;

  const client = getPromptAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }

  try {
    const rows: FacetRow[] = [];
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await client
        .from('prompt_library_prompts')
        .select('category,tool,language,video_length_bucket')
        .eq('status', 'published')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const page = (data ?? []) as FacetRow[];
      rows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }

    const response = PromptFacetsSchema.parse({
      category: tally(rows, (row) => row.category),
      tool: tally(rows, (row) => row.tool),
      language: tally(rows, (row) => row.language),
      length: tally(rows, (row) => row.video_length_bucket),
    });
    return NextResponse.json(response);
  } catch (error) {
    logPromptError('[prompt-library] Facets failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
