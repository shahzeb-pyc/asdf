import { type NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { createR2S3Client, getR2Config } from '@/lib/storage';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';

/**
 * GET .../admin/payments/[paymentId]/screenshot
 * Admin only. Streams the payment screenshot from R2 — the
 * screenshot is never given a public URL, and non-admins get
 * 403 before any storage access. The content type comes from
 * the stored key's extension, because the payment row stores
 * only the key.
 */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; paymentId: string }> }
): Promise<NextResponse> {
  const { subdomain, paymentId } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  const config = getR2Config();
  if (!config) {
    return NextResponse.json(
      { error: 'Screenshots are not available right now. Please try again.' },
      { status: 503 }
    );
  }

  try {
    const { data, error } = await client
      .from('subscription_payments')
      .select('screenshot_storage_key')
      .eq('id', paymentId)
      .maybeSingle();
    const key =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['screenshot_storage_key']
        : null;
    if (error) {
      logServerError('[billing] screenshot lookup failed', error, {
        source: 'billing',
        paymentId,
      });
      return NextResponse.json(
        { error: 'Screenshot could not be loaded. Please try again.' },
        { status: 500 }
      );
    }
    if (typeof key !== 'string' || key.length === 0 || key.includes('..')) {
      return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
    }
    const extension = key.split('.').pop() ?? '';
    const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';
    const s3 = createR2S3Client(config);
    const object = await s3.send(
      new GetObjectCommand({ Bucket: config.bucketName, Key: key })
    );
    const body = object.Body as
      | { transformToByteArray: () => Promise<Uint8Array> }
      | undefined;
    if (!body || typeof body.transformToByteArray !== 'function') {
      return NextResponse.json(
        { error: 'Screenshot could not be read. Please try again.' },
        { status: 502 }
      );
    }
    const bytes = await body.transformToByteArray();
    return new NextResponse(bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    logServerError('[billing] screenshot stream failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Screenshot could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}
