/**
 * The check that has to run before tsx exists.
 *
 * `npm run app` is a TypeScript entry point, so without dependencies installed
 * it fails as `'tsx' is not recognized` — which names a tool the reader has
 * never heard of and does not mention the one command that fixes it. Plain
 * Node, no imports beyond the standard library, so this runs on a bare clone.
 */
import { existsSync } from 'node:fs';

if (!existsSync('./node_modules/tsx')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.error('\n  Dependencies are not installed yet.\n');
  console.error(`    ${npm} install\n`);
  console.error('  Then run this again.\n');
  process.exit(1);
}
