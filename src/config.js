/**
 * Configuration loading, defaults and validation.
 *
 * The defaults here are deliberately opinionated in one direction: a check is
 * only on by default if a failure it reports is almost certainly a real defect
 * on almost any stack. A smoke crawler that cries wolf gets muted, and a muted
 * crawler protects nothing, so anything ambiguous (third-party 4xx, console
 * warnings, slow navigations) is off or narrowed until the user opts in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';

/** Default config file name, looked up in the working directory. */
export const CONFIG_FILENAME = 'deep-smoke.config.json';

/** Default personas file name, looked up next to the config file. */
export const PERSONAS_FILENAME = 'deep-smoke.personas.json';

/**
 * Console messages that indicate a broken page rather than a noisy one.
 *
 * These are matched against the message text, not against the framework, on
 * purpose: `Cannot read properties of undefined` means the same thing whether it
 * came out of React, Vue, Svelte or a hand-written script, and a stack-specific
 * list would silently stop working the day someone changes framework.
 */
export const DEFAULT_CONSOLE_FAIL_PATTERNS = [
  'Cannot read propert',
  'is not a function',
  'is not defined',
  'undefined is not',
  'null is not an object',
  'Maximum call stack',
  'Maximum update depth',
  'Unexpected token',
  'SyntaxError',
  'TypeError',
  'ReferenceError',
  'RangeError',
  'ChunkLoadError',
  'Loading chunk',
  'Failed to fetch dynamically imported module',
  'Hydration',
  'hydrat',
  'Minified React error',
  'Element type is invalid',
];

/**
 * Console messages that are noise on a healthy page.
 *
 * Anchored at the start of the message so that a line which merely *contains* a
 * benign word is still eligible to fail. The distinction matters: "Failed to
 * load resource" as the whole message is a browser-level notice we already catch
 * through response status codes, while "Uncaught TypeError: Failed to fetch" is
 * a real crash that happens to contain the same words.
 */
export const DEFAULT_CONSOLE_IGNORE_PATTERNS = [
  '^Failed to load resource',
  '^net::ERR_',
  '^\\[vite\\]',
  '^\\[HMR\\]',
  '^Download the React DevTools',
  '^ResizeObserver loop',
  '^A preload for',
  '^The resource .* was preloaded',
];

/** Text that a generic error-boundary screen tends to contain. */
export const DEFAULT_ERROR_BOUNDARY_TEXTS = [
  'something went wrong',
  'unexpected error',
  'an error occurred',
  'this page could not be loaded',
];

/** Selectors an app can add to mark its own error fallback unambiguously. */
export const DEFAULT_ERROR_BOUNDARY_SELECTORS = [
  '[data-error-boundary]',
  '[data-testid="error-boundary"]',
  '.error-boundary',
];

/**
 * Paths whose contents change what the app does at runtime.
 *
 * Used by `verify` to decide whether evidence produced at an older commit still
 * describes the code being shipped. The list is intentionally source-shaped
 * rather than exhaustive: it must catch the changes that can break a page and
 * ignore the ones that cannot, or every README edit would force a full re-crawl
 * and people would stop running the gate at all.
 */
export const DEFAULT_BEHAVIOUR_PATHS = [
  'src',
  'app',
  'pages',
  'components',
  'lib',
  'public',
  'index.html',
  'package.json',
  'package-lock.json',
];

/** @typedef {'none'|'form'|'storageState'|'module'} AuthStrategy */

/**
 * Baseline configuration. Every field is overridable from the config file, and
 * a subset is overridable again from the command line.
 */
export const DEFAULT_CONFIG = Object.freeze({
  baseUrl: null,
  routes: ['/'],
  ignoreRoutes: [],
  personas: null,
  protectedPrefixes: [],
  publicRoutes: [],
  maxRoutes: 100,
  budgetMs: 180_000,
  navigationTimeoutMs: 20_000,
  routeTimeoutMs: 45_000,
  settleMs: 250,
  readySelector: null,
  retryFailedRoutes: true,
  checks: {
    pageExceptions: true,
    errorBoundaries: true,
    blankScreen: true,
    httpStatus: true,
    brokenAssets: true,
    consoleErrors: true,
    authRedirects: true,
  },
  errorBoundary: {
    texts: DEFAULT_ERROR_BOUNDARY_TEXTS,
    selectors: DEFAULT_ERROR_BOUNDARY_SELECTORS,
  },
  console: {
    severity: 'error',
    failPatterns: DEFAULT_CONSOLE_FAIL_PATTERNS,
    ignorePatterns: DEFAULT_CONSOLE_IGNORE_PATTERNS,
  },
  http: {
    failFrom: 400,
    thirdPartyIsFatal: false,
    // A missing favicon is requested by the browser rather than by the app, and
    // it 404s on a large share of otherwise healthy projects. Failing every
    // single route over it on the first run is the fastest way to lose a user.
    ignoreUrlPatterns: ['/favicon\\.ico(\\?|$)'],
  },
  evidence: {
    dir: '.deep-smoke',
    write: true,
  },
  freshness: {
    behaviourPaths: DEFAULT_BEHAVIOUR_PATHS,
    maxAgeMinutes: 120,
  },
  browser: {
    channel: null,
    executablePath: null,
    headless: true,
    viewport: { width: 1366, height: 900 },
    launchArgs: [],
  },
});

