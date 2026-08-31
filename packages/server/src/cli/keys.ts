/**
 * API key management.
 *
 *   npm run keys -- list ekena
 *   npm run keys -- create ekena merchandiser "sarah, merch team"
 *   npm run keys -- rotate 7
 *   npm run keys -- revoke 7
 *   npm run keys -- roles
 *
 * Keys are stored only as SHA-256 hashes, so a created key is printed once and
 * cannot be recovered afterwards.
 *
 * `rotate` is the one to reach for on a suspected leak or a scheduled
 * rotation: it issues a replacement with the same site, role and label, links
 * the two so the chain is auditable, and leaves the old key live for a grace
 * period so a running deployment is not cut off mid-request. Pass
 * `--now` to revoke immediately instead.
 */
import { createPool, migrate } from '../db/pool.js';
import { ROLES, ROLE_SUMMARY, createApiKey, isRole, issueApiKey } from '../routes/auth.js';
import { SiteRegistry } from '../config/sites.js';

const [command, ...args] = process.argv.slice(2);
const db = createPool();
await migrate(db);

try {
  switch (command) {
    case 'list': {
      const site = args[0];
      const { rows } = await db.query(
        `SELECT id, site_id, scope, label, created_at, revoked_at, last_used_at, replaced_by
         FROM api_keys ${site ? 'WHERE site_id = $1' : ''} ORDER BY site_id, id`,
        site ? [site] : [],
      );
      if (rows.length === 0) {
        console.log('no API keys yet — create one with: npm run keys -- create <site> <scope>');
        break;
      }
      console.log(
        '\n id  site        role          label                 created      last used    state',
      );
      for (const r of rows) {
        const state = r.revoked_at
          ? (r.replaced_by ? `rotated -> ${r.replaced_by}` : 'revoked')
          : 'active';
        console.log(
          ` ${String(r.id).padEnd(3)} ${String(r.site_id).padEnd(11)} ${String(r.scope).padEnd(13)} ` +
            `${String(r.label ?? '—').padEnd(21)} ${new Date(r.created_at).toISOString().slice(0, 10)}   ` +
            // A key that has never been used is either new or forgotten, and
            // an operator deciding what to revoke needs to see which.
            `${(r.last_used_at ? new Date(r.last_used_at).toISOString().slice(0, 10) : 'never').padEnd(12)} ` +
            state,
        );
      }
      console.log('');
      break;
    }
    case 'create': {
      const [siteId, scope, ...labelParts] = args;
      if (!siteId || !isRole(scope)) {
        console.error(`usage: keys create <site> <${ROLES.join('|')}> [label]`);
        process.exitCode = 1;
        break;
      }
      SiteRegistry.load().require(siteId);
      const key = await createApiKey(db, siteId, scope, labelParts.join(' ') || undefined);
      console.log(
        `\n${scope} key for ${siteId}:\n\n  ${key}\n\n` +
          `${ROLE_SUMMARY[scope]}\n` +
          (scope === 'search'
            ? ''
            : 'Server-side only — never ship this in a browser bundle.\n') +
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
    case 'rotate': {
      const id = Number(args[0]);
      const immediate = args.includes('--now');
      if (!id) {
        console.error('usage: keys rotate <id> [--now]');
        process.exitCode = 1;
        break;
      }
      const { rows } = await db.query<{ site_id: string; scope: string; label: string | null }>(
        'SELECT site_id, scope, label FROM api_keys WHERE id = $1 AND revoked_at IS NULL',
        [id],
      );
      const old = rows[0];
      if (!old || !isRole(old.scope)) {
        console.error(`no active key with id ${id}`);
        process.exitCode = 1;
        break;
      }
      const { key, id: replacement } = await issueApiKey(
        db, old.site_id, old.scope, old.label ?? undefined,
      );
      await db.query(
        `UPDATE api_keys SET replaced_by = $2${immediate ? ', revoked_at = now()' : ''}
         WHERE id = $1`,
        [id, replacement],
      );
      console.log(
        `\nreplacement ${old.scope} key for ${old.site_id}:\n\n  ${key}\n\n` +
          (immediate
            ? `Key ${id} is revoked as of now. Anything still using it is already failing.\n`
            : `Key ${id} is still live. Deploy this one, confirm traffic has moved\n` +
              `(npm run keys -- list ${old.site_id} shows last use), then:\n\n` +
              `  npm run keys -- revoke ${id}\n`),
      );
      break;
    }
    case 'roles': {
      console.log('\nRoles, least to most privileged. Each one includes the last.\n');
      for (const role of ROLES) {
        console.log(`  ${role.padEnd(14)}${ROLE_SUMMARY[role]}`);
      }
      console.log('');
      break;
    }
    default:
      console.error('usage: keys <list|create|rotate|revoke|roles> …');
      process.exitCode = 1;
  }
} finally {
  await db.end();
}
