import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  animatedElementCount,
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  completeMinimalOnboarding,
  forbiddenCopy,
  poll,
  runJourney,
  setDocumentVisibility,
} from './lib/journey.mjs';

const TITLE = 'Release synthetic نور 日本語';
const DAY = '2026-10-04';
const NOTE = 'A synthetic release review: сохраняем спокойствие, aniq keyingi qadam.';
const routes = [
  '/',
  '/inbox',
  `/plan/day/${DAY}`,
  `/plan/week/${DAY}`,
  '/axis',
  '/axis/alignment',
  '/review',
  '/search',
  '/notifications',
  '/data',
  '/settings',
];
const visit = async (page, path) => {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.locator('main h1').waitFor();
  await poll(
    () =>
      page
        .locator('main[aria-busy="true"], main [aria-busy="true"]')
        .count()
        .then((count) => count === 0),
    'The visible release route must finish loading.',
  );
};

async function downloadedText(page, name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const file = await event;
  const path = await file.path();
  assert(path !== null, 'The synthetic download must complete.');
  return { text: await readFile(path, 'utf8'), name: file.suggestedFilename() };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Computed solid text/background audit; gradient/decorative text is reported separately. */
async function contrastAudit(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('A canvas color parser is required.');
    const parse = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => (i === 3 ? v / 255 : v));
    };
    const composite = (front, back) =>
      front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]));
    const background = (element) => {
      const chain = [];
      let current = element;
      while (current !== null) {
        chain.push(current);
        current = current.parentElement;
      }
      return chain
        .reverse()
        .reduce(
          (color, node) => composite(parse(getComputedStyle(node).backgroundColor), color),
          [255, 255, 255],
        );
    };
    const luminance = (color) =>
      color
        .map((v) => {
          const n = v / 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => {
      const x = luminance(a),
        y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const failures = [],
      skipped = [];
    let checked = 0,
      minimum = 100;
    for (const element of document.querySelectorAll('main *, .sidebar *, .topbar *')) {
      if (
        !(element instanceof HTMLElement) ||
        ![...element.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && /\S/u.test(node.textContent ?? ''),
        )
      )
        continue;
      const box = element.getBoundingClientRect(),
        style = getComputedStyle(element);
      if (
        box.width === 0 ||
        box.height === 0 ||
        element.closest(
          '[aria-hidden="true"], .sr-only, button:disabled, [aria-disabled="true"], option',
        ) !== null ||
        style.visibility === 'hidden'
      )
        continue;
      if (style.backgroundImage !== 'none') {
        skipped.push(element.tagName);
        continue;
      }
      const back = background(element),
        fore = composite(parse(style.color), back);
      const value = ratio(fore, back),
        large =
          Number.parseFloat(style.fontSize) >= 24 ||
          (Number.parseFloat(style.fontSize) >= 18.66 && Number.parseInt(style.fontWeight) >= 700);
      checked += 1;
      minimum = Math.min(minimum, value);
      if (value + 0.01 < (large ? 3 : 4.5))
        failures.push({
          tag: element.tagName,
          className: element.className,
          text: (element.textContent ?? '').trim().slice(0, 70),
          ratio: value,
          threshold: large ? 3 : 4.5,
        });
    }
    const tokens = getComputedStyle(document.documentElement);
    const nonText = ['--control-border', '--focus'].flatMap((token) =>
      ['--bg', '--bg-raised', '--surface'].map((surface) => ({
        token,
        surface,
        ratio: ratio(
          parse(tokens.getPropertyValue(token)).slice(0, 3),
          parse(tokens.getPropertyValue(surface)).slice(0, 3),
        ),
      })),
    );
    return { checked, minimum, skippedGradientOrDecorativeText: skipped.length, failures, nonText };
  });
}

