import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../src/config.js';
import { buildEvidence, writeEvidence } from '../src/evidence.js';
import { assessEvidence, behaviourChangedBetween, checkFreshness, verifyEvidence } from '../src/verify.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

let workspace;

/**
 * A scripted git repository, so freshness can be tested against a known history
 * instead of against whatever the working copy happens to contain.
 *
 * @param {object} [script] History description.
 * @returns {{available: boolean, run: Function, tryRun: Function}} Adapter.
 */
function fakeGit({ available = true, head = NEW, known = [OLD, NEW], ancestors = { [OLD]: [NEW] }, changed = {}, shallow = false, diffFails = false } = {}) {
  const tryRun = (args) => {
    const [command] = args;
    if (command === 'rev-parse' && args[1] === 'HEAD') return { ok: true, out: head };
    if (command === 'rev-parse' && args[1] === '--is-shallow-repository') return { ok: true, out: shallow ? 'true' : 'false' };
    if (command === 'rev-parse' && args[1] === '--git-dir') return { ok: available, out: '.git' };
    if (command === 'cat-file') {
      const commit = String(args[2]).replace('^{commit}', '');
      return { ok: known.includes(commit), out: '' };
    }
    if (command === 'merge-base') {
      const [, , from, to] = args;
      return { ok: (ancestors[from] ?? []).includes(to), out: '' };
    }
    if (command === 'diff') {
      if (diffFails) return { ok: false, out: '' };
      const [, , from, to] = args;
      return { ok: true, out: (changed[`${from}..${to}`] ?? []).join('\n') };
    }
    return { ok: false, out: '' };
  };
  return { available, tryRun, run: (args) => (tryRun(args).ok ? tryRun(args).out : null) };
}

/**
 * Evidence for a clean level 3 run at a given commit.
 *
 * @param {object} [options] Shape controls.
 * @returns {object} Evidence.
 */
function evidenceAt({ commit = OLD, level = 3, failing = 0, truncated = false, scoped = false, personas = ['anonymous'], createdAt } = {}) {
  const results = personas.flatMap((persona) => [
    { persona, route: '/', requestedPath: '/', finalPath: '/', ok: true, flaky: false, durationMs: 5, failures: [] },
  ]);
  for (let index = 0; index < failing; index += 1) {
    results.push({ persona: personas[0], route: `/bad-${index}`, requestedPath: `/bad-${index}`, finalPath: `/bad-${index}`, ok: false, flaky: false, durationMs: 5, failures: [{ check: 'blank-screen', message: 'blank' }] });
  }
  const evidence = buildEvidence(
    {
      plan: { level, scoped, requireAuthInvariants: level === 3 },
      personaReports: personas.map((persona) => ({
        persona: { id: persona, label: persona, authenticated: persona !== 'anonymous', authStrategy: 'none', authDetail: 'anonymous' },
        results: results.filter((result) => result.persona === persona),
        invariants: [],
        truncated,
        truncationReason: truncated ? 'route budget reached' : null,
        error: null,
      })),
      startedAt: createdAt ? new Date(createdAt) : new Date(),
      durationMs: 100,
      baseUrl: 'http://localhost:4173',
      config: structuredClone(DEFAULT_CONFIG),
    },
    { vcs: commit ? { kind: 'git', commit, branch: 'main', dirty: false } : { kind: 'none', commit: null, branch: null, dirty: null } },
  );
  return evidence;
}

const FRESHNESS = { behaviourPaths: DEFAULT_CONFIG.freshness.behaviourPaths, maxAgeMinutes: 120 };

