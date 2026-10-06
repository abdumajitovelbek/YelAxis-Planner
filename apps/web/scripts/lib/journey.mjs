import { chromiumExecutableOptions } from './browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, firefox } from 'playwright-core';
import { isStaticCacheUrl } from './cache-policy.mjs';

/**
 * Shared helpers for production-browser journeys, copied from verify-horizons.mjs so each journey
 * keeps the same guarantees: a `vite preview` server stopped with its whole process group, a
 * watchdog, step logs, a failure screenshot, persistent browser contexts (Playwright Chromium, or
 * Playwright Firefox with `--firefox`), minimal onboarding, screenshots, and the single-h1,
 * overflow, 44 px target, and reduced-motion checks.
 */

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDate(value, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Run one journey against the production build. `body(journey)` receives the origin, the browser
 * choice, `step`, `shot`, `launch`, and `observe`; it returns extra result fields. The result is
 * printed as JSON; a failure leaves a full-page screenshot of the latest page.
 */
export async function runJourney(
  { basePort = 7100, name, timeZone, timeoutMinutes = 10, title },
  body,
) {
  const inFirefox = process.argv.includes('--firefox');
  const browserLabel = inFirefox ? 'firefox' : 'chromium';
  const port = basePort + (Date.now() % 300);
  const origin = `http://127.0.0.1:${String(port)}`;
  const profileDirectory = await mkdtemp(join(tmpdir(), `yelaxis-${name}-${browserLabel}-`));
  const screenshots = [];
  const checks = [];
  let currentStep = 'start';
  let activePage;

  const server = spawn(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    // Own process group so the vite child is stopped with pnpm (SIGTERM alone leaves it running).
    { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += String(chunk);
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += String(chunk);
  });
  const stopServer = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already stopped */
    }
  };
  process.on('exit', stopServer);
  const watchdog = setTimeout(() => {
    process.stderr.write(
      `${title} journey exceeded ${String(timeoutMinutes)} minutes at step: ${currentStep}\n`,
    );
    stopServer();
    process.exit(1);
  }, timeoutMinutes * 60_000);

  const journey = {
    origin,
    inFirefox,
    browserLabel,
    timeZone,
    checks,
    screenshots,
    step(stepName) {
      currentStep = stepName;
      process.stderr.write(`step: ${stepName}\n`);
    },
    async shot(page, shotName) {
      const path = `/tmp/yelaxis-${name}-${inFirefox ? 'firefox-' : ''}${shotName}.png`;
      await page.screenshot({ path, fullPage: true });
      screenshots.push(path);
    },
    launch(deviceZone = timeZone) {
      if (inFirefox)
        return firefox.launchPersistentContext(profileDirectory, {
          headless: true,
          viewport: { width: 1280, height: 800 },
          timezoneId: deviceZone,
          locale: 'en-US',
        });
      return chromium.launchPersistentContext(profileDirectory, {
        ...chromiumExecutableOptions(),
        headless: true,
        args: ['--no-sandbox', '--disable-gpu'],
        viewport: { width: 1280, height: 800 },
        timezoneId: deviceZone,
        locale: 'en-US',
      });
    },
    /** Record external requests and browser errors, and remember the page for a failure shot. */
    observe(page, externalRequests, browserErrors) {
      activePage = page;
      page.on('request', (request) => {
        if (!request.url().startsWith(origin)) externalRequests.push(request.url());
      });
      page.on('pageerror', (error) =>
        browserErrors.push(`${error.stack ?? error.message} [step: ${currentStep}]`),
      );
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        // Resource errors carry no URL in their text; keep the location so failures are actionable.
        const where = message.location()?.url;
        browserErrors.push(
          `${where ? `${message.text()} (${where})` : message.text()} [step: ${currentStep}; page: ${page.url()}]`,
        );
      });
    },
  };

  const waitForServer = async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Preview exited:\n${serverOutput}`);
      try {
        const response = await fetch(origin);
        if (response.ok) return;
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for preview:\n${serverOutput}`);
  };

  try {
    await waitForServer();
    const extra = await body(journey).catch(async (error) => {
      const failure = `/tmp/yelaxis-${name}-${inFirefox ? 'firefox-' : ''}failure.png`;
      await activePage?.screenshot({ path: failure, fullPage: true }).catch(() => undefined);
      process.stderr.write(`Failure at step "${currentStep}". Screenshot: ${failure}\n`);
      throw error;
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          browser: inFirefox ? 'Playwright Firefox' : 'Playwright Chromium',
          timeZone,
          ...extra,
          checks,
          screenshots,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    clearTimeout(watchdog);
    stopServer();
    await rm(profileDirectory, { force: true, recursive: true });
  }
}

export async function assertSingleH1(page, label) {
  const count = await page.getByRole('heading', { level: 1 }).count();
  assert(count === 1, `${label} must have exactly one h1 (found ${String(count)}).`);
}

export async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  assert(
    metrics.body <= metrics.viewport,
    `${label} overflows (${String(metrics.body)} > ${String(metrics.viewport)}).`,
  );
}

