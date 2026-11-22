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
  it('lists Bulk Delete Posts last in the Facebook group (spec 213)', () => {
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
    ]);
    const bulkDelete = facebook.leaves[facebook.leaves.length - 1];
    expect(bulkDelete?.href).toContain('/bulk-delete-posts');
    expect(facebook.tooltip).toContain('Bulk Delete Posts');
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
