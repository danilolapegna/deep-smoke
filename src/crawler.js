/**
 * Route discovery and the visit loop.
 *
 * The crawl is a breadth-first walk from a set of seed routes, following links
 * as it goes, once per persona, in a browser context of that persona's own.
 * Breadth-first rather than depth-first because a truncated crawl should have
 * covered the pages nearest the entry points, which are the ones most users
 * reach; a depth-first crawl that runs out of budget has tested one long tail
 * and nothing else.
 *
 * Everything in this file either drives a browser or arranges the walk. The
 * judgement about what the browser saw lives in `assertions.js`, so that a
 * change to the rules never requires touching the automation and vice versa.
 */

import { performance } from 'node:perf_hooks';
import {
  checkAuthInvariant,
  classifyResponse,
  evaluateRoute,
  matchesPrefix,
  normalisePath,
} from './assertions.js';
import { compilePatterns, severityFilter } from './config.js';
import { applyAuth, contextOptionsFor } from './auth/index.js';
import { buildPlan, UNKNOWN_ROUTE_CHECK_OVERRIDES } from './levels.js';
import { launchBrowser, loadPlaywright } from './browser.js';
import { ConfigError, EnvironmentError } from './errors.js';

/**
 * Segments replaced when computing a route's identity.
 *
 * Two visits to `/orders/8f3c...` and `/orders/1a2b...` exercise the same code,
 * so they collapse to one route for de-duplication. The concrete path is kept
 * separately and is what actually gets navigated: navigating the literal string
 * `/orders/:id` would test the not-found page and quietly report it as coverage
 * of the detail page.
 */
const DYNAMIC_SEGMENT_RULES = [
  [/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id'],
  [/\/[0-9a-f]{24,64}(?=\/|$)/gi, '/:id'],
  [/\/\d{4,}(?=\/|$)/g, '/:id'],
];

/** @typedef {import('playwright').Page} PlaywrightPage */
/** @typedef {import('playwright').BrowserContext} PlaywrightContext */

/**
 * Turns a link into a route identity plus a concrete path to navigate.
 *
 * Paths are returned relative to the base URL, so an app served under a sub-path
 * works without any special configuration: the crawl always concatenates the base
 * and the path, and a link that leaves the sub-path leaves the app.
 *
 * @param {string} href Value of an `href` attribute, absolute or relative.
 * @param {string} baseUrl Base URL of the app under test, origin plus optional sub-path.
 * @returns {{pattern: string, path: string}|null} Route identity and concrete path, or null when the link leaves the app.
 */
export function normaliseRoute(href, baseUrl) {
  let url;
  let base;
  try {
    base = new URL(baseUrl);
    url = new URL(href, `${baseUrl}/`);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (!['http:', 'https:'].includes(url.protocol)) return null;

  const mount = base.pathname.replace(/\/+$/, '');
  let pathname = url.pathname;
  if (mount) {
    if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return null;
    pathname = pathname.slice(mount.length) || '/';
  }

  const path = normalisePath(pathname);
  let pattern = path;
  for (const [expression, replacement] of DYNAMIC_SEGMENT_RULES) {
    pattern = pattern.replace(expression, replacement);
  }
  return { pattern, path };
}

/**
 * Matches a path against an ignore entry.
 *
 * Supports an exact path, or a trailing `*` for a subtree. Deliberately not full
 * glob syntax: the thing being matched is a URL path, where a prefix is almost
 * always what people mean, and a half-implemented glob dialect is worse than an
 * obvious limitation.
 *
 * @param {string} path Route path.
 * @param {string} pattern Ignore entry, for example `/api/*`.
 * @returns {boolean} True if the path is covered by the entry.
 */
export function matchesRoutePattern(path, pattern) {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1).replace(/\/+$/, '');
    return prefix === '' ? true : matchesPrefix(path, prefix);
  }
  return normalisePath(path) === normalisePath(pattern);
}

/**
 * Whether a route should be skipped entirely.
 *
 * @param {string} path Route path.
 * @param {string[]} patterns Ignore entries from the config.
 * @returns {boolean} True if the route must not be visited.
 */
export function shouldIgnoreRoute(path, patterns) {
  return patterns.some((pattern) => matchesRoutePattern(path, pattern));
}

