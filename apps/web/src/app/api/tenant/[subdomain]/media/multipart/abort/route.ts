import { type NextRequest, NextResponse } from 'next/server';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { readJsonBody, enforceIpRateLimit, bodyTooLargeResponse } from '@/lib/request-body';
import {
  MultipartAbortRequestSchema,
  authenticateMultipartRequest,
  assertKeyOwnedBySession,
  getMultipartClient,
} from '../multipart-lib';

/**
 * Multipart step 4 (P3): abort a server-side upload when the user
 * cancels. Best effort by design: an already-completed, already-
 * aborted, or expired upload still answers ok, so cancel never
 * surfaces a storage error to the user. (R2 also aborts
 * incomplete multipart uploads on its own lifecycle.)
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_multipart_abort', 60);
  if (limited) return limited;

  const auth = await authenticateMultipartRequest(request, subdomain);
  if (auth instanceof NextResponse) return auth;
  const { session } = auth;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = MultipartAbortRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const forbidden = assertKeyOwnedBySession(body.key, session);
  if (forbidden) return forbidden;

  const clientOrError = getMultipartClient();
  if (clientOrError instanceof NextResponse) return clientOrError;
  const { client, config } = clientOrError;

  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: config.bucketName,
        Key: body.key,
        UploadId: body.uploadId,
      })
    );
  } catch {
    // Best effort: already gone is fine.
  }
  return NextResponse.json({ ok: true });
}
