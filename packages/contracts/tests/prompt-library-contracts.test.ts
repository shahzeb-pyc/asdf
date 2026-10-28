import { describe, expect, it } from 'vitest';
import {
  formatExactDurationSeconds,
  isPromptLibraryStorageKey,
  PromptCreateSchema,
  PromptDetailSchema,
  PromptFacetsSchema,
  PromptListItemSchema,
  PromptListQuerySchema,
  promptFormatMatchesAspectRatio,
  promptLengthDisplay,
  PromptUpdateSchema,
} from '../src/domain/prompt-library.js';

// Note: slug derivation (slugify) lives in the web server layer,
// not contracts — the contracts slug rule is the regex on
// PromptCreateSchema.slug.

const validCreate = {
  slug: 'puppy-first-bath',
  title: 'Puppy first bath',
  shortDescription: 'A golden puppy first bath.',
  masterPrompt: 'A golden puppy in a bathtub.',
  steps: [{ position: 1, body: 'Open your video tool.' }],
  tool: 'dola_ai',
  category: 'animals',
  language: 'en',
  length: '1min_plus',
  format: 'vertical_reel',
  aspectRatio: '9:16',
  media: [
    {
      position: 1,
      mediaType: 'video',
      storageKey: 'prompts/abc/preview.mp4',
      posterKey: 'prompts/abc/poster.jpg',
      durationSeconds: 30,
      isMain: true,
    },
    {
      position: 2,
      mediaType: 'image',
      storageKey: 'prompts/abc/shot-2.jpg',
      posterKey: null,
      durationSeconds: null,
      isMain: false,
    },
  ],
  status: 'draft',
} as const;

