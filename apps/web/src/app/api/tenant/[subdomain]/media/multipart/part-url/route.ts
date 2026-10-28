import { type NextRequest, NextResponse } from 'next/server';
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readJsonBody, enforceIpRateLimit, bodyTooLargeResponse } from '@/lib/request-body';
import { MultipartPartUrlRequestSchema } from '@fbuploadpro/contracts';
import {
  authenticateMultipartRequest,
  assertKeyOwnedBySession,
  getMultipartClient,
  isNoSuchUploadError,
  noSuchUploadResponse,
} from '../multipart-lib';

/**
 * Multipart step 2a (P3): presign one part. Minted fresh on every
 * attempt, so a URL that expired while the file was paused can
 * never strand a large upload — the client simply presigns again.
 * Rate limit is generous on purpose: a 500 MB file is ~63 parts,
 * and three files upload concurrently.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_multipart_part', 300);
  if (limited) return limited;

  const auth = await authenticateMultipartRequest(request, subdomain);
  if (auth instanceof NextResponse) return auth;
  const { session } = auth;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = MultipartPartUrlRequestSchema.safeParse(bodyResult.value);
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
    const uploadUrl = await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: config.bucketName,
        Key: body.key,
        UploadId: body.uploadId,
        PartNumber: body.partNumber,
      }),
      { expiresIn: 900 }
    );
    return NextResponse.json({ uploadUrl, expiresInSeconds: 900 });
  } catch (error) {
    if (isNoSuchUploadError(error)) return noSuchUploadResponse();
    throw error;
  }
}
