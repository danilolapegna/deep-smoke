/**
 * Error types that carry an exit code.
 *
 * A crawler has three genuinely different ways to not-pass, and collapsing them
 * into a single non-zero exit makes CI unusable: a broken page must block a
 * merge, a typo in a flag must not look like a broken page, and a missing
 * browser must be distinguishable from both so an operator knows to fix the
 * machine rather than the app. Every error thrown by this package therefore
 * declares which of those it is, and the CLI maps it straight to `process.exit`.
 */

/**
 * Bad input: an unknown flag, an unparseable config file, a persona missing a
 * required field. The user can fix this without touching the app under test.
 *
 * Exits with code 2.
 */
export class ConfigError extends Error {
  /** @param {string} message Actionable description, including the offending value. */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = 2;
  }
}

/**
 * The machine cannot run the crawl: Playwright is not installed, no browser
 * binary is available, the target is unreachable.
 *
 * Kept separate from `ConfigError` because CI should treat it as
 * infrastructure-red rather than as a failing test: exiting 1 here would report
 * a healthy app as broken, which is the fastest way to teach a team to ignore
 * the tool.
 *
 * Exits with code 3.
 */
export class EnvironmentError extends Error {
  /**
   * @param {string} message Actionable description.
   * @param {{cause?: unknown}} [options] Original error, preserved for `--verbose`.
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'EnvironmentError';
    this.exitCode = 3;
  }
}

/**
 * Reads the exit code an error asks for, defaulting to 3.
 *
 * An unexpected exception is closer to "the machine is wrong" than to "the app
 * is wrong": we would rather send an operator to look at the harness than
 * silently fail a pull request on a bug in this package.
 *
 * @param {unknown} error Anything thrown.
 * @returns {number} Process exit code.
 */
export function exitCodeFor(error) {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'exitCode') : undefined;
  return typeof code === 'number' ? code : 3;
}
