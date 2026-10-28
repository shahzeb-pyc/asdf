import { type NextRequest, NextResponse } from 'next/server';
import {
  authenticatePromptRequest,
  getPromptAdminClient,
  logPromptError,
  type PromptDbRow,
} from '@/lib/server/prompt-library';

/**
 * Prompt Library copy — POST only, RPC only.
 *
 * The browser never writes copied_count. This route resolves the
 * slug to a published prompt, then calls increment_prompt_copy,
 * which increments the counter AND inserts a copy event in one
 * transaction and returns the new count. A draft or missing prompt
 * is a 404, not a count change.
 */

type RouteParams = {
  params: Promise<{ subdomain: string; slug: string }>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const { data, error } = await client
      .from('prompt_library_prompts')
      .select('id, status')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    const prompt = data as Pick<PromptDbRow, 'id' | 'status'> | null;
    if (!prompt || prompt.status !== 'published') {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const userId = UUID_PATTERN.test(session.userId)
      ? session.userId
      : null;
    const { data: newCount, error: rpcError } = await client.rpc(
      'increment_prompt_copy',
      { p_prompt_id: prompt.id, p_user_id: userId },
    );
    if (rpcError) throw rpcError;

    return NextResponse.json({ slug, copiedCount: newCount });
  } catch (error) {
    logPromptError('[prompt-library] Copy prompt failed', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
