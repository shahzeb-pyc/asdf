import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { ZERO_PLATFORM_COUNTS, type EntitlementResponse } from '@fbuploadpro/contracts';
import { BrandProvider } from '@/components/brand';
import { BrandLogo } from '@/components/brand/brand-logo';
import { AuthSplitLayout } from '@/components/auth/auth-split-layout';
import { LoginShowcasePanel } from '@/components/auth/login-showcase-panel';
import { TopbarPlanPill } from '@/components/shell/topbar-plan-pill';
import { getUserSections } from '@/components/shell/sidebar-sections';
import { PrivacyPolicyContent } from '@/components/privacy/privacy-policy-content';
import { getConnectSuccessCopy } from '@/app/connect/facebook/success/page';
import { getInstagramConnectSuccessCopy } from '@/app/connect/instagram/success/page';
import { getThreadsConnectSuccessCopy } from '@/app/connect/threads/success/page';
import { getConnectErrorCopy } from '@/app/connect/facebook/error/page';

/**
 * Brand sweep (spec 191 §7): every brand-gated surface rendered with
 * the white-label brand must show NextRise and never FBUploadPro.
 * The negative controls render the same surfaces with our brand and
 * assert FBUploadPro is still there — a sweep that cannot fail is
 * theatre.
 */

const entitlementState = vi.hoisted(() => ({
  value: null as EntitlementResponse | null,
}));

vi.mock('@/components/billing/entitlement-provider', () => ({
  useSharedEntitlement: () => ({ entitlement: entitlementState.value }),
}));

function paidEntitlement(): EntitlementResponse {
  const ends = new Date();
  ends.setDate(ends.getDate() + 30);
  return {
    plan: 'paid',
    active: true,
    counts: ZERO_PLATFORM_COUNTS,
    usage: ZERO_PLATFORM_COUNTS,
    periodEndsAt: ends.toISOString(),
    periodStartsAt: null,
    canPost: true,
    readOnly: false,
    reason: null,
    hasPriorPeriod: true,
  };
}

function sectionLabels(): string[] {
  const sections = getUserSections('student1', true, 'nextrise');
  const out: string[] = [];
  for (const section of sections) {
    if (section.label) out.push(section.label);
    for (const item of section.items) {
      if (item.kind === 'leaf') out.push(item.label);
      if (item.kind === 'group') {
        out.push(item.label);
        for (const leaf of item.leaves) out.push(leaf.label);
      }
    }
  }
  return out;
}

describe('brand sweep (spec 191)', () => {
  it('lib/brand.ts stays client-safe: it never imports next/headers', () => {
    // The production build fails when a client-imported module pulls
    // in next/headers (server-only). The headers() read lives in
    // lib/brand-server.ts, imported only by the root layout.
    const source = readFileSync(path.resolve(process.cwd(), 'src/lib/brand.ts'), 'utf8');
    expect(source).not.toContain('next/headers');
  });

  it('BrandLogo renders NextRise, never FBUploadPro, on nextrise', () => {
    const { container } = render(<BrandLogo brand="nextrise" />);
    expect(container.textContent).toContain('NextRise');
    expect(container.textContent).not.toContain('FBUploadPro');
  });

  it('negative control: BrandLogo renders FBUploadPro on our brand', () => {
    const { container } = render(<BrandLogo brand="fbuploadpro" />);
    expect(container.textContent).toContain('FBUploadPro');
  });

  it('AuthSplitLayout + showcase render NextRise, never FBUploadPro, on nextrise', () => {
    const { container } = render(
      <BrandProvider brand="nextrise">
        <AuthSplitLayout
          title="Sign In"
          description="Welcome back."
          showcase={<LoginShowcasePanel />}
        >
          <p>form</p>
        </AuthSplitLayout>
      </BrandProvider>
    );
    expect(container.textContent).toContain('NextRise');
    expect(container.textContent).not.toContain('FBUploadPro');
  });

  it('TopbarPlanPill renders the NextRise days text, never FBUploadPro, on nextrise', () => {
    entitlementState.value = paidEntitlement();
    const { container } = render(
      <BrandProvider brand="nextrise">
        <TopbarPlanPill subdomain="student1" useCleanPaths={false} brand="nextrise" />
      </BrandProvider>
    );
    expect(container.textContent).toContain('30 days left');
    expect(container.textContent).not.toContain('FBUploadPro');
    entitlementState.value = null;
  });

  it('sidebar sections carry no FBUploadPro text on nextrise', () => {
    const text = JSON.stringify(sectionLabels());
    expect(text).not.toContain('FBUploadPro');
    expect(sectionLabels()).not.toContain('Billing');
  });

  it('privacy copy names NextRise Digital, never FBUploadPro, on nextrise', () => {
    const { container } = render(
      <PrivacyPolicyContent lastUpdated="25 October 2026" brandName="NextRise Digital" />
    );
    expect(container.textContent).toContain('NextRise Digital');
    expect(container.textContent).not.toContain('FBUploadPro');
  });

  it('connect copy names the brand, never FBUploadPro, on nextrise', () => {
    const fb = getConnectSuccessCopy({ accountName: 'Amina' }, 'NextRise');
    expect(`${fb.title} ${fb.description}`).not.toContain('FBUploadPro');
    expect(fb.description).toContain('NextRise dashboard');
    const ig = getInstagramConnectSuccessCopy({ accountName: 'Amina' }, 'NextRise');
    expect(`${ig.title} ${ig.description}`).not.toContain('FBUploadPro');
    const th = getThreadsConnectSuccessCopy({ accountName: 'Amina' }, 'NextRise');
    expect(`${th.title} ${th.description}`).not.toContain('FBUploadPro');
    const err = getConnectErrorCopy('account_save_failed', null, 'NextRise');
    expect(err.description).toContain('NextRise dashboard');
    expect(err.description).not.toContain('FBUploadPro');
  });

  it('negative control: connect copy still names FBUploadPro with the default brand', () => {
    const fb = getConnectSuccessCopy({ accountName: 'Amina' });
    expect(fb.description).toContain('FBUploadPro dashboard');
  });
});
