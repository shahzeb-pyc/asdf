import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static only. No Cloudflare adapter, no SSR, no Pages Functions:
// Astro pre-renders every page at build time to dist/.
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