/** Every visible control in `main` is at least 44 px tall. */
export async function assertTargets(page, label) {
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'main button, main select, main input:not([type=checkbox]):not([type=radio]), main summary',
      ),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.height < 44;
      })
      .map((element) => `${element.tagName} "${(element.textContent ?? '').trim().slice(0, 30)}"`),
  );
  assert(small.length === 0, `${label} has targets under 44px: ${small.slice(0, 8).join(', ')}`);
}

/** Number of elements in `main` that still animate or transition for more than 0.01 s. */
export function animatedElementCount(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('main *')].filter((element) => {
        const style = getComputedStyle(element);
        const seconds = (value) =>
          Math.max(...value.split(',').map((part) => Number.parseFloat(part) || 0));
        return seconds(style.animationDuration) > 0.01 || seconds(style.transitionDuration) > 0.01;
      }).length,
  );
}

export async function completeMinimalOnboarding(page) {
  await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  await page.getByRole('button', { name: 'Start locally' }).click();
  await page.getByRole('button', { name: 'Confirm defaults' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByLabel('First concrete Action').fill('Onboarding useful Action');
  await page.getByRole('button', { name: 'Continue to handbook' }).click();
  await page.getByRole('button', { name: 'Skip and open Today' }).click();
  await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();
}

/** Press Tab (or Shift+Tab) until `locator` has focus: a keyboard-only path to a control. */
export async function tabTo(page, locator, { backwards, max = 300 } = {}) {
  await locator.waitFor();
  const visited = [];
  for (let presses = 0; presses < max; presses += 1) {
    // Re-resolve every time: a re-render may replace the element while focus moves.
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    // Tab never wraps past the end of the page in every browser (Firefox leaves the page), and
    // from the page body Firefox continues where a removed element was. So choose the direction
    // before every press: Shift+Tab while the focused element comes after the target.
    const reverse =
      backwards ??
      (await locator.evaluate((element) => {
        const active = document.activeElement;
        if (active === null || active === document.body || active === element) return false;
        return (element.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      }));
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
    if (visited.length < 60)
      visited.push(
        await page.evaluate(() => {
          const active = document.activeElement;
          if (active === null) return 'none';
          const label = (active.getAttribute('aria-label') ?? active.textContent ?? '')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, 30);
          return `${active.tagName.toLowerCase()}${active.id === '' ? '' : `#${active.id}`}:${label}`;
        }),
      );
  }
  throw new Error(
    `The keyboard could not reach ${String(locator)} in ${String(max)} presses. First stops: ${visited.join(' → ')}`,
  );
}

/** Visible and accessible text of every button in a container, whitespace-collapsed and sorted. */
export function buttonNames(locator) {
  return locator
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => (button.textContent ?? '').replace(/\s+/gu, ' ').trim()).sort(),
    );
}

/*
 * Helpers added for the Today Today journey. They poll from Node with `page.evaluate` instead of
 * `page.waitForFunction`, so they also work while a Playwright page clock is paused (paused fake
 * timers stop in-page polling that relies on timers or animation frames).
 */

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Real (Node) delay; never affected by a page clock. */
export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Poll `check()` until it returns a truthy value (which is returned); throw `message` on timeout. */
export async function poll(check, message, { timeout = 10_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let detail = '';
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await sleep(interval);
  }
  throw new Error(detail === '' ? message : `${message} (${detail})`);
}

