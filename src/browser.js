/**
 * Finding and launching a browser.
 *
 * Playwright is a peer dependency rather than a dependency: it is a large
 * download, it is frequently already present in a project that runs any kind of
 * end-to-end test, and pinning a copy inside this package would mean shipping a
 * second browser toolchain to everyone who only wants the `verify` subcommand.
 * The cost of that choice is that a missing install has to be explained well,
 * which is most of what this file is for.
 */

import { EnvironmentError } from './errors.js';

/** Module specifiers tried, in order of preference. */
const CANDIDATE_MODULES = ['playwright', 'playwright-core'];

/** System browser channels tried when no bundled browser is installed. */
const FALLBACK_CHANNELS = ['chrome', 'chromium', 'msedge'];

/**
 * The message shown when Playwright is not installed.
 *
 * Written as two commands rather than a sentence because that is what the reader
 * needs: the second one is the step people forget, and forgetting it produces a
 * completely different and much more confusing error later.
 *
 * @returns {string} Installation instructions.
 */
export function missingPlaywrightMessage() {
  return [
    'Playwright is required to run a crawl, and it is not installed.',
    '',
    '  npm install --save-dev playwright',
    '  npx playwright install chromium',
    '',
    'deep-smoke declares playwright as an optional peer dependency, so it is never',
    'installed for you. The verify subcommand works without it.',
  ].join('\n');
}

/**
 * Loads Playwright, or explains how to install it.
 *
 * The importer is injectable so the failure path can be tested without
 * uninstalling anything.
 *
 * @param {object} [options] Loader options.
 * @param {(specifier: string) => Promise<any>} [options.importer] Module loader.
 * @returns {Promise<{chromium: any, source: string}>} A minimal launcher facade.
 * @throws {EnvironmentError} If no Playwright package can be loaded.
 */
export async function loadPlaywright({ importer = (specifier) => import(specifier) } = {}) {
  const failures = [];
  for (const specifier of CANDIDATE_MODULES) {
    try {
      const module = await importer(specifier);
      // Both the namespace and its default export are checked because the two
      // packages, and the two module systems they are consumed from, disagree.
      const chromium = module?.chromium ?? module?.default?.chromium;
      if (chromium?.launch) return { chromium, source: specifier };
      failures.push(`${specifier}: loaded but exposes no chromium launcher`);
    } catch (cause) {
      failures.push(`${specifier}: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
    }
  }
  throw new EnvironmentError(`${missingPlaywrightMessage()}\n\nTried:\n  ${failures.join('\n  ')}`);
}

/**
 * Launches a browser, preferring the bundled build and falling back to a system one.
 *
 * The fallback exists because "Playwright is installed but its browsers are not"
 * is the single most common way a first run fails, and on a machine that already
 * has a Chromium-family browser the run can simply proceed. When every attempt
 * fails, the error reported is the one from the *bundled* attempt: it is the
 * supported path, so its diagnosis is the one worth reading.
 *
 * @param {object} input Launch input.
 * @param {any} input.playwright Playwright module namespace.
 * @param {object} input.browser Browser section of the config.
 * @param {(message: string) => void} [input.log] Verbose logger.
 * @returns {Promise<any>} A launched browser instance.
 * @throws {EnvironmentError} If no browser could be launched.
 */
export async function launchBrowser({ playwright, browser, log = () => {} }) {
  const options = {
    headless: browser.headless !== false,
    args: Array.isArray(browser.launchArgs) ? browser.launchArgs : [],
  };

  if (browser.executablePath) {
    log(`launching browser from ${browser.executablePath}`);
    return playwright.chromium.launch({ ...options, executablePath: browser.executablePath });
  }
  if (browser.channel) {
    log(`launching browser channel ${browser.channel}`);
    return playwright.chromium.launch({ ...options, channel: browser.channel });
  }

  let bundledError;
  try {
    return await playwright.chromium.launch(options);
  } catch (cause) {
    bundledError = cause;
    log(`bundled browser unavailable (${cause instanceof Error ? cause.message.split('\n')[0] : cause}), trying system channels`);
  }

  for (const channel of FALLBACK_CHANNELS) {
    try {
      const instance = await playwright.chromium.launch({ ...options, channel });
      log(`using system browser channel: ${channel}`);
      return instance;
    } catch {
      // Try the next channel. The bundled error is the one worth reporting.
    }
  }

  throw new EnvironmentError(
    'No browser could be launched. Install the bundled browser with:\n\n  npx playwright install chromium\n\n' +
      'or point deep-smoke at a browser you already have, with --channel=chrome or ' +
      'browser.executablePath in your config.\n\nOriginal error:\n' +
      (bundledError instanceof Error ? bundledError.message : String(bundledError)),
    { cause: bundledError },
  );
}
