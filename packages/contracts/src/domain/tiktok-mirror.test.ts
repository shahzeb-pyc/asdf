import { describe, expect, it } from 'vitest';
import { TikwmUserInfoResponseSchema } from './tiktok-mirror.js';

// Pins the camelCase `secUid` field the ADU scraper's TikWM fallback
// resolves (spec scraper-tikwm-fallback). The live /user/info payload
// carries secUid (76 chars), uniqueId, and a numeric id — and NO
// snake_case `sec_uid` field. A snake_case-only payload must parse
// with secUid undefined, so the lookup treats it as a failure instead
// of silently resolving nothing.
describe('TikwmUserInfoResponseSchema', () => {
  it('parses the live /user/info shape: camelCase secUid, uniqueId, numeric id', () => {
    const parsed = TikwmUserInfoResponseSchema.safeParse({
      code: 0,
      msg: 'success',
      data: {
        user: {
          unique_id: 'courtroom62',
          uniqueId: 'courtroom62',
          nickname: 'Courtroom 62',
          avatar: 'https://example.invalid/avatar.jpg',
          secUid: 'MS4wLjABAAAA-FAKE-SECUID-VALUE-USED-ONLY-IN-THIS-TEST-0123456789abcdef',
          id: 123456789012345,
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.data?.user?.secUid).toBe(
      'MS4wLjABAAAA-FAKE-SECUID-VALUE-USED-ONLY-IN-THIS-TEST-0123456789abcdef',
    );
    expect(parsed.data.data?.user?.uniqueId).toBe('courtroom62');
    expect(parsed.data.data?.user?.id).toBe(123456789012345);
  });

  it('accepts a string id too', () => {
    const parsed = TikwmUserInfoResponseSchema.safeParse({
      code: 0,
      data: { user: { unique_id: 'courtroom62', secUid: 'sec-uid-value', id: '12345' } },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.data?.user?.id).toBe('12345');
  });

  it('ignores snake_case sec_uid: secUid stays undefined when only sec_uid is present', () => {
    const parsed = TikwmUserInfoResponseSchema.safeParse({
      code: 0,
      data: {
        user: {
          unique_id: 'courtroom62',
          sec_uid: 'MS4wLjABAAAA-SNAKE-CASE-ONLY-VALUE',
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.data?.user?.secUid).toBeUndefined();
  });

  it('keeps parsing the old shape (no secUid fields at all)', () => {
    const parsed = TikwmUserInfoResponseSchema.safeParse({
      code: 0,
      data: { user: { unique_id: 'courtroom62', nickname: 'Courtroom 62' } },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.data?.user?.secUid).toBeUndefined();
  });
});
