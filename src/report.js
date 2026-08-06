/**
 * Turning a run into something a human reads in five seconds, or a machine parses.
 *
 * The console report is written for the two moments that actually happen: a
 * developer glancing at a terminal, and somebody opening a failed CI job three
 * days later with no context. Both need the verdict first, the failures second,
 * and the totals last, which is the opposite of the order the data arrives in.
 *
 * The machine-readable output is the evidence file itself rather than a separate
 * report format. One shape, one schema, one thing to document.
 */

/**
 * Process exit codes.
 *
 * Split three ways so that a pipeline can tell "the app is broken" from "the
 * command was wrong" from "this machine cannot run browsers". Collapsing them
 * makes a red build ambiguous, and an ambiguous red build gets retried rather
 * than read.
 */
export const EXIT_CODES = Object.freeze({
  PASS: 0,
  FAILED: 1,
  USAGE: 2,
  ENVIRONMENT: 3,
});

/** ANSI codes, applied only when the output is a terminal that wants them. */
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
};

/**
 * Builds a styling function that becomes a no-op when colour is unwanted.
 *
 * Honours the NO_COLOR convention, because a report full of escape codes in a
 * log aggregator is worse than a plain one.
 *
 * @param {boolean} enabled Whether to emit colour.
 * @returns {(text: string, ...styles: (keyof typeof ANSI)[]) => string} Styler.
 */
export function createStyler(enabled) {
  return (text, ...styles) => {
    if (!enabled || styles.length === 0) return text;
    return styles.map((style) => ANSI[style]).join('') + text + ANSI.reset;
  };
}

/**
 * Whether colour should be used for a stream.
 *
 * @param {NodeJS.WriteStream} stream Output stream.
 * @param {Record<string, string|undefined>} [env] Environment.
 * @returns {boolean} True when colour is appropriate.
 */