describe('behaviourChangedBetween', () => {
  it('says nothing changed when the commits are the same', () => {
    const result = behaviourChangedBetween({ from: NEW, to: NEW, behaviourPaths: ['src'], git: fakeGit() });
    assert.equal(result.changed, false);
  });

  it('accepts a later commit that only touched documentation', () => {
    const git = fakeGit({ changed: { [`${OLD}..${NEW}`]: [] } });
    assert.equal(behaviourChangedBetween({ from: OLD, to: NEW, behaviourPaths: ['src'], git }).changed, false);
  });

  it('rejects a later commit that touched source', () => {
    const git = fakeGit({ changed: { [`${OLD}..${NEW}`]: ['src/checkout.jsx'] } });
    const result = behaviourChangedBetween({ from: OLD, to: NEW, behaviourPaths: ['src'], git });
    assert.equal(result.changed, true);
    assert.deepEqual(result.files, ['src/checkout.jsx']);
  });

  it('fails closed on a shallow clone, where the range cannot be examined', () => {
    const git = fakeGit({ shallow: true });
    assert.match(behaviourChangedBetween({ from: OLD, to: NEW, behaviourPaths: ['src'], git }).reason, /shallow/);
  });

  it('fails closed when the evidence commit is not in this repository', () => {
    const git = fakeGit({ known: [NEW] });
    assert.match(behaviourChangedBetween({ from: OLD, to: NEW, behaviourPaths: ['src'], git }).reason, /not in this repository/);
  });

  it('fails closed when the evidence commit is on another branch', () => {
    const git = fakeGit({ known: [OTHER, NEW], ancestors: {} });
    assert.match(behaviourChangedBetween({ from: OTHER, to: NEW, behaviourPaths: ['src'], git }).reason, /not an ancestor/);
  });

  it('fails closed when git itself errors', () => {
    const git = fakeGit({ diffFails: true });
    assert.match(behaviourChangedBetween({ from: OLD, to: NEW, behaviourPaths: ['src'], git }).reason, /git diff failed/);
  });
});

describe('checkFreshness', () => {
  it('accepts evidence from the commit being verified', () => {
    const result = checkFreshness({ evidence: evidenceAt({ commit: NEW }), tip: NEW, git: fakeGit(), ...FRESHNESS });
    assert.equal(result.fresh, true);
  });

  it('rejects evidence whose commit hash is not a hash', () => {
    const evidence = evidenceAt();
    evidence.vcs.commit = 'produced-by-hand';
    const result = checkFreshness({ evidence, tip: NEW, git: fakeGit(), ...FRESHNESS });
    assert.equal(result.fresh, false);
    assert.match(result.reasons[0], /not a commit hash/);
  });

  it('rejects commit-bound evidence when the code has moved on', () => {
    const git = fakeGit({ changed: { [`${OLD}..${NEW}`]: ['src/app.tsx', 'src/router.ts'] } });
    const result = checkFreshness({ evidence: evidenceAt({ commit: OLD }), tip: NEW, git, ...FRESHNESS });
    assert.equal(result.fresh, false);
    assert.match(result.reasons[0], /src\/app\.tsx/);
    assert.match(result.reasons[0], /Re-run the crawl/);
  });

  it('refuses evidence with no commit inside a repository, unless asked', () => {
    const evidence = evidenceAt({ commit: null });
    const strict = checkFreshness({ evidence, tip: NEW, git: fakeGit(), ...FRESHNESS });
    assert.equal(strict.fresh, false);
    assert.match(strict.reasons[0], /--allow-unversioned/);

    const relaxed = checkFreshness({ evidence, tip: NEW, git: fakeGit(), allowUnversioned: true, ...FRESHNESS });
    assert.equal(relaxed.fresh, true);
    assert.match(relaxed.warnings[0], /age alone/);
  });

  it('falls back to an age check outside a repository', () => {
    const recent = evidenceAt({ commit: null });
    assert.equal(checkFreshness({ evidence: recent, tip: null, git: fakeGit({ available: false }), ...FRESHNESS }).fresh, true);

    const stale = evidenceAt({ commit: null, createdAt: '2020-01-01T00:00:00.000Z' });
    const verdict = checkFreshness({ evidence: stale, tip: null, git: fakeGit({ available: false }), ...FRESHNESS });
    assert.equal(verdict.fresh, false);
    assert.match(verdict.reasons[0], /minutes old/);
  });

  it('rejects commit-bound evidence when there is no repository to check it against', () => {
    const verdict = checkFreshness({ evidence: evidenceAt(), tip: null, git: fakeGit({ available: false }), ...FRESHNESS });
    assert.equal(verdict.fresh, false);
    assert.match(verdict.reasons[0], /not a git repository/);
  });

  it('warns about a dirty working tree without rejecting the evidence', () => {
    const evidence = evidenceAt({ commit: NEW });
    evidence.vcs.dirty = true;
    const verdict = checkFreshness({ evidence, tip: NEW, git: fakeGit(), ...FRESHNESS });
    assert.equal(verdict.fresh, true);
    assert.match(verdict.warnings[0], /not clean/);
  });
});

