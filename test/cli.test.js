import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { helpText, parseArgs } from '../bin/deep-smoke.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildEvidence, writeEvidence } from '../src/evidence.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/deep-smoke.js', import.meta.url));

let workspace;
let installedBin;

/**
 * Runs the binary and returns its output and exit code, never throwing.
 *
 * @param {string[]} args Command-line arguments.
 * @param {string} [cwd] Working directory.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Result.
 */
async function cli(args, cwd = workspace, binary = BIN) {
  try {
    const { stdout, stderr } = await run(process.execPath, [binary, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * Writes passing evidence into a directory, with no version control stamp.
 *
 * @param {string} dir Working directory.
 * @param {number} level Level to claim.
 * @returns {string} File written.
 */
function seedEvidence(dir, level) {
  const evidence = buildEvidence({
    plan: { level, scoped: false, requireAuthInvariants: level === 3 },
    personaReports: [
      {
        persona: { id: 'anonymous', label: 'Anonymous', authenticated: false, authStrategy: 'none', authDetail: 'anonymous' },
        results: [{ persona: 'anonymous', route: '/', requestedPath: '/', finalPath: '/', ok: true, flaky: false, durationMs: 4, failures: [] }],
        invariants: [],
        truncated: false,
        truncationReason: null,
        error: null,
      },
    ],
    startedAt: new Date(),
    durationMs: 50,
    baseUrl: 'http://localhost:4173',
    config: structuredClone(DEFAULT_CONFIG),
  });
  return writeEvidence(evidence, { dir: '.deep-smoke', cwd: dir });
}

describe('parseArgs', () => {
  it('accepts both --flag=value and --flag value', () => {
    assert.equal(parseArgs(['--level=2']).flags.level, 2);
    assert.equal(parseArgs(['--level', '2']).flags.level, 2);
  });

  it('resolves short aliases', () => {
    assert.equal(parseArgs(['-h']).flags.help, true);
    assert.equal(parseArgs(['-v']).flags.version, true);
  });

  it('recognises verify as a command and as a flag', () => {
    assert.equal(parseArgs(['verify', '--level=3']).command, 'verify');
    assert.equal(parseArgs(['--verify', '--level=3']).command, 'verify');
    assert.deepEqual(parseArgs(['verify', 'evidence.json']).positionals, ['evidence.json']);
  });

  it('lets --verify take an optional file', () => {
    assert.equal(parseArgs(['--verify=out.json']).flags.verify, 'out.json');
    assert.equal(parseArgs(['--verify']).flags.verify, '');
  });

  it('rejects an unknown flag rather than ignoring a typo', () => {
    assert.throws(() => parseArgs(['--levl=2']), /Unknown option: --levl/);
  });

  it('rejects a flag that needs a value but has none', () => {
    assert.throws(() => parseArgs(['--url']), /needs a value/);
  });

  it('rejects a value given to a boolean flag', () => {
    assert.throws(() => parseArgs(['--json=yes']), /does not take a value/);
  });

  it('rejects a non-numeric level', () => {
    assert.throws(() => parseArgs(['--level=high']), /needs a number/);
  });
});

describe('helpText', () => {
  it('answers the question people actually have, which is which level to use', () => {
    const help = helpText();
    for (const marker of ['USAGE', 'LEVELS', 'WHAT COUNTS AS A FAILURE', 'OPTIONS', 'EXIT CODES', 'EXAMPLES']) {
      assert.ok(help.includes(marker), `help is missing the ${marker} section`);
    }
    assert.match(help, /--level=3\s+The entire reachable route tree/);
    assert.match(help, /deep-smoke verify --level=3/);
  });

  it('documents every flag it accepts', () => {
    const help = helpText();
    for (const flag of ['--url', '--only', '--personas', '--json', '--allow-unversioned', '--channel']) {
      assert.ok(help.includes(flag), `help is missing ${flag}`);
    }
  });
});

describe('command line', () => {
  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-smoke-cli-'));
    installedBin = path.join(workspace, 'deep-smoke');
    fs.symlinkSync(BIN, installedBin, 'file');
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('prints help when invoked through an installed binary symlink', async () => {
    const { code, stdout } = await cli(['--help'], workspace, installedBin);
    assert.equal(code, 0);
    assert.match(stdout, /USAGE/);
  });

  it('rejects an invalid option through an installed binary symlink', async () => {
    const { code, stderr } = await cli(['--nope'], workspace, installedBin);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown option: --nope/);
  });

  it('fails verification without evidence through an installed binary symlink', async () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'installed-'));
    const { code, stderr } = await cli(['verify', '--level=1'], dir, installedBin);
    assert.equal(code, 1);
    assert.match(stderr, /No evidence files found/);
  });

  it('prints help and exits cleanly', async () => {
    const { code, stdout } = await cli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /deep-smoke \d+\.\d+\.\d+/);
  });

  it('prints its version', async () => {
    const { code, stdout } = await cli(['--version']);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('exits 2 on an unknown option', async () => {
    const { code, stderr } = await cli(['--nope']);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown option: --nope/);
  });

  it('exits 2 when a run has no target url', async () => {
    const { code, stderr } = await cli(['--level=1']);
    assert.equal(code, 2);
    assert.match(stderr, /No target URL/);
  });

  it('exits 2 when verify is not told which level it demands', async () => {
    const { code, stderr } = await cli(['verify']);
    assert.equal(code, 2);
    assert.match(stderr, /verify needs --level/);
  });

  it('accepts fresh evidence and exits 0', async () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'project-'));
    seedEvidence(dir, 3);
    const { code, stderr } = await cli(['verify', '--level=3', '--allow-unversioned'], dir);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /PASS/);
  });

  it('rejects evidence from a lower level and says why', async () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'project-'));
    seedEvidence(dir, 1);
    const { code, stderr } = await cli(['verify', '--level=3', '--allow-unversioned'], dir);
    assert.equal(code, 1);
    assert.match(stderr, /below the required level/);
    assert.match(stderr, /Fix: deep-smoke --level=3/);
  });

  it('reports the absence of any evidence rather than passing quietly', async () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'project-'));
    const { code, stderr } = await cli(['verify', '--level=1'], dir);
    assert.equal(code, 1);
    assert.match(stderr, /No evidence files found/);
  });

  it('keeps stdout clean for machines and stderr for people', async () => {
    const dir = fs.mkdtempSync(path.join(workspace, 'project-'));
    seedEvidence(dir, 3);
    const { code, stdout, stderr } = await cli(['verify', '--level=3', '--allow-unversioned', '--json', '--quiet'], dir);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.accepted.evidence.level, 3);
  });
});
