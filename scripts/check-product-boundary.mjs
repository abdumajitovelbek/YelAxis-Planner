import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectRepositoryFiles } from './lib/repository-files.mjs';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const forbiddenDependencyRules = [
  {
    id: 'model-sdk-dependency',
    pattern:
      /^(?:(?:ai|openai|ollama|llamaindex|langchain)$|@ai-sdk\/|@anthropic-ai\/|@google\/(?:generative-ai|genai)$|@langchain\/)/i,
  },
  {
    id: 'calendar-integration-dependency',
    pattern: /^(?:@googleapis\/calendar|ical|ical\.js)$/i,
  },
  {
    id: 'analytics-or-crash-dependency',
    pattern:
      /^(?:posthog-js|mixpanel-browser|@sentry\/|@segment\/analytics-next|@amplitude\/analytics-browser|@bugsnag\/js)/i,
  },
  {
    id: 'external-action-dependency',
    pattern: /^(?:@stripe\/stripe-js|@paypal\/paypal-js)$/i,
  },
];

const forbiddenSourceRules = [
  {
    id: 'visible-ai-or-provider-wording',
    pattern:
      /\b(?:AI|ChatGPT|OpenAI|Anthropic|AI (?:assistant|chat|planner|proposal|suggestion)|artificial intelligence)\b/i,
  },
  {
    id: 'model-provider-endpoint',
    pattern:
      /(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|\/v1\/(?:chat\/completions|responses))/i,
  },
  {
    id: 'calendar-permission-or-adapter',
    pattern: /(?:calendar\.googleapis\.com|\/calendar\/v3\/|webcal:)/i,
  },
  {
    id: 'automatic-planning-wording',
    pattern:
      /\b(?:auto(?:matic(?:ally)?)?[- ]?(?:schedule|reschedule|prioriti[sz]e|complete)|generate (?:my |a )?(?:day|week|month|year) plan)\b/i,
  },
];

const forbiddenRouteSegments = new Set([
  'ai',
  'assistant',
  'chat',
  'proposal',
  'automatic-planning',
]);

function isTestOrFixture(relativePath) {
  return (
    /(?:^|\/)(?:__fixtures__|__tests__|fixtures?|tests?)(?:\/|$)/i.test(relativePath) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(relativePath)
  );
}

function isRuntimeSource(relativePath) {
  if (!sourceExtensions.has(extname(relativePath))) return false;
  if (isTestOrFixture(relativePath)) return false;

  return (
    /^apps\/[^/]+\/(?:app|src)\//.test(relativePath) ||
    /^packages\/[^/]+\/(?:app|src)\//.test(relativePath)
  );
}

function readTextFile(absolutePath) {
  if (statSync(absolutePath).size > MAX_TEXT_FILE_BYTES) return null;
  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

function checkPackageManifest(file, findings) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file.absolutePath, 'utf8'));
  } catch {
    findings.push({ relativePath: file.relativePath, ruleId: 'invalid-package-manifest' });
    return;
  }

  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;

    for (const dependency of Object.keys(dependencies)) {
      for (const rule of forbiddenDependencyRules) {
        if (rule.pattern.test(dependency)) {
          findings.push({
            relativePath: file.relativePath,
            ruleId: rule.id,
            detail: dependency,
          });
        }
      }
    }
  }
}

function checkRuntimeSource(file, findings) {
  const routeParts = file.relativePath.split('/');
  if (
    routeParts.includes('app') &&
    routeParts.some((part) =>
      forbiddenRouteSegments.has(basename(part, extname(part)).toLowerCase()),
    )
  ) {
    findings.push({ relativePath: file.relativePath, ruleId: 'forbidden-ai-route' });
  }

  const text = readTextFile(file.absolutePath);
  if (text === null) return;

  for (const rule of forbiddenSourceRules) {
    rule.pattern.lastIndex = 0;
    if (
      rule.pattern.test(rule.id === 'automatic-planning-wording' ? withoutInputPurpose(text) : text)
    ) {
      findings.push({ relativePath: file.relativePath, ruleId: rule.id });
    }
  }
}

/**
 * The HTML input-purpose attribute (`autocomplete`, React `autoComplete`) is required for sign-in
 * fields (WCAG 2.2 SC 1.3.5); its name is not automatic-planning wording. Only the attribute name
 * followed by `=` or `:` is ignored, so the same words in copy are still found.
 */
function withoutInputPurpose(text) {
  return text.replace(/\bauto[Cc]omplete(?=\s*[=:])/gu, '');
}

function checkAppConfiguration(file, findings) {
  const text = readTextFile(file.absolutePath);
  if (text === null) return;

  const configRules = forbiddenSourceRules.filter(
    (rule) => rule.id === 'calendar-permission-or-adapter' || rule.id === 'model-provider-endpoint',
  );
  for (const rule of configRules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      findings.push({ relativePath: file.relativePath, ruleId: rule.id });
    }
  }
}

export function checkProductBoundary({ root = process.cwd(), files } = {}) {
  const resolvedRoot = resolve(root);
  const candidates = files ?? collectRepositoryFiles(resolvedRoot);
  const findings = [];

  for (const file of candidates) {
    try {
      if (file.relativePath === 'package.json' || file.relativePath.endsWith('/package.json')) {
        checkPackageManifest(file, findings);
      }
      if (isRuntimeSource(file.relativePath)) checkRuntimeSource(file, findings);
      if (/^apps\/[^/]+\/(?:app\.json|app\.config\.[cm]?[jt]s)$/.test(file.relativePath)) {
        checkAppConfiguration(file, findings);
      }
    } catch (error) {
      findings.push({
        relativePath: file.relativePath,
        ruleId: 'boundary-scan-error',
        detail: error instanceof Error && 'code' in error ? error.code : 'UNKNOWN',
      });
    }
  }

  return findings.sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

export function formatBoundaryFindings(findings) {
  return [
    'manual planning boundary violations were detected:',
    ...findings.map(
      (finding) =>
        `- ${finding.relativePath} [${finding.ruleId}]${finding.detail ? `: ${finding.detail}` : ''}`,
    ),
  ].join('\n');
}

function main() {
  const findings = checkProductBoundary();
  if (findings.length > 0) {
    console.error(formatBoundaryFindings(findings));
    process.exitCode = 1;
    return;
  }

  console.log('manual planning forbidden dependency and production-string check passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
