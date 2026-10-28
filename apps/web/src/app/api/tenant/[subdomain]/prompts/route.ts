import { type NextRequest, NextResponse } from 'next/server';
import {
  PromptCreateSchema,
  PromptListQuerySchema,
  PromptListResponseSchema,
} from '@fbuploadpro/contracts';
import {
  authenticatePromptRequest,
  escapeIlikePattern,
  getPromptAdminClient,
  getPromptPublicUrl,
  logPromptError,
  requirePromptAdmin,
  slugifyPromptTitle,
  toPromptCreateRow,
  toPromptListItem,
  type PromptDbRow as Row,
} from '@/lib/server/prompt-library';

/**
 * Prompt Library list + admin create.
 *
 * GET: published prompts only, paginated (pageSize capped at 50 by
 * the contracts query schema — never an unbounded SELECT).
 * POST: ADMIN ONLY. Prompts are never uploaded by users; every new
 * prompt is added by US via this backend route. A non-admin gets
 * 403, and a published prompt is rejected unless its preview and
 * poster keys live under the prompts/ R2 prefix.
 */

type RouteParams = { params: Promise<{ subdomain: string }> };

export async function GET(
  request: NextRequest,
  context: RouteParams,
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticatePromptRequest(request, subdomain);
  if ('error' in auth) return auth.error;
  const { session } = auth;

  const parsed = PromptListQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_QUERY', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const query = parsed.data;

  const client = getPromptAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }
  const publicUrl = getPromptPublicUrl();
  if (!publicUrl) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }

  try {
    let dbQuery = client
      .from('prompt_library_prompts')
      .select('*', { count: 'exact' })
      .eq('status', 'published');

    if (query.category) dbQuery = dbQuery.eq('category', query.category);
    if (query.tool) dbQuery = dbQuery.eq('tool', query.tool);
    if (query.language) dbQuery = dbQuery.eq('language', query.language);
    if (query.length) dbQuery = dbQuery.eq('video_length_bucket', query.length);
    if (query.format) dbQuery = dbQuery.eq('format', query.format);
    if (query.search) {
      const pattern = `%${escapeIlikePattern(query.search)}%`;
      dbQuery = dbQuery.or(
        `title.ilike.${pattern},short_description.ilike.${pattern}`,
      );
    }

    if (query.sort === 'most_copied') {
      dbQuery = dbQuery.order('copied_count', { ascending: false });
    } else if (query.sort === 'a_to_z') {
      dbQuery = dbQuery.order('title', { ascending: true });
    } else {
      dbQuery = dbQuery.order('created_at', { ascending: false });
    }

    const from = (query.page - 1) * query.pageSize;
    const to = from + query.pageSize - 1;
    const { data, count, error } = await dbQuery.range(from, to);
    if (error) throw error;

    const rows = (data ?? []) as Row[];
    const favouriteIds = new Set<string>();
    if (rows.length > 0) {
      const { data: favs, error: favError } = await client
        .from('prompt_library_favourites')
        .select('prompt_id')
        .eq('user_id', session.userId)
        .in(
          'prompt_id',
          rows.map((row) => row.id),
        );
      if (favError) throw favError;
      for (const fav of favs ?? []) {
        favouriteIds.add((fav as { prompt_id: string }).prompt_id);
      }
    }

    const response = PromptListResponseSchema.parse({
      items: rows.map((row) =>
        toPromptListItem(row, publicUrl, favouriteIds.has(row.id)),
      ),
      total: count ?? rows.length,
      page: query.page,
      pageSize: query.pageSize,
    });
    return NextResponse.json(response);
  } catch (error) {
    logPromptError('[prompt-library] List prompts failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: RouteParams,
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticatePromptRequest(request, subdomain);
  if ('error' in auth) return auth.error;
  const { session } = auth;

  const forbidden = requirePromptAdmin(session.role);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }
  const parsed = PromptCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_BODY', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const client = getPromptAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }

  const slug = input.slug ?? slugifyPromptTitle(input.title);
  try {
    const { data: existing } = await client
      .from('prompt_library_prompts')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: 'SLUG_ALREADY_EXISTS' },
        { status: 409 },
      );
    }

    const row = toPromptCreateRow(input, slug, session.userId);
    const { data: inserted, error: insertError } = await client
      .from('prompt_library_prompts')
      .insert(row)
      .select('*')
      .single();
    if (insertError) throw insertError;
    const prompt = inserted as Row;

    const steps = input.steps.map((step) => ({
      prompt_id: prompt.id,
      position: step.position,
      title: step.title ?? null,
      body: step.body,
    }));
    const { error: stepsError } = await client
      .from('prompt_library_how_to_steps')
      .insert(steps);
    if (stepsError) {
      // Roll back the prompt rather than leaving a step-less prompt.
      await client
        .from('prompt_library_prompts')
        .delete()
        .eq('id', prompt.id);
      throw stepsError;
    }

    const publicUrl = getPromptPublicUrl();
    if (!publicUrl) {
      return NextResponse.json(
        { error: 'SERVICE_UNAVAILABLE' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        slug: prompt.slug,
        id: prompt.id,
      },
      { status: 201 },
    );
  } catch (error) {
    logPromptError('[prompt-library] Create prompt failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
