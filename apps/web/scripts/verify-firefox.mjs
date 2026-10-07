import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { firefox } from './lib/browser.mjs';

const port = 4300 + (Date.now() % 500);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-persistence-firefox-'));
const databaseName = `/persistence-firefox-${Date.now().toString(16)}.sqlite3`;
const server = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
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
  const exclusiveLock = await verifyExclusiveLock();
  const seed = await runPhase('seed', true);
  const reopen = await runPhase('reopen', false);
  process.stdout.write(
    `${JSON.stringify(
      {
        browser: 'Playwright Firefox 153',
        normalWebsite: 'passed',
        exclusiveLock,
        persistenceSeed: seed,
        persistenceReopen: reopen,
        installation: 'not supported by Firefox desktop',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  stopProcessGroup(server);
  await rm(profileDirectory, { force: true, recursive: true });
}

async function verifyExclusiveLock() {
  const context = await firefox.launchPersistentContext(profileDirectory, {
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  try {
    const holder = context.pages()[0] ?? (await context.newPage());
    const heldUrl = new URL('/test/persistence.html', origin);
    heldUrl.searchParams.set('phase', 'hold');
    heldUrl.searchParams.set('database', databaseName);
    await holder.goto(heldUrl.toString(), { waitUntil: 'domcontentloaded' });
    await holder.waitForFunction(
      () => document.querySelector('#result')?.getAttribute('data-status') === 'holding',
    );
    const contender = await context.newPage();
    const result = await openVerification(contender, 'expect-busy');
    return result;
  } finally {
    await context.close();
  }
}

async function runPhase(phase, verifyShell) {
  const context = await firefox.launchPersistentContext(profileDirectory, {
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const browserMessages = [];
  let step = 'open';
  try {
    page.on('console', (message) =>
      browserMessages.push(`console:${message.type()}:${message.text()}`),
    );
    page.on('pageerror', (error) => browserMessages.push(`pageerror:${error.message}`));
    page.on('requestfinished', (request) => {
      if (request.url().includes('sqlite')) browserMessages.push(`request:${request.url()}`);
    });
    page.on('worker', (worker) => browserMessages.push(`worker:${worker.url()}`));
    if (verifyShell) {
      await page.goto(origin, { waitUntil: 'networkidle' });
      try {
        await page.waitForFunction(
          () => {
            const heading = document.querySelector('h1')?.textContent?.trim();
            return (
              heading === 'Connect direction to action.' ||
              heading === 'Your local plan could not be opened'
            );
          },
          undefined,
          { timeout: 60_000 },
        );
      } catch (error) {
        const features = await page.evaluate(async () => {
          const workerFeatures = await new Promise((resolve) => {
            const source =
              'postMessage({directory:typeof navigator.storage?.getDirectory,sync:typeof FileSystemFileHandle?.prototype?.createSyncAccessHandle})';
            const worker = new Worker(URL.createObjectURL(new Blob([source])));
            worker.onmessage = (event) => resolve(event.data);
            window.setTimeout(() => resolve({ timeout: true }), 3000);
          });
          return {
            crossOriginIsolated,
            directory: typeof navigator.storage?.getDirectory,
            fileHandle: typeof FileSystemFileHandle,
            sharedArrayBuffer: typeof SharedArrayBuffer,
            workerFeatures,
          };
        });
        throw new Error(
          `Firefox application startup timed out: ${JSON.stringify({
            features,
            browserMessages,
          })}`,
          { cause: error },
        );
      }
      const heading = (await page.locator('h1').textContent())?.trim();
      if (heading !== 'Connect direction to action.') {
        throw new Error(
          `Firefox application startup failed: ${await page.locator('body').innerText()}`,
        );
      }
      await page.getByRole('button', { name: 'Start locally' }).click();
      step = 'confirm defaults';
      await page.getByRole('button', { name: 'Confirm defaults' }).click();
      await page.getByRole('button', { name: 'Skip for now' }).click();
      await page.getByRole('button', { name: 'Skip for now' }).click();
      await page.getByRole('button', { name: 'Skip for now' }).click();
      await page.getByLabel('First concrete Action').fill('Firefox onboarding Action');
      step = 'save first Action';
      await page.getByRole('button', { name: 'Continue to handbook' }).click();
      // The step effect moves focus and may scroll. Let that transition settle before aiming
      // the pointer at the completion button, especially on slower development-build runners.
      await page
        .getByRole('heading', { name: 'Learn the manual loop in a safe sandbox.' })
        .waitFor();
      await page.waitForFunction(
        () => document.activeElement === document.querySelector('#onboarding-title'),
      );
      step = 'complete onboarding';
      await page.evaluate(() => {
        window.__onboardingPointerEvents = [];
        for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click']) {
          document.addEventListener(
            type,
            (event) => {
              window.__onboardingPointerEvents.push({
                type,
                target: event.target?.textContent?.slice(0, 120),
                tag: event.target?.tagName,
                disabled: event.target?.disabled,
                x: event.clientX,
                y: event.clientY,
                trusted: event.isTrusted,
              });
            },
            { capture: true },
          );
        }
      });
      const complete = page.getByRole('button', { name: 'Skip and open Today' });
      await complete.hover();
      await complete.click({ delay: 100 });
      const deliveredClick = await page.evaluate(() =>
        window.__onboardingPointerEvents.some(
          (event) =>
            event.type === 'click' && event.target === 'Skip and open Today' && event.trusted,
        ),
      );
      if (!deliveredClick)
        throw new Error('Firefox did not deliver the trusted handbook pointer click.');
      await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();
      step = 'capture while online';
      await page.getByRole('button', { name: /Capture Alt C/u }).click();
      const capture = page.getByRole('dialog', { name: 'Add to Inbox' });
      await capture.getByLabel('Title').fill('Firefox offline Action');
      await capture.getByRole('button', { name: 'Capture', exact: true }).click();
      await page.getByRole('link', { name: 'Inbox' }).click();
      await page.getByText('Firefox offline Action', { exact: true }).waitFor();
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.getByText('Offline — your local plan remains available.').waitFor();
      await page.getByRole('button', { name: /Capture Alt C/u }).click();
      const offlineCapture = page.getByRole('dialog', { name: 'Add to Inbox' });
      await offlineCapture.getByLabel('Title').fill('Firefox second offline Action');
      await offlineCapture.getByRole('button', { name: 'Capture', exact: true }).click();
      await page.getByText('Firefox second offline Action', { exact: true }).waitFor();
      await context.setOffline(false);
      await page
        .getByRole('navigation', { name: 'Tools' })
        .getByRole('link', { name: 'Settings' })
        .click();
      await page.getByRole('heading', { name: 'Your local setup' }).waitFor();
      await page.getByLabel('Light').check();
      if ((await page.locator('html').getAttribute('data-theme')) !== 'light') {
        throw new Error('Firefox did not apply the selected theme.');
      }
    }

    return await openVerification(page, phase);
  } catch (error) {
    const screenshot = `/tmp/yelaxis-persistence-firefox-${phase}-failure.png`;
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    const state = await page
      .evaluate(() => ({
        heading: document.querySelector('h1')?.textContent,
        alerts: [...document.querySelectorAll('[role=alert]')].map((node) => node.textContent),
        visibleText: document.querySelector('main')?.textContent?.slice(0, 5000),
        locale: navigator.language,
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        geometry: {
          viewport: [innerWidth, innerHeight],
          screen: [screen.width, screen.height],
          window: [outerWidth, outerHeight],
          scroll: [scrollX, scrollY],
        },
        pointerEvents: window.__onboardingPointerEvents,
        buttons: [...document.querySelectorAll('button')].map((node) => ({
          text: node.textContent,
          disabled: node.disabled,
          bounds: node.getBoundingClientRect().toJSON(),
          hovered: node.matches(':hover'),
        })),
      }))
      .catch(() => ({ closed: true }));
    throw new Error(
      `Firefox persistence failed at ${step}: ${JSON.stringify({ state, browserMessages, screenshot })}`,
      { cause: error },
    );
  } finally {
    await context.close();
  }
}

async function openVerification(page, phase) {
  const url = new URL('/test/persistence.html', origin);
  url.searchParams.set('phase', phase);
  url.searchParams.set('database', databaseName);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#result')?.getAttribute('data-status') !== 'running',
    undefined,
    { timeout: 60_000 },
  );
  const status = await page.locator('#result').getAttribute('data-status');
  const content = await page.locator('#result').textContent();
  if (status !== 'passed') {
    throw new Error(`Firefox persistence phase ${phase} failed:\n${content ?? ''}`);
  }
  return JSON.parse(content ?? '{}');
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before Firefox verification:\n${serverOutput}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Vite:\n${serverOutput}`);
}

/** Stop pnpm and the vite server it started (both share the detached process group). */
function stopProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
}
