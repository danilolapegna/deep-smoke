/**
 * The evidence file: what a run proved, in a form another program can check.
 *
 * A crawl is worth something to the person watching it run and almost nothing to
 * anyone else, because the interesting claim ("every route rendered for every
 * persona") is unfalsifiable once the terminal is closed. The evidence file
 * turns that claim into an artefact with a scope and an expiry date: which
 * routes, which personas, at which commit.
 *
 * Two properties are load-bearing and should survive any future change to this
 * format. Totals are always derived from the per-route results and never stored
 * as an independent source of truth, so an edited total contradicts itself.
 * And the commit is recorded, so `verify` can decide whether the evidence still
 * describes the code in front of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConfigError } from './errors.js';

/** Bumped when the shape changes in a way that older readers cannot handle. */
export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * Creates a small git adapter, or a null one outside a repository.
 *
 * Injectable rather than called inline so that freshness logic can be tested
 * against scripted histories instead of against whatever the test runner's
 * working copy happens to look like.
 *
 * @param {string} cwd Directory to run git in.
 * @returns {{available: boolean, run(args: string[]): string|null, tryRun(args: string[]): {ok: boolean, out: string}}} Adapter.
 */
export function createGitAdapter(cwd = process.cwd()) {
  /**
   * @param {string[]} args Git arguments.
   * @returns {{ok: boolean, out: string}} Result, with failure distinguished from empty output.
   */
  const tryRun = (args) => {
    try {
      const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, out: out.trim() };
    } catch {
      return { ok: false, out: '' };
    }
  };
  const available = tryRun(['rev-parse', '--git-dir']).ok;
  return {
    available,
    run: (args) => {
      const result = tryRun(args);
      return result.ok ? result.out : null;
    },
    tryRun,
  };
}

/**
 * Reads the provenance of the working copy.
 *
 * `dirty` is recorded but never used to reject evidence. Refusing to accept a
 * crawl of a working tree with an unrelated file open would make the tool
 * unusable during development, while knowing about it afterwards is genuinely
 * useful when a result looks impossible.
 *
 * @param {ReturnType<typeof createGitAdapter>} git Git adapter.
 * @returns {{kind: 'git'|'none', commit: string|null, branch: string|null, dirty: boolean|null}} Provenance.
 */
export function readVcsInfo(git) {
  if (!git.available) return { kind: 'none', commit: null, branch: null, dirty: null };
  const commit = git.run(['rev-parse', 'HEAD']);
  const branch = git.run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git.tryRun(['status', '--porcelain']);
  return {
    kind: 'git',
    commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null,
    branch: branch || null,
    dirty: status.ok ? status.out.length > 0 : null,
  };
}

/**
 * Derives the totals of a run from its per-route results.
 *
 * The single most important function in the anti-cheat story, because it is
 * called twice: once when writing evidence and once when verifying it. Nothing
 * downstream ever trusts a stored total, so hand-editing one changes nothing.
 *
 * @param {{results: any[], invariants: any[], personas: any[]}} parts Run parts.
 * @returns {{routesVisited: number, routesFailed: number, routesFlaky: number, invariantsChecked: number, invariantsViolated: number, personasCovered: string[], personaErrors: {persona: string, message: string}[], result: 'pass'|'fail'}} Derived summary.
 */
export function summarise({ results, invariants, personas }) {
  const routesFailed = results.filter((result) => result.ok === false).length;
  const invariantsViolated = invariants.filter((invariant) => invariant.ok === false).length;
  const personaErrors = personas
    .filter((persona) => persona.error)
    .map((persona) => ({ persona: persona.id, message: persona.error }));
  return {
    routesVisited: results.length,
    routesFailed,
    routesFlaky: results.filter((result) => result.flaky === true).length,
    invariantsChecked: invariants.length,
    invariantsViolated,
    personasCovered: personas.map((persona) => persona.id),
    personaErrors,
    result: routesFailed === 0 && invariantsViolated === 0 && personaErrors.length === 0 ? 'pass' : 'fail',
  };
}

/**
 * Assembles the evidence object for a finished run.
 *
 * The declared configuration is copied in, not just the results, because half of
 * reading old evidence is working out what it was allowed to look at: a green
 * level 3 that ignored half the app is a different claim from one that did not.
 *
 * @param {object} runResult Output of `runSmoke`.
 * @param {object} [options] Assembly options.
 * @param {{kind: string, commit: string|null, branch: string|null, dirty: boolean|null}} [options.vcs] Provenance.
 * @param {string} [options.toolVersion] Version of this package.
 * @returns {object} Evidence object.
 */
