import { readFile, writeFile } from 'node:fs/promises';
import {
  runJourney,
  assert,
  completeMinimalOnboarding,
  poll,
  assertStaticCaches,
  blockForeignRequests,
  recordForeignRequests,
} from './lib/journey.mjs';

// Local, synthetic, compatible-shell update/reversal only. No hosted rollback claim.
await runJourney(
  {
    basePort: 9700,
    name: 'release-security',
    timeZone: 'UTC',
    title: 'Release security',
    timeoutMinutes: 8,
  },
  async (j) => {
    const context = await j.launch();
    const errors = [],
      external = [],
      consoleMessages = [];
    const scriptPath = new URL('../dist/sw.js', import.meta.url);
    const original = await readFile(scriptPath, 'utf8');
    try {
      await blockForeignRequests(context, j.origin, external);
      recordForeignRequests(context, j.origin, external);
      const page = context.pages()[0] ?? (await context.newPage());
      j.observe(page, external, errors);
      page.on('console', (message) => consoleMessages.push(message.text()));
      j.step('reviewed response policy and static shell');
      const response = await page.goto(j.origin, { waitUntil: 'networkidle' });
      const headers = response.headers();
      assert(
        headers['content-security-policy']?.includes("script-src 'self' 'wasm-unsafe-eval'"),
        'Production preview must enforce reviewed scripts/WASM policy.',
      );
      assert(
        !headers['content-security-policy'].includes("'unsafe-eval'"),
        'JavaScript eval must remain forbidden.',
      );
      assert(
        headers['x-content-type-options'] === 'nosniff' &&
          headers['x-frame-options'] === 'DENY' &&
          headers['referrer-policy'] === 'no-referrer',
        'No sniffing/framing/referrer exposure.',
      );
      j.checks.push('reviewed CSP, no JS eval, nosniff, DENY and no-referrer delivered');
      await completeMinimalOnboarding(page);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      // clientsClaim is deliberately false; a fresh document adopts the installed shell.
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      const marker = 'Synthetic release private planning marker';
      await page.getByRole('button', { name: /Capture Alt C/u }).click();
      const dialog = page.getByRole('dialog', { name: 'Add to Inbox', exact: true });
      await dialog.getByLabel(/^Title/u).fill(marker);
      await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.goto(j.origin + '/inbox', { waitUntil: 'networkidle' });
      await page.getByRole('link', { name: marker, exact: true }).waitFor();
      const initialController = await page.evaluate(
        () => navigator.serviceWorker.controller.scriptURL,
      );
      j.step('waiting update preserves acknowledged data and requires confirmation');
      await writeFile(scriptPath, original + '\n// synthetic compatible candidate update\n');
      await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
      const update = page.getByRole('dialog', {
        name: 'A new YelAxis Planner version is available',
      });
      await update.waitFor();
      assert(
        (await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)) ===
          initialController,
        'Update cannot switch before explicit consent.',
      );
      await update.getByRole('button', { name: 'Later', exact: true }).click();
      await page.getByRole('link', { name: marker, exact: true }).waitFor();
      // Reopening a controlled document surfaces the still-waiting update, without auto activation.
      await page.reload({ waitUntil: 'networkidle' });
      await update.waitFor();
      const previousDocument = await page.evaluate(() => performance.timeOrigin);
      await update.getByRole('button', { name: 'Update now', exact: true }).click();
      await poll(
        () => page.evaluate((previous) => performance.timeOrigin > previous, previousDocument),
        'Explicit activation must reload into a new document before inspecting persisted records.',
      );
      await page.getByRole('link', { name: marker, exact: true }).waitFor();
      await poll(
        () => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting === null),
        'Explicit update must finish activation.',
      );
      j.checks.push(
        'waiting update, Later, deliberate activation preserve acknowledged synthetic Action',
      );
      j.step('compatible shell reversal without resetting user data');
      await writeFile(scriptPath, original + '\n// synthetic compatible shell reversal\n');
      await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
      await update.waitFor();
      const reversalDocument = await page.evaluate(() => performance.timeOrigin);
      await update.getByRole('button', { name: 'Update now', exact: true }).click();
      await poll(
        () => page.evaluate((previous) => performance.timeOrigin > previous, reversalDocument),
        'Explicit activation must reload into a new document before inspecting persisted records.',
      );
      await page.getByRole('link', { name: marker, exact: true }).waitFor();
      await poll(
        () => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting === null),
        'Explicit reversal must finish activation.',
      );
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('link', { name: marker, exact: true }).waitFor();
      j.checks.push(
        'compatible current-schema static-shell reversal and restart preserve exact Action',
      );
      j.step('offline deep link, cache and privacy/log boundary');
      await assertStaticCaches(page, j.origin);
      await context.setOffline(true);
      // Browser-level offline mode now blocks all network. Remove the online request interceptor:
      // Firefox's interceptor otherwise prevents navigation from reaching its static service worker.
      // Context-wide egress observation and every offline/cache/error assertion remain active.
      await context.unrouteAll({ behavior: 'wait' });
      await page.goto(j.origin + '/search', { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Search', exact: true }).waitFor();
      const names = await page.evaluate(async () => caches.keys());
      assert(names.length > 0, 'Offline static cache must exist.');
      assert(
        consoleMessages.every((text) => !text.includes(marker)),
        'Planning content must not enter browser logs.',
      );
      assert(
        external.length === 0 && errors.length === 0,
        'No external request or browser error on release lifecycle.',
      );
      j.checks.push(
        'offline deep link; static-only cache; no synthetic planning marker in browser logs; zero egress/errors',
      );
      return {
        browserVersion: context.browser()?.version() ?? null,
        externalRequests: 0,
        browserErrors: 0,
        privacyMarkerInLogs: false,
        rollbackScope: 'local compatible current-schema shell only',
        hostedReleaseVerified: false,
      };
    } finally {
      await writeFile(scriptPath, original);
      await context.close();
    }
  },
);
