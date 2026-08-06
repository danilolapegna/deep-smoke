/**
 * Example of the `module` authentication strategy, used by the crawl test.
 *
 * A real one would call an API, exchange a code or drive a sign-in screen. This
 * one seeds the same browser storage the fixture app reads, which is enough to
 * prove the plumbing: the module runs before the crawl, its effects survive into
 * every page of the persona's context, and the protected routes stop redirecting.
 *
 * @param {object} input Provided by deep-smoke.
 * @param {import('playwright').BrowserContext} input.context Browser context for this persona.
 * @param {Record<string, unknown>} input.options Anything under `auth.options` in the persona.
 * @returns {Promise<void>} Resolves once the session is in place.
 */
export default async function authenticate({ context, options }) {
  const value = String(options.session ?? 'signed-in');
  await context.addInitScript((session) => {
    try {
      window.localStorage.setItem('deep-smoke-session', session);
    } catch {
      // Storage is unavailable on about:blank; the next real page will take it.
    }
  }, value);
}
