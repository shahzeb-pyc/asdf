import type { NextResponse } from 'next/server';

// Phase 1 (spec 114): CSP stays Report-Only. This constant is the single
// flip point for Phase 2 enforcement — change it to
// 'Content-Security-Policy' (plus the theme-script hash) in that PR.
// No other file may hardcode the header name.
export const CSP_HEADER_NAME = 'Content-Security-Policy-Report-Only';

export const CSP_REPORT_PATH = '/api/csp-report';

const MAX_FIELD_LENGTH = 512;

export interface NormalizedReport {
  documentUri: string;
  blockedUri: string;
  effectiveDirective: string;
  sourceFile: string;
  lineNumber: string;
  columnNumber: string;
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCodePoint(byte);
  });
  return btoa(binary);
}

export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' https://*.supabase.co https://us.i.posthog.com https://eu.i.posthog.com",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "form-action 'self'",
    'report-to csp-endpoint',
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');
}

export function applyCspHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set(CSP_HEADER_NAME, buildContentSecurityPolicy(nonce));
  response.headers.set('Reporting-Endpoints', `csp-endpoint="${CSP_REPORT_PATH}"`);
  return response;
}

function truncateField(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, MAX_FIELD_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).slice(0, MAX_FIELD_LENGTH);
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLegacyReport(report: Record<string, unknown>): NormalizedReport | null {
  const hasRecognizedField =
    'document-uri' in report || 'blocked-uri' in report || 'effective-directive' in report || 'violated-directive' in report;
  if (!hasRecognizedField) return null;
  return {
    documentUri: truncateField(report['document-uri']),
    blockedUri: truncateField(report['blocked-uri']),
    effectiveDirective: truncateField(report['effective-directive'] ?? report['violated-directive']),
    sourceFile: truncateField(report['source-file']),
    lineNumber: truncateField(report['line-number']),
    columnNumber: truncateField(report['column-number']),
  };
}

function normalizeReportingApiReport(body: Record<string, unknown>): NormalizedReport | null {
  const hasRecognizedField =
    'documentURL' in body || 'blockedURL' in body || 'effectiveDirective' in body;
  if (!hasRecognizedField) return null;
  return {
    documentUri: truncateField(body.documentURL),
    blockedUri: truncateField(body.blockedURL),
    effectiveDirective: truncateField(body.effectiveDirective),
    sourceFile: truncateField(body.sourceFile),
    lineNumber: truncateField(body.lineNumber),
    columnNumber: truncateField(body.columnNumber),
  };
}

export function parseCspReports(body: unknown): NormalizedReport[] {
  try {
    if (Array.isArray(body)) {
      const reports: NormalizedReport[] = [];
      for (const entry of body) {
        if (!isRecord(entry) || !isRecord(entry.body)) continue;
        const normalized = normalizeReportingApiReport(entry.body);
        if (normalized) reports.push(normalized);
      }
      return reports;
    }

    if (isRecord(body) && isRecord(body['csp-report'])) {
      const normalized = normalizeLegacyReport(body['csp-report']);
      return normalized ? [normalized] : [];
    }

    return [];
  } catch {
    return [];
  }
}
