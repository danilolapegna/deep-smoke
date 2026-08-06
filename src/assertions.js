/**
 * What counts as a real failure, and what is just noise.
 *
 * Every function here is pure: it takes a plain description of what the browser
 * did on one route and returns a verdict. Keeping the judgement separate from
 * the automation is what makes the interesting half of this tool testable in
 * milliseconds without a browser, and it is also what makes the rules auditable
 * by someone deciding whether to trust a red build.
 *
 * The bias throughout is against false positives. A crawler that fails a healthy
 * page teaches its users to bypass it, and a bypassed gate is worth less than no
 * gate, because it also carries the illusion of coverage.
 */

/**
 * @typedef {object} FailedResponse
 * @property {string} url Absolute URL of the response.
 * @property {number} status HTTP status code.
 * @property {'document'|'asset'|'api'|'third-party'} kind Classified origin and role.
 * @property {string} [method] HTTP method, for reporting.
 */

/**
 * @typedef {object} DomProbe
 * @property {number} elementCount Descendants of the app root (or body).
 * @property {number} textLength Length of trimmed visible text.
 * @property {boolean} boundaryBySelector A configured error-boundary selector matched.
 * @property {boolean} boundaryByText A configured error-boundary phrase was present.
 */

/**
 * @typedef {object} RouteObservation
 * @property {string} route Deduplicated route pattern, for example `/items/:id`.
 * @property {string} requestedPath Path actually navigated, for example `/items/42`.
 * @property {string} finalPath Path after client-side or server-side redirects.
 * @property {number|null} documentStatus HTTP status of the main document, null if unknown.
 * @property {string|null} navigationError Playwright navigation error message, if any.
 * @property {string[]} pageErrors Uncaught exception messages.
 * @property {{type: string, text: string}[]} consoleMessages Console output during the visit.
 * @property {FailedResponse[]} failedResponses Responses at or above the failure threshold.
 * @property {DomProbe} dom What the page looked like once it settled.
 */

/**
 * @typedef {object} Failure
 * @property {string} check Stable identifier, safe to grep for in CI logs.
 * @property {string} message One-line human summary.
 * @property {string} [detail] Longer evidence, for example the exception text.
 */

/** Failure identifiers, exported so consumers can filter without string literals. */
export const CHECKS = Object.freeze({
  NAVIGATION: 'navigation',
  PAGE_EXCEPTION: 'page-exception',
  ERROR_BOUNDARY: 'error-boundary',
  BLANK_SCREEN: 'blank-screen',
  HTTP_STATUS: 'http-status',
  BROKEN_ASSET: 'broken-asset',
  CONSOLE_ERROR: 'console-error',
  AUTH_REDIRECT: 'auth-redirect',
});

/**
 * Maps a check identifier to the config key that switches it off.
 *
 * Kept as data rather than as branches in `evaluateRoute` so that adding a check
 * cannot silently become unconfigurable.
 */
export const CHECK_TO_CONFIG_KEY = Object.freeze({
  [CHECKS.NAVIGATION]: 'blankScreen',
  [CHECKS.PAGE_EXCEPTION]: 'pageExceptions',
  [CHECKS.ERROR_BOUNDARY]: 'errorBoundaries',
  [CHECKS.BLANK_SCREEN]: 'blankScreen',
  [CHECKS.HTTP_STATUS]: 'httpStatus',
  [CHECKS.BROKEN_ASSET]: 'brokenAssets',
  [CHECKS.CONSOLE_ERROR]: 'consoleErrors',
  [CHECKS.AUTH_REDIRECT]: 'authRedirects',
});

