import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = fileURLToPath(new URL('../apps/web/', import.meta.url));
// Each local journey reads the same production artifact. Account journeys build their own public configuration.
const localJourneys = [
  ['persistence', 'verify-browser'],
  ['persistence-firefox', 'verify-firefox'],
  ['onboarding', 'verify-onboarding'],
  ['actions', 'verify-actions'],
  ['actions-performance', 'verify-actions-performance'],
  ['horizons', 'verify-horizons'],
  ['horizons-firefox', 'verify-horizons', '--firefox'],
  ['horizons-performance', 'verify-horizons-performance'],
  ['pwa', 'verify-pwa'],
  ['alignment', 'verify-alignment'],
  ['alignment-firefox', 'verify-alignment', '--firefox'],
  ['today', 'verify-today'],
  ['today-firefox', 'verify-today', '--firefox'],
  ['today-performance', 'verify-today-performance'],
  ['reviews', 'verify-reviews'],
  ['reviews-firefox', 'verify-reviews', '--firefox'],
  ['search', 'verify-search'],
  ['search-firefox', 'verify-search', '--firefox'],
  ['search-performance', 'verify-search-performance'],
  ['notifications', 'verify-notifications'],
  ['notifications-firefox', 'verify-notifications', '--firefox'],
];
const accountJourneys = [
  ['sync', 'verify-sync'],
  ['sync-firefox', 'verify-sync', '--firefox'],
  ['sync-performance', 'verify-sync-performance'],
  ['data', 'verify-data'],
  ['data-firefox', 'verify-data', '--firefox'],
];

async function run(name, binary, args, cwd) {
  process.stdout.write(`VERIFY_STAGE ${name}\n`);
  const child = spawn(binary, args, { cwd, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`Browser gate stopped at ${name}, exit ${String(code)}.`);
  process.stdout.write(`VERIFY_PASSED ${name}\n`);
}

try {
  await run('local-build', 'pnpm', ['run', 'build'], root);
  for (const [name, file, ...args] of localJourneys)
    await run(name, process.execPath, [`scripts/${file}.mjs`, ...args], web);
  await run('backend', 'pnpm', ['run', 'test:backend'], root);
  for (const [name, file, ...args] of accountJourneys)
    await run(name, process.execPath, [`scripts/${file}.mjs`, ...args], web);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