async function describeActiveElement(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return 'none';
    const label = (active.getAttribute('aria-label') ?? active.textContent ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 40);
    return `${active.tagName.toLowerCase()} "${label}"`;
  });
}

/**
 * Wait until `locator` has focus, or (with `within`) contains the focused element. The locator is
 * re-resolved on every attempt, so a re-rendered element still counts.
 */
export async function waitForFocus(
  page,
  locator,
  { label, timeout = 10_000, within = false } = {},
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (
        (await locator.count()) > 0 &&
        (await locator
          .first()
          .evaluate(
            (element, inside) =>
              inside
                ? element.contains(document.activeElement)
                : element === document.activeElement,
            within,
          ))
      )
        return;
    } catch {
      /* re-rendering */
    }
    await sleep(50);
  }
  throw new Error(
    `${label ?? String(locator)}: focus is on ${await describeActiveElement(page)} instead.`,
  );
}

/**
 * Wait until the direct `li` rows of `list` are exactly `expected`, in order; a row matches when
 * its text contains the expected title.
 */
export async function expectListOrder(list, expected, label, { timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  let actual = [];
  while (Date.now() < deadline) {
    try {
      actual = await list
        .locator(':scope > li')
        .evaluateAll((rows) =>
          rows.map((row) => (row.textContent ?? '').replace(/\s+/gu, ' ').trim()),
        );
    } catch {
      actual = [];
    }
    if (
      actual.length === expected.length &&
      expected.every((title, index) => actual[index].includes(title))
    )
      return;
    await sleep(100);
  }
  throw new Error(
    `${label}: expected ${expected.join(', ')}, found ${actual.map((row) => row.slice(0, 60)).join(' | ')}.`,
  );
}

/** Text of every element named by the control's `aria-describedby`, whitespace-collapsed. */
export function accessibleDescription(locator) {
  return locator.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/u)
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  );
}

/**
 * Emulate the page being hidden or shown again (a minimized window or a background tab): override
 * `document.visibilityState` and `document.hidden`, then dispatch `visibilitychange`.
 */
