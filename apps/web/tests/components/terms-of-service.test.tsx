import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TermsOfServiceContent } from '../../src/components/terms/terms-of-service-content';

const HEADINGS = [
  'What FBUploadPro is',
  'Your account',
  'Your content and connected accounts',
  'Acceptable use',
  'Availability',
  'Liability',
  'Ending your use',
  'Changes to these terms',
  'Contact',
];

describe('TermsOfServiceContent', () => {
  it('renders every section in order, with the given last-updated date', () => {
    const { container } = render(<TermsOfServiceContent lastUpdated="27 October 2026" />);
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getByText(/Last updated: 27 October 2026/)).toBeInTheDocument();
    for (const heading of HEADINGS) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    const rendered = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent);
    expect(rendered).toEqual(HEADINGS);
  });

  it('states the key terms promises and the public-access footer', () => {
    render(<TermsOfServiceContent lastUpdated="27 October 2026" />);
    expect(screen.getByText(/You keep ownership of your content/)).toBeInTheDocument();
    expect(screen.getByText(/The service is provided as is/)).toBeInTheDocument();
    expect(screen.getByText(/This page is public — no sign-in needed/)).toBeInTheDocument();
  });
});
