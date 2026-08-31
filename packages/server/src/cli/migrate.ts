/**
 * Apply the schema.
 *
 *   npm run migrate
 *
 * The server does not migrate on boot on purpose: several instances starting
 * at once would race, and a schema change is a deploy step someone should be
 * able to run, watch and roll back on its own. `npm run app` and the seed both
 * call this for you; this exists for the case where neither is what you want —
 * an existing database whose schema moved under it.
 */
import { createPool, migrate } from '../db/pool.js';

const db = createPool();
try {
  const ran = await migrate(db);
  console.log(ran.length
    ? `applied ${ran.length} migration(s):\n  ${ran.join('\n  ')}`
    : 'schema is current');
} finally {
  await db.end();
}
