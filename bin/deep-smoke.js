#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Two commands share one configuration loader: `deep-smoke` runs a crawl,
 * `deep-smoke verify` checks whether a crawl that already happened still counts.
 * They are separate because they run in different places. The crawl belongs
 * where a browser is available; the check belongs in a hook or a pipeline stage
 * that must stay fast and must work on a machine with no browser at all.
 *
 * Output discipline: machine-readable JSON goes to stdout and nothing else does,
 * so `deep-smoke --json | jq` works without a filter. Human reports, progress and
 * errors go to stderr.
 */

import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  EXIT_CODES,
  VERSION,
  buildEvidence,
  createGitAdapter,
  exitCodeFor,
  exitCodeForRun,
  formatRunReport,
  formatVerifyReport,
  loadConfig,
  loadPersonas,
  readVcsInfo,
  runSmoke,
  shouldUseColor,
  verifyEvidence,
  writeEvidence,
} from '../src/index.js';

/**
 * Known flags. Anything else is a usage error rather than a silent no-op,
 * because a typo in a CI flag that quietly disables a check is the worst
 * possible outcome for a tool whose whole job is to not miss things.
 */
const FLAGS = {
  level: { value: 'number', help: 'Smoke level: 1, 2 or 3. Default 1 for a run, required for verify.' },
  url: { value: 'string', help: 'Base URL of the running app, for example http://localhost:4173.' },
  config: { value: 'string', help: 'Path to a config file. Default: deep-smoke.config.json in the working directory.' },
  personas: { value: 'string', help: 'Path to a personas file. Overrides "personas" in the config.' },
  only: { value: 'string', help: 'Comma-separated routes to visit. Scopes the run and disables link discovery.' },
  'max-routes': { value: 'number', help: 'Cap on routes visited per persona.' },
  'budget-ms': { value: 'number', help: 'Wall-clock budget per persona, in milliseconds.' },
  'evidence-dir': { value: 'string', help: 'Directory for evidence files. Default: .deep-smoke' },
  evidence: { value: 'string', help: 'Explicit evidence path: where to write it (run), or which file to check (verify).' },
  'no-evidence': { value: false, help: 'Do not write an evidence file.' },
  verify: { value: 'optional-string', help: 'Check existing evidence instead of crawling. Same as the verify command.' },
  'allow-unversioned': { value: false, help: 'Accept evidence that records no commit, checking only its age.' },
  commit: { value: 'string', help: 'Commit to stamp evidence with (run) or verify against (verify). Default: HEAD.' },
  channel: { value: 'string', help: 'Browser channel to use, for example chrome or msedge.' },
  'browser-path': { value: 'string', help: 'Path to a browser executable, bypassing channel detection.' },
  headed: { value: false, help: 'Show the browser window. Useful when a route fails only for you.' },
  json: { value: false, help: 'Print the evidence object to stdout as JSON.' },
  quiet: { value: false, help: 'Suppress the human report. Exit codes still apply.' },
  verbose: { value: false, help: 'Log every route as it is visited.' },
  help: { value: false, alias: 'h', help: 'Show this help.' },
  version: { value: false, alias: 'v', help: 'Print the version.' },
};

/**
 * Parses argv into a command, positionals and flags.
 *
 * @param {string[]} argv Arguments after the node executable and script.
 * @returns {{command: string, positionals: string[], flags: Record<string, string|number|boolean>}} Parsed input.
 * @throws {ConfigError} On an unknown flag or a missing value.
 */
