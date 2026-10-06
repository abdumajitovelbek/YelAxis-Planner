import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, firefox, chromiumExecutableOptions } from './lib/browser.mjs';

// An actual uncached request must fail; navigator state alone cannot establish offline coverage.
const shell =
  '<p>Synthetic connectivity fixture</p><script>navigator.serviceWorker.register("/sw.js")</script>';
const worker = `
  self.addEventListener('install', event => event.waitUntil(caches.open('connectivity').then(cache => cache.addAll(['/']))));
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))));
`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/sw.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/sw.js' ? worker : shell);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['firefox', firefox],
  ]) {
    const browser = await type.launch({
      headless: true,
      ...(name === 'chromium' ? chromiumExecutableOptions() : {}),
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin);
      if (name === 'chromium') {
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      }
      await context.setOffline(true);
      if (name === 'chromium') await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => navigator.onLine === false);
      const blocked = await page.evaluate(() =>
        fetch('/uncached-probe').then(
          () => false,
          () => true,
        ),
      );
      assert.equal(blocked, true, 'Offline traffic must genuinely be blocked.');
      await context.setOffline(false);
      await page.reload();
      await page.waitForFunction(() => navigator.onLine === true);
      assert.equal(
        await page.evaluate(() => fetch('/uncached-probe').then((response) => response.ok)),
        true,
      );
      console.log(
        JSON.stringify({
          browser: name,
          version: browser.version(),
          offlineRequestsBlocked: true,
          offlineReload: name === 'chromium',
          onlineRecovery: true,
        }),
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
