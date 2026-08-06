/**
 * Pluggable authentication.
 *
 * Signing in is the part of a smoke crawl that is different in every single
 * project, so it is the one part this tool refuses to have an opinion about.
 * There are four strategies and they form a ladder: `none` for public pages,
 * `form` for the ninety percent of apps with a username and a password field,
 * `storageState` for anything you can log into once by hand, and `module` for
 * everything else, including single sign-on, one-time codes and bespoke token
 * exchanges.
 *
 * No vendor, provider or framework is named anywhere in this file, and none
 * should be added: the moment a smoke tool ships a special case for one auth
 * provider, it starts rotting in step with that provider's API.
 *
 * Secrets are referenced, never stored: any string field may be written as
 * `env:VARIABLE_NAME`, and only the variable name is ever printed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, EnvironmentError } from '../errors.js';

/**
 * A persona's auth block: a strategy plus whatever fields that strategy needs.
 * The per-strategy fields are validated at load time by `validateAuthConfig`.
 *
 * @typedef {{strategy: 'none'|'form'|'storageState'|'module'} & Record<string, any>} AuthConfig
 */

/** @typedef {import('playwright').Page} PlaywrightPage */
/** @typedef {import('playwright').BrowserContext} PlaywrightContext */

/** Fields each strategy requires, checked at load time so a run never dies halfway through. */
const REQUIRED_FIELDS = {
  none: [],
  form: ['loginPath', 'usernameSelector', 'passwordSelector', 'submitSelector', 'username', 'password'],
  storageState: ['path'],
  module: ['path'],
};

/** Prefix marking a value that must be read from the environment at run time. */
const ENV_PREFIX = 'env:';

/**
 * Validates one persona's auth block.
 *
 * @param {Record<string, unknown>} auth Raw auth object.
 * @param {string} personaId Persona id, for error messages.
 * @returns {AuthConfig} Normalised auth config.
 * @throws {ConfigError} On an unknown strategy or a missing required field.
 */
export function validateAuthConfig(auth, personaId) {
  const strategy = auth.strategy ?? 'none';
  if (typeof strategy !== 'string' || !(strategy in REQUIRED_FIELDS)) {
    throw new ConfigError(
      `Persona "${personaId}": unknown auth strategy ${JSON.stringify(strategy)}. ` +
        `Expected one of: ${Object.keys(REQUIRED_FIELDS).join(', ')}`,
    );
  }
  const missing = REQUIRED_FIELDS[/** @type {keyof typeof REQUIRED_FIELDS} */ (strategy)].filter(
    (field) => auth[field] === undefined || auth[field] === null || auth[field] === '',
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `Persona "${personaId}": auth strategy "${strategy}" requires ${missing.join(', ')}.`,
    );
  }
  return /** @type {AuthConfig} */ ({ ...auth, strategy });
}

/**
 * Resolves a possibly-indirect secret.
 *
 * A missing environment variable is reported as an environment problem rather
 * than a failing test: an unset secret in CI means the pipeline is misconfigured,
 * and reporting it as a broken page would send someone to debug an app that is
 * perfectly healthy.
 *
 * @param {string} value Literal value, or `env:VARIABLE_NAME`.
 * @param {string} label Field name, used in error messages.
 * @param {Record<string, string|undefined>} [env] Environment to read from.
 * @returns {string} Resolved value.
 * @throws {EnvironmentError} If an environment reference is unset or empty.
 */
export function resolveSecret(value, label, env = process.env) {
  if (typeof value !== 'string' || !value.startsWith(ENV_PREFIX)) return String(value);
  const name = value.slice(ENV_PREFIX.length).trim();
  const resolved = env[name];
  if (resolved === undefined || resolved === '') {
    throw new EnvironmentError(
      `${label} refers to environment variable ${name}, which is not set. ` +
        'Set it in your shell or in your CI secrets, then run again.',
    );
  }
  return resolved;
}

/**
 * Browser context options a persona needs before its first navigation.
 *
 * Storage state has to be supplied at context creation, not after it, which is
 * why this is separate from `applyAuth`.
 *
 * @param {AuthConfig} auth Persona auth config.
 * @param {string} baseDir Directory to resolve relative paths against.
 * @returns {Record<string, unknown>} Options to spread into `browser.newContext`.
 * @throws {ConfigError} If a referenced storage state file does not exist.
 */
export function contextOptionsFor(auth, baseDir) {
  if (auth.strategy !== 'storageState') return {};
  const file = path.resolve(baseDir, String(auth.path));
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `Storage state file not found: ${file}. ` +
        'Create it by signing in once and saving the browser context, for example with Playwright codegen.',
    );
  }
  return { storageState: file };
}

/**
 * Signs a persona in, if its strategy needs an interactive step.
 *
 * Returns a description rather than a boolean so the evidence file can record
 * *how* a session was obtained. Six months later, "the admin crawl passed" is
 * only meaningful next to "the admin session came from a real form login".
 *
 * @param {object} input Application input.
 * @param {AuthConfig} input.auth Persona auth config.
 * @param {PlaywrightContext} input.context Browser context for this persona.
 * @param {PlaywrightPage} input.page A page in that context.
 * @param {string} input.baseUrl Base URL of the app under test.
 * @param {string} input.baseDir Directory to resolve relative paths against.
 * @param {import('../personas.js').Persona} input.persona The persona being prepared.
 * @param {(message: string) => void} [input.log] Verbose logger.
 * @returns {Promise<{applied: boolean, detail: string}>} What happened.
 * @throws {EnvironmentError} If the sign-in could not be completed.
 */
