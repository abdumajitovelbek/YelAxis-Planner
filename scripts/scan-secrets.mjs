import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectRepositoryFiles } from './lib/repository-files.mjs';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

const directRules = [
  {
    id: 'private-key-block',
    pattern: new RegExp(
      ['-----BEGIN ', '(?:(?:RSA|EC|OPENSSH|DSA|PGP) )?', 'PRIVATE KEY-----'].join(''),
      'g',
    ),
  },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'openai-style-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: 'stripe-live-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: 'supabase-secret-key', pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

const sensitiveAssignmentNames = [
  'ANTHROPIC_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'GITHUB_TOKEN',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'POSTGRES_URL',
  'SENTRY_AUTH_TOKEN',
  'SLACK_BOT_TOKEN',
  'STRIPE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'JWT_SECRET',
  'SIGNING_SECRET',
];

const assignmentPattern = new RegExp(
  `\\b(${sensitiveAssignmentNames.join('|')})\\b[ \\t]*(?::|=)[ \\t]*["'\\\`]?(?<value>[^\\s"'\\\`,;]+)`,
  'gi',
);

const safePlaceholderPatterns = [
  /^$/,
  /^\$\{[A-Z0-9_]+\}$/i,
  /^<[^>]+>$/,
  /^(?:change[-_]?me|dummy|example|not[-_]?set|placeholder|replace[-_]?me|test|unused)$/i,
  /^(?:your|example|test|dummy)[-_]/i,
];

function isSafePlaceholder(value) {
  return safePlaceholderPatterns.some((pattern) => pattern.test(value));
}

function readTextFile(absolutePath) {
  const size = statSync(absolutePath).size;
  if (size > MAX_TEXT_FILE_BYTES) return null;

  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

function scanText(relativePath, text) {
  const ruleIds = new Set();

  for (const rule of directRules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) ruleIds.add(rule.id);
  }

  assignmentPattern.lastIndex = 0;
  for (const match of text.matchAll(assignmentPattern)) {
    const value = match.groups?.value ?? '';
    if (!isSafePlaceholder(value)) ruleIds.add('sensitive-value-assignment');
  }

  if (containsPrivateJwt(text)) ruleIds.add('private-jwt');
  // One bounded decoding pass catches ordinary encoded/renamed secret fixtures. Values never
  // enter findings or errors. This is a pattern check, not a claim to detect every obfuscation.
  for (const match of text.matchAll(/\b[A-Za-z0-9+/_-]{40,4096}={0,2}/g)) {
    const decoded = Buffer.from(match[0], 'base64').toString('utf8');
    if (
      containsPrivateJwt(decoded) ||
      directRules.some(({ pattern }) => {
        pattern.lastIndex = 0;
        return pattern.test(decoded);
      })
    )
      ruleIds.add('encoded-secret');
  }

  return [...ruleIds].sort().map((ruleId) => ({ relativePath, ruleId }));
}

function containsPrivateJwt(text) {
  for (const match of text.matchAll(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  )) {
    try {
      const claims = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      // Anonymous public configuration is not an authorization secret. Every other signed
      // role, authenticated identity or session-bearing token stays outside source/evidence.
      if (claims?.role !== 'anon' || claims.sub || claims.session_id || claims.refresh_token)
        return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function scanSecrets({ root = process.cwd(), files } = {}) {
  const resolvedRoot = resolve(root);
  const candidates = files ?? collectRepositoryFiles(resolvedRoot);
  const findings = [];

  for (const file of candidates) {
    let text;
    try {
      text = readTextFile(file.absolutePath);
    } catch (error) {
      findings.push({
        relativePath: file.relativePath,
        ruleId: 'unreadable-file',
        errorCode: error instanceof Error && 'code' in error ? error.code : 'UNKNOWN',
      });
      continue;
    }

    if (text === null) continue;
    findings.push(...scanText(file.relativePath, text));
  }

  return findings;
}

export function formatSecretFindings(findings) {
  const lines = [
    'Potential high-risk secret material was detected. Matched values are intentionally hidden.',
  ];
  for (const finding of findings) {
    lines.push(`- ${finding.relativePath} [${finding.ruleId}]`);
  }
  return lines.join('\n');
}

function main() {
  const findings = scanSecrets();
  if (findings.length > 0) {
    console.error(formatSecretFindings(findings));
    process.exitCode = 1;
    return;
  }

  console.log('High-risk secret pattern check passed (matched values are never printed).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