/** Console severities, ordered from most to least severe. */
const SEVERITY_LEVELS = { error: ['error'], warning: ['error', 'warning'], all: null };

/**
 * Deep-merges a user object over a default object, one level of nesting deep.
 *
 * Arrays replace rather than concatenate. Concatenating would make it impossible
 * to *remove* a default (you could never narrow `console.failPatterns`), and a
 * user who wants the defaults plus one more can spread the exported constant.
 *
 * @param {Record<string, unknown>} base Defaults.
 * @param {Record<string, unknown>} override User values.
 * @returns {Record<string, unknown>} Merged copy; inputs are not mutated.
 */
function mergeConfig(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = base[key];
    const mergeable =
      current && typeof current === 'object' && !Array.isArray(current) &&
      value && typeof value === 'object' && !Array.isArray(value);
    out[key] = mergeable
      ? mergeConfig(/** @type {Record<string, unknown>} */ (current), /** @type {Record<string, unknown>} */ (value))
      : value;
  }
  return out;
}

/**
 * Reads and parses a JSON file, reporting the path in any error.
 *
 * `JSON.parse` alone says "Unexpected token } in JSON at position 412", which is
 * useless when a run loads a config file, a personas file and a storage state.
 *
 * @param {string} file Absolute or relative path.
 * @param {string} label Human name of the file, used in the error message.
 * @returns {unknown} Parsed contents.
 * @throws {ConfigError} If the file is missing or malformed.
 */
export function readJsonFile(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Cannot read ${label}: ${file} (${/** @type {Error} */ (cause).message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`${label} is not valid JSON: ${file} (${/** @type {Error} */ (cause).message})`);
  }
}

/**
 * Normalises a base URL into `scheme://host[:port]` with no trailing slash.
 *
 * Route paths are concatenated onto this string thousands of times per run, so
 * normalising once at load time removes an entire class of double-slash bugs
 * from the crawler.
 *
 * @param {string} value Any absolute URL.
 * @returns {string} Origin without a trailing slash.
 * @throws {ConfigError} If the value is not an absolute http(s) URL.
 */
export function normaliseBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`Invalid --url: ${value}. Expected an absolute URL such as http://localhost:3000`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`Invalid --url protocol: ${parsed.protocol}. Only http and https are supported.`);
  }
  const base = parsed.origin + parsed.pathname.replace(/\/+$/, '');
  return base;
}

/**
 * Compiles the console severity setting into the set of message types to keep.
 *
 * @param {string} severity One of `error`, `warning`, `all`.
 * @returns {string[]|null} Allowed message types, or null to accept every type.
 * @throws {ConfigError} On an unknown severity.
 */
export function severityFilter(severity) {
  if (!(severity in SEVERITY_LEVELS)) {
    throw new ConfigError(
      `Invalid console.severity: ${severity}. Expected one of: ${Object.keys(SEVERITY_LEVELS).join(', ')}`,
    );
  }
  return SEVERITY_LEVELS[/** @type {keyof typeof SEVERITY_LEVELS} */ (severity)];
}

/**
 * Compiles a list of pattern strings into case-insensitive regular expressions.
 *
 * Patterns are regex source strings rather than globs because the thing being
 * matched is a stack trace or an error message, where anchors and alternation
 * earn their keep. An invalid pattern fails loudly at load time instead of
 * silently matching nothing halfway through a crawl.
 *
 * @param {string[]} patterns Regex sources.
 * @param {string} label Config key, used in the error message.
 * @returns {RegExp[]} Compiled patterns.
 * @throws {ConfigError} If a pattern does not compile.
 */
export function compilePatterns(patterns, label) {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (cause) {
      throw new ConfigError(`Invalid regular expression in ${label}: ${pattern} (${/** @type {Error} */ (cause).message})`);
    }
  });
}