/**
 * Reads the state of a settled page from inside the browser.
 *
 * Runs as a single evaluation rather than several queries so the numbers
 * describe one moment. A page that is mid-transition can otherwise report an
 * empty root and a full text body from two calls milliseconds apart, which
 * produces a failure nobody can reproduce.
 *
 * @param {PlaywrightPage} page Page to inspect.
 * @param {{texts: string[], selectors: string[]}} boundary Error-boundary markers.
 * @returns {Promise<import('./assertions.js').DomProbe>} What the page looks like.
 */
async function probeDom(page, boundary) {
  return page.evaluate(({ texts, selectors }) => {
    const root = document.querySelector('#root, #app, main, [data-reactroot]') ?? document.body;
    const text = (document.body?.innerText ?? '').trim();
    const lowerText = text.toLowerCase();
    return {
      elementCount: root ? root.querySelectorAll('*').length : 0,
      textLength: text.length,
      boundaryByText: texts.some((phrase) => lowerText.includes(phrase.toLowerCase())),
      boundaryBySelector: selectors.some((selector) => {
        try {
          return Boolean(document.querySelector(selector));
        } catch {
          return false;
        }
      }),
    };
  }, boundary);
}

/**
 * Waits until the page has something on it, or gives up quietly.
 *
 * Network idle is not used as the readiness signal: an app with polling, a live
 * connection or an analytics heartbeat never reaches it, and the crawl becomes
 * a stopwatch rather than a test. Waiting for the app root to have children is
 * both faster and true of every stack that renders anything at all.
 *
 * @param {PlaywrightPage} page Page to wait on.
 * @param {string|null} readySelector Optional app-specific readiness selector.
 * @param {number} timeout Milliseconds to wait.
 * @returns {Promise<boolean>} True if content appeared, false if the wait ran out.
 */
