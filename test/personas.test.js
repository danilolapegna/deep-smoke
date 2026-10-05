import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigError, EnvironmentError } from '../src/errors.js';
import { loadPersonas, normalisePersona, describePersona } from '../src/personas.js';
import { contextOptionsFor, resolveSecret, validateAuthConfig } from '../src/auth/index.js';

let workspace;

describe('loadPersonas', () => {
  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-smoke-personas-'));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('defaults to a single anonymous visitor', () => {
    const empty = fs.mkdtempSync(path.join(workspace, 'empty-'));
    const { personas, sourcePath } = loadPersonas({ baseDir: empty });
    assert.equal(sourcePath, null);
    assert.equal(personas.length, 1);
    assert.equal(personas[0].authenticated, false);
  });

  it('picks up a personas file sitting next to the config', () => {
    const project = fs.mkdtempSync(path.join(workspace, 'project-'));
    fs.writeFileSync(
      path.join(project, 'deep-smoke.personas.json'),
      JSON.stringify([{ id: 'anonymous' }, { id: 'member', auth: { strategy: 'storageState', path: './m.json' } }]),
    );
    const { personas, sourcePath } = loadPersonas({ baseDir: project });
    assert.equal(sourcePath, path.join(project, 'deep-smoke.personas.json'));
    assert.equal(personas.length, 2);
  });

  it('accepts an inline array', () => {
    const { personas } = loadPersonas({
      source: [{ id: 'anonymous' }, { id: 'member', auth: { strategy: 'storageState', path: './m.json' } }],
    });
    assert.deepEqual(personas.map((persona) => persona.id), ['anonymous', 'member']);
    assert.equal(personas[1].authenticated, true);
  });

  it('accepts a file holding either an array or an object with a personas key', () => {
    const asArray = path.join(workspace, 'array.json');
    fs.writeFileSync(asArray, JSON.stringify([{ id: 'anonymous' }]));
    assert.equal(loadPersonas({ source: asArray }).personas.length, 1);

    const asObject = path.join(workspace, 'object.json');
    fs.writeFileSync(asObject, JSON.stringify({ _note: 'commented', personas: [{ id: 'anonymous' }, { id: 'other' }] }));
    assert.equal(loadPersonas({ source: asObject }).personas.length, 2);
  });

  it('rejects duplicate ids, which would make evidence ambiguous', () => {
    assert.throws(() => loadPersonas({ source: [{ id: 'member' }, { id: 'member' }] }), /Duplicate persona id/);
  });

  it('rejects an empty list rather than treating it as anonymous', () => {
    assert.throws(() => loadPersonas({ source: [] }), /empty/);
  });

  it('resolves a relative personas path against the config directory', () => {
    const nested = path.join(workspace, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'people.json'), JSON.stringify([{ id: 'anonymous' }]));
    const { sourcePath } = loadPersonas({ source: './people.json', baseDir: nested });
    assert.equal(sourcePath, path.join(nested, 'people.json'));
  });
});

describe('normalisePersona', () => {
  it('derives authenticated from the strategy', () => {
    assert.equal(normalisePersona({ id: 'a' }, 0).authenticated, false);
    assert.equal(normalisePersona({ id: 'a', auth: { strategy: 'form', loginPath: '/login', usernameSelector: '#u', passwordSelector: '#p', submitSelector: '#s', username: 'u', password: 'p' } }, 0).authenticated, true);
  });

  it('falls back to the id when no label is given', () => {
    assert.equal(normalisePersona({ id: 'admin' }, 0).label, 'admin');
  });

  it('requires a non-empty id', () => {
    assert.throws(() => normalisePersona({}, 2), /index 2/);
  });

  it('requires seeds to be routes', () => {
    assert.throws(() => normalisePersona({ id: 'a', seeds: [3] }, 0), /seeds/);
  });
});

describe('validateAuthConfig', () => {
  it('lists exactly what a strategy is missing', () => {
    assert.throws(
      () => validateAuthConfig({ strategy: 'form', loginPath: '/login' }, 'member'),
      /usernameSelector, passwordSelector, submitSelector, username, password/,
    );
  });

  it('rejects an unknown strategy and names the alternatives', () => {
    assert.throws(() => validateAuthConfig({ strategy: 'magic' }, 'member'), /none, form, storageState, module/);
  });

  it('treats a missing auth block as anonymous', () => {
    assert.equal(validateAuthConfig({}, 'member').strategy, 'none');
  });
});

describe('resolveSecret', () => {
  it('passes a literal through unchanged', () => {
    assert.equal(resolveSecret('hunter2', 'auth.password', {}), 'hunter2');
  });

  it('reads an environment reference', () => {
    assert.equal(resolveSecret('env:SMOKE_PASSWORD', 'auth.password', { SMOKE_PASSWORD: 'from-env' }), 'from-env');
  });

  it('reports a missing variable as an environment problem, naming only the variable', () => {
    assert.throws(
      () => resolveSecret('env:SMOKE_PASSWORD', 'auth.password', {}),
      (error) => {
        assert.ok(error instanceof EnvironmentError);
        assert.equal(error.exitCode, 3, 'a missing secret is a broken pipeline, not a broken page');
        assert.match(error.message, /SMOKE_PASSWORD/);
        return true;
      },
    );
  });
});

describe('contextOptionsFor', () => {
  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-smoke-personas-'));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('returns nothing for strategies that do not need context options', () => {
    assert.deepEqual(contextOptionsFor({ strategy: 'none' }, workspace), {});
    assert.deepEqual(contextOptionsFor({ strategy: 'form' }, workspace), {});
  });

  it('passes an existing storage state file to the browser context', () => {
    const file = path.join(workspace, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
    assert.deepEqual(contextOptionsFor({ strategy: 'storageState', path: './state.json' }, workspace), {
      storageState: file,
    });
  });

  it('fails early, with instructions, when the storage state is missing', () => {
    assert.throws(
      () => contextOptionsFor({ strategy: 'storageState', path: './absent.json' }, workspace),
      ConfigError,
    );
  });
});

describe('describePersona', () => {
  it('says how a persona signs in', () => {
    assert.equal(describePersona({ id: 'anonymous', auth: { strategy: 'none' } }), 'anonymous (not signed in)');
    assert.equal(describePersona({ id: 'member', auth: { strategy: 'form' } }), 'member (form login)');
  });
});
