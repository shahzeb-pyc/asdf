import * as React from 'react';
import type { Brand } from '@fbuploadpro/contracts';
import { BrandMark } from '@/components/brand';
import { Card } from '@/components/shared/ui/card';

/**
 * Maintenance page content (spec 209).
 *
 * A static, server-rendered terminal state, on the account-suspended
 * pattern: a centred card on the canvas, brand mark + brand name,
 * the ordered copy, and nothing else — no countdown, no fake time,
 * no links off the page. No interactive elements, no client JS.
 * The brand name comes from the request host (the page wrapper
 * resolves it), so the white label reads NextRise Digital and our
 * brand reads FBUploadPro.
 */
export function MaintenanceContent({
  brand,
  brandName,
}: {
  brand: Brand;
  brandName: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4 text-ink">
      <Card className="w-full max-w-110 items-center gap-0 px-6 py-6 text-center">
        <div className="mb-3 flex items-center justify-center gap-2">
          <BrandMark size={32} brand={brand} />
          <span className="text-body leading-heading font-bold tracking-caption text-ink">
            {brandName}
          </span>
        </div>
        <h1 className="mb-2 text-xl leading-heading font-bold tracking-h2 text-ink">
          Under maintenance
        </h1>
        <p className="text-body leading-body text-ink-sub">
          We&apos;ll be back in an hour.
        </p>
      </Card>
    </main>
  );
}
