import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../src/config.js';
import { LEVELS, buildPlan, resolveLevel, selectPersonas, unknownRouteProbeFor } from '../src/levels.js';
import { ConfigError } from '../src/errors.js';

const anonymous = { id: 'anonymous', label: 'Anonymous', auth: { strategy: 'none' }, authenticated: false, seeds: [] };
const member = {
  id: 'member',
  label: 'Member',
  auth: { strategy: 'storageState', path: './member.json' },
  authenticated: true,
  seeds: ['/app'],
};
const admin = {
  id: 'admin',
  label: 'Admin',
  auth: { strategy: 'storageState', path: './admin.json' },
  authenticated: true,
  seeds: ['/admin'],
};

/**
 * Config with a small declared surface, so plans are readable in assertions.
 *
 * @param {object} [overrides] Fields to replace.
 * @returns {Record<string, any>} Config.
 */
const config = (overrides = {}) => ({ ...structuredClone(DEFAULT_CONFIG), routes: ['/', '/pricing'], ...overrides });

describe('resolveLevel', () => {
  it('accepts the three levels, as numbers or strings', () => {
    assert.equal(resolveLevel(1).id, 1);
    assert.equal(resolveLevel('3').id, 3);
  });

  it('rejects anything else', () => {
    assert.throws(() => resolveLevel(0), ConfigError);
    assert.throws(() => resolveLevel(4), /Expected 1, 2 or 3/);
  });
});

describe('selectPersonas', () => {
  it('level 1 takes one persona, preferring the anonymous one', () => {
    assert.deepEqual(selectPersonas(LEVELS[1], [member, anonymous]).map((p) => p.id), ['anonymous']);
  });

  it('level 1 falls back to the first persona when none is anonymous', () => {
    assert.deepEqual(selectPersonas(LEVELS[1], [member, admin]).map((p) => p.id), ['member']);
  });

  it('level 2 pairs anonymous with the first authenticated persona', () => {
    assert.deepEqual(selectPersonas(LEVELS[2], [anonymous, member, admin]).map((p) => p.id), ['anonymous', 'member']);
  });

  it('level 3 refuses to choose', () => {
    assert.deepEqual(selectPersonas(LEVELS[3], [anonymous, member, admin]).map((p) => p.id), [
      'anonymous',
      'member',
      'admin',
    ]);
  });

  it('fails loudly on an empty persona list', () => {
    assert.throws(() => selectPersonas(LEVELS[1], []), ConfigError);
  });
});

describe('unknownRouteProbeFor', () => {
  it('produces a sibling of the route under test', () => {
    assert.equal(unknownRouteProbeFor('/'), '/deep-smoke-unknown-route');
    assert.equal(unknownRouteProbeFor('/checkout'), '/checkout/deep-smoke-unknown-route');
    assert.equal(unknownRouteProbeFor('/checkout/'), '/checkout/deep-smoke-unknown-route');
  });
});

describe('buildPlan', () => {
  it('level 1 visits exactly one route plus the unknown-route probe', () => {
    const plan = buildPlan({ level: 1, config: config(), personas: [anonymous, member] });
    assert.equal(plan.personas.length, 1);
    assert.deepEqual(plan.personas[0].seeds, ['/']);
    assert.deepEqual(plan.personas[0].probes, ['/deep-smoke-unknown-route']);
    assert.equal(plan.discoveryDepth, 0);
    assert.equal(plan.requireAuthInvariants, false);
  });

  it('level 2 follows links one hop and covers both sides of the login wall', () => {
    const plan = buildPlan({ level: 2, config: config(), personas: [anonymous, member, admin] });
    assert.deepEqual(plan.personas.map((entry) => entry.persona.id), ['anonymous', 'member']);
    assert.equal(plan.discoveryDepth, 1);
    assert.deepEqual(plan.personas[0].probes, []);
  });

  it('level 3 walks without a depth limit and checks the authentication rules', () => {
    const plan = buildPlan({ level: 3, config: config(), personas: [anonymous, member] });
    assert.equal(plan.discoveryDepth, Number.POSITIVE_INFINITY);
    assert.equal(plan.requireAuthInvariants, true);
  });

  it('adds persona seeds to the declared routes', () => {
    const plan = buildPlan({ level: 3, config: config(), personas: [member] });
    assert.deepEqual(plan.personas[0].seeds, ['/', '/pricing', '/app']);
  });

  it('de-duplicates and normalises seeds while keeping their order', () => {
    const plan = buildPlan({
      level: 3,
      config: config({ routes: ['/', '/pricing/', '/pricing', ' /about '] }),
      personas: [anonymous],
    });
    assert.deepEqual(plan.personas[0].seeds, ['/', '/pricing', '/about']);
  });

  it('scoping with --only replaces the inventory and stops discovery', () => {
    const plan = buildPlan({ level: 3, config: config(), personas: [anonymous, member], only: ['/orders', '/orders/new'] });
    assert.deepEqual(plan.personas[0].seeds, ['/orders', '/orders/new']);
    assert.equal(plan.discoveryDepth, 0);
    assert.equal(plan.scoped, true);
    assert.equal(plan.requireAuthInvariants, false, 'a scoped run cannot make a whole-app claim');
  });
});
