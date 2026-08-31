import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectRoutes, generateSpec } from '../src/routes/spec.js';
import { reconcile, routeKey } from '../src/routes/openapi.js';

/**
 * §4.13 asks for an OpenAPI document "kept current". These are the tests that
 * make that true rather than aspirational: the spec is generated from the route
 * table, and drift in either direction fails here.
 */
describe('openapi', () => {
  test('every registered route is documented, and nothing documented is gone', async () => {
    const { undocumented, stale } = reconcile(await collectRoutes());
    assert.deepEqual(undocumented, [], 'add these to DOCS in routes/openapi.ts');
    assert.deepEqual(stale, [], 'these are documented but no longer registered');
  });

  test('the checked-in document matches what the routes produce', async () => {
    const generated = `${JSON.stringify(await generateSpec(), null, 2)}\n`;
    const onDisk = readFileSync('docs/openapi.json', 'utf8');
    assert.equal(onDisk, generated, 'docs/openapi.json is stale — run: npm run openapi');
  });

  test('the documented role is the enforced role', async () => {
    // Two values that agree by habit will eventually disagree. The spec reads
    // the guard's own role rather than a second copy of it.
    const spec = await generateSpec() as {
      paths: Record<string, Record<string, { 'x-required-role'?: string }>>;
    };
    const roleOf = (method: string, path: string) =>
      spec.paths[path]?.[method.toLowerCase()]?.['x-required-role'];

    assert.equal(roleOf('POST', '/v1/{site}/search'), 'search');
    assert.equal(roleOf('GET', '/v1/{site}/analytics/overview'), 'analyst');
    assert.equal(roleOf('POST', '/v1/{site}/admin/badges'), 'merchandiser');
    assert.equal(roleOf('POST', '/v1/{site}/catalog/batch'), 'admin');
  });

  test('every authenticated operation documents 401 and 403', async () => {
    const spec = await generateSpec() as {
      paths: Record<string, Record<string, {
        responses: Record<string, unknown>; security?: unknown[];
      }>>;
    };
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (Array.isArray(op.security) && op.security.length === 0) continue;
        for (const code of ['401', '403', '429']) {
          assert.ok(op.responses[code], `${method.toUpperCase()} ${path} is missing ${code}`);
        }
      }
    }
  });

  test('a request body always documents how it can be rejected', async () => {
    const spec = await generateSpec() as {
      paths: Record<string, Record<string, { requestBody?: unknown; responses: Record<string, unknown> }>>;
    };
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op.requestBody) continue;
        assert.ok(op.responses['400'], `${method.toUpperCase()} ${path} takes a body but documents no 400`);
      }
    }
  });

  test('shared rule definitions are addressable, not duplicated', async () => {
    const spec = await generateSpec() as { components: { schemas: Record<string, unknown> } };
    assert.ok(spec.components.schemas.selector);
    assert.ok(spec.components.schemas.condition);
    // Fastify addresses shared schemas by $id; an OpenAPI consumer cannot.
    assert.ok(!JSON.stringify(spec).includes('"compass.'), 'unresolved $id reference');
  });

  test('health and metrics are reachable without a key, and say so', async () => {
    const spec = await generateSpec() as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    for (const path of ['/health', '/health/ready', '/metrics', '/v1/sites', '/openapi.json']) {
      assert.deepEqual(spec.paths[path]?.get?.security, [], path);
    }
    // And the shopper endpoints do not.
    assert.deepEqual(spec.paths['/v1/{site}/search']?.post?.security, [{ apiKey: [] }]);
  });

  test('path parameters are named the way OpenAPI expects', async () => {
    const routes = await collectRoutes();
    assert.ok(routes.some((r) => routeKey(r.method, r.url) === 'GET /v1/:site/directory'));
    const spec = await generateSpec() as { paths: Record<string, unknown> };
    assert.ok(spec.paths['/v1/{site}/directory'], 'Fastify :site must become {site}');
    assert.ok(!Object.keys(spec.paths).some((p) => p.includes(':')));
  });
});
