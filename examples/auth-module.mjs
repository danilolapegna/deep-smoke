/**
 * Example of the `module` authentication strategy.
 *
 * Use this when your sign-in does not fit a form and a saved browser session is
 * not practical: a token exchange, a one-time code read from a test mailbox, a
 * redirect through an identity provider, a tenant header, a signed cookie minted
 * by your own backend.
 *
 * The contract is small on purpose. You get the persona's browser context and a
 * page in it, both already pointed at the app under test. Whatever state you
 * leave behind (cookies, local storage, an init script) applies to every page
 * deep-smoke opens for that persona afterwards. Throw to fail the persona; the
 * run reports it as an environment problem rather than as a broken page, so a
 * missing test account does not look like a regression.
 *
 * Referenced from a persona as:
 *
 *   {
 *     "id": "partner",
 *     "auth": {
 *       "strategy": "module",
 *       "path": "./deep-smoke-auth.mjs",
 *       "options": { "tenant": "acme" }
 *     }
 *   }
 */

/**
 * Signs a persona in by exchanging credentials for a token and seeding it.
 *
 * @param {object} input Provided by deep-smoke.
 * @param {import('playwright').BrowserContext} input.context The persona's browser context.
 * @param {import('playwright').Page} input.page A page in that context.
 * @param {string} input.baseUrl Base URL of the app under test.
 * @param {{id: string, label: string}} input.persona The persona being prepared.
 * @param {Record<string, unknown>} input.options Whatever you put under `auth.options`.
 * @param {(message: string) => void} input.log Verbose logger, printed with --verbose.
 * @returns {Promise<void>} Resolves once the session is in place.
 */
export default async function authenticate({ context, baseUrl, persona, options, log }) {
  const email = process.env.SMOKE_PARTNER_EMAIL;
  const password = process.env.SMOKE_PARTNER_PASSWORD;
  if (!email || !password) {
    throw new Error('SMOKE_PARTNER_EMAIL and SMOKE_PARTNER_PASSWORD must be set');
  }

  log(`signing ${persona.id} in through the API`);
  const response = await fetch(`${baseUrl}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant': String(options.tenant ?? '') },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`token endpoint answered ${response.status}`);
  }
  const { token, expiresAt } = await response.json();

  // Two ways to hand the session to the browser. Use whichever your app reads.

  // 1. A cookie, for an app whose session lives in one.
  await context.addCookies([
    {
      name: 'session',
      value: token,
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
      expires: expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : undefined,
    },
  ]);

  // 2. Local storage, for an app that reads a token on boot. An init script runs
  //    before the app's own scripts on every page, which is what makes this work
  //    on the very first navigation rather than only after a reload.
  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem('auth.token', value);
    } catch {
      // Storage is unavailable on about:blank; the next real page will take it.
    }
  }, token);
}