export async function setDocumentVisibility(page, state) {
  await page.evaluate((next) => {
    if (next === 'visible') {
      delete document.visibilityState;
      delete document.hidden;
    } else {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/**
 * Words the product never uses about a person's plan (calm-copy rules and the manual planning boundary).
 * Returns the ones found in `text`.
 */
export function forbiddenCopy(text) {
  const found = [
    ...text.matchAll(
      /\b(?:streaks?|scores?|grades?|productivity|behind|failed|missed|penalty|penalties|lost)\b/giu,
    ),
  ].map((match) => match[0]);
  if (/\bAI\b/u.test(text)) found.push('AI');
  return found;
}

/**
 * Every service-worker cache entry is a same-origin static asset with no plan data. Returns the
 * number of cached URLs.
 */
export async function assertStaticCaches(page, origin, planIds = []) {
  const cached = await page.evaluate(async () => {
    if (!('caches' in window)) return [];
    const names = await caches.keys();
    const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
    return requests.flat().map((request) => request.url);
  });
  for (const url of cached) {
    const parsed = new URL(url);
    assert(parsed.origin === origin, `Cache holds a foreign URL: ${url}`);
    assert(
      parsed.pathname === '/' ||
        /\.(?:html|js|css|wasm|png|svg|ico|webmanifest|json|woff2?)$/u.test(parsed.pathname),
      `Cache holds a non-static URL: ${url}`,
    );
    assert(
      [...parsed.searchParams.keys()].every((key) => key === '__WB_REVISION__'),
      `Cache holds a URL with data: ${url}`,
    );
    assert(isStaticCacheUrl(url, origin, planIds), `Cache holds plan or API data: ${url}`);
  }
  return cached.length;
}

/**
 * Wording manual planning never shows (the manual planning boundary scan): AI, model, or
 * provider wording, ranking or suggestion wording, and automatic-planning wording. Returns the
 * words found in `text`.
 */
export function modelOrRankingCopy(text) {
  const patterns = [
    /\b(?:ChatGPT|OpenAI|Anthropic|GPT|LLM|chatbot|copilot|assistant|artificial intelligence|machine learning|language model)\b/giu,
    /\b(?:rank(?:ed|ing|ings|s)?|suggest(?:ed|ion|ions|s)?|recommend(?:ed|ation|ations|s)?|smart|insights?|proposals?|optimi[sz](?:e|ed|es|ing|ation))\b/giu,
    /\bauto(?:matic(?:ally)?)?[- ]?(?:schedul|reschedul|plan|prioriti[sz]|complet|focus|rank|select|choos)\w*/giu,
    /\bgenerated? (?:my |a |your )?(?:day|week|month|year) plan\b/giu,
  ];
  const found = patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
  if (/\bAI\b/u.test(text)) found.push('AI');
  return found;
}

/** Route segments manual planning never has (the manual planning boundary scan's forbidden routes). */
export const modelRouteSegments = Object.freeze([
  'ai',
  'assistant',
  'chat',
  'proposal',
  'automatic-planning',
]);

/** Every link on the page whose path has a route segment manual planning never has (a plural counts too). */
export function modelRouteLinks(page) {
  return page.evaluate(
    (segments) =>
      [...document.querySelectorAll('a[href]')]
        .map((link) => new URL(link.getAttribute('href') ?? '', window.location.href))
        .filter((url) =>
          url.pathname
            .split('/')
            .some((part) => segments.includes(part.toLowerCase().replace(/s$/u, ''))),
        )
        .map((url) => url.href),
    [...modelRouteSegments],
  );
}

/**
 * Abort every http(s) or web-socket request that leaves `origin` and record its URL in `blocked`
 * (verification contract: the journey works unchanged when every request away from the app is blocked).
 */
export async function blockForeignRequests(context, origin, blocked) {
  await context.route(
    (url) => /^(?:https?|wss?):$/u.test(url.protocol) && url.origin !== origin,
    (route) => {
      blocked.push(route.request().url());
      return route.abort();
    },
  );
}

/**
 * Record every request a browser context makes (pages, workers, and the service worker) that
 * leaves `origin`.
 */
export function recordForeignRequests(context, origin, external) {
  context.on('request', (request) => {
    if (!request.url().startsWith(origin)) external.push(request.url());
  });
}

/**
 * Record every attempt to ask for notification permission or to show or push a notification
 * without initiating permission or delivery. In
 * every page of `context`, Notification.requestPermission, ServiceWorkerRegistration#showNotification,
 * and PushManager#subscribe are wrapped: each call is recorded in `calls` (with `describe()` appended)
 * and then passed on unchanged.
 */
export async function recordNotificationRequests(context, calls, describe = () => '') {
  await context.exposeBinding('__journeyNotificationCall', (_source, what) => {
    calls.push(`${String(what)}${describe()}`);
  });
  await context.addInitScript(() => {
    const report = (what) => {
      try {
        void window.__journeyNotificationCall?.(what);
      } catch {
        /* the page is unloading */
      }
    };
    const wrap = (owner, name, label) => {
      const original = owner?.[name];
      if (typeof original !== 'function') return;
      owner[name] = function (...args) {
        report(label);
        return original.apply(this, args);
      };
    };
    wrap(window.Notification, 'requestPermission', 'Notification.requestPermission');
    wrap(window.ServiceWorkerRegistration?.prototype, 'showNotification', 'showNotification');
    wrap(window.PushManager?.prototype, 'subscribe', 'PushManager.subscribe');
  });
}

/** Visible form fields in `main` with no name source (a label, aria-label, or aria-labelledby). */
export function unlabelledFields(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('main input:not([type=hidden]), main textarea, main select')]
      .filter((field) => {
        const box = field.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return false;
        return !(
          (field.labels?.length ?? 0) > 0 ||
          (field.getAttribute('aria-label') ?? '').trim() !== '' ||
          (field.getAttribute('aria-labelledby') ?? '').trim() !== ''
        );
      })
      .map((field) => `${field.tagName.toLowerCase()}#${field.id}`),
  );
}
