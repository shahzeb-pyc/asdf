import { type NextRequest, NextResponse } from 'next/server';
import {
  BillingScreenshotUploadUrlRequestSchema,
  BillingScreenshotUploadUrlResponseSchema,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { getStorageService } from '@/lib/storage';
import { enforceIpRateLimit, readJsonBody } from '@/lib/request-body';

/**
 * POST /api/tenant/[subdomain]/billing/payments/screenshot-upload
 * Mint a presigned R2 PUT URL for one manual-payment screenshot
 * (submit rewrite 2026-11-01).
 *
 * The browser uploads the bytes straight to R2, so a multi-MB image
 * never rides a serverless function body — the old multipart payment
 * POST bundled the file with the coupon hold, the R2 write, the DB
 * insert, and the idempotency store into one long request, and any
 * downstream blip surfaced as the generic "could not be submitted"
 * error. Checkout shows this upload's own loading state and blocks
 * submit until it finishes; the payment POST then references the
 * returned key instead of a file.
 *
 * The key is namespaced to the caller (`billing-screenshots/<userId>/`)
 * and unguessable, and the payment route refuses any key outside
 * that namespace. Screenshots never counted against the media
 * library quota, so no quota gate applies here. A presigned PUT
 * carries no server-enforced size bound — the declared size is
 * validated here, and a forged key pointing at nothing is refused
 * by the admin, who approves only with a screenshot in hand.
 * Reusing an old key buys nothing new: re-uploading the same image
 * was always possible, and the screenshot itself is never verified
 * against a payment record.
 */
const SCREENSHOT_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_billing_screenshot_upload', 30);
  if (limited) return limited;

  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const { session } = auth;

  // Admins never buy plans (same rule as the payment route).
  if (session.role === 'admin') {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'Admin accounts do not buy plans.' },
      { status: 403 }
    );
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The screenshot details could not be read.' },
      { status: 400 }
    );
  }
  const parsed = BillingScreenshotUploadUrlRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'The screenshot must be a PNG, JPG, WebP, or GIF image under 10 MB.',
      },
      { status: 400 }
    );
  }
  const { mimeType } = parsed.data;
  const extension = SCREENSHOT_EXTENSIONS[mimeType];
  if (!extension) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'The screenshot must be a PNG, JPG, WebP, or GIF image under 10 MB.',
      },
      { status: 400 }
    );
  }

  const storageKey = `billing-screenshots/${session.userId}/${crypto.randomUUID()}.${extension}`;
  let uploadUrl: string;
  try {
    const result = await getStorageService().getPresignedUploadUrl({
      key: storageKey,
      contentType: mimeType,
      expiresInSeconds: 900,
    });
    uploadUrl = result.uploadUrl;
  } catch {
    return NextResponse.json(
      { error: 'The screenshot upload could not start. Please try again.' },
      { status: 502 }
    );
  }

  const payload = BillingScreenshotUploadUrlResponseSchema.parse({
    storageKey,
    uploadUrl,
    expiresInSeconds: 900,
  });
  return NextResponse.json(payload);
}
