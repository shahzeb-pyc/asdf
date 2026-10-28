import { type NextRequest, NextResponse } from 'next/server';
import { CompleteMultipartUploadCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { readJsonBody, enforceIpRateLimit, bodyTooLargeResponse } from '@/lib/request-body';
import {
  MultipartCompleteRequestSchema,
  authenticateMultipartRequest,
  assertKeyOwnedBySession,
  getMultipartClient,
  isNoSuchUploadError,
  noSuchUploadResponse,
} from '../multipart-lib';

/**
 * Multipart step 3 (P3): assemble the parts into the final object.
 * The server lists the parts itself (ListParts) instead of trusting
 * client-reported etags — so the client never needs to read the
 * ETag response header, and no CORS exposed-header dependency
 * exists. A part-count mismatch fails loudly instead of silently
 * assembling a short file.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_multipart_complete', 30);
  if (limited) return limited;

  const auth = await authenticateMultipartRequest(request, subdomain);
  if (auth instanceof NextResponse) return auth;
  const { session } = auth;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = MultipartCompleteRequestSchema.safeParse(bodyResult.value);
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
    const listed = await client.send(
      new ListPartsCommand({
        Bucket: config.bucketName,
        Key: body.key,
        UploadId: body.uploadId,
        MaxParts: 1000,
      })
    );
    const parts = (listed.Parts ?? []).filter(
      (part) => part.PartNumber !== undefined && part.ETag !== undefined
    );
    if (parts.length !== body.expectedPartCount) {
      return NextResponse.json(
        {
          error: `Multipart upload incomplete: expected ${body.expectedPartCount} parts, found ${parts.length}`,
        },
        { status: 400 }
      );
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: config.bucketName,
        Key: body.key,
        UploadId: body.uploadId,
        MultipartUpload: {
          Parts: parts
            .map((part) => ({ ETag: part.ETag as string, PartNumber: part.PartNumber as number }))
            .sort((a, b) => a.PartNumber - b.PartNumber),
        },
      })
    );
    return NextResponse.json({ key: body.key });
  } catch (error) {
    if (isNoSuchUploadError(error)) return noSuchUploadResponse();
    throw error;
  }
}