describe('prompt library contracts', () => {
  it('accepts a valid admin create payload', () => {
    expect(PromptCreateSchema.safeParse(validCreate).success).toBe(true);
  });

  it('accepts an exact length alongside the bucket, and rejects a bad one', () => {
    // A source that says exactly 30s is recorded as 30, with the
    // bucket kept only for filtering — the bucket never replaces it.
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        length: '15_30s',
        exactDurationSeconds: 30,
      }).success,
    ).toBe(true);
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        exactDurationSeconds: null,
      }).success,
    ).toBe(true);
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        exactDurationSeconds: -1,
      }).success,
    ).toBe(false);
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        exactDurationSeconds: 30.5,
      }).success,
    ).toBe(false);
    // PATCH can set the exact length, and can clear it back to null.
    expect(
      PromptUpdateSchema.safeParse({ exactDurationSeconds: 30 }).success,
    ).toBe(true);
    expect(
      PromptUpdateSchema.safeParse({ exactDurationSeconds: null }).success,
    ).toBe(true);
  });

  it('renders the exact length, never the bucket label, when known', () => {
    expect(formatExactDurationSeconds(30)).toBe('30s');
    expect(formatExactDurationSeconds(75)).toBe('1 min 15s');
    expect(formatExactDurationSeconds(60)).toBe('1 min');
    expect(formatExactDurationSeconds(0)).toBe('0s');
    // Exact present: 30s, not the 15_30s bucket label "15-30s".
    expect(promptLengthDisplay(30, '15_30s')).toBe('30s');
    expect(promptLengthDisplay(75, '1min_plus')).toBe('1 min 15s');
    // Exact absent: bucket label fallback, unchanged.
    expect(promptLengthDisplay(null, '15_30s')).toBe('15-30s');
    expect(promptLengthDisplay(undefined, '1min_plus')).toBe('1 min+');
  });

  it('requires the exact length field on list and detail output', () => {
    const listItem = {
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'puppy-first-bath',
      title: 'Puppy first bath',
      shortDescription: 'A golden puppy first bath.',
      tool: 'dola_ai',
      category: 'animals',
      language: 'en',
      length: '15_30s',
      exactDurationSeconds: 30,
      format: 'vertical_reel',
      aspectRatio: '9:16',
      previewMediaType: 'video',
      previewUrl: 'https://media.example.com/prompts/abc/preview.mp4',
      previewPosterUrl: 'https://media.example.com/prompts/abc/poster.jpg',
      copiedCount: 0,
      status: 'published',
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T00:00:00.000Z',
      isFavourite: false,
    };
    expect(PromptListItemSchema.safeParse(listItem).success).toBe(true);
    // Null (unknown) is valid; omitting the field entirely is not —
    // the API must always return it explicitly so the UI can tell
    // "unknown" from a missing field.
    expect(
      PromptListItemSchema.safeParse({ ...listItem, exactDurationSeconds: null })
        .success,
    ).toBe(true);
    const { exactDurationSeconds, ...without } = listItem;
    void exactDurationSeconds;
    expect(PromptListItemSchema.safeParse(without).success).toBe(false);
  });

  it('accepts brand-new taxonomy values outside the old enums', () => {
    // Since migration 20261028140000, tool/category/language are
    // free text: a new value needs no migration. The old demo
    // values still validate alongside them.
    const parsed = PromptCreateSchema.safeParse({
      ...validCreate,
      tool: 'sora',
      category: 'travel',
      language: 'fr',
    });
    expect(parsed.success).toBe(true);
    expect(PromptCreateSchema.safeParse(validCreate).success).toBe(true);
  });

  it('normalises taxonomy values: lowercased, single spaces, language codes', () => {
    const parsed = PromptCreateSchema.safeParse({
      ...validCreate,
      tool: '  Sora  ',
      category: '  Travel  ',
      language: 'FR',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tool).toBe('sora');
      expect(parsed.data.category).toBe('travel');
      expect(parsed.data.language).toBe('fr');
    }
  });

  it('rejects empty/overlong taxonomy values and bad language codes', () => {
    for (const [key, value] of [
      ['tool', ''],
      ['tool', 'x'.repeat(101)],
      ['category', '   '],
      ['category', 'x'.repeat(101)],
      ['language', 'e'],
      ['language', 'english'],
      ['language', 'e1'],
    ] as const) {
      expect(
        PromptCreateSchema.safeParse({ ...validCreate, [key]: value }).success,
      ).toBe(false);
    }
  });

  it('still rejects an unknown length or format (system enums, unchanged)', () => {
    for (const [key, value] of [
      ['length', '2min_plus'],
      ['format', 'square'],
    ] as const) {
      expect(
        PromptCreateSchema.safeParse({ ...validCreate, [key]: value }).success,
      ).toBe(false);
    }
  });

  it('facets accept brand-new taxonomy values', () => {
    expect(
      PromptFacetsSchema.safeParse({
        category: [{ value: 'travel', count: 1 }],
        tool: [{ value: 'sora', count: 1 }],
        language: [{ value: 'fr', count: 1 }],
        length: [{ value: '1min_plus', count: 1 }],
      }).success,
    ).toBe(true);
  });

  it('rejects a vertical format with a horizontal aspect ratio', () => {
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        aspectRatio: '16:9',
      }).success,
    ).toBe(false);
    expect(promptFormatMatchesAspectRatio('vertical_reel', '9:16')).toBe(true);
    expect(promptFormatMatchesAspectRatio('horizontal_video', '16:9')).toBe(
      true,
    );
  });

  it('requires a poster key for a video media item', () => {
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        media: [
          {
            position: 1,
            mediaType: 'video',
            storageKey: 'prompts/abc/preview.mp4',
            posterKey: null,
            durationSeconds: 30,
            isMain: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects zero mains, two mains, and duplicate media positions', () => {
    const single = validCreate.media[0];
    const noMain = { ...single, isMain: false };
    expect(
      PromptCreateSchema.safeParse({ ...validCreate, media: [noMain] })
        .success,
    ).toBe(false);
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        media: [single, { ...validCreate.media[1], isMain: true }],
      }).success,
    ).toBe(false);
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        media: [single, { ...validCreate.media[1], position: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate how-to step positions', () => {
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        steps: [
          { position: 1, body: 'One.' },
          { position: 1, body: 'Two.' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects storage keys outside the prompts/ R2 prefix', () => {
    expect(isPromptLibraryStorageKey('prompts/abc/preview.mp4')).toBe(true);
    expect(isPromptLibraryStorageKey('users/x/media/preview.mp4')).toBe(false);
    expect(isPromptLibraryStorageKey('preview.mp4')).toBe(false);
    expect(isPromptLibraryStorageKey('prompts/../secret.mp4')).toBe(false);
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        media: [
          {
            position: 1,
            mediaType: 'video',
            storageKey: 'users/x/preview.mp4',
            posterKey: 'prompts/abc/poster.jpg',
            durationSeconds: 30,
            isMain: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed slug', () => {
    expect(
      PromptCreateSchema.safeParse({
        ...validCreate,
        slug: 'Puppy First Bath!',
      }).success,
    ).toBe(false);
  });

  it('coerces list query params and caps pageSize at 50', () => {
    const parsed = PromptListQuerySchema.safeParse({
      search: 'puppy',
      category: 'animals',
      sort: 'most_copied',
      page: '2',
      pageSize: '999',
    });
    expect(parsed.success).toBe(false); // pageSize over the cap is rejected
    const ok = PromptListQuerySchema.safeParse({ page: '2', pageSize: '50' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.page).toBe(2);
      expect(ok.data.pageSize).toBe(50);
      expect(ok.data.sort).toBe('newest');
    }
  });

  it('parses favorites_only from query strings without turning "false" into true', () => {
    const on = PromptListQuerySchema.safeParse({ favorites_only: 'true' });
    expect(on.success).toBe(true);
    if (on.success) expect(on.data.favorites_only).toBe(true);
    const off = PromptListQuerySchema.safeParse({ favorites_only: 'false' });
    expect(off.success).toBe(true);
    if (off.success) expect(off.data.favorites_only).toBe(false);
    const absent = PromptListQuerySchema.safeParse({});
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.favorites_only).toBe(false);
    expect(
      PromptListQuerySchema.safeParse({ favorites_only: 'yes' }).success,
    ).toBe(false);
  });

  it('list items never carry the master prompt, steps, or full media list', () => {
    const detail = {
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'puppy-first-bath',
      title: 'Puppy first bath',
      shortDescription: 'A golden puppy first bath.',
      masterPrompt: 'Secret master prompt.',
      tool: 'dola_ai',
      category: 'animals',
      language: 'en',
      length: '1min_plus',
      exactDurationSeconds: null,
      format: 'vertical_reel',
      aspectRatio: '9:16',
      previewMediaType: 'video',
      previewUrl: 'https://media.example.com/prompts/abc/preview.mp4',
      previewPosterUrl: 'https://media.example.com/prompts/abc/poster.jpg',
      copiedCount: 0,
      status: 'published',
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T00:00:00.000Z',
      isFavourite: false,
      media: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          position: 1,
          mediaType: 'video',
          storageKey: 'prompts/abc/preview.mp4',
          posterKey: 'prompts/abc/poster.jpg',
          url: 'https://media.example.com/prompts/abc/preview.mp4',
          posterUrl: 'https://media.example.com/prompts/abc/poster.jpg',
          durationSeconds: 30,
          isMain: true,
        },
      ],
      steps: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          position: 1,
          title: null,
          body: 'Open your video tool.',
        },
      ],
    };
    expect(PromptDetailSchema.safeParse(detail).success).toBe(true);
    const listItem = PromptListItemSchema.parse(detail);
    expect('masterPrompt' in listItem).toBe(false);
    expect('steps' in listItem).toBe(false);
    expect('media' in listItem).toBe(false);
    expect(listItem.previewUrl).toBe(
      'https://media.example.com/prompts/abc/preview.mp4',
    );
  });

  it('accepts a valid facets payload, new taxonomy values, and rejects negative counts and unknown lengths', () => {
    const facets = {
      category: [
        { value: 'animals', count: 2 },
        { value: 'comedy', count: 1 },
      ],
      tool: [{ value: 'dola_ai', count: 3 }],
      language: [{ value: 'en', count: 3 }],
      length: [{ value: '1min_plus', count: 3 }],
    };
    expect(PromptFacetsSchema.safeParse(facets).success).toBe(true);
    // Taxonomy is free text now: 'sports' is a valid facet value.
    expect(
      PromptFacetsSchema.safeParse({
        ...facets,
        category: [{ value: 'sports', count: 1 }],
      }).success,
    ).toBe(true);
    // Length is still a system enum, so an unknown length is rejected.
    expect(
      PromptFacetsSchema.safeParse({
        ...facets,
        length: [{ value: '2min_plus', count: 1 }],
      }).success,
    ).toBe(false);
    expect(
      PromptFacetsSchema.safeParse({
        ...facets,
        tool: [{ value: 'dola_ai', count: -1 }],
      }).success,
    ).toBe(false);
    expect(
      PromptFacetsSchema.safeParse({
        category: [],
        tool: [],
        language: [],
        length: [],
      }).success,
    ).toBe(true);
  });
});