export function parseArgs(argv) {
  const aliases = Object.fromEntries(
    Object.entries(FLAGS)
      .filter(([, spec]) => spec.alias)
      .map(([name, spec]) => [spec.alias, name]),
  );
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const isShort = !token.startsWith('--');
    const body = token.replace(/^--?/, '');
    const equals = body.indexOf('=');
    const rawName = equals === -1 ? body : body.slice(0, equals);
    const name = isShort ? aliases[rawName] ?? rawName : rawName;
    const spec = FLAGS[name];
    if (!spec) {
      throw new ConfigError(`Unknown option: ${token}\nRun deep-smoke --help to see the available options.`);
    }
    if (spec.value === false) {
      if (equals !== -1) throw new ConfigError(`Option --${name} does not take a value.`);
      flags[name] = true;
      continue;
    }
    let value;
    if (equals !== -1) {
      value = body.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      const hasValue = next !== undefined && !next.startsWith('-');
      if (hasValue) {
        value = next;
        index += 1;
      } else if (spec.value === 'optional-string') {
        value = '';
      } else {
        throw new ConfigError(`Option --${name} needs a value, for example --${name}=<value>.`);
      }
    }
    if (spec.value === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new ConfigError(`Option --${name} needs a number, received ${JSON.stringify(value)}.`);
      flags[name] = parsed;
    } else {
      flags[name] = value;
    }
  }

  const command = positionals[0] === 'verify' || 'verify' in flags ? 'verify' : 'run';
  return { command, positionals: positionals[0] === 'verify' ? positionals.slice(1) : positionals, flags };
}

/**
 * Builds the help text.
 *
 * Written as prose plus examples rather than as a flag dump, because the useful
 * question at the moment someone types `--help` is almost never "what flags
 * exist" but "which level do I want here".
 *
 * @returns {string} Help text.
 */
export function helpText() {
  const options = Object.entries(FLAGS)
    .map(([name, spec]) => {
      const value = spec.value === false ? '' : spec.value === 'optional-string' ? '[=<value>]' : '=<value>';
      const flag = `  --${name}${value}${spec.alias ? `, -${spec.alias}` : ''}`;
      return `${flag.padEnd(30)}${spec.help}`;
    })
    .join('\n');

  return `deep-smoke ${VERSION}
Walk every reachable route, as every kind of user, and check the page actually rendered.

USAGE
  deep-smoke [options]                    crawl a running app
  deep-smoke verify [file] [options]      check evidence from an earlier crawl

LEVELS
  --level=1   One route, happy path plus one unknown-route probe.
              For a small, contained change. Seconds.
  --level=2   The surface of one feature, signed out and signed in.
              For a medium or large feature, or anything touching shared layout.
  --level=3   The entire reachable route tree, every persona, with and without
              authentication, plus the authentication rules below.
              For the gate before merging. Run it against a production build.

WHAT COUNTS AS A FAILURE
  An uncaught exception, an error boundary, a blank screen, a 4xx or 5xx on
  navigation, a broken same-origin asset, a console error matching the configured
  patterns, and, at level 3, a violated authentication rule: a protected route
  reachable while signed out, or a public route that bounces a signed-in user.
  Every check can be switched off individually in the config.

OPTIONS
${options}

EXIT CODES
  0  the crawl passed, or the evidence was accepted
  1  something failed: a route, an authentication rule, or the evidence check
  2  the command or the configuration was wrong
  3  the machine could not run the crawl: no Playwright, no browser, no session

EXAMPLES
  Quick check of one route while developing:
    deep-smoke --level=1 --url=http://localhost:5173 --only=/checkout

  The feature you just changed, signed out and signed in:
    deep-smoke --level=2 --url=http://localhost:5173 --only=/orders,/orders/new

  The gate, against a production build:
    npm run build && npm run preview &
    deep-smoke --level=3 --url=http://localhost:4173

  In a pre-push hook or a pipeline, with no browser needed:
    deep-smoke verify --level=3

FILES
  deep-smoke.config.json     configuration, if present in the working directory
  .deep-smoke/L3-<commit>.json   evidence written by a run, read by verify

Full documentation: https://github.com/danilolapegna/deep-smoke
`;
}

/**
 * Translates command-line flags into config overrides.
 *
 * @param {Record<string, any>} flags Parsed flags.
 * @returns {Record<string, any>} Config overrides.
 */
function overridesFrom(flags) {
  const overrides = {};
  if (flags.url) overrides.baseUrl = flags.url;
  if (flags.personas) overrides.personas = flags.personas;
  if (flags['max-routes'] !== undefined) overrides.maxRoutes = flags['max-routes'];
  if (flags['budget-ms'] !== undefined) overrides.budgetMs = flags['budget-ms'];
  if (flags['evidence-dir'] || flags['no-evidence']) {
    overrides.evidence = {};
    if (flags['evidence-dir']) overrides.evidence.dir = flags['evidence-dir'];
    if (flags['no-evidence']) overrides.evidence.write = false;
  }
  if (flags.channel || flags['browser-path'] || flags.headed) {
    overrides.browser = {};
    if (flags.channel) overrides.browser.channel = flags.channel;
    if (flags['browser-path']) overrides.browser.executablePath = flags['browser-path'];
    if (flags.headed) overrides.browser.headless = false;
  }
  return overrides;
}

