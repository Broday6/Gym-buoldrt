/**
 * API key management.
 *
 *   npm run keys -- list ekena
 *   npm run keys -- create ekena search "miva storefront"
 *   npm run keys -- revoke 7
 *
 * Keys are stored only as SHA-256 hashes, so a created key is printed once and
 * cannot be recovered afterwards.
 */
import { createPool, migrate } from '../db/pool.js';
import { createApiKey } from '../routes/auth.js';
import { SiteRegistry } from '../config/sites.js';

const [command, ...args] = process.argv.slice(2);
const db = createPool();
await migrate(db);

try {
  switch (command) {
    case 'list': {
      const site = args[0];
      const { rows } = await db.query(
        `SELECT id, site_id, scope, label, created_at, revoked_at FROM api_keys
         ${site ? 'WHERE site_id = $1' : ''} ORDER BY site_id, id`,
        site ? [site] : [],
      );
      if (rows.length === 0) {
        console.log('no API keys yet — create one with: npm run keys -- create <site> <scope>');
        break;
      }
      console.log('\n id  site        scope   label                 created      state');
      for (const r of rows) {
        console.log(
          ` ${String(r.id).padEnd(3)} ${String(r.site_id).padEnd(11)} ${String(r.scope).padEnd(7)} ` +
            `${String(r.label ?? '—').padEnd(21)} ${new Date(r.created_at).toISOString().slice(0, 10)}   ` +
            `${r.revoked_at ? 'revoked' : 'active'}`,
        );
      }
      console.log('');
      break;
    }
    case 'create': {
      const [siteId, scope, ...labelParts] = args;
      if (!siteId || (scope !== 'search' && scope !== 'admin')) {
        console.error('usage: keys create <site> <search|admin> [label]');
        process.exitCode = 1;
        break;
      }
      SiteRegistry.load().require(siteId);
      const key = await createApiKey(db, siteId, scope, labelParts.join(' ') || undefined);
      console.log(
        `\n${scope} key for ${siteId}:\n\n  ${key}\n\n` +
          (scope === 'search'
            ? 'Safe to ship in a storefront bundle.\n'
            : 'Server-side only. This grants catalogue and configuration writes.\n') +
          'Store it now — only its hash is kept, so it cannot be shown again.\n',
      );
      break;
    }
    case 'revoke': {
      const id = Number(args[0]);
      if (!id) {
        console.error('usage: keys revoke <id>');
        process.exitCode = 1;
        break;
      }
      const { rowCount } = await db.query(
        'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id],
      );
      // Revocation is visible to running servers within the key cache TTL (30s).
      console.log(rowCount ? `key ${id} revoked` : `no active key with id ${id}`);
      break;
    }
    default:
      console.error('usage: keys <list|create|revoke> …');
      process.exitCode = 1;
  }
} finally {
  await db.end();
}
