import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  EVIDENCE_SCHEMA_VERSION,
  buildEvidence,
  evidenceFileName,
  listEvidenceFiles,
  readEvidence,
  summarise,
  validateEvidenceShape,
  writeEvidence,
} from '../src/evidence.js';

let workspace;

/**
 * Builds a run result shaped like the crawler's output, without a browser.
 *
 * @param {object} [options] Shape controls.
 * @returns {object} Run result.
 */
function runResult({ failing = 0, invariantViolations = 0, truncated = false, personaError = null, level = 3, scoped = false } = {}) {
  const results = [
    { persona: 'anonymous', route: '/', requestedPath: '/', finalPath: '/', ok: true, flaky: false, durationMs: 10, failures: [] },
    { persona: 'anonymous', route: '/about', requestedPath: '/about', finalPath: '/about', ok: true, flaky: false, durationMs: 12, failures: [] },
  ];
  for (let index = 0; index < failing; index += 1) {
    results.push({
      persona: 'anonymous',
      route: `/broken-${index}`,
      requestedPath: `/broken-${index}`,
      finalPath: `/broken-${index}`,
      ok: false,
      flaky: false,
      durationMs: 9,
      failures: [{ check: 'blank-screen', message: 'blank screen' }],
    });
  }
  const invariants = [{ persona: 'anonymous', route: '/app', kind: 'protected-route-must-bounce-anonymous', ok: invariantViolations === 0, message: 'x' }];

  return {
    plan: { level, scoped, requireAuthInvariants: level === 3 },
    personaReports: [
      {
        persona: { id: 'anonymous', label: 'Anonymous', authenticated: false, authStrategy: 'none', authDetail: 'anonymous' },
        results,
        invariants,
        truncated,
        truncationReason: truncated ? 'route budget reached (maxRoutes=2)' : null,
        error: personaError,
      },
    ],
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    durationMs: 4321,
    baseUrl: 'http://localhost:4173',
    config: structuredClone(DEFAULT_CONFIG),
  };
}

describe('summarise', () => {
  it('derives totals from the results rather than trusting a stored number', () => {
    const summary = summarise({
      results: [{ ok: true }, { ok: false }, { ok: true, flaky: true }],
      invariants: [{ ok: true }, { ok: false }],
      personas: [{ id: 'anonymous' }],
    });
    assert.equal(summary.routesVisited, 3);
    assert.equal(summary.routesFailed, 1);
    assert.equal(summary.routesFlaky, 1);
    assert.equal(summary.invariantsViolated, 1);
    assert.equal(summary.result, 'fail');
  });

  it('fails a run whose persona could not be crawled at all', () => {
    const summary = summarise({
      results: [{ ok: true }],
      invariants: [],
      personas: [{ id: 'member', error: 'session never took effect' }],
    });
    assert.equal(summary.result, 'fail');
    assert.equal(summary.personaErrors.length, 1);
  });
});

describe('buildEvidence', () => {
  it('records the claim, the scope and the provenance', () => {
    const evidence = buildEvidence(runResult(), {
      vcs: { kind: 'git', commit: 'abc123def456abc123def456abc123def456abcd', branch: 'main', dirty: false },
      toolVersion: '9.9.9',
    });
    assert.equal(evidence.tool, 'deep-smoke');
    assert.equal(evidence.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.equal(evidence.toolVersion, '9.9.9');
    assert.equal(evidence.level, 3);
    assert.equal(evidence.result, 'pass');
    assert.equal(evidence.summary.routesVisited, 2);
    assert.deepEqual(evidence.summary.personasCovered, ['anonymous']);
    assert.equal(evidence.target.baseUrl, 'http://localhost:4173');
    assert.deepEqual(evidence.declared.checks, DEFAULT_CONFIG.checks);
    assert.equal(evidence.vcs.commit.startsWith('abc123'), true);
  });

  it('fails the run when any route failed', () => {
    const evidence = buildEvidence(runResult({ failing: 1 }));
    assert.equal(evidence.result, 'fail');
    assert.equal(evidence.summary.routesFailed, 1);
  });

  it('carries truncation forward instead of quietly reporting full coverage', () => {
    const evidence = buildEvidence(runResult({ truncated: true }));
    assert.equal(evidence.coverage.truncated, true);
    assert.match(evidence.coverage.truncationReasons[0], /route budget/);
  });
});

describe('evidence files', () => {
  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-smoke-evidence-'));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('names a file after its level and commit', () => {
    const evidence = buildEvidence(runResult(), {
      vcs: { kind: 'git', commit: 'abcdef0123456789abcdef0123456789abcdef01', branch: 'main', dirty: false },
    });
    assert.equal(evidenceFileName(evidence), 'L3-abcdef012345.json');
  });

  it('falls back to a timestamp with no version control', () => {
    const evidence = buildEvidence(runResult());
    assert.equal(evidenceFileName(evidence), 'L3-2026-01-01T10-00-00-000Z.json');
  });

  it('writes, lists and reads back', () => {
    const evidence = buildEvidence(runResult());
    const file = writeEvidence(evidence, { dir: '.deep-smoke', cwd: workspace });
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(listEvidenceFiles(path.join(workspace, '.deep-smoke')), [file]);
    assert.deepEqual(readEvidence(file).summary, evidence.summary);
  });

  it('returns an empty list for a directory that does not exist', () => {
    assert.deepEqual(listEvidenceFiles(path.join(workspace, 'nowhere')), []);
  });

  it('refuses a file that is not deep-smoke evidence', () => {
    const file = path.join(workspace, 'not-evidence.json');
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
    assert.throws(() => readEvidence(file), /Not a valid deep-smoke evidence file/);
  });
});

describe('validateEvidenceShape', () => {
  it('accepts real evidence', () => {
    assert.deepEqual(validateEvidenceShape(buildEvidence(runResult())), []);
  });

  it('lists every structural problem at once', () => {
    const problems = validateEvidenceShape({ tool: 'something-else', level: 7, results: 'no' });
    assert.ok(problems.length >= 3);
    assert.ok(problems.some((problem) => problem.includes('deep-smoke')));
    assert.ok(problems.some((problem) => problem.includes('level')));
  });

  it('rejects a results array whose entries are not route verdicts', () => {
    const evidence = buildEvidence(runResult());
    evidence.results[1] = { route: '/about' };
    assert.ok(validateEvidenceShape(evidence).some((problem) => problem.includes('results[1]')));
  });
});
