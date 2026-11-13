import { describe, it, expect } from 'vitest';
import {
  sectionForUsageFeature,
  USAGE_FEATURE_SECTIONS,
} from '../src/domain/subscription.js';
import { DestinationSectionSchema } from '../src/domain/database.js';

/**
 * Spec 174 PR 2B — the usage-feature → section mapping is the
 * single source of truth the register/release paths derive the
 * section from. Every capped feature the app registers today
 * maps to exactly one section; the two mirror features share
 * 'mirror'; legacy publish-now features map to 'publish_now'
 * for the migration backfill (their rows are history). An
 * unknown feature has no section — callers fail loud.
 */
describe('sectionForUsageFeature', () => {
  it('maps each capped feature to its section', () => {
    expect(sectionForUsageFeature('destination-queue')).toBe('schedule');
    expect(sectionForUsageFeature('auto-download-upload')).toBe('adu');
    expect(sectionForUsageFeature('tiktok-mirror')).toBe('mirror');
    expect(sectionForUsageFeature('auto-repost')).toBe('mirror');
  });

  it('maps legacy publish-now features to publish_now (backfill only)', () => {
    expect(sectionForUsageFeature('publish-now')).toBe('publish_now');
    expect(sectionForUsageFeature('instagram-publish-now')).toBe('publish_now');
    expect(sectionForUsageFeature('threads-publish-now')).toBe('publish_now');
  });

  it('returns null for an unknown feature instead of inventing a section', () => {
    expect(sectionForUsageFeature('some-future-feature')).toBeNull();
    expect(sectionForUsageFeature('')).toBeNull();
  });

  it('every mapped value is a valid destination section', () => {
    for (const section of Object.values(USAGE_FEATURE_SECTIONS)) {
      expect(DestinationSectionSchema.safeParse(section).success).toBe(true);
    }
  });
});
