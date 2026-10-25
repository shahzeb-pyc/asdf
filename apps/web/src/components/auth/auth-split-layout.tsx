'use client';

/**
 * AuthSplitLayout — the split chrome shared by every entry route
 * (login, signup, forgot/reset password). Rebuilt for spec 136
 * (PR-136A) on design tokens + token-backed utilities only: the
 * previous implementation's embedded style block and inline styles
 * are deleted, and the responsive behaviour they carried (showcase
 * hidden below the lg breakpoint, mobile brand header shown instead,
 * form panel full-width) is re-expressed in utilities.
 *
 * Slot contract (preserved as behaviour): `title` / `description`
 * head the form card, `children` is the form itself, `footer` renders
 * under a hairline divider when present, `showcase` overrides the
 * default showcase panel, and `formPosition` chooses which side the
 * form sits on (default: left).
 */

import React from 'react';
import { BrandMark } from '@/components/brand';
import { AuthShowcasePanel } from '@/components/auth/login-showcase-panel';
import { cn } from '@/lib/utils';

export interface AuthSplitLayoutProps {
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  formPosition?: 'left' | 'right';
  showcase?: React.ReactNode;
}

const BrandLogo = () => (
  <div className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-line bg-subtle">
    <BrandMark size={22} />
  </div>
);

export function AuthSplitLayout({
  title,
  description,
  children,
  footer,
  formPosition = 'left',
  showcase,
}: Readonly<AuthSplitLayoutProps>) {
  const isFormLeft = formPosition === 'left';

  const showcaseNode = (
    <section
      aria-label="FBUploadPro Showcase"
      className={cn(
        'relative hidden w-1/2 overflow-hidden border-line bg-canvas lg:block',
        isFormLeft ? 'border-l' : 'border-r'
      )}
    >
      <div className="relative flex h-full flex-col justify-between px-14 py-12">
        {showcase ?? <AuthShowcasePanel />}
      </div>
    </section>
  );

  const formNode = (
    <main className="flex min-h-screen w-full items-center justify-center bg-canvas px-4 py-8 lg:w-1/2 lg:px-6">
      <div className="flex w-full max-w-md flex-col">
        {/* Mobile brand header (rendered when the showcase is hidden). */}
        <div className="mb-6 flex items-center justify-center gap-2.5 lg:hidden">
          <BrandLogo />
          <span className="text-lg font-bold tracking-h3">FBUploadPro</span>
        </div>

        {/* Auth card */}
        <div className="rounded-md border border-line bg-panel px-7 py-8 shadow-card">
          <div className="mb-6">
            <h2 className="mb-1 text-xl font-bold tracking-h2 text-ink">{title}</h2>
            <p className="text-body leading-body text-ink-sub">{description}</p>
          </div>

          {children}

          {footer && (
            <div className="mt-6 border-t border-line pt-4 text-center">{footer}</div>
          )}
        </div>
      </div>
    </main>
  );

  return (
    <div className="flex min-h-screen w-full flex-col bg-canvas font-sans text-ink lg:flex-row">
      {isFormLeft ? (
        <>
          {formNode}
          {showcaseNode}
        </>
      ) : (
        <>
          {showcaseNode}
          {formNode}
        </>
      )}
    </div>
  );
}
