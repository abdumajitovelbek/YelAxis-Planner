import {
  animatedElementCount,
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  blockForeignRequests,
  completeMinimalOnboarding,
  poll,
  recordForeignRequests,
  runJourney,
  tabTo,
  unlabelledFields,
  waitForFocus,
} from './lib/journey.mjs';

/**
 * Real production app, worker SQLite, canonical commands, restart and offline journeys. Native
 * Chromium permission denial/grant is exercised through browser permission controls. Native
 * Firefox grant is attempted; its denial uses a labelled deterministic boundary. Notification
 * show/error/click events are a labelled API double because a headless browser cannot establish
 * OS display or a lock-screen preview. No service-worker notification or push is involved.
 */
const date = '2027-01-04';
const initialTime = new Date(`${date}T08:00:00.000Z`);

async function installBoundary(context, inFirefox) {
  await context.addInitScript(
    ({ firefoxDenial }) => {
      const NativeNotification = window.Notification;
      window.__notificationFixture = {
        forcedPermission: null,
        requestCount: 0,
        shown: [],
        handles: [],
        fail: false,
      };
      class JourneyNotification extends EventTarget {
        static get permission() {
          return (
            window.__notificationFixture.forcedPermission ??
            NativeNotification?.permission ??
            'denied'
          );
        }
        static async requestPermission() {
          window.__notificationFixture.requestCount += 1;
          if (firefoxDenial && JourneyNotification.permission === 'default') {
            window.__notificationFixture.forcedPermission = 'denied';
            return 'denied';
          }
          return NativeNotification.requestPermission();
        }
        constructor(title, options) {
          super();
          this.closed = false;
          window.__notificationFixture.shown.push({
            title,
            body: options?.body,
            tag: options?.tag,
          });
          window.__notificationFixture.handles.push(this);
          queueMicrotask(() =>
            this.dispatchEvent(new Event(window.__notificationFixture.fail ? 'error' : 'show')),
          );
        }
        close() {
          this.closed = true;
          this.dispatchEvent(new Event('close'));
        }
      }
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: JourneyNotification,
      });
      Object.defineProperty(window.__notificationFixture, 'nativePermission', {
        get: () => NativeNotification?.permission ?? 'unsupported',
      });
    },
    { firefoxDenial: inFirefox },
  );
}

