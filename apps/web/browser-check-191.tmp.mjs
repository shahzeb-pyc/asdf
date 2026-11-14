/**
 * Real-browser brand check for spec 191 (white-label NextRise).
 *
 * Runs against the PRODUCTION build on localhost:3000 with Chromium
 * host-resolver rules mapping the brand hosts to 127.0.0.1 (the
 * sandbox /etc/hosts is a read-only bind-mount, so no host entries
 * can be added there). No database is reachable from this sandbox,
 * so the check covers the unauthenticated surfaces + middleware
 * behaviour; the logged-in shell (sidebar / pill) is covered by the
 * component tests + brand sweep and needs a live session for a
 * browser eyeball.
 *
 * Usage: pnpm build && (start the server on :3000 with the dummy env)
 * then: node /home/hatch/workspace/verify191-probe/browser-check.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = '/home/hatch/workspace/verify191-probe';
fs.mkdirSync(OUT, { recursive: true });

const HOST_RULES =
  'MAP app.nextrisehq.com 127.0.0.1, MAP *.app.nextrisehq.com 127.0.0.1, ' +
  'MAP app.fbuploadpro.com 127.0.0.1, MAP *.fbuploadpro.com 127.0.0.1';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  args: [`--host-resolver-rules=${HOST_RULES}`],
});

async function newPage(viewport, dark) {
  const context = await browser.newContext({
    viewport,
    ...(dark
      ? {
          colorScheme: 'dark',
          // The app's theme init reads localStorage 'theme' first.
          storageState: undefined,
        }
      : { colorScheme: 'light' }),
  });
  if (dark) {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('theme', 'dark');
      } catch {}
    });
  }
  return context;
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

// --- Login page, both brands, desktop light ---
for (const [label, host, brand] of [
  ['nextrise', 'app.nextrisehq.com:3000', 'NextRise'],
  ['ours', 'app.fbuploadpro.com:3000', 'FBUploadPro'],
]) {
  const ctx = await newPage({ width: 1280, height: 900 }, false);
  const page = await ctx.newPage();
  const resp = await page.goto(`http://${host}/login`, { waitUntil: 'networkidle' });
  const text = (await page.textContent('body')) ?? '';
  const title = await page.title();
  check(
    `login ${label}: HTTP ${resp?.status()}`,
    resp?.status() === 200,
    `status=${resp?.status()}`
  );
  check(`login ${label}: title names ${brand}`, title.includes(brand), `title=${title}`);
  check(`login ${label}: brand name visible`, text.includes(brand));
  const hasSignup = text.includes('Create one');
  const hasForgot = text.includes('Forgot password?');
  const hasOldUsers = text.includes('For old FBUploadPro users');
  if (brand === 'NextRise') {
    check('login nextrise: no signup link', !hasSignup);
    check('login nextrise: no forgot-password link', !hasForgot);
    check('login nextrise: no old-users banner', !hasOldUsers);
    check('login nextrise: no FBUploadPro text anywhere', !text.includes('FBUploadPro'));
  } else {
    check('login ours: signup link present', hasSignup);
    check('login ours: forgot-password link present', hasForgot);
    check('login ours: old-users banner present', hasOldUsers);
  }
  // WhatsApp floater (deferred, client-only): wait for it to appear.
  try {
    await page.waitForSelector('[data-testid="whatsapp-support-button"]', { timeout: 8000 });
    const href = await page.getAttribute('[data-testid="whatsapp-support-button"]', 'href');
    if (brand === 'NextRise') {
      check('whatsapp nextrise: wa.me/923429469500', (href ?? '').includes('wa.me/923429469500'), href ?? '');
    } else {
      check('whatsapp ours: button absent without a configured number', false, `unexpected href=${href}`);
    }
  } catch {
    if (brand === 'NextRise') {
      check('whatsapp nextrise: button rendered', false, 'selector never appeared');
    } else {
      check('whatsapp ours: button absent without a configured number', true, 'no number configured in this env');
    }
  }
  await shot(page, `login-${label}-desktop-light`);
  await ctx.close();
}

// --- Login page, phone + dark, nextrise ---
{
  const ctx = await newPage({ width: 390, height: 844 }, true);
  const page = await ctx.newPage();
  await page.goto('http://app.nextrisehq.com:3000/login', { waitUntil: 'networkidle' });
  const text = (await page.textContent('body')) ?? '';
  check('login nextrise phone dark: NextRise visible', text.includes('NextRise'));
  check('login nextrise phone dark: no signup link', !text.includes('Create one'));
  check('login nextrise phone dark: no FBUploadPro text', !text.includes('FBUploadPro'));
  await shot(page, 'login-nextrise-phone-dark');
  await ctx.close();
}

// --- Privacy page, both brands ---
for (const [label, host, brand] of [
  ['nextrise', 'app.nextrisehq.com:3000', 'NextRise Digital'],
  ['ours', 'app.fbuploadpro.com:3000', 'FBUploadPro'],
]) {
  const ctx = await newPage({ width: 1280, height: 900 }, false);
  const page = await ctx.newPage();
  const resp = await page.goto(`http://${host}/privacy`, { waitUntil: 'networkidle' });
  const text = (await page.textContent('body')) ?? '';
  const title = await page.title();
  check(`privacy ${label}: HTTP ${resp?.status()}`, resp?.status() === 200);
  check(`privacy ${label}: title names ${brand}`, title.includes(brand), `title=${title}`);
  check(`privacy ${label}: copy names ${brand}`, text.includes(brand));
  if (brand === 'NextRise Digital') {
    check('privacy nextrise: no FBUploadPro text', !text.includes('FBUploadPro'));
  }
  await shot(page, `privacy-${label}-desktop-light`);
  await ctx.close();
}

// --- Middleware blocks on the white-label host ---
{
  const ctx = await newPage({ width: 1280, height: 900 }, false);
  const page = await ctx.newPage();
  // /signup must bounce to /login (middleware 307).
  const signupResp = await page.goto('http://app.nextrisehq.com:3000/signup', { waitUntil: 'domcontentloaded' });
  const signupUrl = page.url();
  check(
    'middleware nextrise: /signup bounces to /login',
    signupUrl.includes('/login'),
    `landed=${signupUrl} status=${signupResp?.status()}`
  );
  // /muse_guide.md must 404 (rewrite to /_not-found).
  const guideResp = await page.goto('http://app.nextrisehq.com:3000/muse_guide.md', { waitUntil: 'domcontentloaded' });
  check(
    'middleware nextrise: /muse_guide.md is a 404',
    guideResp?.status() === 404,
    `status=${guideResp?.status()}`
  );
  // Our brand: /signup renders (no session → the signup page itself).
  const ourSignup = await page.goto('http://app.fbuploadpro.com:3000/signup', { waitUntil: 'domcontentloaded' });
  check(
    'middleware ours: /signup renders (not bounced)',
    ourSignup?.status() === 200 && page.url().includes('/signup'),
    `status=${ourSignup?.status()} url=${page.url()}`
  );
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('FAILURES:');
  for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
  process.exit(1);
}
