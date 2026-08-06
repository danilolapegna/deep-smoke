import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKS,
  checkAuthInvariant,
  classifyConsoleMessage,
  classifyResponse,
  evaluateRoute,
  isBlankScreen,
  isErrorBoundary,
} from '../src/assertions.js';
import { DEFAULT_CONFIG, compilePatterns, severityFilter } from '../src/config.js';

const BASE = 'https://app.example.com';

/**
 * Builds an observation of a perfectly healthy page, so each test can change
 * exactly one thing and attribute the verdict to it.
 *
 * @param {object} [overrides] Fields to replace.
 * @returns {import('../src/assertions.js').RouteObservation} Observation.
 */
function observation(overrides = {}) {
  return {
    route: '/',
    requestedPath: '/',
    finalPath: '/',
    documentStatus: 200,
    navigationError: null,
    pageErrors: [],
    consoleMessages: [],
    failedResponses: [],
    dom: { elementCount: 40, textLength: 500, boundaryByText: false, boundaryBySelector: false },
    ...overrides,
  };
}

const OPTIONS = {
  checks: DEFAULT_CONFIG.checks,
  consoleSeverities: severityFilter('error'),
  consoleFailPatterns: compilePatterns(DEFAULT_CONFIG.console.failPatterns, 'test'),
  consoleIgnorePatterns: compilePatterns(DEFAULT_CONFIG.console.ignorePatterns, 'test'),
  httpFailFrom: 400,
  thirdPartyIsFatal: false,
};

/**
 * Collects the check ids a verdict reported.
 *
 * @param {{failures: {check: string}[]}} verdict Verdict.
 * @returns {string[]} Check ids.
 */
const checksOf = (verdict) => verdict.failures.map((failure) => failure.check);

describe('classifyResponse', () => {
  it('treats the app\'s own bundle as an asset', () => {
    assert.equal(classifyResponse(`${BASE}/assets/index-a1b2.js`, BASE), 'asset');
  });

  it('treats an off-origin request as third party even when it looks like an asset', () => {
    assert.equal(classifyResponse('https://cdn.other.example/x.js', BASE), 'third-party');
  });

  it('trusts the resource type over the file extension', () => {
    assert.equal(classifyResponse(`${BASE}/session`, BASE, 'document'), 'document');
    assert.equal(classifyResponse(`${BASE}/logo`, BASE, 'image'), 'asset');
  });

  it('treats an extensionless same-origin request as an api call', () => {
    assert.equal(classifyResponse(`${BASE}/api/orders`, BASE, 'fetch'), 'api');
  });
});

describe('classifyConsoleMessage', () => {
  const matchers = {
    severities: severityFilter('error'),
    failPatterns: compilePatterns(DEFAULT_CONFIG.console.failPatterns, 'test'),
    ignorePatterns: compilePatterns(DEFAULT_CONFIG.console.ignorePatterns, 'test'),
  };

  it('marks a dereference of undefined as fatal', () => {
    const message = { type: 'error', text: "TypeError: Cannot read properties of undefined (reading 'id')" };
    assert.equal(classifyConsoleMessage(message, matchers), 'fatal');
  });

  it('ignores browser noise that only starts benign', () => {
    const message = { type: 'error', text: 'ResizeObserver loop completed with undelivered notifications.' };
    assert.equal(classifyConsoleMessage(message, matchers), 'ignored');
  });

  it('still fails a real crash that happens to contain a benign word', () => {
    const message = { type: 'error', text: 'Uncaught TypeError: Failed to fetch' };
    assert.equal(classifyConsoleMessage(message, matchers), 'fatal');
  });

  it('drops messages below the configured severity', () => {
    const message = { type: 'warning', text: 'TypeError: something' };
    assert.equal(classifyConsoleMessage(message, matchers), 'benign');
    assert.equal(
      classifyConsoleMessage(message, { ...matchers, severities: severityFilter('warning') }),
      'fatal',
    );
  });

  it('treats every message as fatal when no fail patterns are configured', () => {
    const message = { type: 'error', text: 'a bespoke complaint nobody predicted' };
    assert.equal(classifyConsoleMessage(message, { ...matchers, failPatterns: [] }), 'fatal');
    assert.equal(classifyConsoleMessage(message, matchers), 'benign');
  });
});

describe('isBlankScreen', () => {
  it('is true only for an empty shell', () => {
    assert.equal(isBlankScreen({ elementCount: 0, textLength: 0 }), true);
    assert.equal(isBlankScreen({ elementCount: 1, textLength: 1 }), true);
  });

  it('is false for a sparse but real page', () => {
    assert.equal(isBlankScreen({ elementCount: 1, textLength: 30 }), false);
    assert.equal(isBlankScreen({ elementCount: 12, textLength: 0 }), false);
  });
});

describe('isErrorBoundary', () => {
  it('believes a marked fallback unconditionally', () => {
    assert.equal(
      isErrorBoundary({ boundaryBySelector: true, boundaryByText: false, elementCount: 900, textLength: 9000 }, 0),
      true,
    );
  });

  it('believes the phrase on a page that is sparse in both structure and text', () => {
    assert.equal(
      isErrorBoundary({ boundaryBySelector: false, boundaryByText: true, elementCount: 6, textLength: 80 }, 0),
      true,
    );
  });

  it('does not fail a short page that is dense with text', () => {
    assert.equal(
      isErrorBoundary({ boundaryBySelector: false, boundaryByText: true, elementCount: 7, textLength: 1200 }, 0),
      false,
    );
  });

  it('does not fail a documentation page that discusses errors', () => {
    assert.equal(
      isErrorBoundary({ boundaryBySelector: false, boundaryByText: true, elementCount: 400, textLength: 5000 }, 0),
      false,
    );
  });

  it('believes the phrase anywhere when an exception also fired', () => {
    assert.equal(
      isErrorBoundary({ boundaryBySelector: false, boundaryByText: true, elementCount: 400, textLength: 5000 }, 1),
      true,
    );
  });
});

