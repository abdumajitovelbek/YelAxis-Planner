import { isAbsolute } from 'node:path';
import { chromium as nativeChromium, firefox as nativeFirefox } from 'playwright-core';

/**
 * Network blocking and navigator state are separate in Chromium's current protocol. A cached
 * service-worker navigation can reset navigator.onLine while requests remain blocked. Keep the
 * synthetic connectivity signal consistent on every document, alongside real network blocking.
 * This is test instrumentation, not a claim about physical network or OS observations.
 */
async function instrumentConnectivity(context) {
  let online = true;
  await context.exposeFunction('__journeyReadOnline', () => online);
  await context.addInitScript(() => {
    const publish = async () => {
      const value = await window.__journeyReadOnline();
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
      window.dispatchEvent(new Event(value ? 'online' : 'offline'));
    };
    void publish();
    window.addEventListener('DOMContentLoaded', () => void publish(), { once: true });
  });
  const blockNetwork = context.setOffline.bind(context);
  context.setOffline = async (offline) => {
    online = !offline;
    await blockNetwork(offline);
    await Promise.all(
      context.pages().map((page) =>
        page.evaluate((value) => {
          Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
          window.dispatchEvent(new Event(value ? 'online' : 'offline'));
        }, online),
      ),
    );
  };
  return context;
}

function instrumentBrowser(type) {
  const launchOptions = (options) => ({
    ...options,
    ...(type === nativeFirefox ? firefoxDisplayOptions() : {}),
  });
  return {
    async launchPersistentContext(profile, options) {
      return instrumentConnectivity(
        await type.launchPersistentContext(profile, launchOptions(options)),
      );
    },
    async launch(options) {
      const browser = await type.launch(launchOptions(options));
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...options) =>
        instrumentConnectivity(await newContext(...options));
      return browser;
    },
  };
}

export const chromium = instrumentBrowser(nativeChromium);
export const firefox = instrumentBrowser(nativeFirefox);

/** A virtual desktop can exercise native input when a runner's headless backend drops events. */
export function firefoxDisplayOptions(env = process.env) {
  return env.FIREFOX_HEADED === '1' ? { headless: false } : {};
}

/** Use the pinned Playwright browser unless the contributor deliberately selects another binary. */
export function chromiumExecutableOptions(env = process.env, { nativePermissions = false } = {}) {
  const path =
    env.CHROMIUM_EXECUTABLE_PATH ||
    (nativePermissions ? nativeChromium.executablePath() : undefined);
  if (!path) return {};
  if (!isAbsolute(path)) throw new Error('CHROMIUM_EXECUTABLE_PATH must be an absolute path.');
  return { executablePath: path };
}
