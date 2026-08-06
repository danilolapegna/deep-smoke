/**
 * Personas: who is looking at the app.
 *
 * A route is not one thing. `/settings` is a redirect for a signed-out visitor,
 * a page for a member and a different page for an administrator, and the two
 * most common production incidents in that list (the member sees the admin view,
 * the signed-out visitor sees the member view) are invisible to any crawl that
 * only knows about URLs. Personas make the audience an explicit input, so
 * "tested" can mean "tested as everyone who can reach it".
 *
 * The default persona set is a single anonymous visitor, so an app without
 * authentication needs no persona file at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { PERSONAS_FILENAME, readJsonFile } from './config.js';
import { validateAuthConfig } from './auth/index.js';

/**
 * @typedef {object} Persona
 * @property {string} id Stable identifier used in reports and evidence.
 * @property {string} label Human-readable name.
 * @property {import('./auth/index.js').AuthConfig} auth How this persona signs in.
 * @property {boolean} authenticated Derived: true unless the strategy is `none`.
 * @property {string[]} seeds Extra entry routes that only this persona can reach.
 */

/** The persona every app has, whether or not it has a login screen. */
export const ANONYMOUS_PERSONA = Object.freeze({
  id: 'anonymous',
  label: 'Anonymous visitor',
  auth: Object.freeze({ strategy: 'none' }),
  authenticated: false,
  seeds: Object.freeze([]),
});

/**
 * Validates and normalises one persona definition.
 *
 * @param {unknown} raw Persona as written by the user.
 * @param {number} index Position in the list, used in error messages.
 * @returns {Persona} Normalised persona.
 * @throws {ConfigError} If a required field is missing or malformed.
 */
export function normalisePersona(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`Persona at index ${index} must be an object.`);
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  const id = source.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ConfigError(`Persona at index ${index} is missing a non-empty "id".`);
  }
  const seeds = source.seeds ?? [];
  if (!Array.isArray(seeds) || seeds.some((seed) => typeof seed !== 'string')) {
    throw new ConfigError(`Persona "${id}": "seeds" must be an array of route strings.`);
  }
  const auth = source.auth ?? { strategy: 'none' };
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new ConfigError(`Persona "${id}": "auth" must be an object, for example {"strategy": "none"}.`);
  }
  const authConfig = validateAuthConfig(/** @type {Record<string, unknown>} */ (auth), id);

  return {
    id: id.trim(),
    label: typeof source.label === 'string' && source.label.trim() !== '' ? source.label.trim() : id.trim(),
    auth: authConfig,
    authenticated: authConfig.strategy !== 'none',
    seeds: /** @type {string[]} */ (seeds),
  };
}

/**
 * Loads personas from an inline array or a JSON file.
 *
 * Both forms are supported because they serve different projects: a small app
 * keeps two personas inline in its config, while an app with real credentials
 * keeps them in a separate file that is easier to exclude from version control.
 * With neither, a `deep-smoke.personas.json` sitting next to the config is picked
 * up, and failing that the app is crawled as a single anonymous visitor, which is
 * the right answer for anything without a login screen.
 *
 * @param {object} options Loader options.
 * @param {string[]|Record<string, unknown>[]|string|null} [options.source] Inline personas, or a path to a personas file.
 * @param {string} [options.baseDir] Directory to resolve a relative path against.
 * @returns {{personas: Persona[], sourcePath: string|null}} Normalised personas plus provenance.
 * @throws {ConfigError} On a malformed personas file or duplicate ids.
 */
export function loadPersonas({ source = null, baseDir = process.cwd() } = {}) {
  let resolvedSource = source;
  if (resolvedSource === null || resolvedSource === undefined) {
    const conventional = path.join(baseDir, PERSONAS_FILENAME);
    if (!fs.existsSync(conventional)) {
      return { personas: [{ ...ANONYMOUS_PERSONA, seeds: [] }], sourcePath: null };
    }
    resolvedSource = conventional;
  }

  let raw = resolvedSource;
  let sourcePath = null;
  if (typeof resolvedSource === 'string') {
    sourcePath = path.resolve(baseDir, resolvedSource);
    const parsed = readJsonFile(sourcePath, 'personas file');
    // Accept both a bare array and an object with a `personas` key, because both
    // shapes appear in the wild the moment someone wants to add a comment field.
    raw = Array.isArray(parsed)
      ? parsed
      : /** @type {Record<string, unknown>} */ (parsed)?.personas;
    if (!Array.isArray(raw)) {
      throw new ConfigError(
        `Personas file must contain an array, or an object with a "personas" array: ${sourcePath}`,
      );
    }
  }

  if (!Array.isArray(raw)) {
    throw new ConfigError('Inline "personas" must be an array or a path to a personas file.');
  }
  if (raw.length === 0) {
    throw new ConfigError('Personas list is empty. Remove it to crawl anonymously, or declare at least one persona.');
  }

  const personas = raw.map((entry, index) => normalisePersona(entry, index));
  const duplicates = personas.map((persona) => persona.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new ConfigError(`Duplicate persona id(s): ${[...new Set(duplicates)].join(', ')}. Ids appear in evidence and must be unique.`);
  }

  return { personas, sourcePath };
}

/**
 * Describes a persona in one line, for logs and reports.
 *
 * @param {Persona} persona Persona to describe.
 * @returns {string} For example `member (form login)`.
 */
export function describePersona(persona) {
  const how = persona.auth.strategy === 'none' ? 'not signed in' : `${persona.auth.strategy} login`;
  return `${persona.id} (${how})`;
}
