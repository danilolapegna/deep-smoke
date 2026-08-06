/**
 * Verifying evidence: is there a passing crawl for the code in front of me?
 *
 * This is the half of the tool that makes the other half worth wiring into a
 * pipeline. A crawl proves something about a specific version of an app at a
 * specific moment; without a way to tie that proof to the commit being shipped,
 * a green result decays silently into a green sticker.
 *
 * The freshness rule is deliberately simple to state, because a rule people
 * cannot state is a rule they cannot trust: evidence is valid for the commit it
 * was produced from, or for a later commit that changed nothing which could
 * affect behaviour. Editing a README does not invalidate a crawl. Touching a
 * component does.
 *
 * What this cannot do is also worth stating plainly. Nothing here proves a
 * browser ever ran. The guarantee is narrower and still useful: evidence must be
 * internally consistent, must be bound to a real commit in this repository's
 * history, and must not have been overtaken by changes to the code. Forging that
 * is possible, but it is no longer a five-second edit, and it can no longer
 * happen by accident, which is how it usually happens.
 */

import path from 'node:path';
import {
  createGitAdapter,
  listEvidenceFiles,
  readEvidence,
  summarise,
  validateEvidenceShape,
} from './evidence.js';

/**
 * Decides whether behaviour-relevant files changed between two commits.
 *
 * Every uncertain answer is "yes, it changed". A crawler that resolves doubt in
 * favour of accepting stale evidence is worse than no crawler, because it
 * reports coverage that does not exist; the cost of the opposite mistake is one
 * more crawl.
 *
 * @param {object} input Comparison input.
 * @param {string} input.from Commit the evidence was produced at.
 * @param {string} input.to Commit being verified.
 * @param {string[]} input.behaviourPaths Paths whose contents change runtime behaviour.
 * @param {ReturnType<typeof createGitAdapter>} input.git Git adapter.
 * @returns {{changed: boolean, reason: string|null, files: string[]}} Verdict plus the evidence for it.
 */
export function behaviourChangedBetween({ from, to, behaviourPaths, git }) {
  if (!from || from === to) return { changed: false, reason: null, files: [] };
  if (!git.available) {
    return { changed: true, reason: 'not a git repository, so the range cannot be examined', files: [] };
  }
  if (git.run(['rev-parse', '--is-shallow-repository']) === 'true') {
    return {
      changed: true,
      reason: 'shallow clone: the history needed to compare these commits is not present (fetch with full depth)',
      files: [],
    };
  }
  const known = git.tryRun(['cat-file', '-e', `${from}^{commit}`]);
  if (!known.ok) {
    return { changed: true, reason: `commit ${short(from)} is not in this repository`, files: [] };
  }
  const ancestor = git.tryRun(['merge-base', '--is-ancestor', from, to]);
  if (!ancestor.ok) {
    return {
      changed: true,
      reason: `commit ${short(from)} is not an ancestor of ${short(to)}, so the evidence describes a different branch state`,
      files: [],
    };
  }
  const diff = git.tryRun(['diff', '--name-only', from, to, '--', ...behaviourPaths]);
  if (!diff.ok) {
    return { changed: true, reason: 'git diff failed, so the range cannot be trusted', files: [] };
  }
  const files = diff.out.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    changed: files.length > 0,
    reason: files.length > 0 ? `behaviour changed since ${short(from)}` : null,
    files,
  };
}

/**
 * Applies the freshness rule to one piece of evidence.
 *
 * @param {object} input Freshness input.
 * @param {object} input.evidence Evidence object.
 * @param {string|null} input.tip Commit being verified, null outside a repository.
 * @param {string[]} input.behaviourPaths Paths whose contents change runtime behaviour.
 * @param {ReturnType<typeof createGitAdapter>} input.git Git adapter.
 * @param {number} input.maxAgeMinutes Age limit used only when there is no commit to bind to.
 * @param {boolean} [input.allowUnversioned] Accept evidence with no commit inside a repository.
 * @param {Date} [input.now] Clock, injectable for tests.
 * @returns {{fresh: boolean, reasons: string[], warnings: string[]}} Verdict.
 */
