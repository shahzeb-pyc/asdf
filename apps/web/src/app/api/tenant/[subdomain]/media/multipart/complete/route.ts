import { type NextRequest, NextResponse } from 'next/server';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { readJsonBody, enforceIpRateLimit, bodyTooLargeResponse } from '@/lib/request-body';
import { logServerError } from '@/lib/server-analytics';
import { MultipartCompleteRequestSchema } from '@fbuploadpro/contracts';
import {
  authenticateMultipartRequest,
  assertKeyOwnedBySession,
  getMultipartClient,
  isNoSuchUploadError,
  MULTIPART_MAX_FILE_SIZE_BYTES,
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
    // Backstop for the initiate-time cap: sum the ACTUAL uploaded
    // bytes from ListParts (never the client-declared size). A client
    // that declared a smaller size than it uploaded is rejected here
    // and the upload is aborted, so no over-cap object is assembled.
    const totalBytes = parts.reduce((sum, part) => sum + (part.Size ?? 0), 0);
    if (totalBytes > MULTIPART_MAX_FILE_SIZE_BYTES) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucketName,
            Key: body.key,
            UploadId: body.uploadId,
          })
        );
      } catch (abortError) {
        // Best-effort cleanup only: the rejection below is the loud
        // signal, and nothing is assembled either way. An orphaned
        // upload left behind by a failed abort never becomes a file.
        logServerError('[media/multipart/complete] Failed to abort over-cap upload', abortError, {
          source: 'media-multipart-complete',
          subdomain,
        });
      }
      return NextResponse.json(
        { error: 'Multipart upload exceeds the 500 MB limit' },
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
