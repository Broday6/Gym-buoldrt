import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, ROLE_SUMMARY, isRole, roleCovers, type KeyScope } from '../src/routes/auth.js';

/**
 * Roles are ordered, and everything downstream — one comparison at the guard,
 * the console hiding controls, the CLI listing — depends on that ordering being
 * total and on each role genuinely containing the one below it.
 */
describe('roles', () => {
  test('each role covers every role below it and none above', () => {
    for (let i = 0; i < ROLES.length; i++) {
      for (let j = 0; j < ROLES.length; j++) {
        assert.equal(
          roleCovers(ROLES[i]!, ROLES[j]!),
          i >= j,
          `${ROLES[i]} vs ${ROLES[j]}`,
        );
      }
    }
  });

  test('a storefront key cannot reach the reports', () => {
    assert.equal(roleCovers('search', 'analyst'), false);
    assert.equal(roleCovers('search', 'merchandiser'), false);
    assert.equal(roleCovers('search', 'admin'), false);
  });

  test('an analyst can read but not merchandise', () => {
    assert.equal(roleCovers('analyst', 'analyst'), true);
    assert.equal(roleCovers('analyst', 'merchandiser'), false);
  });

  test('a merchandiser cannot push a catalogue', () => {
    assert.equal(roleCovers('merchandiser', 'merchandiser'), true);
    assert.equal(roleCovers('merchandiser', 'admin'), false);
  });

  test('the two original scopes keep exactly the access they had', () => {
    // Every key issued before roles existed is 'search' or 'admin'. Neither may
    // change meaning, or a migration silently grants or removes access.
    assert.equal(roleCovers('admin', 'admin'), true);
    assert.equal(roleCovers('search', 'search'), true);
    assert.equal(roleCovers('search', 'analyst'), false);
  });

  test('unknown role names are rejected rather than defaulting to something', () => {
    for (const bad of ['owner', 'ADMIN', '', 'superuser', null, 7]) {
      assert.equal(isRole(bad), false, String(bad));
    }
    for (const good of ROLES) assert.equal(isRole(good), true);
  });

  test('every role is documented', () => {
    for (const role of ROLES) {
      assert.ok((ROLE_SUMMARY[role as KeyScope] ?? '').length > 20, role);
    }
  });
});

describe('key format', () => {
  test('a key announces its role in its prefix', async () => {
    const { generateKey } = await import('../src/routes/auth.js');
    for (const role of ROLES) {
      const key = generateKey(role);
      // A private key that reads "ck_search_…" looks like the one that is safe
      // to publish. That misread is the whole risk this prefix exists to stop.
      assert.ok(key.startsWith(`ck_${role}_`), `${role} -> ${key}`);
      const others = ROLES.filter((r) => r !== role && !role.startsWith(r));
      for (const other of others) {
        assert.ok(!key.startsWith(`ck_${other}_`), `${role} key must not read as ${other}`);
      }
    }
  });
});
