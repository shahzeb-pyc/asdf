'use client';

import React from 'react';
import { Card } from '@/components/shared/ui/card';

export interface FdolaStudioGateProps {
  subdomain?: string;
}

export function FdolaStudioGate({ subdomain: _subdomain }: Readonly<FdolaStudioGateProps>) {
  return (
    <div
      data-slot="fdola-studio-gate"
      data-testid="fdola-studio-gate"
      className="flex flex-col items-center justify-center px-6 py-12"
    >
      <Card className="w-full max-w-120 items-center gap-4 px-6 py-8 text-center">
        {/* Studio Icon Container */}
        <div
          data-slot="studio-gate-icon"
          data-testid="studio-gate-icon"
          className="flex size-12 items-center justify-center rounded-md border border-line bg-active text-brand-bronze dark:text-primary"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" x2="16" y1="21" y2="21" />
            <line x1="12" x2="12" y1="17" y2="21" />
          </svg>
        </div>

        {/* Title & Coming Soon Notice (OD-141-3(c)) */}
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">Fdola Studio</h1>
          <p data-testid="fdola-gate-message" className="max-w-96 text-body text-ink-sub">
            Fdola Studio is coming soon.
          </p>
        </div>
      </Card>
    </div>
  );
}
