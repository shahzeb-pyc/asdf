import type { Metadata } from 'next';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Publish Now' };

/**
 * Publish Now — empty section shell. The contents are not built yet;
 * this route exists only so the sidebar leaf has a destination.
 * It fetches nothing, prefetches nothing, and calls no API.
 */
export default function TenantPublishNowPage() {
  return (
    <div className="mx-auto w-full max-w-300 px-6 py-6">
      <h1 className="text-xl leading-heading font-bold tracking-h1 text-ink">Publish Now</h1>
    </div>
  );
}