/**
 * Validates a loaded config and fails on the first problem.
 *
 * Validation is total rather than best-effort: a crawl takes minutes, and
 * discovering on route 40 that `maxRoutes` was a string is worse than refusing
 * to start.
 *
 * @param {Record<string, any>} config Merged config.
 * @throws {ConfigError} On any invalid field.
 */
export function validateConfig(config) {
  const positiveNumbers = ['maxRoutes', 'budgetMs', 'navigationTimeoutMs', 'routeTimeoutMs'];
  for (const key of positiveNumbers) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0) {
      throw new ConfigError(`Invalid ${key}: expected a positive number, received ${JSON.stringify(config[key])}`);
    }
  }
  for (const key of ['routes', 'ignoreRoutes', 'protectedPrefixes', 'publicRoutes']) {
    if (!Array.isArray(config[key]) || config[key].some((entry) => typeof entry !== 'string')) {
      throw new ConfigError(`Invalid ${key}: expected an array of strings.`);
    }
  }
  for (const [name, enabled] of Object.entries(config.checks)) {
    if (typeof enabled !== 'boolean') {
      throw new ConfigError(`Invalid checks.${name}: expected true or false, received ${JSON.stringify(enabled)}`);
    }
    if (!(name in DEFAULT_CONFIG.checks)) {
      throw new ConfigError(
        `Unknown check: checks.${name}. Known checks: ${Object.keys(DEFAULT_CONFIG.checks).join(', ')}`,
      );
    }
  }
  severityFilter(config.console.severity);
  compilePatterns(config.console.failPatterns, 'console.failPatterns');
  compilePatterns(config.console.ignorePatterns, 'console.ignorePatterns');
  compilePatterns(config.http.ignoreUrlPatterns, 'http.ignoreUrlPatterns');
  if (typeof config.http.failFrom !== 'number' || config.http.failFrom < 100) {
    throw new ConfigError(`Invalid http.failFrom: expected an HTTP status code, received ${JSON.stringify(config.http.failFrom)}`);
  }
  if (config.routes.length === 0) {
    throw new ConfigError('Invalid routes: at least one seed route is required (for example ["/"]).');
  }
}

/**
 * Loads configuration from disk and command-line overrides.
 *
 * Precedence is command line > config file > defaults, which is the order of
 * increasing generality: the flag describes this run, the file describes this
 * project, the default describes every project.
 *
 * @param {object} options Loader options.
 * @param {string} [options.cwd] Directory to resolve relative paths against.
 * @param {string} [options.configPath] Explicit config file; when set, a missing file is an error.
 * @param {Record<string, unknown>} [options.overrides] Command-line overrides.
 * @returns {{config: Record<string, any>, configPath: string|null, cwd: string}} Loaded config plus provenance.
 * @throws {ConfigError} On an unreadable, malformed or invalid config.
 */
export function loadConfig({ cwd = process.cwd(), configPath, overrides = {} } = {}) {
  const explicit = configPath ? path.resolve(cwd, configPath) : null;
  const implicit = path.resolve(cwd, CONFIG_FILENAME);
  let resolvedPath = null;

  if (explicit) {
    if (!fs.existsSync(explicit)) throw new ConfigError(`Config file not found: ${explicit}`);
    resolvedPath = explicit;
  } else if (fs.existsSync(implicit)) {
    resolvedPath = implicit;
  }

  const fromFile = resolvedPath ? readJsonFile(resolvedPath, 'config file') : {};
  if (fromFile === null || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    throw new ConfigError(`Config file must contain a JSON object: ${resolvedPath}`);
  }

  const withoutComments = Object.fromEntries(
    Object.entries(/** @type {Record<string, unknown>} */ (fromFile)).filter(([key]) => !key.startsWith('_')),
  );
  const unknownKeys = Object.keys(withoutComments).filter((key) => !(key in DEFAULT_CONFIG));
  if (unknownKeys.length > 0) {
    throw new ConfigError(
      `Unknown config key(s): ${unknownKeys.join(', ')}. ` +
        `Known keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}. ` +
        'Keys starting with "_" are ignored and can be used for comments.',
    );
  }

  const config = mergeConfig(mergeConfig(structuredClone(DEFAULT_CONFIG), withoutComments), overrides);
  if (config.baseUrl) config.baseUrl = normaliseBaseUrl(String(config.baseUrl));
  validateConfig(config);

  return { config, configPath: resolvedPath, cwd };
}
