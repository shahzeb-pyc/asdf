import React from 'react';
import { PALETTE } from '@/lib/theme';
import { cn } from '@/lib/utils';

export interface BrandMarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  className?: string;
}

/**
 * Official FBUploadPro Brand Mark (spec 130 PR-130-1: layout and
 * wordmark rebuilt on token-backed utilities; the four path fills
 * keep referencing the generated token values from `lib/theme`,
 * the token system's generated output — no colour literals remain
 * in this file). Implements the 4-path geometric anatomy:
 * 1. Primary gold upload arrow and "F" crown/spine (brand gold token)
 * 2. White specular edge highlight (neutral white token, 0.35 opacity)
 * 3. Peru accent middle crossbar and active stream wing (brand peru token)
 * 4. Bronze accent recurring queue slot anchor (brand bronze token)
 */
export const BrandMark: React.FC<BrandMarkProps> = ({
  size = 32,
  className,
  ...props
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      role="img"
      aria-label="FBUploadPro"
      className={cn('inline-block shrink-0', className)}
      {...props}
    >
      {/* Primary gold: unified ascending upload arrow + "F" crown and spine */}
      <path
        d="M24 11L12 23L17 28L20 25V51L28 45V23H45L53 15H28L24 11Z"
        fill={PALETTE.primary}
      />

      {/* Specular edge highlight: neutral white at 0.35 opacity */}
      <path
        d="M24 11L12 23L13.2 24.2L24 13.4L28 17.4H50.6L53 15H28L24 11Z"
        fill={PALETTE.text}
        fillOpacity={0.35}
      />

      {/* Peru accent: middle "F" crossbar and active stream wing */}
      <path d="M32 30H48L40 38H32V30Z" fill={PALETTE.accent1} />

      {/* Bronze accent: recurring queue slot anchor */}
      <path d="M32 43H41L35 49H32V43Z" fill={PALETTE.accent2} />
    </svg>
  );
};

export interface BrandLogoProps {
  markSize?: number;
  showWordmark?: boolean;
  subtitle?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Composite Brand Logo pairing BrandMark with the canonical logotype and optional subtitle.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({
  markSize = 32,
  showWordmark = true,
  subtitle,
  className,
  style,
}) => {
  return (
    <div className={cn('inline-flex items-center gap-2', className)} style={style}>
      <BrandMark size={markSize} />
      {showWordmark && (
        <div className="flex min-w-0 flex-col">
          <span className="text-body leading-heading font-bold tracking-caption text-ink">
            FBUploadPro
          </span>
          {subtitle && (
            <span className="text-xs leading-heading text-ink-dim">{subtitle}</span>
          )}
        </div>
      )}
    </div>
  );
};
