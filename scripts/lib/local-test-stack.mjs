import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';

export const localTestStackUnavailable =
  'The selected local test stack is unavailable or does not match its configuration.';

function setting(source, section, name) {
  let currentSection = '';
  const matches = [];
  for (const line of source.split('\n')) {
    const header = /^\s*\[([a-zA-Z0-9_.]+)\]\s*(?:#.*)?$/u.exec(line);
    if (header) currentSection = header[1];
    else if (currentSection === section) {
      const assignment = /^\s*([a-zA-Z0-9_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/u.exec(line);
      if (assignment?.[1] === name) matches.push(assignment[2]);
    }
  }
  if (matches.length > 1) throw new Error();
  return matches[0];
}

/** Select only a local directory, with an independent default project and a verified local API port. */
export function selectLocalTestStack(repositoryRoot, workdirOverride) {
  try {
    const root = realpathSync(repositoryRoot);
    const override = workdirOverride?.trim();
    if (override && !isAbsolute(override)) throw new Error();
    const workdir = override ? realpathSync(override) : root;
    const source = readFileSync(join(workdir, 'supabase', 'config.toml'), 'utf8');
    const projectId = /^"([a-z0-9][a-z0-9_-]{0,63})"$/u.exec(
      setting(source, '', 'project_id') ?? '',
    )?.[1];
    const portText = setting(source, 'api', 'port') ?? '';
    const apiPort = Number(portText);
    const tls = setting(source, 'api.tls', 'enabled');
    if (
      !projectId ||
      setting(source, 'api', 'enabled') !== 'true' ||
      !/^\d{1,5}$/u.test(portText) ||
      !Number.isInteger(apiPort) ||
      apiPort < 1 ||
      apiPort > 65535 ||
      (tls !== undefined && tls !== 'true' && tls !== 'false') ||
      (workdir === root && (projectId !== 'yelaxis-planner' || apiPort !== 57421))
    )
      throw new Error();
    const binary = join(
      root,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
    );
    if (!existsSync(binary)) throw new Error();
    return {
      workdir,
      binary,
      projectId,
      apiPort,
      apiProtocol: tls === 'true' ? 'https:' : 'http:',
    };
  } catch {
    throw new Error(localTestStackUnavailable);
  }
}

/** Keys stay in memory. CLI output is never included in errors or written to a file. */
export function readLocalTestStack(repositoryRoot, options = {}) {
  try {
    const selected = selectLocalTestStack(
      repositoryRoot,
      options.workdirOverride ?? process.env['YELAXIS_TEST_STACK_WORKDIR'],
    );
    const execute = options.execute ?? spawnSync;
    const result = execute(
      selected.binary,
      ['status', '--workdir', selected.workdir, '-o', 'env'],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    if (result.status !== 0 || result.error || typeof result.stdout !== 'string') throw new Error();
    const values = new Map();
    for (const line of result.stdout.split('\n')) {
      const match = /^([A-Z0-9_]+)=(?:"([^"\r\n]*)"|([^"\r\n]*))$/u.exec(line.trim());
      if (match) {
        if (values.has(match[1])) throw new Error();
        values.set(match[1], match[2] ?? match[3]);
      }
    }
    const apiUrl = values.get('API_URL');
    const anonKey = values.get('ANON_KEY');
    const serviceRoleKey = values.get('SERVICE_ROLE_KEY');
    const jwtSecret = values.get('JWT_SECRET');
    if (
      ![apiUrl, anonKey, serviceRoleKey, jwtSecret].every(
        (value) => typeof value === 'string' && value.length > 0,
      )
    )
      throw new Error();
    const parsed = new URL(apiUrl);
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]' ||
      (isIP(parsed.hostname) === 4 && parsed.hostname.startsWith('127.'));
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (
      !loopback ||
      parsed.protocol !== selected.apiProtocol ||
      port !== selected.apiPort ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (apiUrl !== parsed.origin && apiUrl !== `${parsed.origin}/`)
    )
      throw new Error();
    return { ...selected, apiUrl: parsed.origin, anonKey, serviceRoleKey, jwtSecret };
  } catch {
    throw new Error(localTestStackUnavailable);
  }
}
