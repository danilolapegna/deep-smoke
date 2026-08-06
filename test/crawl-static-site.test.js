/**
 * The one test that runs the real thing.
 *
 * A tiny static site is served over localhost and crawled for real, which is the
 * only way to check the parts that cannot be unit tested: that link discovery
 * reaches the pages it should, that a signed-in persona stays signed in, and
 * that each detector fires on a page built to trip it.
 *
 * If Playwright or a browser is missing, every test here skips with the reason
 * printed. That is deliberate. The pure logic is covered elsewhere, and a suite
 * that fails on a contributor's machine because of an optional peer dependency
 * teaches people to ignore red.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { buildEvidence, loadConfig, loadPersonas, runSmoke } from '../src/index.js';
import { startStaticServer } from './helpers/static-server.js';
import { browserAvailability } from './helpers/playwright.js';

const SITE = fileURLToPath(new URL('./fixtures/static-site', import.meta.url));
const AUTH_MODULE = fileURLToPath(new URL('./fixtures/auth-module.mjs', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

let server;
let browser;

before(async () => {
  browser = await browserAvailability();
  if (browser.available) server = await startStaticServer(SITE);
});

after(async () => {
  if (server) await server.close();
});

/**
 * Runs a crawl against the fixture site.
 *
 * @param {object} input Run input.
 * @param {number} input.level Level to run.
 * @param {Record<string, unknown>} [input.config] Config overrides.
 * @param {unknown[]} [input.personas] Inline personas.
 * @param {string[]} [input.only] Route scope.
 * @returns {Promise<object>} Evidence for the run.
 */
async function crawl({ level, config: overrides = {}, personas: inline, only = [] }) {
  const { config } = loadConfig({
    cwd: FIXTURE_DIR,
    overrides: {
      baseUrl: server.url,
      routes: ['/'],
      settleMs: 60,
      navigationTimeoutMs: 4_000,
      ...overrides,
    },
  });
  const { personas } = loadPersonas({ source: inline ?? null, baseDir: FIXTURE_DIR });
  const runResult = await runSmoke({
    config,
    personas,
    level,
    only,
    baseDir: FIXTURE_DIR,
    playwright: browser.playwright,
  });
  return buildEvidence(runResult);
}

/**
 * Reads the check ids reported for one route.
 *
 * @param {object} evidence Evidence object.
 * @param {string} route Route to look up.
 * @returns {string[]} Check ids.
 */
function checksFor(evidence, route) {
  const result = evidence.results.find((entry) => entry.route === route);
  assert.ok(result, `route ${route} was not visited`);
  return result.failures.map((failure) => failure.check);
}