describe('evaluateRoute', () => {
  it('passes a healthy page', () => {
    const verdict = evaluateRoute(observation(), OPTIONS);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.failures, []);
  });

  it('reports an uncaught exception first, ahead of its symptoms', () => {
    const verdict = evaluateRoute(
      observation({
        pageErrors: ['TypeError: undefined is not a function'],
        dom: { elementCount: 0, textLength: 0, boundaryByText: false, boundaryBySelector: false },
      }),
      OPTIONS,
    );
    assert.equal(verdict.ok, false);
    assert.equal(checksOf(verdict)[0], CHECKS.PAGE_EXCEPTION);
    assert.ok(checksOf(verdict).includes(CHECKS.BLANK_SCREEN));
  });

  it('reports a 4xx on navigation', () => {
    const verdict = evaluateRoute(observation({ documentStatus: 404 }), OPTIONS);
    assert.deepEqual(checksOf(verdict), [CHECKS.HTTP_STATUS]);
  });

  it('reports a broken same-origin asset', () => {
    const verdict = evaluateRoute(
      observation({ failedResponses: [{ url: `${BASE}/assets/main.js`, status: 404, kind: 'asset' }] }),
      OPTIONS,
    );
    assert.deepEqual(checksOf(verdict), [CHECKS.BROKEN_ASSET]);
  });

  it('ignores a third-party failure by default and reports it when asked', () => {
    const failed = [{ url: 'https://metrics.other.example/beacon', status: 503, kind: 'third-party' }];
    assert.equal(evaluateRoute(observation({ failedResponses: failed }), OPTIONS).ok, true);
    assert.equal(
      evaluateRoute(observation({ failedResponses: failed }), { ...OPTIONS, thirdPartyIsFatal: true }).ok,
      false,
    );
  });

  it('treats a navigation error with a rendered page as a slow route, not a failure', () => {
    const verdict = evaluateRoute(observation({ navigationError: 'Timeout 20000ms exceeded' }), OPTIONS);
    assert.equal(verdict.ok, true);
  });

  it('reports a navigation error that left the page empty', () => {
    const verdict = evaluateRoute(
      observation({
        navigationError: 'net::ERR_CONNECTION_REFUSED',
        documentStatus: null,
        dom: { elementCount: 0, textLength: 0, boundaryByText: false, boundaryBySelector: false },
      }),
      OPTIONS,
    );
    assert.deepEqual(checksOf(verdict), [CHECKS.NAVIGATION]);
  });

  it('honours every individual check switch', () => {
    const broken = observation({
      pageErrors: ['boom'],
      documentStatus: 500,
      failedResponses: [{ url: `${BASE}/a.js`, status: 404, kind: 'asset' }],
      consoleMessages: [{ type: 'error', text: 'ReferenceError: x is not defined' }],
      dom: { elementCount: 0, textLength: 0, boundaryByText: false, boundaryBySelector: true },
    });
    assert.deepEqual(checksOf(evaluateRoute(broken, OPTIONS)).sort(), [
      CHECKS.BLANK_SCREEN,
      CHECKS.BROKEN_ASSET,
      CHECKS.CONSOLE_ERROR,
      CHECKS.ERROR_BOUNDARY,
      CHECKS.HTTP_STATUS,
      CHECKS.PAGE_EXCEPTION,
    ].sort());

    const allOff = {
      ...OPTIONS,
      checks: {
        pageExceptions: false,
        errorBoundaries: false,
        blankScreen: false,
        httpStatus: false,
        brokenAssets: false,
        consoleErrors: false,
        authRedirects: false,
      },
    };
    assert.equal(evaluateRoute(broken, allOff).ok, true);
  });
});

describe('checkAuthInvariant', () => {
  const config = { protectedPrefixes: ['/app'], publicRoutes: ['/', '/pricing'] };

  it('fails when an anonymous visitor stays inside a protected route', () => {
    const verdict = checkAuthInvariant({
      authenticated: false,
      route: '/app/orders',
      finalPath: '/app/orders',
      ...config,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /reached protected route/);
  });

  it('passes when an anonymous visitor is redirected away', () => {
    const verdict = checkAuthInvariant({ authenticated: false, route: '/app', finalPath: '/login', ...config });
    assert.equal(verdict.ok, true);
  });

  it('fails when an authenticated visitor is bounced off a public route', () => {
    const verdict = checkAuthInvariant({ authenticated: true, route: '/pricing', finalPath: '/app', ...config });
    assert.equal(verdict.ok, false);
  });

  it('tolerates a trailing slash on either side', () => {
    const verdict = checkAuthInvariant({ authenticated: true, route: '/pricing', finalPath: '/pricing/', ...config });
    assert.equal(verdict.ok, true);
  });

  it('does not put an unrelated route under a protected prefix', () => {
    assert.equal(
      checkAuthInvariant({ authenticated: false, route: '/application-form', finalPath: '/application-form', ...config }),
      null,
    );
  });

  it('returns null when no invariant applies', () => {
    assert.equal(checkAuthInvariant({ authenticated: false, route: '/about', finalPath: '/about', ...config }), null);
  });
});
