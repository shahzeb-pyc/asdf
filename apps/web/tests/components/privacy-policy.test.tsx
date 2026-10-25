import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrivacyPolicyContent } from '../../src/components/privacy/privacy-policy-content';

const HEADINGS = [
  'What FBUploadPro does',
  'What we collect',
  'What we do with it',
  'Who else sees it',
  'How long we keep it',
  'Your choices',
  'Contact',
];

describe('PrivacyPolicyContent', () => {
  it('renders every section in order, with the given last-updated date', () => {
    const { container } = render(<PrivacyPolicyContent lastUpdated="25 October 2026" />);
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByText(/Last updated: 25 October 2026/)).toBeInTheDocument();
    for (const heading of HEADINGS) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    const rendered = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent);
    expect(rendered).toEqual(HEADINGS);
  });

  it('states the key privacy promises and the public-access footer', () => {
    render(<PrivacyPolicyContent lastUpdated="25 October 2026" />);
    expect(screen.getByText(/Your platform passwords are never stored by us/)).toBeInTheDocument();
    expect(screen.getByText(/We do not sell your data/)).toBeInTheDocument();
    expect(screen.getByText(/This page is public — no sign-in needed/)).toBeInTheDocument();
  });
});
