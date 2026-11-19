import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { MaintenanceContent } from '@/components/maintenance/maintenance-content';

describe('Maintenance page content (spec 209)', () => {
  it('renders the ordered copy with our brand name', () => {
    render(<MaintenanceContent brand="fbuploadpro" brandName="FBUploadPro" />);
    expect(
      screen.getByRole('heading', { name: 'Under maintenance' })
    ).toBeInTheDocument();
    expect(screen.getByText("We'll be back in an hour.")).toBeInTheDocument();
    expect(screen.getByText('FBUploadPro')).toBeInTheDocument();
  });

  it('renders the white-label brand name and no FBUploadPro string', () => {
    render(<MaintenanceContent brand="nextrise" brandName="NextRise Digital" />);
    expect(
      screen.getByRole('heading', { name: 'Under maintenance' })
    ).toBeInTheDocument();
    expect(screen.getByText("We'll be back in an hour.")).toBeInTheDocument();
    expect(screen.getByText('NextRise Digital')).toBeInTheDocument();
    expect(screen.queryByText('FBUploadPro')).toBeNull();
  });

  it('carries no links off the page', () => {
    render(<MaintenanceContent brand="fbuploadpro" brandName="FBUploadPro" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
