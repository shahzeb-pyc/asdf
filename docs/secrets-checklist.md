# FBUploadPro: Production Secrets & Deployment Configuration Checklist

This document details every required secret, environment variable, and credential across the FBUploadPro platform, along with exact format requirements, generation commands, and where each key must be provisioned.

---

## 1. Quick Reference: Where Secrets Belong

| Secret Key | Format / Constraint | Local `.env` | Cloudflare Worker Secret | Vercel / Web Host | GitHub Actions Secrets |
| :--- | :--- | :---: | :---: | :---: | :---: |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL (`https://...`) | ✅ | ✅ | ✅ | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`| Supabase Public Anon JWT | ✅ | ❌ | ✅ | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Admin Service Key | ✅ | ✅ | ✅ | ✅ |
| `NEXT_PUBLIC_ROOT_DOMAIN` | Apex domain (`fbuploadpro.com`) | ✅ | ❌ | ✅ | ❌ |
| `NEXT_PUBLIC_APP_URL` | SaaS portal gateway (`https://app.fbuploadpro.com`) | ✅ | ❌ | ✅ | ❌ |
| `NEXT_PUBLIC_MARKETING_URL` | Marketing site URL (`https://fbuploadpro.com`) | ✅ | ❌ | ✅ | ❌ |
| `SESSION_SECRET` | String, $\ge 32$ chars | ✅ | ❌ | ✅ | ❌ |
| `TOKEN_ENCRYPTION_KEY` | Exactly 64 hex chars (32 bytes) | ✅ | ✅ | ✅ | ✅ |
| `R2_ACCOUNT_ID` | Cloudflare Account Hex ID | ✅ | ❌ | ✅ | ❌ |
| `R2_ACCESS_KEY_ID` | R2 S3 Access Key ID | ✅ | ❌ | ✅ | ❌ |
| `R2_SECRET_ACCESS_KEY` | R2 S3 Secret Access Key | ✅ | ❌ | ✅ | ❌ |
| `R2_BUCKET_NAME` | R2 Bucket identifier | ✅ | ❌ | ✅ | ❌ |
| `R2_PUBLIC_URL` | HTTPS CDN / custom domain | ✅ | ❌ | ✅ | ❌ |
| `CLOUDFLARE_API_TOKEN` | Bearer Token (Workers + R2) | ❌ | ❌ | ❌ | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account Hex ID | ❌ | ❌ | ❌ | ✅ |
| `NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER` | WhatsApp Phone (E.164, e.g. `+15551234567`) | ✅ | ❌ | ✅ | ✅ |
| `NEXT_PUBLIC_WHATSAPP_DEFAULT_MESSAGE` | Default support greeting string | ✅ | ❌ | ✅ | ✅ |
| `NEXT_PUBLIC_SIGNUPS_ENABLED` | Registration toggle (`"true"` / `"false"`) | ✅ | ❌ | ✅ | ✅ |
| `POST_FOR_ME_API_KEY` | Post for Me provider API key (spec 125; YouTube publishing + connect, server-side only — never in the database, never sent to the browser) | ✅ | ✅ | ✅ | ✅ |

---

## 2. Detailed Specifications & Generation Commands

### Category A: Database & Identity Substrate (Pure Supabase PostgREST)

FBUploadPro operates on a pure HTTPS REST database architecture via `@supabase/supabase-js`. Traditional PostgreSQL connection URIs (`DATABASE_URL`, `DATABASE_DIRECT_URL`) and direct TCP socket pooling are permanently eliminated.

#### `NEXT_PUBLIC_SUPABASE_URL`
* **Purpose**: HTTPS REST endpoint for Supabase PostgREST, Auth (GoTrue), and Storage APIs.
* **Format**: Fully qualified HTTPS URL (e.g. `https://[project-ref].supabase.co`).
* **Source**: Supabase Project Dashboard $\rightarrow$ Project Settings $\rightarrow$ API.

#### `NEXT_PUBLIC_SUPABASE_ANON_KEY`
* **Purpose**: Public anonymous client JWT for browser-initiated authentication flows.
* **Source**: Supabase Project Dashboard $\rightarrow$ Project Settings $\rightarrow$ API $\rightarrow$ Project API Keys.

#### `SUPABASE_SERVICE_ROLE_KEY`
* **Purpose**: Elevated administrative key used by server-side route handlers and the Cloudflare Worker to bypass RLS for authorized tenant operations.
* **Source**: Supabase Project Dashboard $\rightarrow$ Project Settings $\rightarrow$ API $\rightarrow$ Project API Keys.

---

### Category B: Cryptography & Security

#### `SESSION_SECRET`
* **Purpose**: Signs and verifies HMAC-SHA256 tenant session authentication tokens across subdomains.
* **Format**: Cryptographically secure random string, **minimum 32 characters**.
* **Generation Command**:
  ```bash
  openssl rand -base64 32
  ```

#### `TOKEN_ENCRYPTION_KEY`
* **Purpose**: Unified 256-bit symmetric key used for AES-256-GCM authenticated encryption and decryption of sensitive Facebook Page OAuth tokens stored in PostgreSQL across both the Web App (`apps/web`) and the Edge Worker (`apps/worker`).
* **Format**: **Strictly 64 hexadecimal characters** (representing 32 raw bytes / 256 bits).
* **Generation Command**:
  ```bash
  openssl rand -hex 32
  ```

---

### Category C: Meta / Facebook Graph API v26.0 (Per-Workspace BYOC)

