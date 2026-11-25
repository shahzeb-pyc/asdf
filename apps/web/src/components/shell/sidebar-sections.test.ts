import { describe, expect, it } from 'vitest';
import { getUserSections } from './sidebar-sections';

function hrefs(sections: ReturnType<typeof getUserSections>): string[] {
  const out: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      if (item.kind === 'leaf') out.push(item.href);
      if (item.kind === 'group') {
        for (const leaf of item.leaves) out.push(leaf.href);
      }
    }
  }
  return out;
}

function labels(sections: ReturnType<typeof getUserSections>): string[] {
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

describe('getUserSections white-label brand (spec 191)', () => {
  it('lists Analytics last in the Facebook group (spec 241)', () => {
    const sections = getUserSections('acme', true, 'fbuploadpro');
    const facebook = sections
      .flatMap((s) => s.items)
      .find((item) => item.kind === 'group' && item.key === 'facebook');
    expect(facebook?.kind).toBe('group');
    if (facebook?.kind !== 'group') return;
    const facebookLabels = facebook.leaves.map((leaf) => leaf.label);
    expect(facebookLabels).toEqual([
      'Accounts',
      'In-App Schedule',
      'Publish Now',
      'Auto Repost',
      'Auto Download/Upload',
      'Bulk Delete Posts',
      'Analytics',
    ]);
    const analytics = facebook.leaves[facebook.leaves.length - 1];
    expect(analytics?.href).toContain('/analytics');
    expect(facebook.tooltip).toContain('Analytics');
  });

  it('keeps Bulk Delete Posts on nextrise', () => {
    const sections = getUserSections('student1', true, 'nextrise');
    expect(labels(sections)).toContain('Bulk Delete Posts');
  });
  it('drops the Billing section on nextrise — but keeps the Muse leaf', () => {
    const sections = getUserSections('student1', true, 'nextrise');
    const sectionLabels = sections.map((s) => s.label ?? s.key);
    expect(sectionLabels).not.toContain('Billing');
    // Owner reversal 2026-11-15: NextRise students use Muse.
    expect(labels(sections)).toContain('Muse Assistant');
    expect(hrefs(sections).some((h) => h.includes('/muse'))).toBe(true);
    expect(labels(sections)).not.toContain('My Plan');
    expect(labels(sections)).not.toContain('Purchase');
    expect(labels(sections)).not.toContain('Payments');
    expect(labels(sections)).not.toContain('Refund');
    expect(hrefs(sections).some((h) => h.includes('/my-plan'))).toBe(false);
    expect(hrefs(sections).some((h) => h.includes('/purchase'))).toBe(false);
  });

  it('keeps every other section on nextrise', () => {
    const sections = getUserSections('student1', true, 'nextrise');
    expect(labels(sections)).toContain('Home');
    expect(labels(sections)).toContain('Media Library');
    expect(labels(sections)).toContain('Prompt Library');
    expect(labels(sections)).toContain('Creator Finder');
    expect(labels(sections)).toContain('Platforms');
    expect(labels(sections)).toContain('Facebook');
    expect(labels(sections)).toContain('In-App Schedule');
  });

  it('negative control: our brand keeps Billing and Muse', () => {
    const sections = getUserSections('acme', true, 'fbuploadpro');
    expect(labels(sections)).toContain('Billing');
    expect(labels(sections)).toContain('Muse Assistant');
    expect(labels(sections)).toContain('My Plan');
    expect(labels(sections)).toContain('Purchase');
  });

  it('negative control: the default brand is ours', () => {
    const sections = getUserSections('acme', true);
    expect(labels(sections)).toContain('Billing');
    expect(labels(sections)).toContain('Muse Assistant');
  });
});

describe('getUserSections Instagram / Threads (spec 237, spec 251)', () => {
  it('shows Accounts + Publish Now for Instagram and Accounts only for Threads', () => {
    // Spec 237 deleted Instagram and Threads Schedule, Auto Repost
    // and Auto Download/Upload leaves alongside Accounts. Spec 251
    // restores Publish Now for Instagram only — the account IS the
    // target, so it needs no pages step. Threads keeps Accounts
    // only. This test fails on the old code: Instagram used to list
    // Accounts only.
    const sections = getUserSections('acme', true, 'fbuploadpro');
    const groups = sections
      .flatMap((s) => s.items)
      .filter((item) => item.kind === 'group');
    for (const [key, leaves] of [
      ['instagram', ['Accounts', 'Publish Now']],
      ['threads', ['Accounts']],
    ] as const) {
      const group = groups.find((item) => item.kind === 'group' && item.key === key);
      expect(group?.kind).toBe('group');
      if (group?.kind !== 'group') continue;
      expect(group.leaves.map((leaf) => leaf.label)).toEqual(leaves);
      expect(group.leaves[0]?.href).toContain(`/${key}/accounts`);
    }
    const instagramGroup = groups.find(
      (item) => item.kind === 'group' && item.key === 'instagram'
    );
    if (instagramGroup?.kind === 'group') {
      expect(instagramGroup.leaves[1]?.href).toContain('/instagram/publish-now');
    }
    expect(hrefs(sections).some((h) => h.includes('/instagram/schedule'))).toBe(false);
    expect(hrefs(sections).some((h) => h.includes('/instagram/publish-now'))).toBe(true);
    expect(hrefs(sections).some((h) => h.includes('/instagram/auto-repost'))).toBe(false);
    expect(hrefs(sections).some((h) => h.includes('/instagram/auto-download-upload'))).toBe(false);
    expect(hrefs(sections).some((h) => h.includes('/threads/schedule'))).toBe(false);
    expect(hrefs(sections).some((h) => h.includes('/threads/publish-now'))).toBe(false);
    expect(hrefs(sections).some((h) => h.includes('/threads/auto-repost'))).toBe(false);
    expect(hrefs(sections).some((h) => h.includes('/threads/auto-download-upload'))).toBe(false);
  });
});
