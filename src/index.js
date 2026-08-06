/**
 * Public entry point.
 *
 * The command line is the primary interface, but everything it does is a thin
 * wrapper around these exports, so a project with an unusual pipeline can drive
 * a crawl from its own script without shelling out and parsing text.
 *
 * @example
 * import { loadConfig, loadPersonas, runSmoke, buildEvidence } from 'deep-smoke';
 *
 * const { config } = loadConfig({ overrides: { baseUrl: 'http://localhost:4173' } });
 * const { personas } = loadPersonas({ source: config.personas });
 * const evidence = buildEvidence(await runSmoke({ config, personas, level: 2 }));
 * if (evidence.result !== 'pass') process.exitCode = 1;
 */

import fs from 'node:fs';

/** Version of this package, read from its own manifest so it cannot drift. */
export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export { ConfigError, EnvironmentError, exitCodeFor } from './errors.js';
export {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  PERSONAS_FILENAME,
  loadConfig,
  normaliseBaseUrl,
  validateConfig,
} from './config.js';
export { ANONYMOUS_PERSONA, describePersona, loadPersonas, normalisePersona } from './personas.js';
export { LEVELS, buildPlan, resolveLevel, selectPersonas, unknownRouteProbeFor } from './levels.js';
export {
  CHECKS,
  checkAuthInvariant,
  classifyConsoleMessage,
  classifyResponse,
  evaluateRoute,
  isBlankScreen,
  isErrorBoundary,
} from './assertions.js';
export { collectLinks, crawlPersona, normaliseRoute, runSmoke, visitRoute } from './crawler.js';
export { loadPlaywright, launchBrowser } from './browser.js';
export {
  EVIDENCE_SCHEMA_VERSION,
  buildEvidence,
  createGitAdapter,
  evidenceFileName,
  listEvidenceFiles,
  readEvidence,
  readVcsInfo,
  summarise,
  validateEvidenceShape,
  writeEvidence,
} from './evidence.js';
export { assessEvidence, behaviourChangedBetween, checkFreshness, verifyEvidence } from './verify.js';
export {
  EXIT_CODES,
  createStyler,
  exitCodeForRun,
  formatDuration,
  formatRunReport,
  formatVerifyReport,
  shouldUseColor,
} from './report.js';
export { applyAuth, contextOptionsFor, resolveSecret, validateAuthConfig } from './auth/index.js';
