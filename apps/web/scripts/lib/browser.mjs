import { isAbsolute } from 'node:path';

/** Use the pinned Playwright browser unless the contributor deliberately selects another binary. */
export function chromiumExecutableOptions(env = process.env) {
  const path = env.CHROMIUM_EXECUTABLE_PATH;
  if (!path) return {};
  if (!isAbsolute(path)) throw new Error('CHROMIUM_EXECUTABLE_PATH must be an absolute path.');
  return { executablePath: path };
}
