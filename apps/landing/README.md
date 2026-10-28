# FBUploadPro landing page

Standalone static marketing site for Cloudflare Pages. No backend, no
database, no sign-in code, no pricing, no forms. It only links out to
the separate web app for signup and login.

## Stack

TypeScript + Astro, static output, Tailwind CSS. No Cloudflare adapter,
no SSR, no Pages Functions, no Worker script, no `wrangler.jsonc`.

## Cloudflare Pages settings (exact)

- Framework preset: Astro
- Root directory: `apps/landing`
- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`
- Node version: 22 (see `.node-version`)

Connect the repository to a Cloudflare Pages project in the dashboard
to get a preview/production URL. That dashboard step is not done in
this repo and no live preview URL is claimed until it is connected.

## Local build

```sh
cd apps/landing
npm install
npm run build
```

The build output is `dist/`. There is no `_redirects` file because this
site needs no redirects: www/apex handling is done in the Pages
project's custom-domain settings, not invented here.