async function waitForContent(page, readySelector, timeout) {
  return page
    .waitForFunction(
      (selector) => {
        if (selector) {
          try {
            if (document.querySelector(selector)) return true;
          } catch {
            return false;
          }
        }
        const root = document.querySelector('#root, #app, main, [data-reactroot]');
        if (root && root.querySelectorAll('*').length >= 3) return true;
        return (document.body?.innerText ?? '').trim().length > 0;
      },
      readySelector,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * Visits one route and records what the browser did.
 *
 * Returns raw observations and makes no judgement: the same visit can be a
 * failure at one level and expected at another (a 404 on the level 1 edge case
 * probe, for instance), and encoding that here would spread the rules across two
 * files.
 *
 * @param {PlaywrightPage} page A fresh page in the persona's context.
 * @param {object} options Visit options.
 * @param {string} options.baseUrl Origin of the app.
 * @param {string} options.route Route identity.
 * @param {string} options.navPath Concrete path to navigate.
 * @param {Record<string, any>} options.config Loaded config.
 * @param {RegExp[]} options.ignoreUrlPatterns Responses to disregard.
 * @returns {Promise<import('./assertions.js').RouteObservation>} What happened.
 */
export async function visitRoute(page, { baseUrl, route, navPath, config, ignoreUrlPatterns }) {
  const consoleMessages = [];
  const pageErrors = [];
  const failedResponses = [];

  const onConsole = (message) => consoleMessages.push({ type: message.type(), text: message.text() });
  const onPageError = (error) => pageErrors.push(error?.message ?? String(error));
  const onResponse = (response) => {
    const status = response.status();
    if (status < config.http.failFrom) return;
    const url = response.url();
    if (ignoreUrlPatterns.some((pattern) => pattern.test(url))) return;
    let resourceType;
    try {
      resourceType = response.request().resourceType();
    } catch {
      resourceType = undefined;
    }
    failedResponses.push({
      url,
      status,
      method: safeMethod(response),
      kind: classifyResponse(url, baseUrl, resourceType),
    });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  let navigationError = null;
  let documentStatus = null;
  try {
    const response = await page.goto(baseUrl + navPath, {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs,
    });
    documentStatus = response ? response.status() : null;
  } catch (cause) {
    navigationError = cause instanceof Error ? cause.message : String(cause);
  }

  const contentAppeared = await waitForContent(page, config.readySelector, Math.min(6_000, config.navigationTimeoutMs));
  await page.waitForTimeout(config.settleMs).catch(() => {});

  let dom = { elementCount: 0, textLength: 0, boundaryByText: false, boundaryBySelector: false };
  try {
    dom = await probeDom(page, config.errorBoundary);
  } catch {
    // A page that closed or refused evaluation is reported through its other
    // signals; an empty probe is the honest reading of "we could not look".
  }

  // A guard that redirects, or a canonical alias, can leave the root empty for a
  // moment: content appeared, then went away again while the transition settled.
  // That case gets a second look. A page where content never appeared does not,
  // since the wait above already gave it every chance and repeating it only makes
  // a broken route slow to report.
  if (contentAppeared && dom.elementCount < 2 && dom.textLength < 2) {
    await waitForContent(page, config.readySelector, blankGracePeriod(config));
    try {
      dom = await probeDom(page, config.errorBoundary);
    } catch {
      // Keep the empty probe.
    }
  }

  const finalPath = safePath(page, navPath);

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('response', onResponse);

  return {
    route,
    requestedPath: navPath,
    finalPath,
    documentStatus,
    navigationError,
    pageErrors,
    consoleMessages,
    failedResponses,
    dom,
  };
}

/**
 * Collects same-origin links from the current page.
 *
 * Anchors only. Buttons that navigate through a router, and routes reachable
 * only after a form submission, are invisible here, which is exactly why the
 * config takes a seed route list: discovery is a convenience on top of a
 * declared inventory, never a replacement for it.
 *
 * @param {PlaywrightPage} page Page to read.
 * @param {string} baseUrl Origin of the app.
 * @returns {Promise<{pattern: string, path: string}[]>} Discovered routes.
 */
export async function collectLinks(page, baseUrl) {
  let hrefs = [];
  try {
    hrefs = await page.$$eval('a[href]', (anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
  } catch {
    return [];
  }
  const routes = [];
  for (const href of hrefs) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    const route = normaliseRoute(href, baseUrl);
    if (route) routes.push(route);
  }
  return routes;
}

/**
 * Crawls the app once, as one persona.
 *
 * @param {object} input Crawl input.
 * @param {any} input.browser Launched browser.
 * @param {import('./personas.js').Persona} input.persona Persona to crawl as.
 * @param {{seeds: string[], probes: string[]}} input.plan This persona's routes.
 * @param {number} input.discoveryDepth Link-following hops allowed past the seeds.
 * @param {Record<string, any>} input.config Loaded config.
 * @param {string} input.baseUrl Origin of the app.
 * @param {string} input.baseDir Directory for resolving relative auth paths.
 * @param {(message: string) => void} [input.log] Verbose logger.
 * @returns {Promise<object>} Persona report.
 */
export async function crawlPersona({ browser, persona, plan, discoveryDepth, config, baseUrl, baseDir, log = () => {} }) {
  const ignoreUrlPatterns = compilePatterns(config.http.ignoreUrlPatterns, 'http.ignoreUrlPatterns');
  const consoleSeverities = severityFilter(config.console.severity);
  const consoleFailPatterns = compilePatterns(config.console.failPatterns, 'console.failPatterns');
  const consoleIgnorePatterns = compilePatterns(config.console.ignorePatterns, 'console.ignorePatterns');

  const context = await browser.newContext({
    viewport: config.browser.viewport,
    ...contextOptionsFor(persona.auth, baseDir),
  });

  const report = {
    persona: {
      id: persona.id,
      label: persona.label,
      authenticated: persona.authenticated,
      authStrategy: persona.auth.strategy,
      authDetail: null,
    },
    results: [],
    invariants: [],
    truncated: false,
    truncationReason: null,
    error: null,
  };

  try {
    const authPage = await context.newPage();
    const outcome = await applyAuth({
      auth: persona.auth,
      context,
      page: authPage,
      baseUrl,
      baseDir,
      persona,
      log,
    });
    report.persona.authDetail = outcome.detail;
    await authPage.close().catch(() => {});

    const started = performance.now();
    const visited = new Set();
    const concreteByPattern = new Map();
    /** @type {{pattern: string, path: string, depth: number, probe: boolean}[]} */
    const queue = [
      ...plan.seeds.map((path) => ({ ...identify(path, baseUrl), depth: 0, probe: false })),
      ...plan.probes.map((path) => ({ ...identify(path, baseUrl), depth: 0, probe: true })),
    ];

    while (queue.length > 0) {
      if (visited.size >= config.maxRoutes) {
        report.truncated = true;
        report.truncationReason = `route budget reached (maxRoutes=${config.maxRoutes})`;
        break;
      }
      if (performance.now() - started > config.budgetMs) {
        report.truncated = true;
        report.truncationReason = `time budget reached (budgetMs=${config.budgetMs})`;
        break;
      }

      const entry = queue.shift();
      if (!entry || visited.has(entry.pattern)) continue;
      if (shouldIgnoreRoute(entry.path, config.ignoreRoutes)) {
        log(`skipping ignored route ${entry.path}`);
        continue;
      }
      visited.add(entry.pattern);

      const navPath = entry.probe ? entry.path : concreteByPattern.get(entry.pattern) ?? entry.path;
      const checks = entry.probe ? { ...config.checks, ...UNKNOWN_ROUTE_CHECK_OVERRIDES } : config.checks;

      let attempt = await runVisit({ context, baseUrl, entry, navPath, config, ignoreUrlPatterns });
      let verdict = evaluateRoute(attempt.observation, {
        checks,
        consoleSeverities,
        consoleFailPatterns,
        consoleIgnorePatterns,
        httpFailFrom: config.http.failFrom,
        thirdPartyIsFatal: config.http.thirdPartyIsFatal,
      });
      let flaky = false;

      // One retry, on a brand new page. A defect that reproduces is a defect; one
      // that does not is a slow chunk or a lost race, and failing a merge on it
      // is how a gate loses its credibility.
      if (!verdict.ok && config.retryFailedRoutes) {
        const retry = await runVisit({ context, baseUrl, entry, navPath, config, ignoreUrlPatterns });
        const retryVerdict = evaluateRoute(retry.observation, {
          checks,
          consoleSeverities,
          consoleFailPatterns,
          consoleIgnorePatterns,
          httpFailFrom: config.http.failFrom,
          thirdPartyIsFatal: config.http.thirdPartyIsFatal,
        });
        if (retryVerdict.ok) {
          flaky = true;
          attempt = retry;
          verdict = retryVerdict;
        } else {
          attempt = retry;
          verdict = retryVerdict;
        }
      }

      report.results.push({
        persona: persona.id,
        route: entry.pattern,
        requestedPath: navPath,
        finalPath: attempt.observation.finalPath,
        probe: entry.probe,
        ok: verdict.ok,
        flaky,
        durationMs: Math.round(attempt.durationMs),
        failures: verdict.failures,
      });
      log(`${verdict.ok ? 'ok  ' : 'FAIL'} [${persona.id}] ${entry.pattern}${flaky ? ' (passed on retry)' : ''}`);

      const invariant = checkAuthInvariant({
        authenticated: persona.authenticated,
        route: entry.pattern,
        finalPath: attempt.observation.finalPath,
        protectedPrefixes: config.protectedPrefixes,
        publicRoutes: config.publicRoutes,
      });
      if (invariant) {
        report.invariants.push({ persona: persona.id, route: entry.pattern, source: 'crawl', ...invariant });
      }

      if (entry.depth < discoveryDepth && !entry.probe) {
        // A redirect target is a reachable route even when nothing links to it:
        // a sign-in screen usually exists only at the end of a guard, and a crawl
        // that never opens it has not tested the page most visitors see first.
        const landing = normaliseRoute(attempt.observation.finalPath, baseUrl);
        const discovered = landing && landing.pattern !== entry.pattern ? [landing, ...attempt.links] : attempt.links;
        for (const link of discovered) {
          if (link.path !== link.pattern && !concreteByPattern.has(link.pattern)) {
            concreteByPattern.set(link.pattern, link.path);
          }
          if (visited.has(link.pattern) || queue.some((queued) => queued.pattern === link.pattern)) continue;
          queue.push({ ...link, depth: entry.depth + 1, probe: false });
        }
      }
    }
  } catch (cause) {
    // A persona that could not sign in at all is an environment failure, not a
    // failing test: the crawl never got far enough to make a claim about the app.
    // Reporting it as a broken page would be exactly the over-claiming this tool
    // exists to prevent, so it is allowed to abort the run with its own exit code.
    if (cause instanceof EnvironmentError) throw cause;
    report.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    await context.close().catch(() => {});
  }

  return report;
}

/**
 * Runs one visit on a page of its own and closes it afterwards.
 *
 * A fresh page per visit keeps one route from leaking state, listeners or a
 * half-finished navigation into the next, which is the difference between a
 * crawl that reports the same result twice and one that does not.
 *
 * @param {object} input Visit input.
 * @returns {Promise<{observation: import('./assertions.js').RouteObservation, links: {pattern: string, path: string}[], durationMs: number}>} Visit outcome.
 */
async function runVisit({ context, baseUrl, entry, navPath, config, ignoreUrlPatterns }) {
  const page = await context.newPage();
  const started = performance.now();
  try {
    const observation = await withDeadline(
      visitRoute(page, { baseUrl, route: entry.pattern, navPath, config, ignoreUrlPatterns }),
      config.routeTimeoutMs,
      `route deadline exceeded after ${config.routeTimeoutMs} ms`,
    );
    const links = await collectLinks(page, baseUrl);
    return { observation, links, durationMs: performance.now() - started };
  } catch (cause) {
    // A route that blows its own deadline is reported as a failure rather than
    // being allowed to hang the run: an unbounded crawl is indistinguishable
    // from a hung CI job, and neither tells anybody anything.
    return {
      observation: {
        route: entry.pattern,
        requestedPath: navPath,
        finalPath: navPath,
        documentStatus: null,
        navigationError: cause instanceof Error ? cause.message : String(cause),
        pageErrors: [],
        consoleMessages: [],
        failedResponses: [],
        dom: { elementCount: 0, textLength: 0, boundaryByText: false, boundaryBySelector: false },
      },
      links: [],
      durationMs: performance.now() - started,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Probes the authentication invariants the crawl did not happen to cover.
 *
 * Declared invariants are checked explicitly rather than inferred from wherever
 * the crawl wandered, because "we never reached the admin area, so it passed" is
 * the failure mode this check exists to prevent.
 *
 * @param {object} input Probe input.
 * @param {any} input.browser Launched browser.
 * @param {import('./personas.js').Persona} input.persona Persona to probe as.
 * @param {object} input.report Persona report to extend.
 * @param {Record<string, any>} input.config Loaded config.
 * @param {string} input.baseUrl Origin of the app.
 * @param {string} input.baseDir Directory for resolving relative auth paths.
 * @param {(message: string) => void} [input.log] Verbose logger.
 * @returns {Promise<void>} Resolves once every declared invariant has a verdict.
 */
export async function probeAuthInvariants({ browser, persona, report, config, baseUrl, baseDir, log = () => {} }) {
  const targets = persona.authenticated ? config.publicRoutes : config.protectedPrefixes;
  if (targets.length === 0) return;

  const context = await browser.newContext({
    viewport: config.browser.viewport,
    ...contextOptionsFor(persona.auth, baseDir),
  });
  try {
    const page = await context.newPage();
    await applyAuth({ auth: persona.auth, context, page, baseUrl, baseDir, persona, log });

    for (const target of targets) {
      const route = normalisePath(target);
      const alreadyChecked = report.invariants.some((entry) => entry.route === route);
      if (alreadyChecked) continue;

      const probe = await context.newPage();
      let finalPath = route;
      try {
        await probe.goto(baseUrl + route, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
        // A redirect decided in the browser happens after the document loads, so
        // the URL has to be given a moment to stop moving before it is read.
        await probe
          .waitForFunction((from) => window.location.pathname !== from, route, { timeout: 3_000 })
          .catch(() => {});
        finalPath = safePath(probe, route);
      } catch {
        finalPath = safePath(probe, route);
      } finally {
        await probe.close().catch(() => {});
      }

      const invariant = checkAuthInvariant({
        authenticated: persona.authenticated,
        route,
        finalPath,
        protectedPrefixes: config.protectedPrefixes,
        publicRoutes: config.publicRoutes,
      });
      if (invariant) {
        report.invariants.push({ persona: persona.id, route, source: 'probe', ...invariant });
        log(`${invariant.ok ? 'ok  ' : 'FAIL'} [${persona.id}] invariant ${invariant.kind} on ${route}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Detects an authenticated persona whose session never took effect.
 *
 * This is the check that keeps the whole persona idea honest. If every protected
 * route bounced to the login screen, the crawl visited a login screen many times
 * and found it healthy, which it is: reporting that as coverage of the signed-in
 * application would be the most confident lie the tool could tell.
 *
 * @param {object} report Persona report.
 * @param {string[]} protectedPrefixes Protected route prefixes.
 * @returns {string|null} Failure message, or null when the session clearly worked.
 */
export function detectAuthenticationNotEngaged(report, protectedPrefixes) {
  if (!report.persona.authenticated || protectedPrefixes.length === 0) return null;
  const attempted = report.results.filter((result) =>
    protectedPrefixes.some((prefix) => matchesPrefix(result.route, prefix)),
  );
  if (attempted.length === 0) return null;
  const engaged = attempted.some((result) =>
    protectedPrefixes.some((prefix) => matchesPrefix(result.finalPath, prefix)),
  );
  if (engaged) return null;
  return (
    `persona "${report.persona.id}" never reached the protected area: all ${attempted.length} protected ` +
    'route(s) redirected away. The crawl tested the signed-out experience, not this persona. ' +
    'Check the auth strategy for this persona.'
  );
}

/**
 * Runs a complete smoke crawl and returns the raw run result.
 *
 * @param {object} input Run input.
 * @param {Record<string, any>} input.config Loaded config.
 * @param {import('./personas.js').Persona[]} input.personas Declared personas.
 * @param {number} input.level Level to run.
 * @param {string[]} [input.only] Explicit route scope.
 * @param {string} [input.baseDir] Directory for resolving relative paths.
 * @param {(message: string) => void} [input.log] Verbose logger.
 * @param {any} [input.playwright] Pre-loaded Playwright, for tests.
 * @returns {Promise<object>} Run result, ready for `buildEvidence`.
 * @throws {EnvironmentError} If no browser can be started.
 */
export async function runSmoke({ config, personas, level, only = [], baseDir = process.cwd(), log = () => {}, playwright }) {
  if (!config.baseUrl) {
    throw new ConfigError('No target URL. Pass --url=http://localhost:3000 or set "baseUrl" in your config file.');
  }
  const plan = buildPlan({ level, config, personas, only });
  const runtime = playwright ?? (await loadPlaywright());
  const browser = await launchBrowser({ playwright: runtime, browser: config.browser, log });
  const startedAt = new Date();
  const started = performance.now();
  const personaReports = [];

  try {
    for (const planned of plan.personas) {
      log(`crawling as ${planned.persona.id}`);
      const report = await crawlPersona({
        browser,
        persona: planned.persona,
        plan: planned,
        discoveryDepth: plan.discoveryDepth,
        config,
        baseUrl: config.baseUrl,
        baseDir,
        log,
      });

      if (!report.error && plan.requireAuthInvariants && config.checks.authRedirects !== false) {
        try {
          await probeAuthInvariants({
            browser,
            persona: planned.persona,
            report,
            config,
            baseUrl: config.baseUrl,
            baseDir,
            log,
          });
        } catch (cause) {
          report.error = cause instanceof Error ? cause.message : String(cause);
        }
      }

      if (!report.error) {
        const notEngaged = detectAuthenticationNotEngaged(report, config.protectedPrefixes);
        if (notEngaged) report.error = notEngaged;
      }

      personaReports.push(report);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    plan,
    personaReports,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    baseUrl: config.baseUrl,
    config,
  };
}

/**
 * How long to wait for a page that looked empty to fill in.
 *
 * Derived rather than configurable, so that one number (`navigationTimeoutMs`)
 * expresses how patient the crawl should be, and a fast fixture site does not
 * pay a fixed three-second toll on every empty page.
 *
 * @param {Record<string, any>} config Loaded config.
 * @returns {number} Milliseconds.
 */
function blankGracePeriod(config) {
  return Math.min(3_000, Math.max(500, Math.round(config.navigationTimeoutMs / 4)));
}

/**
 * Builds a queue entry from a declared seed path.
 *
 * Declared seeds keep any query string they were written with, because a user
 * who wrote `/search?q=shoes` meant that page and not the empty search screen.
 *
 * @param {string} path Seed path.
 * @param {string} baseUrl Origin of the app.
 * @returns {{pattern: string, path: string}} Queue entry.
 */
function identify(path, baseUrl) {
  const normalised = normaliseRoute(path, baseUrl);
  return normalised ?? { pattern: normalisePath(path), path };
}

/**
 * Rejects a promise that outlives its deadline.
 *
 * @template T
 * @param {Promise<T>} promise Work to bound.
 * @param {number} ms Deadline in milliseconds.
 * @param {string} message Timeout message.
 * @returns {Promise<T>} The original result, or a rejection.
 */
async function withDeadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a page's path, tolerating a closed page.
 *
 * @param {PlaywrightPage} page Page to read.
 * @param {string} fallback Value to use when the page cannot be read.
 * @returns {string} Path.
 */
function safePath(page, fallback) {
  try {
    return normalisePath(new URL(page.url()).pathname);
  } catch {
    return normalisePath(fallback);
  }
}

/**
 * Reads a response's HTTP method without throwing on a detached request.
 *
 * @param {any} response Playwright response.
 * @returns {string} Method, defaulting to GET.
 */
function safeMethod(response) {
  try {
    return response.request().method();
  } catch {
    return 'GET';
  }
}
