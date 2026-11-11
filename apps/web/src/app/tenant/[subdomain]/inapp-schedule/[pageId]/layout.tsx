/**
 * Metadata-only segment layout (spec 137 §3.3.4 / PR-A2).
 * The route's page is a client component and cannot export metadata,
 * so the segment title lives here; the layout renders children as-is.
 */
import type { Metadata } from "next";
import * as React from "react";

export const metadata: Metadata = { title: "Page" };

export default function TenantPageDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
