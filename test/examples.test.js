/**
 * The examples are documentation, and documentation rots.
 *
 * Loading them through the real loaders means a config key that gets renamed
 * breaks the build instead of quietly misleading the next person who copies the
 * file. This is cheap, and it is the only kind of documentation test worth
 * writing: it checks that the example still works, not that it still says
 * something.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { loadPersonas } from '../src/personas.js';

const EXAMPLES = fileURLToPath(new URL('../examples', import.meta.url));

describe('the shipped examples', () => {
  it('config example loads, with every key recognised and valid', () => {
    const { config } = loadConfig({ cwd: EXAMPLES, configPath: 'deep-smoke.config.json' });
    assert.equal(config.baseUrl, 'http://localhost:4173');
    assert.deepEqual(config.protectedPrefixes, ['/app', '/admin']);
    assert.equal(config.checks.authRedirects, true);
    assert.equal(config.personas, './deep-smoke.personas.json');
  });

  it('personas example loads, and demonstrates all four strategies', () => {
    const { personas } = loadPersonas({ source: './deep-smoke.personas.json', baseDir: EXAMPLES });
    const strategies = personas.map((persona) => persona.auth.strategy);
    assert.deepEqual(strategies, ['none', 'form', 'storageState', 'module']);
    assert.equal(personas.filter((persona) => persona.authenticated).length, 3);
  });

  it('config and personas fit together', () => {
    const { config } = loadConfig({ cwd: EXAMPLES, configPath: 'deep-smoke.config.json' });
    const { personas } = loadPersonas({ source: config.personas, baseDir: EXAMPLES });
    const seeds = personas.flatMap((persona) => persona.seeds);
    for (const prefix of config.protectedPrefixes) {
      assert.ok(
        seeds.some((seed) => seed.startsWith(prefix)),
        `no persona has a seed under the protected prefix ${prefix}, so nothing would ever crawl it`,
      );
    }
  });

  it('the credentials in the example are references, never literals', () => {
    const { personas } = loadPersonas({ source: './deep-smoke.personas.json', baseDir: EXAMPLES });
    const form = personas.find((persona) => persona.auth.strategy === 'form');
    assert.match(form.auth.username, /^env:/);
    assert.match(form.auth.password, /^env:/);
  });
});