/**
 * Runs a crawl and reports on it.
 *
 * @param {Record<string, any>} flags Parsed flags.
 * @returns {Promise<number>} Exit code.
 */
async function commandRun(flags) {
  const cwd = process.cwd();
  const { config, configPath } = loadConfig({ cwd, configPath: flags.config, overrides: overridesFrom(flags) });
  const baseDir = configPath ? path.dirname(configPath) : cwd;
  const { personas } = loadPersonas({ source: config.personas, baseDir });
  const level = flags.level ?? 1;
  const only = String(flags.only ?? '')
    .split(',')
    .map((route) => route.trim())
    .filter(Boolean);

  const log = flags.verbose ? (message) => process.stderr.write(`  ${message}\n`) : () => {};
  const runResult = await runSmoke({ config, personas, level, only, baseDir, log });

  const git = createGitAdapter(cwd);
  const vcs = readVcsInfo(git);
  if (flags.commit) vcs.commit = String(flags.commit);
  const evidence = buildEvidence(runResult, { vcs, toolVersion: VERSION });

  let evidencePath = null;
  if (config.evidence.write) {
    evidencePath = writeEvidence(evidence, { dir: config.evidence.dir, file: flags.evidence, cwd });
  }

  if (flags.json) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!flags.quiet) {
    process.stderr.write(
      formatRunReport(evidence, {
        color: shouldUseColor(process.stderr),
        evidencePath: evidencePath ? path.relative(cwd, evidencePath) : null,
      }),
    );
  }
  return exitCodeForRun(evidence);
}

/**
 * Checks existing evidence.
 *
 * The level is required rather than defaulted, because a gate that does not say
 * what it demands will eventually accept whatever it is given.
 *
 * @param {Record<string, any>} flags Parsed flags.
 * @param {string[]} positionals Positional arguments after the command.
 * @returns {Promise<number>} Exit code.
 */
async function commandVerify(flags, positionals) {
  if (flags.level === undefined) {
    throw new ConfigError('verify needs --level=1, 2 or 3: state the level this gate requires.');
  }
  const cwd = process.cwd();
  const { config, configPath } = loadConfig({ cwd, configPath: flags.config, overrides: overridesFrom(flags) });
  const baseDir = configPath ? path.dirname(configPath) : cwd;
  const { personas } = loadPersonas({ source: config.personas, baseDir });

  const file = positionals[0] ?? (typeof flags.verify === 'string' && flags.verify !== '' ? flags.verify : flags.evidence);
  const verification = verifyEvidence({
    level: flags.level,
    config,
    file,
    cwd,
    tip: flags.commit,
    expectedPersonas: personas.map((persona) => persona.id),
    allowUnversioned: Boolean(flags['allow-unversioned']),
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  }
  if (!flags.quiet) {
    process.stderr.write(
      `${formatVerifyReport(verification, {
        level: flags.level,
        color: shouldUseColor(process.stderr),
        evidenceDir: path.resolve(cwd, config.evidence.dir),
      })}\n`,
    );
  }
  return verification.ok ? EXIT_CODES.PASS : EXIT_CODES.FAILED;
}

/**
 * Entry point.
 *
 * @param {string[]} argv Raw arguments.
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
    return EXIT_CODES.USAGE;
  }

  const { command, flags, positionals } = parsed;
  if (flags.help) {
    process.stdout.write(helpText());
    return EXIT_CODES.PASS;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_CODES.PASS;
  }

  try {
    return command === 'verify' ? await commandVerify(flags, positionals) : await commandRun(flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\ndeep-smoke: ${message}\n\n`);
    if (flags.verbose && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    return exitCodeFor(error);
  }
}

// npm's installed binary is a symlink. Compare real paths while keeping imports inert.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