await runJourney(
  {
    name: 'recovery-notifications',
    title: 'recovery notifications',
    timeZone: 'UTC',
    basePort: 8700,
    timeoutMinutes: 12,
    // Headless Shell reports denied independently of native browser permission controls.
    // Use the pinned full Chromium binary to verify actual permission denial and grant.
    nativePermissions: true,
  },
  async (j) => {
    const started = Date.now();
    const externalRequests = [];
    const browserErrors = [];
    const blockedRequests = [];
    let context = await j.launch();
    let page;
    let currentTime = initialTime;
    let nativeGrant = false;
    const openPage = async () => {
      await blockForeignRequests(context, j.origin, blockedRequests);
      recordForeignRequests(context, j.origin, externalRequests);
      await installBoundary(context, j.inFirefox);
      page = context.pages()[0] ?? (await context.newPage());
      j.observe(page, externalRequests, browserErrors);
      await page.clock.install({ time: currentTime });
    };
    const refresh = () =>
      page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('yelaxis:notifications-changed'));
      });
    const visit = async (path) => {
      await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
      await page
        .getByRole('heading', { level: 1 })
        .filter({ hasNotText: 'Opening your plan' })
        .waitFor();
      if (path === '/notifications')
        await page.getByText('Loading reminders…', { exact: true }).waitFor({ state: 'hidden' });
      if (path === '/settings')
        await page
          .getByText('Loading notification settings…', { exact: true })
          .waitFor({ state: 'hidden' });
    };
    const tick = async (time) => {
      currentTime = new Date(`${date}T${time}:00.000Z`);
      await page.clock.setSystemTime(currentTime);
      await refresh();
    };
    const capture = async (title, time) => {
      await page.getByRole('button', { name: /Capture Alt C/u }).click();
      const dialog = page.getByRole('dialog', { name: 'Add to Inbox' });
      await dialog.getByLabel('Title').fill(title);
      await dialog.getByText('More details', { exact: true }).click();
      await dialog.getByLabel('Enable reminder definition').check();
      await dialog.getByLabel('Date', { exact: true }).last().fill(date);
      await dialog.getByLabel('Time', { exact: true }).fill(time);
      await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await visit('/inbox');
      const row = page.locator('.inbox-list > li').filter({ hasText: title });
      await row.waitFor();
      const href = await row.getByRole('link', { name: title, exact: true }).getAttribute('href');
      assert(href?.startsWith('/actions/'), 'Capture must create a normal owned Action route.');
      return href;
    };
    try {
      await openPage();
      j.step('conservative defaults and native denial');
      await page.goto(j.origin, { waitUntil: 'networkidle' });
      await completeMinimalOnboarding(page);
      await visit('/settings');
      await page.getByRole('heading', { name: 'Reminders and browser alerts' }).waitFor();
      assert(
        await page.evaluate(() => window.__notificationFixture.requestCount === 0),
        'Launch must never request notification permission.',
      );
      await page.getByText(/Closing the app stops delivery/).waitFor();
      if (j.inFirefox) {
        await page.evaluate(() => {
          window.__notificationFixture.forcedPermission = 'default';
        });
        await refresh();
        await page.getByRole('button', { name: 'Allow browser alerts' }).click();
      } else {
        const allow = page.getByRole('button', { name: 'Allow browser alerts' });
        await allow.waitFor();
        const session = await context.newCDPSession(page);
        await session.send('Browser.setPermission', {
          permission: { name: 'notifications' },
          setting: 'denied',
          origin: j.origin,
        });
        // Reload after a CDP override: Chromium's synchronous Notification.permission cache may
        // still report its earlier value in this renderer while navigator.permissions has changed.
        await page.reload({ waitUntil: 'networkidle' });
        assert(
          await page.evaluate(
            async () =>
              (await navigator.permissions.query({ name: 'notifications' })).state === 'denied',
          ),
          'Chromium must expose actual native notification denial.',
        );
        await session.detach();
      }
      await page.getByText(/Change this site's notification permission/).waitFor();
      j.checks.push(
        j.inFirefox
          ? 'permission denial through an explicit button with a labelled Firefox permission boundary'
          : 'secure Chromium native notification denial leaves internal reminders usable and gives browser Settings recovery',
      );

      j.step('native browser permission grant and explicit enable');
      try {
        await context.grantPermissions(['notifications'], { origin: j.origin });
        nativeGrant = true;
      } catch (error) {
        if (!j.inFirefox) throw error;
      }
      await page.evaluate((native) => {
        window.__notificationFixture.forcedPermission = native ? null : 'granted';
      }, nativeGrant);
      if (!j.inFirefox) await page.reload({ waitUntil: 'networkidle' });
      await refresh();
      if (nativeGrant)
        assert(
          await page.evaluate(() => window.__notificationFixture.nativePermission === 'granted'),
          'Permission grant must reach the native Notifications API.',
        );
      await page.getByRole('button', { name: 'Enable browser alerts' }).click();
      await page.getByRole('button', { name: 'Turn off browser alerts' }).waitFor();
      j.checks.push(
        'native browser grant where supported still requires explicit enable; generic display is the default',
      );

      j.step('generic scheduled alert and explicit centre read/dismiss');
      await capture('Synthetic generic reminder', '08:01');
      await visit('/notifications');
      await tick('08:01');
      await poll(
        () => page.evaluate(() => window.__notificationFixture.shown.length === 1),
        'Due reminder must dispatch once through the notification port.',
      );
      const generic = await page.evaluate(() => window.__notificationFixture.shown[0]);
      assert(
        generic.title === 'YelAxis Planner reminder' &&
          generic.body === 'A reminder is due. Open YelAxis Planner to view it.',
        'Privacy mode must replace the planning title with exact generic content.',
      );
      await page.getByRole('button', { name: 'Mark Synthetic generic reminder as read' }).click();
      await waitForFocus(page, page.getByRole('heading', { name: 'Notifications', exact: true }));
      await page.getByRole('button', { name: 'Dismiss Synthetic generic reminder' }).click();
      await page.getByText('No due reminders. Your plan remains available offline.').waitFor();
      j.checks.push(
        'timed canonical Action reminder dispatches exactly generic privacy content once; centre read/dismiss is explicit and restores heading focus',
      );

      j.step('explicit title exposure preview and dispatch');
      await visit('/settings');
      await page.getByRole('button', { name: 'Preview showing planning titles' }).click();
      await page.getByText(/Titles can appear on a shared or locked screen/).waitFor();
      await page.getByRole('button', { name: 'Keep generic text' }).click();
      assert(
        (await page.getByRole('button', { name: 'Preview showing planning titles' }).count()) === 1,
        'Cancel must retain generic privacy.',
      );
      await page.getByRole('button', { name: 'Preview showing planning titles' }).click();
      await page.getByRole('button', { name: 'Confirm showing planning titles' }).click();
      await page.getByRole('button', { name: 'Use generic notification text' }).waitFor();
      await capture('Synthetic visible title reminder', '08:02');
      await visit('/notifications');
      await tick('08:02');
      await poll(
        () => page.evaluate(() => window.__notificationFixture.shown.length === 1),
        'Title-enabled reminder must dispatch.',
      );
      assert(
        await page.evaluate(
          () => window.__notificationFixture.shown[0].body === 'Synthetic visible title reminder',
        ),
        'Explicitly disabled privacy must match the disclosed title payload.',
      );
      j.checks.push(
        'privacy preview cancellation retains generic content; explicit confirmation permits exactly the live target title payload',
      );

      j.step('adapter failure and finished target suppression');
      const finished = await capture('Synthetic finished reminder', '08:03');
      await visit(finished);
      await page.getByRole('button', { name: 'Complete', exact: true }).click();
      await page.getByText(/Action · completed/u).waitFor();
      await capture('Synthetic error reminder', '08:03');
      await visit('/notifications');
      await page.evaluate(() => {
        window.__notificationFixture.fail = true;
      });
      await tick('08:03');
      const failedRow = page
        .locator('.notification-list > li')
        .filter({ hasText: 'Synthetic error reminder' });
      await failedRow
        .getByText('The browser alert was unavailable. The reminder is available here.')
        .waitFor();
      assert(
        (await page
          .locator('.notification-list > li')
          .filter({ hasText: 'Synthetic finished reminder' })
          .count()) === 0,
        'Completed targets must not deliver or enter the centre.',
      );
      assert(
        await page.evaluate(() => window.__notificationFixture.shown.length === 1),
        'Only the unfinished target may reach the adapter.',
      );
      await refresh();
      assert(
        await page.evaluate(() => window.__notificationFixture.shown.length === 1),
        'A failed adapter claim must not trigger duplicate attempts.',
      );
      j.checks.push(
        'Notification API error retains the internal reminder; completed targets are suppressed; repeated reconciliation never duplicates an attempt',
      );

      j.step('offline reload and reopen missed recovery');
      await capture('Synthetic reopened reminder', '08:05');
      await visit('/notifications');
      if (!j.inFirefox) {
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready;
        });
        await context.setOffline(true);
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Mark Synthetic error reminder as read' }).click();
        j.checks.push(
          'offline production PWA reload keeps centre and explicit read control available through worker SQLite',
        );
      } else {
        await context.setOffline(true);
        await page.getByRole('button', { name: 'Mark Synthetic error reminder as read' }).click();
        j.checks.push(
          'Firefox offline loaded-app centre/read path works; offline reload is covered by Chromium PWA',
        );
      }
      await context.setOffline(false);
      await context.close();
      currentTime = new Date(`${date}T08:07:00.000Z`);
      context = await j.launch();
      await openPage();
      await visit('/notifications');
      const missedRow = page
        .locator('.notification-list > li')
        .filter({ hasText: 'Synthetic reopened reminder' });
      await missedRow
        .getByText('Due while YelAxis Planner was closed or delayed; recovered here.')
        .waitFor();
      assert(
        await page.evaluate(() => window.__notificationFixture.shown.length === 0),
        'Reopening must retain missed reminders without an OS alert storm or redelivery of prior claims.',
      );
      j.checks.push(
        'persistent browser restart recovers the missed reminder and preserves read/dispatch receipts without any closed-browser delivery claim',
      );

      j.step('layouts, themes, keyboard and static caches');
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1280, height: 800 },
        { width: 320, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        await assertSingleH1(page, 'Notifications');
        await assertNoOverflow(page, `Notifications ${String(viewport.width)}`);
        await assertTargets(page, 'Notifications');
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await assertNoOverflow(page, 'Notifications 200% text');
      await j.shot(page, 'centre-200-percent-text');
      await page.evaluate(() => {
        document.documentElement.style.removeProperty('font-size');
      });
      const read = page.getByRole('button', { name: 'Mark Synthetic reopened reminder as read' });
      await page.locator('h1').focus();
      await tabTo(page, read);
      await page.keyboard.press('Enter');
      await waitForFocus(page, page.locator('h1'));
      for (const theme of ['Dark', 'Light']) {
        await visit('/settings');
        await page.getByLabel(theme, { exact: true }).check();
        await visit('/notifications');
        await assertNoOverflow(page, `${theme} Notifications`);
        await j.shot(page, `centre-${theme.toLowerCase()}`);
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert(
        (await animatedElementCount(page)) === 0,
        'Reduced motion must disable notification animations.',
      );
      assert(
        (await unlabelledFields(page)).length === 0,
        'Notification controls must have accessible labels.',
      );
      j.checks.push(
        'notifications keyboard path, focus, 44px targets, laptop/desktop/320px reflow, 200% text, both themes and reduced motion pass',
      );
      const cachedAssets = j.inFirefox ? null : await assertStaticCaches(page, j.origin);
      assert(
        [...new Set(externalRequests)].length === 0 && blockedRequests.length === 0,
        'Notifications may make no external requests.',
      );
      const clockArtifacts = browserErrors.filter(
        (error) =>
          j.inFirefox &&
          error.startsWith(
            '[JavaScript Error: "InvalidStateError: An attempt was made to use an object that is not, or is no longer, usable"] [step: ',
          ),
      );
      const errors = browserErrors.filter((error) => !clockArtifacts.includes(error));
      assert(errors.length === 0, `Unexpected browser errors: ${errors.join(' | ')}`);
      j.checks.push(
        j.inFirefox
          ? 'all requests stay same-origin; no unexpected browser error; static-cache audit is Chromium PWA coverage'
          : 'all requests stay same-origin; service-worker cache holds only static assets; no unexpected browser error',
      );
      return {
        checkCount: j.checks.length,
        durationSeconds: Math.round((Date.now() - started) / 1000),
        nativePermissionGrant: nativeGrant,
        denialBoundary: j.inFirefox
          ? 'scripted Firefox denial'
          : 'native Chromium CDP permission denial',
        notificationDisplayBoundary:
          'deterministic show/error event double in a real browser; physical OS display and lock screen deferred to release',
        offlineReload: !j.inFirefox,
        externalRequests: [...new Set(externalRequests)],
        blockedRequests,
        browserErrors: errors,
        firefoxClockArtifacts: clockArtifacts,
        cachedAssets,
      };
    } catch (error) {
      await page
        .screenshot({
          path: `/tmp/yelaxis-recovery-notifications-${j.browserLabel}-failure.png`,
          fullPage: true,
        })
        .catch(() => undefined);
      process.stderr.write(
        `${await page
          .locator('main')
          .innerText()
          .catch(() => 'Page unavailable')}\n`,
      );
      process.stderr.write(
        `${JSON.stringify(await page.evaluate(() => ({ native: window.__notificationFixture.nativePermission, current: Notification.permission, requests: window.__notificationFixture.requestCount })).catch(() => ({})))}\n`,
      );
      throw error;
    } finally {
      await context.close();
    }
  },
);
