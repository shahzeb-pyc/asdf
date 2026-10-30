import { type NextRequest, NextResponse } from 'next/server';
import {
  authenticatePromptRequest,
  getPromptAdminClient,
  logPromptError,
  type PromptDbRow,
} from '@/lib/server/prompt-library';

/**
 * Prompt Library favourite — POST adds, DELETE removes.
 * Both are idempotent: adding an existing favourite, or removing
 * one that is not there, still returns the resulting state.
 * A user can only ever touch their own rows (user_id = session).
 */

type RouteParams = {
  params: Promise<{ subdomain: string; slug: string }>;
};

async function resolvePromptId(
  client: NonNullable<ReturnType<typeof getPromptAdminClient>>,
  slug: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('prompt_library_prompts')
    .select('id, status')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  const prompt = data as Pick<PromptDbRow, 'id' | 'status'> | null;
  if (!prompt || prompt.status !== 'published') return null;
  return prompt.id;
}

export async function POST(
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

  try {
    const promptId = await resolvePromptId(client, slug);
    if (!promptId) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    const { error } = await client
      .from('prompt_library_favourites')
      .upsert(
        { user_id: session.userId, prompt_id: promptId },
        { onConflict: 'user_id,prompt_id' },
      );
    if (error) throw error;
    return NextResponse.json({ slug, isFavourite: true });
  } catch (error) {
    logPromptError('[prompt-library] Add favourite failed', error);
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

  const client = getPromptAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }

  try {
    const promptId = await resolvePromptId(client, slug);
    if (!promptId) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    const { error } = await client
      .from('prompt_library_favourites')
      .delete()
      .eq('user_id', session.userId)
      .eq('prompt_id', promptId);
    if (error) throw error;
    return NextResponse.json({ slug, isFavourite: false });
  } catch (error) {
    logPromptError('[prompt-library] Remove favourite failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
