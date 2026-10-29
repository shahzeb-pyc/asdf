'use client';

/**
 * PasswordInput — the shared auth password control (spec 136 §5.7),
 * rebuilt on the shared/ui `Input`: show/hide toggle + Caps Lock warning,
 * following the login form's A6 pattern exactly. One password pattern for
 * login / signup / forgot (UI Rule 11).
 *
 * Two usages, one control:
 * - Inside the form standard (RHF + Form primitives), the surrounding
 *   `FormItem` renders the label / description / inline message and
 *   `FormControl` wires `id`, `aria-describedby` and `aria-invalid`
 *   through this component onto the input — pass only input props.
 * - Standalone (a consumer that has not moved to the form standard yet),
 *   pass `label` / `helperText` / `error` and the control renders them
 *   itself, on tokens, with the same ARIA wiring.
 *
 * Paste and password managers are never blocked (UX Rule 28): no paste
 * handlers, no autocomplete suppression.
 */

import React, { forwardRef, useId, useState } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';

import { Input } from '@/components/shared/ui/input';
import { cn } from '@/lib/utils';

export type PasswordInputProps = Omit<React.ComponentProps<typeof Input>, 'type'> & {
  /** Standalone mode only: visible label linked to the input. */
  label?: string | undefined;
  /** Standalone mode only: always-visible hint under the input. */
  helperText?: string | undefined;
  /** Standalone mode only: inline error under the input. */
  error?: string | undefined;
};

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    {
      label,
      helperText,
      error,
      id,
      className,
      disabled,
      onKeyDown,
      onKeyUp,
      onBlur,
      'aria-describedby': ariaDescribedBy,
      'aria-invalid': ariaInvalid,
      ...props
    },
    ref
  ) {
    const [showPassword, setShowPassword] = useState(false);
    const [capsLockOn, setCapsLockOn] = useState(false);
    const generatedId = useId().replace(/:/g, '');
    const inputId = id ?? (label ? `password-input-${generatedId}` : undefined);
    const helperId = helperText && inputId ? `${inputId}-helper` : undefined;
    const errorId = error && inputId ? `${inputId}-error` : undefined;
    const describedBy =
      [ariaDescribedBy, helperId, errorId].filter(Boolean).join(' ') || undefined;

    return (
      <div
        className={cn(
          'flex w-full flex-col',
          label || helperText || error ? 'gap-1.5' : undefined
        )}
      >
        {label && (
          <label htmlFor={inputId} className="text-body font-medium text-ink">
            {label}
          </label>
        )}
        <div className="relative">
          <Input
            ref={ref}
            id={inputId}
            type={showPassword ? 'text' : 'password'}
            className={cn('pr-10', className)}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={ariaInvalid ?? (error ? true : undefined)}
            onKeyDown={(e) => {
              setCapsLockOn(e.getModifierState('CapsLock'));
              onKeyDown?.(e);
            }}
            onKeyUp={(e) => {
              setCapsLockOn(e.getModifierState('CapsLock'));
              onKeyUp?.(e);
            }}
            onBlur={(e) => {
              setCapsLockOn(false);
              onBlur?.(e);
            }}
            {...props}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            disabled={disabled}
            onClick={() => setShowPassword((prev) => !prev)}
            className="absolute top-1/2 right-0 flex h-10 w-10 -translate-y-1/2 items-center justify-center text-ink-dim hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {showPassword ? (
              <EyeOffIcon className="size-4" aria-hidden />
            ) : (
              <EyeIcon className="size-4" aria-hidden />
            )}
          </button>
        </div>
        {helperText && (
          <p id={helperId} className="text-metadata text-ink-sub">
            {helperText}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-metadata font-medium text-brand-rose">
            {error}
          </p>
        )}
        {capsLockOn && (
          <div
            role="status"
            aria-live="polite"
            className="mt-1 text-metadata font-medium text-link"
          >
            Caps Lock is on
          </div>
        )}
      </div>
    );
  }
);
