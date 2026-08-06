import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectAuthenticationNotEngaged, matchesRoutePattern, normaliseRoute, shouldIgnoreRoute } from '../src/crawler.js';
import { launchBrowser, loadPlaywright } from '../src/browser.js';
import { EnvironmentError } from '../src/errors.js';

const BASE = 'https://app.example.com';

describe('normaliseRoute', () => {
  it('resolves a relative link against the app origin', () => {
    assert.deepEqual(normaliseRoute('/orders', BASE), { pattern: '/orders', path: '/orders' });
  });

  it('drops the query string and the fragment from the route identity', () => {
    assert.deepEqual(normaliseRoute('/search?q=shoes#results', BASE), { pattern: '/search', path: '/search' });
  });

  it('collapses a trailing slash', () => {
    assert.equal(normaliseRoute('/orders/', BASE).pattern, '/orders');
    assert.equal(normaliseRoute('/', BASE).pattern, '/');
  });

  it('collapses an identifier so one detail page is not crawled a thousand times', () => {
    const uuid = normaliseRoute('/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301', BASE);
    assert.equal(uuid.pattern, '/orders/:id');
    assert.equal(uuid.path, '/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'the real path is kept for navigation');

    assert.equal(normaliseRoute('/orders/1048576/items', BASE).pattern, '/orders/:id/items');
    assert.equal(normaliseRoute('/orders/9f86d081884c7d659a2feaa0c55ad015', BASE).pattern, '/orders/:id');
  });

  it('leaves a short numeric segment alone, since it is usually a page number, not an identity', () => {
    assert.equal(normaliseRoute('/blog/page/2', BASE).pattern, '/blog/page/2');
  });

  it('refuses links that leave the app', () => {
    assert.equal(normaliseRoute('https://elsewhere.example/x', BASE), null);
    assert.equal(normaliseRoute('mailto:hello@example.com', BASE), null);
    assert.equal(normaliseRoute('javascript:void(0)', BASE), null);
  });

  it('handles an app served under a sub-path', () => {
    const mounted = 'https://example.com/app';
    assert.deepEqual(normaliseRoute('/app/orders', mounted), { pattern: '/orders', path: '/orders' });
    assert.deepEqual(normaliseRoute('orders', mounted), { pattern: '/orders', path: '/orders' });
    assert.deepEqual(normaliseRoute('/app', mounted), { pattern: '/', path: '/' });
    assert.equal(normaliseRoute('/marketing', mounted), null, 'a link outside the sub-path leaves the app');
  });

  it('survives an unparseable href', () => {
    assert.equal(normaliseRoute('http://[', BASE), null);
  });
});

describe('route ignoring', () => {
  it('matches an exact path', () => {
    assert.equal(matchesRoutePattern('/health', '/health'), true);
    assert.equal(matchesRoutePattern('/health/live', '/health'), false);
  });

  it('matches a subtree with a trailing star', () => {
    assert.equal(matchesRoutePattern('/api/orders', '/api/*'), true);
    assert.equal(matchesRoutePattern('/api', '/api/*'), true);
    assert.equal(matchesRoutePattern('/apiary', '/api/*'), false, 'a prefix must end on a path segment');
  });

  it('checks a path against every configured pattern', () => {
    assert.equal(shouldIgnoreRoute('/api/orders', ['/health', '/api/*']), true);
    assert.equal(shouldIgnoreRoute('/orders', ['/health', '/api/*']), false);
  });
});

describe('detectAuthenticationNotEngaged', () => {
  const report = (results) => ({
    persona: { id: 'member', authenticated: true },
    results: results.map(([route, finalPath]) => ({ route, finalPath })),
  });

  it('flags a persona whose every protected route bounced to the sign-in page', () => {
    const message = detectAuthenticationNotEngaged(report([['/app', '/login'], ['/app/settings', '/login']]), ['/app']);
    assert.match(message, /never reached the protected area/);
  });

  it('says nothing when the session clearly worked', () => {
    assert.equal(detectAuthenticationNotEngaged(report([['/app', '/app'], ['/app/settings', '/login']]), ['/app']), null);
  });

  it('says nothing when no protected route was attempted', () => {
    assert.equal(detectAuthenticationNotEngaged(report([['/', '/']]), ['/app']), null);
  });

  it('says nothing about an anonymous persona', () => {
    const anonymous = { persona: { id: 'anonymous', authenticated: false }, results: [{ route: '/app', finalPath: '/login' }] };
    assert.equal(detectAuthenticationNotEngaged(anonymous, ['/app']), null);
  });

  it('says nothing when the app declares no protected area', () => {
    assert.equal(detectAuthenticationNotEngaged(report([['/app', '/login']]), []), null);
  });
});

describe('loadPlaywright', () => {
  it('explains how to install Playwright when it is absent', async () => {
    await assert.rejects(
      () => loadPlaywright({ importer: async () => { throw new Error("Cannot find package 'playwright'"); } }),
      (error) => {
        assert.ok(error instanceof EnvironmentError);
        assert.equal(error.exitCode, 3, 'a missing browser is an environment problem, not a failing test');
        assert.match(error.message, /npm install --save-dev playwright/);
        assert.match(error.message, /npx playwright install chromium/);
        assert.match(error.message, /verify subcommand works without it/);
        return true;
      },
    );
  });

  it('accepts a module that exposes chromium on its default export', async () => {
    const chromium = { launch: async () => ({}) };
    const loaded = await loadPlaywright({ importer: async () => ({ default: { chromium } }) });
    assert.equal(loaded.chromium, chromium);
  });
});

describe('launchBrowser', () => {
  /**
   * A Playwright stand-in that records how it was asked to launch.
   *
   * @param {(options: object) => boolean} accepts Which launch options succeed.
   * @returns {{playwright: object, attempts: object[]}} Stub and its call log.
   */
  function stub(accepts) {
    const attempts = [];
    return {
      attempts,
      playwright: {
        chromium: {
          launch: async (options) => {
            attempts.push(options);
            if (!accepts(options)) throw new Error(`no browser for ${JSON.stringify(options.channel ?? 'bundled')}`);
            return { closed: false };
          },
        },
      },
    };
  }

  it('prefers the bundled browser', async () => {
    const { playwright, attempts } = stub(() => true);
    await launchBrowser({ playwright, browser: { headless: true, launchArgs: [] } });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].channel, undefined);
  });

  it('falls back to a system browser when no bundled one is installed', async () => {
    const { playwright, attempts } = stub((options) => options.channel === 'chrome');
    await launchBrowser({ playwright, browser: { headless: true, launchArgs: [] } });
    assert.deepEqual(attempts.map((attempt) => attempt.channel), [undefined, 'chrome']);
  });

  it('reports the bundled failure, not the last fallback, when nothing works', async () => {
    const { playwright } = stub(() => false);
    await assert.rejects(
      () => launchBrowser({ playwright, browser: { headless: true, launchArgs: [] } }),
      (error) => {
        assert.ok(error instanceof EnvironmentError);
        assert.match(error.message, /npx playwright install chromium/);
        assert.match(error.message, /no browser for "bundled"/);
        return true;
      },
    );
  });

  it('honours an explicit channel without trying anything else', async () => {
    const { playwright, attempts } = stub(() => true);
    await launchBrowser({ playwright, browser: { headless: true, channel: 'msedge', launchArgs: [] } });
    assert.deepEqual(attempts.map((attempt) => attempt.channel), ['msedge']);
  });
});