export async function applyAuth({ auth, context, page, baseUrl, baseDir, persona, log = () => {} }) {
  switch (auth.strategy) {
    case 'none':
      return { applied: false, detail: 'anonymous' };

    case 'storageState':
      // Already applied when the context was created; reported here so that every
      // strategy produces one line of provenance in the evidence file.
      return { applied: true, detail: `storage state from ${auth.path}` };

    case 'form':
      return signInWithForm({ auth, page, baseUrl, persona, log });

    case 'module':
      return runAuthModule({ auth, context, page, baseUrl, baseDir, persona, log });

    default:
      throw new ConfigError(`Persona "${persona.id}": unsupported auth strategy ${auth.strategy}.`);
  }
}

/**
 * Fills and submits a login form, then proves the session took.
 *
 * The proof matters more than the submission. A form that silently rejects the
 * password still leaves a perfectly renderable login page, and a crawl that
 * accepts that as "signed in" will happily report full coverage of an
 * application it never entered. So this refuses to continue while the browser is
 * still sitting on the login route.
 *
 * @param {object} input See `applyAuth`.
 * @param {AuthConfig} input.auth
 * @param {PlaywrightPage} input.page
 * @param {string} input.baseUrl
 * @param {import('../personas.js').Persona} input.persona
 * @param {(message: string) => void} input.log
 * @returns {Promise<{applied: boolean, detail: string}>}
 */
async function signInWithForm({ auth, page, baseUrl, persona, log }) {
  const timeout = Number(auth.timeoutMs ?? 20_000);
  const loginPath = String(auth.loginPath);
  const username = resolveSecret(String(auth.username), `persona "${persona.id}" auth.username`);
  const password = resolveSecret(String(auth.password), `persona "${persona.id}" auth.password`);

  log(`signing in at ${loginPath}`);
  try {
    await page.goto(baseUrl + loginPath, { waitUntil: 'domcontentloaded', timeout });
    await page.fill(String(auth.usernameSelector), username, { timeout });
    await page.fill(String(auth.passwordSelector), password, { timeout });
    await page.click(String(auth.submitSelector), { timeout });
  } catch (cause) {
    throw new EnvironmentError(
      `Persona "${persona.id}": the login form at ${loginPath} could not be filled in ` +
        `(${describeError(cause)}). Check loginPath and the three selectors.`,
      { cause },
    );
  }

  try {
    if (auth.waitForSelector) {
      await page.waitForSelector(String(auth.waitForSelector), { timeout });
    } else if (auth.waitForPath) {
      await page.waitForURL((url) => url.pathname.startsWith(String(auth.waitForPath)), { timeout });
    } else {
      await page.waitForURL((url) => !url.pathname.startsWith(loginPath), { timeout });
    }
  } catch (cause) {
    throw new EnvironmentError(
      `Persona "${persona.id}": sign-in did not complete. The browser is still on ${currentPath(page)} ` +
        `after submitting the form at ${loginPath}. Either the credentials were rejected, or the success ` +
        'signal is different here: set auth.waitForPath or auth.waitForSelector to something that only ' +
        'appears once signed in.',
      { cause },
    );
  }

  return { applied: true, detail: `form login at ${loginPath}` };
}

/**
 * Hands control to a user-supplied module.
 *
 * This is the escape hatch that keeps the other three strategies small. Anything
 * a browser can do to obtain a session, a user can write here, and it stays
 * their code in their repository instead of becoming a config flag in this one.
 *
 * @param {object} input See `applyAuth`.
 * @param {AuthConfig} input.auth
 * @param {PlaywrightContext} input.context
 * @param {PlaywrightPage} input.page
 * @param {string} input.baseUrl
 * @param {string} input.baseDir
 * @param {import('../personas.js').Persona} input.persona
 * @param {(message: string) => void} input.log
 * @returns {Promise<{applied: boolean, detail: string}>}
 */
async function runAuthModule({ auth, context, page, baseUrl, baseDir, persona, log }) {
  const file = path.resolve(baseDir, String(auth.path));
  if (!fs.existsSync(file)) {
    throw new ConfigError(`Persona "${persona.id}": auth module not found: ${file}`);
  }
  const exportName = String(auth.export ?? 'default');
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw new EnvironmentError(`Persona "${persona.id}": auth module failed to load: ${file} (${describeError(cause)})`, { cause });
  }
  const handler = module[exportName];
  if (typeof handler !== 'function') {
    throw new ConfigError(
      `Persona "${persona.id}": auth module ${file} does not export a function named "${exportName}". ` +
        'Export an async function that receives {context, page, baseUrl, persona, options}.',
    );
  }

  log(`running auth module ${path.basename(file)}#${exportName}`);
  try {
    await handler({ context, page, baseUrl, persona, options: auth.options ?? {}, log });
  } catch (cause) {
    throw new EnvironmentError(
      `Persona "${persona.id}": auth module threw (${describeError(cause)}).`,
      { cause },
    );
  }
  return { applied: true, detail: `module ${path.basename(file)}#${exportName}` };
}

/**
 * Current path of a page, tolerating a closed or blank page.
 *
 * @param {PlaywrightPage} page Page to inspect.
 * @returns {string} Path, or `unknown`.
 */
function currentPath(page) {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return 'unknown';
  }
}

/**
 * One-line description of a thrown value.
 *
 * @param {unknown} error Anything thrown.
 * @returns {string} Message text.
 */
function describeError(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error);
}
