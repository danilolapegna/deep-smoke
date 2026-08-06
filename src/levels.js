/**
 * What the three levels mean, and which routes and personas each one selects.
 *
 * The levels exist because the honest answer to "how much should I test this
 * change?" is "it depends on what it can break", and a tool that offers only one
 * answer gets used at the wrong intensity in both directions: too slow for a
 * copy fix, too shallow for a release. Each level is a fixed, nameable amount of
 * paranoia, so a team can put the right one in the right place and stop
 * arguing about it.
 *
 * The levels are cumulative. Anything level 1 checks, level 3 also checks.
 */

import { ConfigError } from './errors.js';
import { normalisePath } from './assertions.js';

/** Path segment appended to produce the level 1 edge case probe. */
export const UNKNOWN_ROUTE_SEGMENT = 'deep-smoke-unknown-route';

/**
 * The three levels, as data.
 *
 * `discoveryDepth` is how many link-following hops past the seed routes the
 * crawler may take: 0 visits exactly what it was told to, 1 covers a feature and
 * the pages it links to, Infinity walks the whole reachable tree.
 */
export const LEVELS = Object.freeze({
  1: Object.freeze({
    id: 1,
    name: 'quick',
    headline: 'One route, happy path plus one edge case.',
    useWhen: 'A small, contained change. The check you run without thinking about it.',
    discoveryDepth: 0,
    personaSelection: 'first',
    includeUnknownRouteProbe: true,
    requireAuthInvariants: false,
  }),
  2: Object.freeze({
    id: 2,
    name: 'feature',
    headline: 'The surface of one feature, signed out and signed in.',
    useWhen: 'A medium or large feature, or anything that touches shared layout or navigation.',
    discoveryDepth: 1,
    personaSelection: 'anonymous-plus-first-authenticated',
    includeUnknownRouteProbe: false,
    requireAuthInvariants: false,
  }),
  3: Object.freeze({
    id: 3,
    name: 'gate',
    headline: 'The entire reachable route tree, every persona, with and without authentication.',
    useWhen: 'Before merging to your main branch, against a production build.',
    discoveryDepth: Number.POSITIVE_INFINITY,
    personaSelection: 'all',
    includeUnknownRouteProbe: false,
    requireAuthInvariants: true,
  }),
});

/**
 * Validates and returns a level definition.
 *
 * @param {number|string} level Requested level.
 * @returns {typeof LEVELS[1]} The level definition.
 * @throws {ConfigError} If the level is not 1, 2 or 3.
 */
export function resolveLevel(level) {
  const id = Number(level);
  const definition = LEVELS[/** @type {1|2|3} */ (id)];
  if (!definition) {
    throw new ConfigError(`Invalid --level: ${level}. Expected 1, 2 or 3.`);
  }
  return definition;
}

/**
 * Picks the personas a level is required to cover.
 *
 * Level 2 pairs anonymous with the first authenticated persona because most
 * regressions in a feature are visible from either side of the login wall, and
 * running every role at that stage buys little for the time it costs. Level 3
 * refuses to choose: a role you never crawl is a role you never tested.
 *
 * @param {typeof LEVELS[1]} definition Level definition.
 * @param {import('./personas.js').Persona[]} personas All declared personas.
 * @returns {import('./personas.js').Persona[]} Personas to crawl, in run order.
 */
export function selectPersonas(definition, personas) {
  if (personas.length === 0) {
    throw new ConfigError('No personas available. Declare at least one persona, or omit the personas file to crawl anonymously.');
  }
  const anonymous = personas.filter((persona) => !persona.authenticated);
  const authenticated = personas.filter((persona) => persona.authenticated);

  switch (definition.personaSelection) {
    case 'first':
      return [anonymous[0] ?? personas[0]];
    case 'anonymous-plus-first-authenticated': {
      const selected = [];
      if (anonymous[0]) selected.push(anonymous[0]);
      if (authenticated[0]) selected.push(authenticated[0]);
      return selected.length > 0 ? selected : [personas[0]];
    }
    case 'all':
    default:
      return personas;
  }
}

/**
 * Builds the edge case route for level 1.
 *
 * The one edge case worth running everywhere, on every stack, is "a URL that
 * does not exist": it is the single route most likely to be missing from a
 * router, and the failure it produces (an unhandled render, an empty shell) is
 * invisible to a happy-path check by construction.
 *
 * @param {string} route The happy-path route.
 * @returns {string} A sibling route that should not exist.
 */
export function unknownRouteProbeFor(route) {
  const base = normalisePath(route);
  return base === '/' ? `/${UNKNOWN_ROUTE_SEGMENT}` : `${base}/${UNKNOWN_ROUTE_SEGMENT}`;
}

/**
 * Checks that are meaningless on a URL that is supposed to be missing.
 *
 * A correct app answers an unknown URL with either a 404 status and a
 * not-found page, or a 200 and a client-rendered not-found view. Both are right,
 * so status and emptiness are not evidence of anything here. What still counts
 * is that the app did not throw, did not fall into an error boundary and did not
 * fail to load its own assets on the way.
 */
export const UNKNOWN_ROUTE_CHECK_OVERRIDES = Object.freeze({
  httpStatus: false,
  blankScreen: false,
});

/**
 * Computes the full plan for a run: who crawls, from where, how deep.
 *
 * `only` overrides the seed inventory rather than filtering it, because the flag
 * means "just look at these", which is how you scope a crawl to the feature you
 * just touched. It also disables discovery, so `--only` never quietly turns into
 * a full crawl on an app whose header links to everything.
 *
 * @param {object} input Plan input.
 * @param {number} input.level Requested level.
 * @param {Record<string, any>} input.config Loaded configuration.
 * @param {import('./personas.js').Persona[]} input.personas Declared personas.
 * @param {string[]} [input.only] Explicit route list from the command line.
 * @returns {{
 *   level: number,
 *   definition: typeof LEVELS[1],
 *   discoveryDepth: number,
 *   personas: {persona: import('./personas.js').Persona, seeds: string[], probes: string[]}[],
 *   requireAuthInvariants: boolean,
 *   scoped: boolean
 * }} The plan.
 */
export function buildPlan({ level, config, personas, only = [] }) {
  const definition = resolveLevel(level);
  const selected = selectPersonas(definition, personas);
  const scoped = only.length > 0;
  const declaredRoutes = scoped ? only : config.routes;

  const planned = selected.map((persona) => {
    const personaSeeds = scoped ? only : [...declaredRoutes, ...(persona.seeds ?? [])];
    const seeds = uniquePaths(personaSeeds);
    // Level 1 is a single route by definition: taking the first seed keeps the
    // promise of the level, and taking it per persona keeps it truthful for a
    // persona whose entry point is not the site root.
    const trimmed = definition.id === 1 ? seeds.slice(0, 1) : seeds;
    const probes = definition.includeUnknownRouteProbe && trimmed.length > 0 ? [unknownRouteProbeFor(trimmed[0])] : [];
    return { persona, seeds: trimmed, probes };
  });

  return {
    level: definition.id,
    definition,
    discoveryDepth: scoped ? 0 : definition.discoveryDepth,
    personas: planned,
    requireAuthInvariants: definition.requireAuthInvariants && !scoped,
    scoped,
  };
}

/**
 * Normalises and de-duplicates a list of paths while preserving order.
 *
 * Order matters: seeds are crawled breadth-first from the front of the list, so
 * a user who puts the most important route first sees its verdict first.
 *
 * @param {string[]} paths Raw paths.
 * @returns {string[]} Normalised, unique paths.
 */
function uniquePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const path = normalisePath(entry.trim());
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