export function checkFreshness({ evidence, tip, behaviourPaths, git, maxAgeMinutes, allowUnversioned = false, now = new Date() }) {
  const reasons = [];
  const warnings = [];
  const commit = evidence?.vcs?.commit ?? null;

  if (commit && !/^[0-9a-f]{7,40}$/i.test(commit)) {
    return { fresh: false, reasons: [`"vcs.commit" is not a commit hash: ${commit}`], warnings };
  }

  if (!commit) {
    // Evidence with no commit can only be bounded by age. Inside a repository
    // that is a downgrade nobody asked for, so it has to be requested explicitly.
    if (git.available && !allowUnversioned) {
      reasons.push(
        'evidence records no commit, but this is a git repository. ' +
          'Re-run the crawl here so the evidence is bound to a commit, or pass --allow-unversioned to accept an age check instead.',
      );
      return { fresh: false, reasons, warnings };
    }
    const ageMinutes = (now.getTime() - Date.parse(evidence.createdAt)) / 60_000;
    if (Number.isNaN(ageMinutes)) {
      reasons.push('evidence has no commit and no readable timestamp, so its age cannot be checked');
      return { fresh: false, reasons, warnings };
    }
    if (ageMinutes > maxAgeMinutes) {
      reasons.push(`evidence has no commit and is ${Math.round(ageMinutes)} minutes old (limit ${maxAgeMinutes})`);
      return { fresh: false, reasons, warnings };
    }
    warnings.push(
      `accepted on age alone (${Math.round(ageMinutes)} minutes old): without version control, evidence cannot be tied to code.`,
    );
    return { fresh: true, reasons, warnings };
  }

  if (!tip) {
    reasons.push('evidence is bound to a commit, but the current directory is not a git repository');
    return { fresh: false, reasons, warnings };
  }

  const comparison = behaviourChangedBetween({ from: commit, to: tip, behaviourPaths, git });
  if (comparison.changed) {
    const detail = comparison.files.length > 0 ? `: ${comparison.files.slice(0, 5).join(', ')}${comparison.files.length > 5 ? ', ...' : ''}` : '';
    reasons.push(`${comparison.reason}${detail}. Re-run the crawl.`);
    return { fresh: false, reasons, warnings };
  }
  if (evidence.vcs?.dirty) {
    warnings.push('the working tree was not clean when this crawl ran');
  }
  return { fresh: true, reasons, warnings };
}

/**
 * Judges one piece of evidence against a required level.
 *
 * Totals are recomputed from the per-route results here rather than read from
 * the file, so a stored total that disagrees with its own detail is caught as a
 * contradiction instead of being believed.
 *
 * @param {object} input Assessment input.
 * @param {object} input.evidence Evidence object.
 * @param {number} input.level Required level.
 * @param {string|null} input.tip Commit being verified.
 * @param {ReturnType<typeof createGitAdapter>} input.git Git adapter.
 * @param {string[]} input.behaviourPaths Paths whose contents change runtime behaviour.
 * @param {number} input.maxAgeMinutes Age limit for evidence with no commit.
 * @param {string[]} [input.expectedPersonas] Personas declared by the current config.
 * @param {boolean} [input.allowUnversioned] Accept evidence with no commit.
 * @param {Date} [input.now] Clock, injectable for tests.
 * @returns {{ok: boolean, reasons: string[], warnings: string[]}} Verdict.
 */