export function shouldUseColor(stream, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

/**
 * Maps a finished run to an exit code.
 *
 * @param {object} evidence Evidence object.
 * @returns {number} Exit code.
 */
export function exitCodeForRun(evidence) {
  return evidence.summary.result === 'pass' ? EXIT_CODES.PASS : EXIT_CODES.FAILED;
}

/**
 * Renders the console report for a finished run.
 *
 * @param {object} evidence Evidence object.
 * @param {object} [options] Rendering options.
 * @param {boolean} [options.color] Emit ANSI colour.
 * @param {number} [options.maxFailures] Cap on individually listed failures.
 * @param {string|null} [options.evidencePath] Where evidence was written.
 * @returns {string} Report text.
 */
export function formatRunReport(evidence, { color = false, maxFailures = 25, evidencePath = null } = {}) {
  const style = createStyler(color);
  const passed = evidence.summary.result === 'pass';
  const lines = [];
  const rule = '-'.repeat(72);

  lines.push('');
  lines.push(rule);
  lines.push(
    `${style('deep-smoke', 'bold')} level ${evidence.level} (${levelName(evidence.level)})  ${
      passed ? style('PASS', 'green', 'bold') : style('FAIL', 'red', 'bold')
    }`,
  );
  lines.push(`target      ${evidence.target.baseUrl}`);
  lines.push(
    `personas    ${evidence.personas
      .map((persona) => `${persona.id}${persona.authenticated ? ' (signed in)' : ''}`)
      .join(', ')}`,
  );
  lines.push(
    `routes      ${evidence.summary.routesVisited} visited, ${evidence.summary.routesFailed} failed` +
      (evidence.summary.routesFlaky > 0 ? `, ${evidence.summary.routesFlaky} passed only on retry` : ''),
  );
  if (evidence.summary.invariantsChecked > 0) {
    lines.push(
      `auth rules  ${evidence.summary.invariantsChecked} checked, ${evidence.summary.invariantsViolated} violated`,
    );
  }
  lines.push(`duration    ${formatDuration(evidence.durationMs)}`);
  if (evidence.vcs?.commit) {
    lines.push(`commit      ${evidence.vcs.commit.slice(0, 12)}${evidence.vcs.dirty ? style(' (working tree not clean)', 'dim') : ''}`);
  }
  if (evidencePath) lines.push(`evidence    ${evidencePath}`);

  if (evidence.coverage?.truncated) {
    lines.push('');
    lines.push(style('Coverage was truncated:', 'yellow'));
    for (const reason of evidence.coverage.truncationReasons ?? []) lines.push(`  ${reason}`);
    lines.push(style('  Raise maxRoutes or budgetMs. Level 3 rejects truncated evidence.', 'dim'));
  }

  for (const persona of evidence.personas) {
    if (!persona.error) continue;
    lines.push('');
    lines.push(`${style('persona error', 'red')} [${persona.id}] ${persona.error}`);
  }

  const failures = evidence.results.filter((result) => !result.ok);
  if (failures.length > 0) {
    lines.push('');
    lines.push(style(`Failing routes (${failures.length}):`, 'bold'));
    for (const failure of failures.slice(0, maxFailures)) {
      lines.push(`  ${style('x', 'red')} [${failure.persona}] ${failure.route}`);
      for (const detail of failure.failures) {
        lines.push(`      ${detail.check}: ${detail.message}`);
      }
      if (failure.finalPath !== failure.requestedPath) {
        lines.push(style(`      redirected to ${failure.finalPath}`, 'dim'));
      }
    }
    if (failures.length > maxFailures) {
      lines.push(style(`  ... and ${failures.length - maxFailures} more (see the evidence file)`, 'dim'));
    }
  }

  const violations = evidence.invariants.filter((invariant) => !invariant.ok);
  if (violations.length > 0) {
    lines.push('');
    lines.push(style(`Authentication rule violations (${violations.length}):`, 'bold'));
    for (const violation of violations) {
      lines.push(`  ${style('x', 'red')} [${violation.persona}] ${violation.message}`);
    }
  }

  lines.push(rule);
  lines.push('');
  return lines.join('\n');
}

/**
 * Renders the console report for a verification.
 *
 * @param {object} verification Output of `verifyEvidence`.
 * @param {object} options Rendering options.
 * @param {number} options.level Required level.
 * @param {boolean} [options.color] Emit ANSI colour.
 * @param {string} [options.evidenceDir] Directory that was searched.
 * @returns {string} Report text.
 */
export function formatVerifyReport(verification, { level, color = false, evidenceDir = '' }) {
  const style = createStyler(color);
  const lines = [];

  if (verification.ok && verification.accepted) {
    const { evidence, file, warnings } = verification.accepted;
    lines.push(
      `${style('deep-smoke verify', 'bold')} ${style('PASS', 'green', 'bold')}  level ${evidence.level} evidence accepted for ${
        verification.tip ? verification.tip.slice(0, 12) : 'this working copy'
      }`,
    );
    lines.push(`  file      ${file}`);
    lines.push(`  routes    ${evidence.summary.routesVisited} visited, 0 failed`);
    lines.push(`  personas  ${evidence.personas.map((persona) => persona.id).join(', ')}`);
    for (const warning of warnings) lines.push(style(`  warning   ${warning}`, 'yellow'));
    return lines.join('\n');
  }

  lines.push(`${style('deep-smoke verify', 'bold')} ${style('FAIL', 'red', 'bold')}  no valid level ${level} evidence for ${
    verification.tip ? verification.tip.slice(0, 12) : 'this working copy'
  }`);
  if (verification.candidates.length === 0) {
    lines.push(`  No evidence files found${evidenceDir ? ` in ${evidenceDir}` : ''}.`);
  } else {
    lines.push(`  Examined ${verification.candidates.length} file(s):`);
    for (const candidate of verification.candidates) {
      lines.push(`    ${candidate.file}`);
      for (const reason of candidate.reasons) lines.push(`      ${reason}`);
    }
  }
  lines.push('');
  lines.push(`  Fix: deep-smoke --level=${level} --url=<base-url>`);
  return lines.join('\n');
}

/**
 * Human-readable duration.
 *
 * @param {number} ms Milliseconds.
 * @returns {string} For example `1m 04s` or `820ms`.
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

/**
 * Name of a level, for the report header.
 *
 * @param {number} level Level id.
 * @returns {string} Short name.
 */
function levelName(level) {
  return { 1: 'quick', 2: 'feature', 3: 'gate' }[level] ?? 'custom';
}
