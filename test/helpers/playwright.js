/**
 * Decides whether the browser-dependent tests can run here.
 *
 * Playwright is an optional peer dependency, so a contributor who only touched
 * the pure logic must still get a green suite. The tests that need a browser
 * skip with an explicit reason rather than failing, and rather than silently
 * passing: a skipped test that says why is information, a hidden one is not.
 */

import { loadPlaywright, launchBrowser } from '../../src/index.js';

/**
 * Tries to load Playwright and open a browser.
 *
 * Launching is part of the check because "installed" and "usable" are different
 * states: the package can be present with no browser binary downloaded, which is
 * the most common half-installed state there is.
 *
 * @returns {Promise<{available: boolean, reason: string, playwright: any}>} Availability.
 */
export async function browserAvailability() {
  let playwright;
  try {
    playwright = await loadPlaywright();
  } catch {
    return {
      available: false,
      reason: 'playwright is not installed (npm install --save-dev playwright && npx playwright install chromium)',
      playwright: null,
    };
  }
  try {
    const browser = await launchBrowser({ playwright, browser: { headless: true, launchArgs: [] } });
    await browser.close();
    return { available: true, reason: '', playwright };
  } catch (cause) {
    return {
      available: false,
      reason: `no browser could be launched: ${cause instanceof Error ? cause.message.split('\n')[0] : cause}`,
      playwright: null,
    };
  }
}
