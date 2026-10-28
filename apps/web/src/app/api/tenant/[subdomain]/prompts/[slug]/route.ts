import { type NextRequest, NextResponse } from 'next/server';
import { PromptUpdateSchema } from '@fbuploadpro/contracts';
import {
  authenticatePromptRequest,
  getPromptAdminClient,
  getPromptPublicUrl,
  isPromptAdmin,
  logPromptError,
  requirePromptAdmin,
  toPromptDetail,
  toPromptUpdateRow,
  validateMergedPrompt,
  type PromptDbRow,
  type PromptStepDbRow,
} from '@/lib/server/prompt-library';

/**
 * Prompt Library detail + admin update/delete, by slug.
 *
 * GET: published prompts for any tenant user; drafts only for admins
 * (anyone else gets 404, not a "draft" leak).
 * PATCH/DELETE: ADMIN ONLY (403 otherwise). PATCH validates the
 * merged row's cross-field invariants and slug uniqueness, and
 * replaces steps only after validating them — if the replacement
 * fails, the previous steps are restored rather than left deleted.
 */

type RouteParams = {
  params: Promise<{ subdomain: string; slug: string }>;
};

async function loadPrompt(
  client: NonNullable<ReturnType<typeof getPromptAdminClient>>,
  slug: string,
) {
  const { data, error } = await client
    .from('prompt_library_prompts')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as PromptDbRow | null;
}

async function loadSteps(
  client: NonNullable<ReturnType<typeof getPromptAdminClient>>,
  promptId: string,
) {
  const { data, error } = await client
    .from('prompt_library_how_to_steps')
    .select('*')
    .eq('prompt_id', promptId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []) as PromptStepDbRow[];
}

export async function GET(
  request: NextRequest,
  context: RouteParams,
): Promise<NextResponse> {
  const { subdomain, slug } = await context.params;
  const auth = await authenticatePromptRequest(request, subdomain);
  if ('error' in auth) return auth.error;
  const { session } = auth;

  const client = getPromptAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }
  const publicUrl = getPromptPublicUrl();
  if (!publicUrl) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }

  try {
    const prompt = await loadPrompt(client, slug);
    if (!prompt) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (prompt.status !== 'published' && !isPromptAdmin(session.role)) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    const steps = await loadSteps(client, prompt.id);
    const { data: fav } = await client
      .from('prompt_library_favourites')
      .select('prompt_id')
      .eq('user_id', session.userId)
      .eq('prompt_id', prompt.id)
      .maybeSingle();
    return NextResponse.json(
      toPromptDetail(prompt, steps, publicUrl, Boolean(fav)),
    );
  } catch (error) {
    logPromptError('[prompt-library] Get prompt failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteParams,
): Promise<NextResponse> {
  const { subdomain, slug } = await context.params;
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
  const parsed = PromptUpdateSchema.safeParse(body);
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

  try {
    const prompt = await loadPrompt(client, slug);
    if (!prompt) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    // Cross-field invariants on the MERGED row, not just the patch.
    const mergedError = validateMergedPrompt({
      format: input.format ?? prompt.format,
      aspectRatio: input.aspectRatio ?? prompt.aspect_ratio,
      previewMediaType:
        input.previewMediaType ?? prompt.preview_media_type,
      previewPosterKey:
        input.previewPosterKey !== undefined
          ? (input.previewPosterKey ?? null)
          : prompt.preview_poster_key,
      previewStorageKey:
        input.previewStorageKey ?? prompt.preview_storage_key,
    });
    if (mergedError) {
      return NextResponse.json({ error: mergedError }, { status: 400 });
    }

    if (input.slug && input.slug !== prompt.slug) {
      const { data: existing } = await client
        .from('prompt_library_prompts')
        .select('id')
        .eq('slug', input.slug)
        .maybeSingle();
      if (existing) {
        return NextResponse.json(
          { error: 'SLUG_ALREADY_EXISTS' },
          { status: 409 },
        );
      }
    }

    const row = toPromptUpdateRow(input);
    if (Object.keys(row).length > 0) {
      const { error } = await client
        .from('prompt_library_prompts')
        .update(row)
        .eq('id', prompt.id);
      if (error) throw error;
    }

    if (input.steps) {
      const previousSteps = await loadSteps(client, prompt.id);
      const { error: deleteError } = await client
        .from('prompt_library_how_to_steps')
        .delete()
        .eq('prompt_id', prompt.id);
      if (deleteError) throw deleteError;
      const { error: insertError } = await client
        .from('prompt_library_how_to_steps')
        .insert(
          input.steps.map((step) => ({
            prompt_id: prompt.id,
            position: step.position,
            title: step.title ?? null,
            body: step.body,
          })),
        );
      if (insertError) {
        // Restore the previous steps rather than leaving none.
        await client.from('prompt_library_how_to_steps').insert(
          previousSteps.map((step) => ({
            prompt_id: prompt.id,
            position: step.position,
            title: step.title,
            body: step.body,
          })),
        );
        throw insertError;
      }
    }

    return NextResponse.json({ slug: input.slug ?? prompt.slug });
  } catch (error) {
    logPromptError('[prompt-library] Update prompt failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteParams,
): Promise<NextResponse> {
  const { subdomain, slug } = await context.params;
  const auth = await authenticatePromptRequest(request, subdomain);
  if ('error' in auth) return auth.error;
  const { session } = auth;

  const forbidden = requirePromptAdmin(session.role);
  if (forbidden) return forbidden;

  const client = getPromptAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }

  try {
    const prompt = await loadPrompt(client, slug);
    if (!prompt) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    // Steps, favourites, and copy events cascade-delete in the DB.
    const { error } = await client
      .from('prompt_library_prompts')
      .delete()
      .eq('id', prompt.id);
    if (error) throw error;
    return NextResponse.json({ deleted: true });
  } catch (error) {
    logPromptError('[prompt-library] Delete prompt failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
