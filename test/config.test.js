import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigError } from '../src/errors.js';
import { DEFAULT_CONFIG, loadConfig, normaliseBaseUrl, compilePatterns, severityFilter } from '../src/config.js';

let workspace;

/**
 * Writes a config file into the scratch workspace.
 *
 * @param {string} name File name.
 * @param {unknown} contents JSON contents, or a raw string.
 * @returns {string} Absolute path.
 */
function writeConfig(name, contents) {
  const file = path.join(workspace, name);
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return file;
}

describe('normaliseBaseUrl', () => {
  it('drops a trailing slash so route concatenation is safe', () => {
    assert.equal(normaliseBaseUrl('http://localhost:3000/'), 'http://localhost:3000');
  });

  it('keeps a base path when the app is not served at the root', () => {
    assert.equal(normaliseBaseUrl('https://example.com/app/'), 'https://example.com/app');
  });

  it('rejects a value that is not an absolute http url', () => {
    assert.throws(() => normaliseBaseUrl('localhost:3000'), ConfigError);
    assert.throws(() => normaliseBaseUrl('file:///tmp/index.html'), /protocol/);
  });
});

describe('loadConfig', () => {
  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-smoke-config-'));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('returns the defaults when there is no config file', () => {
    const { config, configPath } = loadConfig({ cwd: workspace });
    assert.equal(configPath, null);
    assert.deepEqual(config.routes, ['/']);
    assert.equal(config.checks.blankScreen, true);
  });

  it('merges nested sections instead of replacing them wholesale', () => {
    const file = writeConfig('nested.json', { checks: { consoleErrors: false } });
    const { config } = loadConfig({ cwd: workspace, configPath: file });
    assert.equal(config.checks.consoleErrors, false);
    assert.equal(config.checks.blankScreen, true, 'unmentioned checks keep their default');
  });

  it('replaces arrays rather than concatenating, so a list can be narrowed', () => {
    const file = writeConfig('arrays.json', { console: { failPatterns: ['only this'] } });
    const { config } = loadConfig({ cwd: workspace, configPath: file });
    assert.deepEqual(config.console.failPatterns, ['only this']);
  });

  it('lets the command line win over the file', () => {
    const file = writeConfig('override.json', { baseUrl: 'http://from-file.test', maxRoutes: 10 });
    const { config } = loadConfig({
      cwd: workspace,
      configPath: file,
      overrides: { baseUrl: 'http://from-flag.test', maxRoutes: 99 },
    });
    assert.equal(config.baseUrl, 'http://from-flag.test');
    assert.equal(config.maxRoutes, 99);
  });

  it('rejects an unknown key instead of ignoring a typo', () => {
    const file = writeConfig('typo.json', { protectedPrefix: ['/app'] });
    assert.throws(() => loadConfig({ cwd: workspace, configPath: file }), /Unknown config key/);
  });

  it('allows underscore-prefixed keys as comments', () => {
    const file = writeConfig('commented.json', { _why: 'because JSON has no comments', routes: ['/', '/about'] });
    const { config } = loadConfig({ cwd: workspace, configPath: file });
    assert.deepEqual(config.routes, ['/', '/about']);
  });

  it('names the file when the JSON is malformed', () => {
    const file = writeConfig('broken.json', '{ "routes": [ }');
    assert.throws(() => loadConfig({ cwd: workspace, configPath: file }), /broken\.json/);
  });

  it('fails on a missing explicit config file rather than falling back silently', () => {
    assert.throws(() => loadConfig({ cwd: workspace, configPath: 'nope.json' }), /not found/);
  });

  it('validates types up front rather than mid-crawl', () => {
    const negative = writeConfig('negative.json', { maxRoutes: -1 });
    assert.throws(() => loadConfig({ cwd: workspace, configPath: negative }), /maxRoutes/);

    const badCheck = writeConfig('bad-check.json', { checks: { pageExceptions: 'yes' } });
    assert.throws(() => loadConfig({ cwd: workspace, configPath: badCheck }), /true or false/);

    const unknownCheck = writeConfig('unknown-check.json', { checks: { typos: true } });
    assert.throws(() => loadConfig({ cwd: workspace, configPath: unknownCheck }), /Unknown check/);

    const badPattern = writeConfig('bad-pattern.json', { console: { failPatterns: ['('] } });
    assert.throws(() => loadConfig({ cwd: workspace, configPath: badPattern }), /regular expression/);
  });

  it('does not mutate the exported defaults', () => {
    const file = writeConfig('mutation.json', { routes: ['/x'], checks: { blankScreen: false } });
    loadConfig({ cwd: workspace, configPath: file });
    assert.deepEqual(DEFAULT_CONFIG.routes, ['/']);
    assert.equal(DEFAULT_CONFIG.checks.blankScreen, true);
  });
});

describe('pattern compilation', () => {
  it('compiles case-insensitive patterns', () => {
    const [pattern] = compilePatterns(['typeerror'], 'test');
    assert.equal(pattern.test('Uncaught TypeError'), true);
  });

  it('reports the config key that held a broken pattern', () => {
    assert.throws(() => compilePatterns(['['], 'console.failPatterns'), /console\.failPatterns/);
  });

  it('maps severities to accepted message types', () => {
    assert.deepEqual(severityFilter('error'), ['error']);
    assert.deepEqual(severityFilter('warning'), ['error', 'warning']);
    assert.equal(severityFilter('all'), null);
    assert.throws(() => severityFilter('loud'), /Invalid console.severity/);
  });
});
