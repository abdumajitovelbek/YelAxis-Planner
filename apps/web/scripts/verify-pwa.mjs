import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';
import { isStaticCacheUrl } from './lib/cache-policy.mjs';

const port = 5200 + (Date.now() % 400);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-persistence-pwa-'));
const server = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on('data', (chunk) => {
  serverOutput += String(chunk);
});

try {
  await waitForServer();
  const context = await chromium.launchPersistentContext(profileDirectory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  try {
    const result = await verifyProduction(context);
    await verifyStorageUnavailableState();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await context.close();
  }
} finally {
  stopProcessGroup(server);
  await rm(profileDirectory, { force: true, recursive: true });
}

async function verifyProduction(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  await completeMinimalSetup(page);
  await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();

  const session = await context.newCDPSession(page);
  const manifest = await session.send('Page.getAppManifest');
  const installability = await session.send('Page.getInstallabilityErrors');
  assert(manifest.data !== undefined, 'Chromium must parse the web app manifest.');
  const parsedManifest = JSON.parse(manifest.data);
  assert(parsedManifest.name === 'YelAxis Planner', 'Manifest name must be YelAxis Planner.');
  assert(parsedManifest.short_name === 'YelAxis', 'Manifest short name must be YelAxis.');
  assert(parsedManifest.display === 'standalone', 'Manifest must request standalone display.');
  assert(
    installability.installabilityErrors.length === 0,
    `Chromium must report no installability errors: ${JSON.stringify(
      installability.installabilityErrors,
    )}`,
  );

  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated';
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();
  assert(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
    'The production page must be controlled by the service worker after reload.',
  );

  const cacheUrls = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
    return requests.flat().map((request) => request.url);
  });
  assert(cacheUrls.length > 0, 'The offline shell must be precached.');
  assert(
    cacheUrls.every((url) => url.startsWith(origin)),
    'The service worker cache must contain same-origin shell assets only.',
  );
  assert(
    cacheUrls.every((url) => isStaticCacheUrl(url, origin)),
    'The service worker must not cache API, auth, token, or planning-content routes.',
  );

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('.offline-banner').waitFor();
  assert(
    (await page.locator('.offline-banner').textContent())?.trim() ===
      'Offline — your local plan remains available.',
    'Offline status must be visible without hiding the local plan.',
  );
  await context.setOffline(false);

  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  assert(
    (await page.locator(':focus').textContent())?.trim() === 'Skip to content',
    'The first keyboard focus target must be the skip link.',
  );
  await page.keyboard.press('Enter');
  assert(
    (await page.locator(':focus').getAttribute('id')) === 'main-content',
    'The skip link must move focus to main content.',
  );

  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Light').check();
  assert(
    (await page.locator('html').getAttribute('data-theme')) === 'light',
    'Light theme selection must update the document theme.',
  );
  await page.getByLabel('Reduced').check();
  assert(
    (await page.locator('html').getAttribute('data-motion')) === 'reduced',
    'Reduced-motion selection must update the document motion mode.',
  );

  const smallLayout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(
    smallLayout.clientWidth === smallLayout.scrollWidth,
    'Laptop layout must not overflow horizontally.',
  );
  await page.screenshot({ path: '/tmp/yelaxis-persistence-laptop-light.png', fullPage: true });

  await page.getByLabel('Dark').check();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(origin, { waitUntil: 'networkidle' });
  const largeLayout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(
    largeLayout.clientWidth === largeLayout.scrollWidth,
    'Desktop layout must not overflow horizontally.',
  );
  await page.screenshot({ path: '/tmp/yelaxis-persistence-desktop-dark.png', fullPage: true });

  const undersizedControls = await page.evaluate(() =>
    [...document.querySelectorAll('a, button, input')].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      const visible = bounds.width > 0 && bounds.height > 0;
      return visible && (bounds.height < 44 || bounds.width < 44)
        ? [`${element.tagName.toLowerCase()}:${element.textContent?.trim() ?? ''}`]
        : [];
    }),
  );
  assert(
    undersizedControls.length === 0,
    `Interactive controls must meet 44px targets: ${undersizedControls.join(', ')}`,
  );

  return {
    browser: 'Playwright Chromium',
    installabilityErrors: installability.installabilityErrors,
    manifest: {
      display: parsedManifest.display,
      name: parsedManifest.name,
      shortName: parsedManifest.short_name,
    },
    offlineShell: 'passed',
    serviceWorkerCacheEntries: cacheUrls.length,
    keyboardAndFocus: 'passed',
    themesAndReducedMotion: 'passed',
    viewports: ['1440x900', '1920x1080'],
    storageUnavailableState: 'passed',
    screenshots: [
      '/tmp/yelaxis-persistence-laptop-light.png',
      '/tmp/yelaxis-persistence-desktop-dark.png',
    ],
  };
}

async function completeMinimalSetup(page) {
  await page.getByRole('button', { name: 'Start locally' }).click();
  await page.getByRole('button', { name: 'Confirm defaults' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByLabel('First concrete Action').fill('Verify the local PWA');
  await page.getByRole('button', { name: 'Continue to handbook' }).click();
  await page.getByRole('button', { name: 'Skip and open Today' }).click();
}

async function verifyStorageUnavailableState() {
  const browser = await chromium.launch({
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const unavailableContext = await browser.newContext();
  await unavailableContext.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { configurable: true, value: undefined });
  });
  const unavailablePage = await unavailableContext.newPage();
  await unavailablePage.goto(origin, { waitUntil: 'domcontentloaded' });
  await unavailablePage
    .getByRole('heading', { name: 'Your local plan could not be opened' })
    .waitFor();
  assert(
    (await unavailablePage.getByRole('button', { name: 'Try again' }).count()) === 1,
    'Unavailable storage state must offer a retry action.',
  );
  await unavailableContext.close();
  await browser.close();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite preview exited before verification:\n${serverOutput}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Vite preview:\n${serverOutput}`);
}

/** Stop pnpm and the vite server it started (both share the detached process group). */
function stopProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
}