await runJourney(
  {
    name: 'release-accessibility',
    title: 'release release accessibility',
    basePort: 10300,
    timeZone: 'Asia/Tashkent',
    timeoutMinutes: 20,
  },
  async (j) => {
    const errors = [],
      external = [],
      matrix = [],
      contrast = [];
    const context = await j.launch();
    const page = context.pages()[0] ?? (await context.newPage());
    await page.clock.install({ time: new Date('2026-10-04T09:00:00Z') });
    j.observe(page, external, errors);
    await context.route('**/*', (route) =>
      route.request().url().startsWith(j.origin) ? route.continue() : route.abort(),
    );
    await page.goto(j.origin);
    await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
    if (!j.inFirefox)
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
    await context.setOffline(true);

    j.step('complete manual onboarding, capture, plan, act, review and verified export offline');
    await completeMinimalOnboarding(page);
    await page.keyboard.press('Alt+c');
    const capture = page.getByRole('dialog', { name: 'Add to Inbox' });
    await capture.getByLabel(/^Title/u).fill(TITLE);
    await capture.getByRole('button', { name: 'Capture', exact: true }).click();
    await capture.waitFor({ state: 'hidden' });
    await visit(page, '/inbox');
    const inboxRow = page.locator('.inbox-list > li').filter({ hasText: TITLE });
    await inboxRow.getByText('Triage', { exact: true }).click();
    await inboxRow.getByRole('button', { name: 'Do today', exact: true }).click();
    await inboxRow.waitFor({ state: 'hidden' });
    await visit(page, '/');
    const action = page.locator('.today-flexible-list .action-row').filter({ hasText: TITLE });
    await action.getByRole('button', { name: /^Schedule…/u }).click();
    const schedule = page.getByRole('dialog', { name: `Schedule “${TITLE}”` });
    await schedule.getByLabel('Start time').fill('14:00');
    await schedule.getByLabel('Duration (minutes)').fill('20');
    await schedule.getByRole('button', { name: 'Schedule', exact: true }).click();
    await schedule.waitFor({ state: 'hidden' });
    const timed = page.locator('.timeline-entry').filter({ hasText: TITLE });
    await timed.locator('summary').click();
    await timed.getByRole('button', { name: /^Complete/u }).click();
    const completion = page.getByRole('dialog', { name: 'Complete this time block' });
    await completion.getByRole('checkbox', { name: /^Also complete the Action/u }).check();
    await completion.getByRole('button', { name: 'Complete time block', exact: true }).click();
    await completion.waitFor({ state: 'hidden' });
    await page.getByRole('link', { name: 'End day…', exact: true }).click();
    await page.getByLabel('Note (optional)', { exact: true }).fill(NOTE);
    await page.getByRole('button', { name: 'Finish review', exact: true }).click();
    await page.getByText('Review finished.', { exact: true }).waitFor();
    await visit(page, '/data');
    await page.getByRole('button', { name: 'Preview export', exact: true }).click();
    const backup = JSON.parse((await downloadedText(page, 'Download verified JSON')).text);
    assert(
      createHash('sha256').update(canonical(backup.data)).digest('hex') ===
        backup.manifest.dataSha256,
      'The complete offline manual loop exports a matching canonical digest.',
    );
    assert(
      backup.data.actions.some(
        (row) => row.document.title === TITLE && row.document.state === 'completed',
      ),
      'The manually completed Action remains canonical.',
    );
    assert(
      JSON.stringify(backup.data.reviews).includes(NOTE),
      'The deliberate daily review is included in the offline backup.',
    );
    j.checks.push(
      'Offline onboarding → capture → explicit Day placement/schedule → completion → daily review → verified native JSON download; Unicode prose and canonical digest are preserved.',
    );

    j.step('support preview, cancel/focus and explicit metadata-only download');
    await visit(page, '/settings');
    const preview = page.getByRole('button', { name: 'Preview support information', exact: true });
    await preview.focus();
    await page.keyboard.press('Enter');
    assert(
      await page.locator('pre').evaluate((node) => node === document.activeElement),
      'Support preview receives focus.',
    );
    const supportText = await page.locator('pre').textContent();
    assert(
      supportText !== null && !supportText.includes(TITLE) && !supportText.includes(NOTE),
      'Support preview contains no synthetic planning prose.',
    );
    const support = JSON.parse((await downloadedText(page, 'Download support information')).text);
    assert(
      Object.keys(support).every((key) =>
        [
          'schemaVersion',
          'releaseChannel',
          'revision',
          'browserFamily',
          'online',
          'secureContext',
          'capabilities',
          'notificationPermission',
        ].includes(key),
      ),
      'Support report has only the approved metadata fields.',
    );
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    assert(
      await preview.evaluate((node) => node === document.activeElement),
      'Closing the support preview restores opener focus.',
    );
    j.checks.push(
      'Support data is previewed and explicitly downloaded; cancel restores focus; the file excludes synthetic plan/account/content data.',
    );

    j.step('keyboard navigation, semantics, motion and background pause');
    await visit(page, '/');
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    assert(
      await page.locator('main').evaluate((node) => node.contains(document.activeElement)),
      'Skip to content moves focus into the main region.',
    );
    await visit(page, '/settings');
    await page.getByRole('radio', { name: 'Reduced', exact: true }).check();
    assert(
      (await animatedElementCount(page)) === 0,
      'Reduced motion leaves no long animations/transitions.',
    );
    await page.getByRole('radio', { name: 'Full', exact: true }).check();
    await setDocumentVisibility(page, 'hidden');
    const runningHidden = await page.evaluate(
      () =>
        [...document.querySelectorAll('main *')].filter(
          (node) =>
            getComputedStyle(node).animationName !== 'none' &&
            getComputedStyle(node).animationPlayState !== 'paused',
        ).length,
    );
    assert(runningHidden === 0, 'Ambient animations pause when the page is hidden.');
    await setDocumentVisibility(page, 'visible');
    await page.getByRole('radio', { name: 'Use system motion setting', exact: true }).check();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert(
      (await animatedElementCount(page)) === 0,
      'System reduced-motion preference is honored.',
    );
    j.checks.push(
      'Keyboard capture and skip link, dialog/preview focus, native form roles, all motion settings and hidden-document animation pause. This is automation, not a manual screen-reader observation.',
    );

    j.step(
      'all manual destinations: dark/light, 320/1024/1440 reflow, targets, calm copy and contrast',
    );
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (const width of [320, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of routes) {
          await visit(page, path);
          await assertSingleH1(page, `${theme}/${width}/${path}`);
          await assertNoOverflow(page, `${theme}/${width}/${path}`);
          await assertTargets(page, `${theme}/${width}/${path}`);
          const small = await page
            .locator(
              'main button, main select, main input:not([type="checkbox"]):not([type="radio"])',
            )
            .evaluateAll((nodes) =>
              nodes
                .filter((node) => {
                  const r = node.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && r.width < 44;
                })
                .map((node) => node.tagName),
            );
          assert(small.length === 0, `Release controls have 44px width: ${path}.`);
          const visibleCopy = await page.locator('main').innerText();
          // Governing calm-copy rules concern judgment/pressure about a person's plan.
          // This exact storage-loss disclosure is required truthful recovery information.
          // Keep the rendered disclosure unchanged; every other occurrence remains audited.
          const copyForAudit =
            path === '/data'
              ? visibleCopy.replace('after site data is lost,', 'after site data is unavailable,')
              : visibleCopy;
          const badCopy = forbiddenCopy(copyForAudit);
          assert(badCopy.length === 0, `Release calm copy: ${path} (${badCopy.join(', ')}).`);
          matrix.push({ theme, width, path, h1: 1, overflow: false, controlHeightAndWidthPx: 44 });
          if (width === 1440) {
            const result = await contrastAudit(page);
            assert(
              result.failures.length === 0,
              `Computed text contrast: ${theme}/${path}: ${JSON.stringify(result.failures.slice(0, 6))}`,
            );
            assert(
              result.nonText.every((item) => item.ratio >= 3),
              `Focus/control boundaries meet 3:1: ${theme}/${path}.`,
            );
            contrast.push({ theme, path, ...result });
          }
        }
      }
      await j.shot(page, `${theme}-settings-1440`);
    }
    j.checks.push(
      '66 route/theme/width combinations: single h1, no horizontal overflow, 44px form/control targets, non-moralizing words; computed solid text and focus/control-token contrast in both themes. The exact Data phrase “after site data is lost” is a required truthful storage/recovery disclosure, explicitly excluded from the generic pressure-word matcher without changing its rendered text. Gradient/decorative text is counted as excluded, and manual visual review remains separately required.',
    );

    j.step('200% text and 400%-equivalent CSS reflow');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    for (const path of routes) {
      await visit(page, path);
      await assertNoOverflow(page, `200% text ${path}`);
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    await page.setViewportSize({ width: 320, height: 900 });
    await visit(page, `/plan/week/${DAY}`);
    await assertNoOverflow(page, '1280 CSSpx layout at 400% equivalent 320 CSSpx viewport');
    await j.shot(page, '400-percent-equivalent-week');
    j.checks.push(
      'All 11 destinations at 200% root text and a 320 CSSpx reflow viewport equivalent to 1280px at 400% zoom. Native physical browser zoom is not claimed.',
    );

    await context.setOffline(false);
    j.step('denied appearance storage and English speech language with a non-English device');
    await context.addInitScript(() => {
      if (new URL(window.location.href).searchParams.get('verificationLocale') === 'ru-RU')
        Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'ru-RU' });
      const read = Storage.prototype.getItem;
      const write = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('yelaxis:appearance:'))
          throw new DOMException('Denied', 'SecurityError');
        return read.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('yelaxis:appearance:'))
          throw new DOMException('Full', 'QuotaExceededError');
        return write.call(this, key, value);
      };
    });
    await page.goto(`${j.origin}/settings?verificationLocale=ru-RU`);
    await visit(page, '/settings');
    assert(
      (await page.locator('html').getAttribute('lang')) === 'en' &&
        (await page.locator('html').getAttribute('dir')) === 'ltr',
      'The English catalog retains its speech language with a Russian device locale.',
    );
    await page.getByRole('radio', { name: 'Light', exact: true }).check();
    await poll(
      () =>
        page
          .locator('html')
          .getAttribute('data-theme')
          .then((theme) => theme === 'light'),
      'A denied preference write must retain the in-memory theme choice.',
    );
    await page.getByRole('radio', { name: 'Reduced', exact: true }).check();
    assert((await animatedElementCount(page)) === 0, 'Denied writes still allow reduced motion.');
    await visit(page, '/search');
    assert(
      (await page.locator('h1').innerText()) === 'Search',
      'The canonical plan remains usable after denied preference reads and writes.',
    );
    j.checks.push(
      'Denied appearance reads and quota-failed writes retain a usable plan and session theme/motion choices; English speech language stays accurate with non-English device formatting.',
    );
    j.step('expanded pseudo locale and RTL without changing canonical data or time semantics');
    for (const locale of ['en-XA', 'ar-XB']) {
      await context.addInitScript((value) => {
        Object.defineProperty(navigator, 'language', { configurable: true, get: () => value });
      }, locale);
      await page.reload();
      await page.locator('main h1').waitFor();
      assert(
        (await page.locator('html').getAttribute('lang')) === locale,
        'Device pseudo locale sets the document language.',
      );
      assert(
        (await page.locator('html').getAttribute('dir')) === (locale === 'ar-XB' ? 'rtl' : 'ltr'),
        'Device pseudo locale sets the correct document direction.',
      );
      for (const path of routes) {
        await visit(page, path);
        await assertNoOverflow(page, `${locale} expanded ${path}`);
        await assertTargets(page, `${locale} expanded ${path}`);
      }
      await visit(page, '/search');
      assert(
        (await page.locator('h1').innerText()).startsWith('⟦'),
        'Visible Search title comes from the expanded catalog.',
      );
      await j.shot(page, `${locale}-expanded-320`);
    }
    await visit(page, `/plan/day/${DAY}`);
    assert(
      (await page
        .locator('.timeline-grid')
        .evaluate((node) => getComputedStyle(node).direction)) === 'ltr',
      'RTL preserves the spatial time axis.',
    );
    j.checks.push(
      '22 expanded en-XA/ar-XB destinations reflow at 320 CSSpx; document language/direction reflect device locale; catalog expansion retains user Unicode; RTL does not reverse the time axis.',
    );
    if (!j.inFirefox) await assertStaticCaches(page, j.origin);
    assert(
      external.length === 0,
      'The complete local manual journey attempts no external request.',
    );
    assert(
      errors.length === 0,
      `The release journey has no browser errors: ${JSON.stringify(errors.slice(0, 3))}`,
    );
    j.checks.push(
      'No external/AI/analytics/calendar request or browser error; Chromium service-worker caches contain static assets only.',
    );
    await context.close();
    return {
      fixture: 'synthetic local owner and Unicode prose only',
      matrix,
      contrast,
      browserErrors: errors.length,
      externalRequests: external.length,
      manualScreenReaderPerformed: false,
      physicalOSNotificationsPerformed: false,
      nativePhysicalZoomPerformed: false,
    };
  },
);