describe('crawling a real site', () => {
  it('walks the reachable routes and passes on a healthy site', async (t) => {
    if (!browser.available) return t.skip(browser.reason);

    const evidence = await crawl({
      level: 3,
      config: { protectedPrefixes: ['/private'], publicRoutes: ['/', '/about'] },
    });

    assert.equal(evidence.result, 'pass', JSON.stringify(evidence.results.filter((r) => !r.ok), null, 2));
    const routes = evidence.results.map((result) => result.route).sort();
    assert.deepEqual(routes, ['/', '/about', '/docs', '/login', '/private']);
    assert.equal(evidence.summary.routesFailed, 0);
  });

  it('does not mistake a page that discusses errors for a broken one', async (t) => {
    if (!browser.available) return t.skip(browser.reason);
    const evidence = await crawl({ level: 2, only: ['/docs'] });
    assert.deepEqual(checksFor(evidence, '/docs'), []);
  });

  it('detects each failure class on a page built to trip it', async (t) => {
    if (!browser.available) return t.skip(browser.reason);

    const evidence = await crawl({
      level: 2,
      only: [
        '/traps/exception',
        '/traps/boundary',
        '/traps/blank',
        '/traps/console-error',
        '/traps/broken-asset',
        '/traps/noisy-console',
        '/traps/does-not-exist',
      ],
    });

    assert.deepEqual(checksFor(evidence, '/traps/exception'), ['page-exception']);
    assert.deepEqual(checksFor(evidence, '/traps/boundary'), ['error-boundary']);
    assert.deepEqual(checksFor(evidence, '/traps/blank'), ['blank-screen']);
    assert.deepEqual(checksFor(evidence, '/traps/console-error'), ['console-error']);
    assert.deepEqual(checksFor(evidence, '/traps/broken-asset'), ['broken-asset']);
    assert.deepEqual(checksFor(evidence, '/traps/noisy-console'), [], 'known browser noise is not a defect');
    assert.deepEqual(checksFor(evidence, '/traps/does-not-exist'), ['http-status']);
    assert.equal(evidence.result, 'fail');
  });

  it('respects the check switches', async (t) => {
    if (!browser.available) return t.skip(browser.reason);
    const evidence = await crawl({
      level: 2,
      only: ['/traps/console-error'],
      config: { checks: { consoleErrors: false } },
    });
    assert.equal(evidence.result, 'pass');
  });

  it('treats an unknown route as an edge case rather than a defect at level 1', async (t) => {
    if (!browser.available) return t.skip(browser.reason);
    const evidence = await crawl({ level: 1 });
    const probe = evidence.results.find((result) => result.probe);
    assert.ok(probe, 'level 1 should probe an unknown route');
    assert.equal(probe.ok, true, 'a correct 404 page is not a failure');
    assert.equal(evidence.result, 'pass');
  });

  it('crawls the protected area as a signed-in persona', async (t) => {
    if (!browser.available) return t.skip(browser.reason);

    const evidence = await crawl({
      level: 3,
      config: { protectedPrefixes: ['/private'], publicRoutes: ['/', '/about'] },
      personas: [
        { id: 'anonymous' },
        {
          id: 'member',
          label: 'Signed-in member',
          auth: { strategy: 'module', path: AUTH_MODULE, options: { session: 'member@example.test' } },
          seeds: ['/private'],
        },
      ],
    });

    assert.equal(evidence.result, 'pass', JSON.stringify(evidence.summary, null, 2));

    const memberRoutes = evidence.results.filter((result) => result.persona === 'member').map((result) => result.route);
    assert.ok(memberRoutes.includes('/private'), 'the signed-in persona should reach the protected area');
    assert.ok(memberRoutes.includes('/private/settings'), 'and should discover what it links to');

    const memberPrivate = evidence.results.find((result) => result.persona === 'member' && result.route === '/private');
    assert.equal(memberPrivate.finalPath, '/private', 'a signed-in visitor is not redirected');

    const anonymousPrivate = evidence.results.find((result) => result.persona === 'anonymous' && result.route === '/private');
    assert.equal(anonymousPrivate.finalPath, '/login', 'an anonymous visitor is redirected to sign in');
    assert.equal(anonymousPrivate.ok, true, 'being redirected is correct behaviour, not a failure');
  });

  it('checks the authentication rules at level 3', async (t) => {
    if (!browser.available) return t.skip(browser.reason);

    const evidence = await crawl({
      level: 3,
      config: { protectedPrefixes: ['/private'], publicRoutes: ['/', '/about'] },
      personas: [
        { id: 'anonymous' },
        { id: 'member', auth: { strategy: 'module', path: AUTH_MODULE }, seeds: ['/private'] },
      ],
    });

    const kinds = evidence.invariants.map((invariant) => invariant.kind);
    assert.ok(kinds.includes('protected-route-must-bounce-anonymous'));
    assert.ok(kinds.includes('public-route-must-stay-authenticated'));
    assert.equal(evidence.summary.invariantsViolated, 0);
  });

  it('fails a protected route that an anonymous visitor can read', async (t) => {
    if (!browser.available) return t.skip(browser.reason);

    // The trap pages are not guarded, so declaring one as protected is exactly
    // the mistake this rule exists to catch: a page that renders for everybody.
    const evidence = await crawl({
      level: 3,
      config: { routes: ['/traps/noisy-console'], protectedPrefixes: ['/traps'] },
    });

    const violation = evidence.invariants.find((invariant) => !invariant.ok);
    assert.ok(violation, 'an unguarded protected route must violate the rule');
    assert.match(violation.message, /anonymous visitor reached protected route/);
    assert.equal(evidence.result, 'fail');
  });

  it('fails a persona whose sign-in never took effect', async (t) => {
    if (!browser.available) return t.skip(browser.reason);

    const evidence = await crawl({
      level: 2,
      config: { protectedPrefixes: ['/private'] },
      personas: [
        // A storage state that carries no session: the persona is declared as
        // authenticated but will be redirected exactly like an anonymous one.
        { id: 'broken-session', auth: { strategy: 'storageState', path: './empty-state.json' }, seeds: ['/private'] },
      ],
    });

    assert.equal(evidence.result, 'fail');
    assert.equal(evidence.summary.personaErrors.length, 1);
    assert.match(evidence.summary.personaErrors[0].message, /never reached the protected area/);
  });

  it('stops at the route budget and records that it did', async (t) => {
    if (!browser.available) return t.skip(browser.reason);
    const evidence = await crawl({ level: 3, config: { maxRoutes: 2 } });
    assert.equal(evidence.coverage.truncated, true);
    assert.match(evidence.coverage.truncationReasons[0], /route budget/);
  });
});
