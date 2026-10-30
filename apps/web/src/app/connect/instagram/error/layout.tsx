/**
 * Metadata-only segment layout, mirroring Facebook's
 * `app/connect/facebook/error/layout.tsx`. The route's page is a
 * client component and cannot export metadata, so the segment title
 * lives here; the layout renders children as-is.
 */
import type { Metadata } from "next";
import * as React from "react";

export const metadata: Metadata = { title: "Connection error" };

export default function ConnectInstagramErrorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
