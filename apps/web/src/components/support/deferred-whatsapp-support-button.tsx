'use client';

import dynamic from 'next/dynamic';

/**
 * Deferred WhatsApp support button (spec 152 O3).
 *
 * The support floater is inert until tapped and fixed to the
 * viewport corner, so it has no business in the first-paint bundle:
 * it loads after first paint via `next/dynamic` with `ssr: false`.
 * It is fixed-position, so its late arrival moves no layout — it
 * simply appears in its corner once loaded. When no support number
 * is configured the button renders nothing, exactly as before.
 */
const WhatsAppSupportButton = dynamic(
  () =>
    import('./whatsapp-support-button').then((module) => module.WhatsAppSupportButton),
  { ssr: false }
);

export function DeferredWhatsAppSupportButton() {
  return <WhatsAppSupportButton />;
}