describe('assessEvidence', () => {
  const base = { tip: NEW, git: fakeGit(), ...FRESHNESS };

  it('accepts a clean level 3 run at the current commit', () => {
    const verdict = assessEvidence({ evidence: evidenceAt({ commit: NEW }), level: 3, ...base });
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.ok, true);
  });

  it('rejects evidence from a lower level', () => {
    const verdict = assessEvidence({ evidence: evidenceAt({ commit: NEW, level: 2 }), level: 3, ...base });
    assert.match(verdict.reasons[0], /below the required level/);
  });

  it('accepts level 3 evidence when only level 2 is required', () => {
    assert.equal(assessEvidence({ evidence: evidenceAt({ commit: NEW }), level: 2, ...base }).ok, true);
  });

  it('rejects a run that failed', () => {
    const verdict = assessEvidence({ evidence: evidenceAt({ commit: NEW, failing: 2 }), level: 3, ...base });
    assert.match(verdict.reasons[0], /2 failing route/);
  });

  it('catches a hand-edited total that contradicts its own results', () => {
    const evidence = evidenceAt({ commit: NEW, failing: 1 });
    evidence.summary.routesFailed = 0;
    evidence.summary.result = 'pass';
    evidence.result = 'pass';
    const verdict = assessEvidence({ evidence, level: 3, ...base });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes('disagrees with the results')));
  });

  it('catches evidence whose failing routes were deleted but whose claim was not', () => {
    const evidence = evidenceAt({ commit: NEW });
    evidence.results = [];
    const verdict = assessEvidence({ evidence, level: 3, ...base });
    assert.ok(verdict.reasons.some((reason) => reason.includes('no routes were visited')));
  });

  it('rejects a truncated crawl for a level 3 claim', () => {
    const verdict = assessEvidence({ evidence: evidenceAt({ commit: NEW, truncated: true }), level: 3, ...base });
    assert.ok(verdict.reasons.some((reason) => reason.includes('truncated')));
  });

  it('rejects a scoped run for a level 3 claim', () => {
    const verdict = assessEvidence({ evidence: evidenceAt({ commit: NEW, scoped: true }), level: 3, ...base });
    assert.ok(verdict.reasons.some((reason) => reason.includes('--only')));
  });

  it('rejects level 3 evidence that skipped a declared persona', () => {
    const verdict = assessEvidence({
      evidence: evidenceAt({ commit: NEW, personas: ['anonymous'] }),
      level: 3,
      expectedPersonas: ['anonymous', 'admin'],
      ...base,
    });
    assert.ok(verdict.reasons.some((reason) => reason.includes('admin')));
  });

  it('does not demand full persona coverage below level 3', () => {
    const verdict = assessEvidence({
      evidence: evidenceAt({ commit: NEW, level: 2, personas: ['anonymous'] }),
      level: 2,
      expectedPersonas: ['anonymous', 'admin'],
      ...base,
    });
    assert.equal(verdict.ok, true);
  });

  it('rejects a file that is not evidence at all, without pretending to judge it', () => {
    const verdict = assessEvidence({ evidence: { tool: 'something-else' }, level: 1, ...base });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes('deep-smoke')));
  });
});

describe('verifyEvidence', () => {
  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-smoke-verify-'));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('reports why every candidate was rejected, not just that none passed', () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'repo-'));
    writeEvidence(evidenceAt({ commit: null, level: 1 }), { dir: '.deep-smoke', cwd: dir });
    writeEvidence(evidenceAt({ commit: null, level: 3, failing: 1 }), { dir: '.deep-smoke', cwd: dir });

    const verification = verifyEvidence({
      level: 3,
      config: structuredClone(DEFAULT_CONFIG),
      cwd: dir,
      allowUnversioned: true,
    });
    assert.equal(verification.ok, false);
    assert.equal(verification.candidates.length, 2);
    const reasons = verification.candidates.flatMap((candidate) => candidate.reasons).join(' ');
    assert.match(reasons, /below the required level/);
    assert.match(reasons, /1 failing route/);
  });

  it('accepts the first valid candidate', () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'repo-'));
    const file = writeEvidence(evidenceAt({ commit: null }), { dir: '.deep-smoke', cwd: dir });
    const verification = verifyEvidence({
      level: 3,
      config: structuredClone(DEFAULT_CONFIG),
      cwd: dir,
      allowUnversioned: true,
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.accepted.file, file);
  });

  it('reports an unreadable candidate instead of crashing', () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'repo-'));
    fs.mkdirSync(path.join(dir, '.deep-smoke'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.deep-smoke', 'L3-broken.json'), '{ not json');
    const verification = verifyEvidence({ level: 3, config: structuredClone(DEFAULT_CONFIG), cwd: dir });
    assert.equal(verification.ok, false);
    assert.equal(verification.candidates.length, 1);
  });
});