> [!IMPORTANT]
> **Strict Per-Workspace BYOC (Zero Global Platform Credentials)**: The platform operator does NOT provide global `FACEBOOK_APP_ID` or `FACEBOOK_APP_SECRET` environment variables. Every tenant workspace must configure its own dedicated Facebook App ID and App Secret via the web dashboard under **Settings $\rightarrow$ Facebook BYOC** (`workspace_byoc_credentials`). Raw App Secrets are encrypted at rest using AES-256-GCM via `TOKEN_ENCRYPTION_KEY`.

#### Facebook BYOC Credentials Format
* **App ID**: Public Numeric App ID from Meta Developer Dashboard (e.g. `123456789012345`).
* **App Secret**: 32-character hexadecimal App Secret from Meta Developer Dashboard (Settings → Basic).
* **Required Meta App Settings**:
  - Valid OAuth Redirect URIs must include:
    ```text
    https://app.fbuploadpro.com/api/auth/facebook/callback
    http://localhost:3000/api/auth/facebook/callback (for local testing)
    ```
  - App Permissions in App Review: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`, `business_management`, `read_insights`, `public_profile`.
  - Future X (Twitter) and TikTok platform integrations will utilize platform-provided credentials rather than BYOC.

---

### Category D: Cloudflare R2 Media Storage

#### `R2_ACCOUNT_ID`
* **Format**: 32-character hex account ID from Cloudflare dashboard URL or Workers overview.

#### `R2_ACCESS_KEY_ID` & `R2_SECRET_ACCESS_KEY`
* **Purpose**: S3-compatible credentials used to generate presigned browser-to-bucket direct upload URLs (`PutObjectCommand`).
* **Generation**: Cloudflare Dashboard → R2 Object Storage → **Manage R2 API Tokens** → Create Token with **Object Read & Write** permissions scoped to your media bucket.

#### `R2_BUCKET_NAME`
* **Format**: Slug string (e.g. `fbuploadpro-media-prod`).

#### `R2_PUBLIC_URL`
* **Purpose**: The public CDN endpoint for serving uploaded media and thumbnails.
* **Format**: Fully qualified HTTPS URL without trailing slash (e.g. `https://media.fbuploadpro.com`).
* **Configuration**: Configured via Cloudflare R2 Bucket → **Settings** → **Custom Domains**.

---

### Category E: Cloudflare Worker Deployment (CI/CD)

To deploy `apps/worker` via GitHub Actions (`wrangler deploy`):

#### `CLOUDFLARE_API_TOKEN`
* **Generation**: Cloudflare Dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template.
* **Permissions**:
  - Account: `Worker Scripts: Edit`, `Account Settings: Read`
  - Zone: `Workers Routes: Edit` (if using custom domains)
  - R2: `Workers R2 Storage: Edit`

#### `CLOUDFLARE_ACCOUNT_ID`
* Account ID string from Cloudflare overview.

---

### Category F: Registration & Platform Availability

#### `NEXT_PUBLIC_SIGNUPS_ENABLED`
* **Purpose**: Toggles registration availability across both the web UI and server API endpoints.
* **Format**: Boolean string (`"true"` / `"false"`).
* **Behavior**: When set to `"false"`, `/signup` displays a pause notice directing users to `/login` or support, and `POST /api/auth/signup` returns HTTP 403 Forbidden. Defaults to `"true"` if unset.
* **Provisioning**: Configured in GitHub Secrets (`gh secret set NEXT_PUBLIC_SIGNUPS_ENABLED --body "true"`) and synced to Vercel via `.github/workflows/sync-vercel-env.yml`.

---

## 3. Step-by-Step Injection Guide

### 1. In GitHub Repository Variables & Secrets (for CI/CD Deployments)
Go to **GitHub Repo** → **Settings** → **Secrets and variables** → **Actions**:

**Repository Variables** (Public settings):
- `NEXT_PUBLIC_ROOT_DOMAIN`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_MARKETING_URL`
- `NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER`
- `NEXT_PUBLIC_WHATSAPP_DEFAULT_MESSAGE`

**Repository Secrets** (Sensitive credentials & platform controls):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SESSION_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `NEXT_PUBLIC_SIGNUPS_ENABLED`
- *(If deploying Next.js to Vercel)*: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`

### 2. In Cloudflare Workers (Production Worker)
Secrets are automatically injected during deployment via [`.github/workflows/deploy-worker.yml`](../.github/workflows/deploy-worker.yml). The workflow reads `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `TOKEN_ENCRYPTION_KEY` directly from your GitHub Repository Secrets and sets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `TOKEN_ENCRYPTION_KEY` on the worker automatically using Wrangler.

You do **not** need to manually configure secrets in the Cloudflare Dashboard. If manual CLI injection is ever needed for local testing:
```bash
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

### 3. In Web Host (Vercel)
Instead of manually inputting secrets in the Vercel Dashboard, synchronize them directly from GitHub Secrets using the automated workflow [`.github/workflows/sync-vercel-env.yml`](../.github/workflows/sync-vercel-env.yml).

1. Ensure `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` are set in GitHub Repository Secrets.
2. Ensure application secrets (`NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, etc.) are configured in GitHub Repository Secrets.
3. The workflow runs automatically on every merge or push to `main` (and can also be triggered on demand via `gh workflow run sync-vercel-env.yml` or `workflow_dispatch`).
4. The workflow will automatically upsert all variables into Vercel production and preview environments via the Vercel REST API.

---

## 4. End-to-End Deployment Guide
For a comprehensive step-by-step walkthrough covering service provisioning across Supabase, Vercel, Cloudflare, Upstash, and GitHub Secrets, see [`docs/deployment-guide.md`](./deployment-guide.md).