export function buildEvidence(runResult, { vcs = { kind: 'none', commit: null, branch: null, dirty: null }, toolVersion = 'unknown' } = {}) {
  const { plan, personaReports, startedAt, durationMs, baseUrl, config } = runResult;
  const results = personaReports.flatMap((report) => report.results);
  const invariants = personaReports.flatMap((report) => report.invariants);
  const personas = personaReports.map((report) => ({
    id: report.persona.id,
    label: report.persona.label,
    authenticated: report.persona.authenticated,
    authStrategy: report.persona.authStrategy,
    authDetail: report.persona.authDetail,
    routesVisited: report.results.length,
    routesFailed: report.results.filter((result) => result.ok === false).length,
    truncated: report.truncated,
    truncationReason: report.truncationReason,
    error: report.error,
  }));

  const summary = summarise({ results, invariants, personas });

  return {
    tool: 'deep-smoke',
    toolVersion,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    level: plan.level,
    scoped: plan.scoped,
    createdAt: startedAt.toISOString(),
    durationMs,
    vcs,
    target: { baseUrl },
    declared: {
      routes: config.routes,
      ignoreRoutes: config.ignoreRoutes,
      protectedPrefixes: config.protectedPrefixes,
      publicRoutes: config.publicRoutes,
      checks: config.checks,
      maxRoutes: config.maxRoutes,
      budgetMs: config.budgetMs,
      behaviourPaths: config.freshness.behaviourPaths,
    },
    personas,
    results,
    invariants,
    coverage: {
      truncated: personas.some((persona) => persona.truncated),
      truncationReasons: personas.filter((persona) => persona.truncated).map((persona) => `${persona.id}: ${persona.truncationReason}`),
      authInvariantsChecked: plan.requireAuthInvariants,
    },
    summary,
    result: summary.result,
  };
}

/**
 * Default file name for a piece of evidence.
 *
 * The commit is in the name so that several runs can coexist in one directory
 * and `verify` can pick the right one without opening all of them, and so that
 * a stale file is visibly stale in a directory listing.
 *
 * @param {object} evidence Evidence object.
 * @returns {string} File name.
 */
export function evidenceFileName(evidence) {
  const stamp = evidence.vcs?.commit
    ? evidence.vcs.commit.slice(0, 12)
    : new Date(evidence.createdAt).toISOString().replace(/[:.]/g, '-');
  return `L${evidence.level}-${stamp}.json`;
}

/**
 * Writes evidence to disk, creating the directory if needed.
 *
 * @param {object} evidence Evidence object.
 * @param {object} options Write options.
 * @param {string} options.dir Directory to write into.
 * @param {string} [options.file] Explicit file path, overriding the generated name.
 * @param {string} [options.cwd] Directory to resolve relative paths against.
 * @returns {string} Absolute path written.
 */
export function writeEvidence(evidence, { dir, file, cwd = process.cwd() }) {
  const target = file ? path.resolve(cwd, file) : path.resolve(cwd, dir, evidenceFileName(evidence));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Lists candidate evidence files in a directory, newest first.
 *
 * @param {string} dir Evidence directory.
 * @returns {string[]} Absolute paths, most recently modified first.
 */
export function listEvidenceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * Reads and shape-checks an evidence file.
 *
 * @param {string} file Path to an evidence file.
 * @returns {object} Parsed evidence.
 * @throws {ConfigError} If the file is missing, malformed or not evidence.
 */
export function readEvidence(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`Cannot read evidence file ${file}: ${/** @type {Error} */ (cause).message}`);
  }
  const problems = validateEvidenceShape(parsed);
  if (problems.length > 0) {
    throw new ConfigError(`Not a valid deep-smoke evidence file: ${file}\n  ${problems.join('\n  ')}`);
  }
  return parsed;
}

/**
 * Lists everything structurally wrong with an evidence object.
 *
 * Returns a list rather than throwing on the first problem, because `verify`
 * reports on several candidate files at once and a reader comparing them needs
 * all the reasons, not the first one from each.
 *
 * @param {unknown} evidence Candidate evidence.
 * @returns {string[]} Problems, empty when the shape is valid.
 */
export function validateEvidenceShape(evidence) {
  const problems = [];
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['file does not contain a JSON object'];
  }
  const candidate = /** @type {Record<string, any>} */ (evidence);
  if (candidate.tool !== 'deep-smoke') problems.push('missing "tool": "deep-smoke"');
  if (typeof candidate.schemaVersion !== 'number') problems.push('missing numeric "schemaVersion"');
  if (![1, 2, 3].includes(candidate.level)) problems.push('"level" must be 1, 2 or 3');
  if (typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) {
    problems.push('"createdAt" must be an ISO timestamp');
  }
  if (!Array.isArray(candidate.results)) problems.push('"results" must be an array');
  if (!Array.isArray(candidate.invariants)) problems.push('"invariants" must be an array');
  if (!Array.isArray(candidate.personas)) problems.push('"personas" must be an array');
  if (Array.isArray(candidate.results)) {
    const malformed = candidate.results.findIndex(
      (result) => typeof result?.route !== 'string' || typeof result?.ok !== 'boolean',
    );
    if (malformed !== -1) problems.push(`results[${malformed}] must have a string "route" and a boolean "ok"`);
  }
  return problems;
}