export function assessEvidence({
  evidence,
  level,
  tip,
  git,
  behaviourPaths,
  maxAgeMinutes,
  expectedPersonas = [],
  allowUnversioned = false,
  now = new Date(),
}) {
  const reasons = [];
  const warnings = [];

  const shapeProblems = validateEvidenceShape(evidence);
  if (shapeProblems.length > 0) {
    return { ok: false, reasons: shapeProblems, warnings };
  }

  if (evidence.level < level) {
    reasons.push(`level ${evidence.level} is below the required level ${level}`);
  }

  const derived = summarise({
    results: evidence.results,
    invariants: evidence.invariants,
    personas: evidence.personas,
  });
  if (derived.result !== 'pass') {
    const parts = [];
    if (derived.routesFailed > 0) parts.push(`${derived.routesFailed} failing route(s)`);
    if (derived.invariantsViolated > 0) parts.push(`${derived.invariantsViolated} violated invariant(s)`);
    if (derived.personaErrors.length > 0) parts.push(`${derived.personaErrors.length} persona error(s)`);
    reasons.push(`the run did not pass: ${parts.join(', ')}`);
  }
  if (evidence.summary && evidence.summary.routesFailed !== derived.routesFailed) {
    reasons.push(
      `stored summary disagrees with the results it summarises (says ${evidence.summary.routesFailed} failing, results show ${derived.routesFailed})`,
    );
  }
  if (derived.routesVisited < 1) {
    reasons.push('no routes were visited');
  }
  if (evidence.personas.length === 0) {
    reasons.push('no personas were recorded');
  }

  if (level >= 3) {
    if (evidence.scoped) {
      reasons.push('this run was scoped with --only, which cannot support a level 3 claim about the whole route tree');
    }
    if (evidence.coverage?.truncated) {
      const detail = (evidence.coverage.truncationReasons ?? []).join('; ');
      reasons.push(`the crawl was truncated${detail ? ` (${detail})` : ''}, so it did not cover the whole route tree`);
    }
    const covered = new Set(evidence.personas.map((persona) => persona.id));
    const missing = expectedPersonas.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      reasons.push(`declared persona(s) not covered: ${missing.join(', ')}`);
    }
  }

  const freshness = checkFreshness({ evidence, tip, behaviourPaths, git, maxAgeMinutes, allowUnversioned, now });
  reasons.push(...freshness.reasons);
  warnings.push(...freshness.warnings);

  return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * Finds and judges evidence for the current commit.
 *
 * Every rejected candidate is reported with its reason. The most common support
 * question a gate produces is "why is it asking me to run this again", and a
 * verifier that answers only "no valid evidence" guarantees that question gets
 * asked every time.
 *
 * @param {object} input Verification input.
 * @param {number} input.level Required level.
 * @param {Record<string, any>} input.config Loaded config.
 * @param {string} [input.file] Explicit evidence file to judge.
 * @param {string} [input.cwd] Repository directory.
 * @param {string} [input.tip] Commit to verify against, defaults to HEAD.
 * @param {string[]} [input.expectedPersonas] Personas declared by the current config.
 * @param {boolean} [input.allowUnversioned] Accept evidence with no commit.
 * @param {Date} [input.now] Clock, injectable for tests.
 * @returns {{ok: boolean, accepted: {file: string, evidence: object, warnings: string[]}|null, candidates: {file: string, ok: boolean, reasons: string[], warnings: string[]}[], tip: string|null}} Verdict.
 */
export function verifyEvidence({
  level,
  config,
  file,
  cwd = process.cwd(),
  tip,
  expectedPersonas = [],
  allowUnversioned = false,
  now = new Date(),
}) {
  const git = createGitAdapter(cwd);
  const resolvedTip = tip ?? (git.available ? git.run(['rev-parse', 'HEAD']) : null);
  const behaviourPaths = config.freshness.behaviourPaths;
  const maxAgeMinutes = config.freshness.maxAgeMinutes;

  const files = file
    ? [path.resolve(cwd, file)]
    : listEvidenceFiles(path.resolve(cwd, config.evidence.dir));

  const candidates = [];
  let accepted = null;

  for (const candidateFile of files) {
    let evidence;
    try {
      evidence = readEvidence(candidateFile);
    } catch (cause) {
      candidates.push({
        file: candidateFile,
        ok: false,
        reasons: [/** @type {Error} */ (cause).message.split('\n').slice(1).join(' ').trim() || 'unreadable evidence file'],
        warnings: [],
      });
      continue;
    }
    const verdict = assessEvidence({
      evidence,
      level,
      tip: resolvedTip,
      git,
      behaviourPaths,
      maxAgeMinutes,
      expectedPersonas,
      allowUnversioned,
      now,
    });
    candidates.push({ file: candidateFile, ...verdict });
    if (verdict.ok && !accepted) {
      accepted = { file: candidateFile, evidence, warnings: verdict.warnings };
    }
  }

  return { ok: Boolean(accepted), accepted, candidates, tip: resolvedTip };
}

/**
 * Shortens a commit hash for messages.
 *
 * @param {string} commit Full or partial hash.
 * @returns {string} First eight characters.
 */
function short(commit) {
  return String(commit).slice(0, 8);
}
