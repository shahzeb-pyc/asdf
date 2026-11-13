/**
 * @file brand-logo.test.tsx
 * @description Unit tests for BrandMark and BrandLogo components (Spec 054 / US1).
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { BrandMark, BrandLogo } from '@/components/brand';
import { PALETTE } from '@/lib/theme';
import { render } from '../components/setup';

describe('BrandMark Component (Spec 054 / US1)', () => {
  it('renders official 64x64 SVG vector geometry with accessible attributes', () => {
    const { html, hasAttribute, hasTag } = render(<BrandMark />);

    expect(hasTag('svg')).toBe(true);
    expect(hasAttribute('viewBox', '0 0 64 64')).toBe(true);
    expect(hasAttribute('role', 'img')).toBe(true);
    expect(hasAttribute('aria-label', 'FBUploadPro')).toBe(true);
    expect(hasAttribute('width', '32')).toBe(true);
    expect(hasAttribute('height', '32')).toBe(true);

    // Verify all 4 geometric paths and token fills
    expect(html).toContain(PALETTE.primary); // #FFFC00
    expect(html).toContain(PALETTE.accent1); // #FCF000
    expect(html).toContain(PALETTE.accent2); // #716400
    expect(html).toContain('fill-opacity="0.35"'); // Specular edge highlight
  });

  it('scales accurately to custom dimensions via size prop', () => {
    const { hasAttribute } = render(<BrandMark size={20} />);
    expect(hasAttribute('width', '20')).toBe(true);
    expect(hasAttribute('height', '20')).toBe(true);

    const { hasAttribute: hasAttribute64 } = render(<BrandMark size={64} />);
    expect(hasAttribute64('width', '64')).toBe(true);
    expect(hasAttribute64('height', '64')).toBe(true);
  });
});

describe('BrandLogo Component (Spec 054 / US1)', () => {
  it('renders BrandMark alongside FBUploadPro wordmark and optional subtitle', () => {
    const { hasText, hasAttribute, html } = render(
      <BrandLogo markSize={24} subtitle="Studio" />
    );

    expect(hasAttribute('width', '24')).toBe(true);
    expect(hasText('FBUploadPro')).toBe(true);
    expect(hasText('Studio')).toBe(true);
    expect(html).toContain(PALETTE.primary);
  });

  it('hides wordmark when showWordmark is false', () => {
    const { hasTag } = render(
      <BrandLogo markSize={20} showWordmark={false} />
    );

    expect(hasTag('svg')).toBe(true);
    expect(hasTag('span')).toBe(false);
  });
});
