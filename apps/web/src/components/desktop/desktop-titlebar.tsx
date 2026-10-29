'use client';

import React, { useEffect, useState } from 'react';
import {
  isDesktopApp,
  isMacDesktop,
  sendDesktopWindowAction,
  openExternalUrl,
} from '@fbuploadpro/contracts';
import { BrandMark } from '@/components/brand';
import { cn } from '@/lib/utils';

export interface DesktopTitleBarProps {
  /** Optional override for testing or manual preview */
  forceVisible?: boolean;
  /** Optional platform override for testing ('mac' | 'windows' | 'linux') */
  platformOverride?: 'mac' | 'windows' | 'linux';
}

/**
 * Desktop title bar (spec 130 PR-130-1: rebuilt on design tokens —
 * token-backed utilities only, zero inline styles). Presence,
 * placement and behaviour are unchanged: it renders only inside the
 * desktop shell, publishes its height as the
 * `--desktop-titlebar-height` variable the shell offsets by, and
 * routes external target="_blank" links out of the webview.
 */
export function DesktopTitleBar({ forceVisible = false, platformOverride }: Readonly<DesktopTitleBarProps>) {
  const [mounted, setMounted] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    const desktop = forceVisible || isDesktopApp();
    const mac = platformOverride ? platformOverride === 'mac' : isMacDesktop();
    setIsDesktop(desktop);
    setIsMac(mac);
    setMounted(true);

    if (desktop) {
      document.documentElement.style.setProperty('--desktop-titlebar-height', '36px');
      document.documentElement.dataset.desktop = 'true';
    }

    // Intercept target="_blank" external links inside desktop shell to prevent navigating the embedded webview
    const handleDocumentClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement)?.closest('a');
      if (!target) return;
      const href = target.getAttribute('href');
      const isTargetBlank = target.getAttribute('target') === '_blank';
      if (!href) return;

      const isHttp = href.startsWith('http://') || href.startsWith('https://');
      if (isHttp && isTargetBlank) {
        let url: URL | null = null;
        try {
          url = new URL(href, window.location.href);
        } catch {
          // Invalid URLs are not intercepted — the browser handles them.
          url = null;
        }
        if (url && url.origin !== window.location.origin) {
          e.preventDefault();
          void openExternalUrl(href);
        }
      }
    };

    if (desktop) {
      document.addEventListener('click', handleDocumentClick, true);
    }

    return () => {
      document.documentElement.style.removeProperty('--desktop-titlebar-height');
      delete document.documentElement.dataset.desktop;
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, [forceVisible, platformOverride]);

  // When forceVisible is passed (e.g. in tests using renderToStaticMarkup), render directly
  const shouldRender = forceVisible || (mounted && isDesktop);
  if (!shouldRender) {
    return null;
  }

  const effectiveIsMac = platformOverride ? platformOverride === 'mac' : isMac;

  const handleAction = (action: 'minimize' | 'toggle_maximize' | 'close') => (e: React.MouseEvent) => {
    e.stopPropagation();
    void sendDesktopWindowAction(action);
  };

  const handleDoubleClick = () => {
    void sendDesktopWindowAction('toggle_maximize');
  };

  const windowControlClassName =
    'flex h-full w-11 cursor-pointer items-center justify-center bg-transparent text-ink-sub transition-colors duration-base ease-standard';

  return (
    <header
      data-testid="desktop-titlebar"
      data-tauri-drag-region
      onDoubleClick={handleDoubleClick}
      className={cn(
        'fixed inset-x-0 top-0 z-overlay-top flex h-9 items-center justify-between border-b border-line bg-canvas font-sans select-none',
        effectiveIsMac ? 'px-3' : 'pl-3'
      )}
    >
      {effectiveIsMac ? (
        // macOS Traffic Lights on the Left
        <>
          <div
            data-testid="desktop-traffic-lights"
            data-tauri-drag-region="false"
            className="flex items-center gap-2"
          >
            <button
              type="button"
              data-testid="desktop-close-btn"
              data-tauri-drag-region="false"
              onClick={handleAction('close')}
              aria-label="Close window"
              className="size-3 cursor-pointer rounded-full bg-signal-critical p-0"
            />
            <button
              type="button"
              data-testid="desktop-minimize-btn"
              data-tauri-drag-region="false"
              onClick={handleAction('minimize')}
              aria-label="Minimize window"
              className="size-3 cursor-pointer rounded-full bg-link p-0"
            />
            <button
              type="button"
              data-testid="desktop-maximize-btn"
              data-tauri-drag-region="false"
              onClick={handleAction('toggle_maximize')}
              aria-label="Maximize or restore window"
              className="size-3 cursor-pointer rounded-full bg-brand-emerald p-0"
            />
          </div>

          <div
            data-tauri-drag-region
            className="mr-16 flex flex-1 items-center justify-center gap-2 text-metadata font-medium text-ink-sub"
          >
            <span>FBUploadPro</span>
          </div>
        </>
      ) : (
        // Windows / Linux Layout: Brand on Left, Controls on Right
        <>
          <div
            data-testid="desktop-brand-title"
            data-tauri-drag-region
            className="flex items-center gap-2 text-metadata font-medium text-ink-sub"
          >
            <BrandMark size={16} />
            <span>FBUploadPro</span>
          </div>

          {/* Draggable spacer */}
          <div data-tauri-drag-region className="h-full flex-1" />

          {/* Windows / Linux Window Control Buttons */}
          <div
            data-testid="desktop-window-controls"
            data-tauri-drag-region="false"
            className="flex h-full items-center"
          >
            <button
              type="button"
              data-testid="desktop-minimize-btn"
              data-tauri-drag-region="false"
              onClick={handleAction('minimize')}
              aria-label="Minimize window"
              className={windowControlClassName}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <rect y="4.5" width="10" height="1" />
              </svg>
            </button>

            <button
              type="button"
              data-testid="desktop-maximize-btn"
              data-tauri-drag-region="false"
              onClick={handleAction('toggle_maximize')}
              aria-label="Maximize or restore window"
              className={windowControlClassName}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="1.5" y="1.5" width="7" height="7" />
              </svg>
            </button>

            <button
              type="button"
              data-testid="desktop-close-btn"
              data-tauri-drag-region="false"
              onClick={handleAction('close')}
              aria-label="Close window"
              className={windowControlClassName}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
              </svg>
            </button>
          </div>
        </>
      )}
    </header>
  );
}