/** File extensions that identify a static asset regardless of how it was requested. */
const ASSET_EXTENSION = /\.(?:js|mjs|cjs|css|map|json|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)(?:\?|#|$)/i;

/**
 * Decides what a response was for, so the same status code can mean different things.
 *
 * A 404 on the app's own JavaScript bundle is always a defect. A 404 from a
 * third-party analytics beacon is somebody else's outage and must not fail
 * anyone's merge. Without this distinction a crawler is only as reliable as the
 * least reliable ad network on the page.
 *
 * @param {string} url Absolute response URL.
 * @param {string} baseUrl Origin of the app under test.
 * @param {string} [resourceType] Playwright resource type, when available.
 * @returns {'document'|'asset'|'api'|'third-party'} Response role.
 */
export function classifyResponse(url, baseUrl, resourceType) {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return 'third-party';
  if (resourceType === 'document') return 'document';
  if (resourceType && ['script', 'stylesheet', 'image', 'font', 'media'].includes(resourceType)) return 'asset';
  if (ASSET_EXTENSION.test(url)) return 'asset';
  return 'api';
}

/**
 * Decides whether one console message means the page is broken.
 *
 * Three-way rather than boolean, because "not a failure" hides two different
 * situations that a user debugging their config needs to tell apart: a message
 * explicitly muted by `ignorePatterns`, and a message that simply did not look
 * fatal.
 *
 * @param {{type: string, text: string}} message Console message.
 * @param {object} options Compiled matchers.
 * @param {string[]|null} options.severities Accepted message types, null for all.
 * @param {RegExp[]} options.failPatterns Patterns that mark a message as fatal; empty means every message at the accepted severity is fatal.
 * @param {RegExp[]} options.ignorePatterns Patterns that mute a message outright.
 * @returns {'fatal'|'ignored'|'benign'} Classification.
 */
export function classifyConsoleMessage(message, { severities, failPatterns, ignorePatterns }) {
  if (severities && !severities.includes(message.type)) return 'benign';
  if (ignorePatterns.some((pattern) => pattern.test(message.text))) return 'ignored';
  if (failPatterns.length === 0) return 'fatal';
  return failPatterns.some((pattern) => pattern.test(message.text)) ? 'fatal' : 'benign';
}

/**
 * Decides whether the page rendered nothing at all.
 *
 * The thresholds are deliberately brutal (two elements, two characters) because
 * "the page looks a bit empty" is a judgement this tool cannot make, while "the
 * app root has no children" is an objective fact that always means the route did
 * not mount. Anything in between is left to the user's own assertions.
 *
 * @param {DomProbe} dom Probe taken after the settle delay.
 * @returns {boolean} True if the route produced an empty shell.
 */
export function isBlankScreen(dom) {
  return dom.elementCount < 2 && dom.textLength < 2;
}

/** A rendered error fallback is short: a heading, a sentence, maybe a button. */
const SPARSE_PAGE_ELEMENTS = 12;
const SPARSE_PAGE_TEXT = 300;

/**
 * Decides whether an error fallback is on screen.
 *
 * A selector match is authoritative: an app that marks its own fallback with
 * `data-error-boundary` is telling us directly, and that is the reliable way to
 * be detected. Text matching is a fallback for apps that do not, and it is
 * deliberately timid, because a page about error handling legitimately contains
 * the words "something went wrong". So the phrase only counts on a page that is
 * *also* sparse in both structure and text, or on a page where an exception
 * already fired. A documentation page fails both tests and is left alone.
 *
 * @param {DomProbe} dom Probe taken after the settle delay.
 * @param {number} pageErrorCount Uncaught exceptions seen during the visit.
 * @returns {boolean} True if the route rendered an error fallback.
 */
export function isErrorBoundary(dom, pageErrorCount) {
  if (dom.boundaryBySelector) return true;
  if (!dom.boundaryByText) return false;
  if (pageErrorCount > 0) return true;
  return dom.elementCount < SPARSE_PAGE_ELEMENTS && dom.textLength < SPARSE_PAGE_TEXT;
}

/**
 * Turns one visited route into a verdict.
 *
 * Ordering of the failure list is by diagnostic value, not by detection order:
 * when a component throws, it also blanks the screen and logs to the console,
 * and a report that leads with "blank screen" sends the reader to the wrong
 * place. The exception comes first because it names the actual bug.
 *
 * @param {RouteObservation} observation What the browser did.
 * @param {object} options Evaluation options.
 * @param {Record<string, boolean>} options.checks Enabled checks, by config key.
 * @param {string[]|null} options.consoleSeverities Accepted console message types.
 * @param {RegExp[]} options.consoleFailPatterns Fatal console patterns.
 * @param {RegExp[]} options.consoleIgnorePatterns Muted console patterns.
 * @param {number} options.httpFailFrom Lowest status treated as a failure.
 * @param {boolean} options.thirdPartyIsFatal Whether off-origin failures count.
 * @returns {{ok: boolean, failures: Failure[]}} Verdict for this route.
 */
export function evaluateRoute(observation, options) {
  const {
    checks,
    consoleSeverities,
    consoleFailPatterns,
    consoleIgnorePatterns,
    httpFailFrom,
    thirdPartyIsFatal,
  } = options;
  const enabled = (check) => checks[CHECK_TO_CONFIG_KEY[check]] !== false;
  const failures = /** @type {Failure[]} */ ([]);
  const blank = isBlankScreen(observation.dom);

  if (observation.pageErrors.length > 0 && enabled(CHECKS.PAGE_EXCEPTION)) {
    failures.push({
      check: CHECKS.PAGE_EXCEPTION,
      message: `uncaught exception: ${firstLine(observation.pageErrors[0])}`,
      detail: observation.pageErrors.join('\n'),
    });
  }

  if (enabled(CHECKS.ERROR_BOUNDARY) && isErrorBoundary(observation.dom, observation.pageErrors.length)) {
    failures.push({
      check: CHECKS.ERROR_BOUNDARY,
      message: 'error fallback rendered instead of the page',
    });
  }

  // A navigation error that still produced a page is a slow route, not a broken
  // one; the same error on an empty page is the only evidence we have of what
  // went wrong, so it is reported instead of a bare "blank screen". Both share
  // the blankScreen switch, since they are two readings of the same symptom.
  if (observation.navigationError && blank && enabled(CHECKS.NAVIGATION)) {
    failures.push({
      check: CHECKS.NAVIGATION,
      message: `navigation failed and the page stayed empty: ${firstLine(observation.navigationError)}`,
    });
  } else if (blank && enabled(CHECKS.BLANK_SCREEN)) {
    failures.push({
      check: CHECKS.BLANK_SCREEN,
      message: 'blank screen: the route rendered no content',
    });
  }

  if (
    enabled(CHECKS.HTTP_STATUS) &&
    typeof observation.documentStatus === 'number' &&
    observation.documentStatus >= httpFailFrom
  ) {
    failures.push({
      check: CHECKS.HTTP_STATUS,
      message: `HTTP ${observation.documentStatus} on navigation`,
    });
  }

  const relevantResponses = observation.failedResponses.filter(
    (response) => response.status >= httpFailFrom && (response.kind !== 'third-party' || thirdPartyIsFatal),
  );
  const brokenAssets = relevantResponses.filter((response) => response.kind === 'asset');
  const brokenCalls = relevantResponses.filter((response) => response.kind === 'api' || response.kind === 'third-party');

  if (brokenAssets.length > 0 && enabled(CHECKS.BROKEN_ASSET)) {
    failures.push({
      check: CHECKS.BROKEN_ASSET,
      message: `broken asset: ${brokenAssets[0].status} ${brokenAssets[0].url}`,
      detail: brokenAssets.map((response) => `${response.status} ${response.url}`).join('\n'),
    });
  }

  if (brokenCalls.length > 0 && enabled(CHECKS.HTTP_STATUS)) {
    failures.push({
      check: CHECKS.HTTP_STATUS,
      message: `request failed: ${brokenCalls[0].status} ${brokenCalls[0].method ?? 'GET'} ${brokenCalls[0].url}`,
      detail: brokenCalls.map((response) => `${response.status} ${response.url}`).join('\n'),
    });
  }

  if (enabled(CHECKS.CONSOLE_ERROR)) {
    const fatal = observation.consoleMessages.filter(
      (message) =>
        classifyConsoleMessage(message, {
          severities: consoleSeverities,
          failPatterns: consoleFailPatterns,
          ignorePatterns: consoleIgnorePatterns,
        }) === 'fatal',
    );
    if (fatal.length > 0) {
      failures.push({
        check: CHECKS.CONSOLE_ERROR,
        message: `console ${fatal[0].type}: ${truncate(firstLine(fatal[0].text), 160)}`,
        detail: fatal.map((message) => `[${message.type}] ${message.text}`).join('\n'),
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Checks one authentication invariant on a route that has already been visited.
 *
 * This is the check that a route-by-route render crawl cannot make on its own,
 * and it is the one that catches the most expensive class of bug: a protected
 * page that renders perfectly, for someone who should never have seen it.
 *
 * @param {object} input Invariant input.
 * @param {boolean} input.authenticated Whether the persona was signed in.
 * @param {string} input.route Route that was requested.
 * @param {string} input.finalPath Path the browser ended on.
 * @param {string[]} input.protectedPrefixes Route prefixes that require a session.
 * @param {string[]} input.publicRoutes Routes that must stay reachable when signed in.
 * @returns {{kind: string, ok: boolean, message: string}|null} Verdict, or null when the route is not covered by an invariant.
 */
export function checkAuthInvariant({ authenticated, route, finalPath, protectedPrefixes, publicRoutes }) {
  const isProtected = protectedPrefixes.some((prefix) => matchesPrefix(route, prefix));
  const isPublic = publicRoutes.some((entry) => normalisePath(entry) === normalisePath(route));

  if (!authenticated && isProtected) {
    const stillInside = protectedPrefixes.some((prefix) => matchesPrefix(finalPath, prefix));
    return {
      kind: 'protected-route-must-bounce-anonymous',
      ok: !stillInside,
      message: stillInside
        ? `anonymous visitor reached protected route ${route} (ended on ${finalPath})`
        : `anonymous visitor was redirected away from ${route} to ${finalPath}`,
    };
  }

  if (authenticated && isPublic) {
    const stayed = normalisePath(finalPath) === normalisePath(route);
    return {
      kind: 'public-route-must-stay-authenticated',
      ok: stayed,
      message: stayed
        ? `authenticated visitor stayed on public route ${route}`
        : `authenticated visitor was bounced off public route ${route} to ${finalPath}`,
    };
  }

  return null;
}

/**
 * Trailing-slash-insensitive path comparison.
 *
 * `/pricing` and `/pricing/` are the same page to a user and to every router in
 * common use, so treating them as different would produce invariant violations
 * that no one can act on.
 *
 * @param {string} value Any path.
 * @returns {string} Path without a trailing slash, never empty.
 */
export function normalisePath(value) {
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Tests whether a path sits under a prefix, on a path-segment boundary.
 *
 * Plain `startsWith` would put `/administration` under `/admin`, quietly
 * requiring a session for an unrelated page.
 *
 * @param {string} value Path to test.
 * @param {string} prefix Prefix to test against.
 * @returns {boolean} True if `value` is the prefix or sits below it.
 */
export function matchesPrefix(value, prefix) {
  const path = normalisePath(value);
  const base = normalisePath(prefix);
  if (base === '/') return true;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * First line of a multi-line message, for single-line reporting.
 *
 * @param {string} value Message, possibly with a stack trace.
 * @returns {string} First non-empty line.
 */
function firstLine(value) {
  return String(value).split('\n').find((line) => line.trim().length > 0)?.trim() ?? String(value);
}

/**
 * Truncates with an ellipsis marker.
 *
 * @param {string} value Text.
 * @param {number} max Maximum length.
 * @returns {string} Possibly shortened text.
 */
function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
