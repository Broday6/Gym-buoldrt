/**
 * Write the OpenAPI document to disk.
 *
 *   npm run openapi            # regenerate docs/openapi.json
 *   npm run openapi -- --check # fail if it is out of date
 *
 * The `--check` mode is what keeps §4.13's "kept current" honest: CI runs it,
 * so adding an endpoint without regenerating the spec fails the build rather
 * than shipping a document that quietly describes the previous version.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { generateSpec } from '../routes/spec.js';

const OUT = 'docs/openapi.json';
const spec = `${JSON.stringify(await generateSpec(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`${OUT} does not exist — run: npm run openapi`);
    process.exit(1);
  }
  if (current !== spec) {
    console.error(
      `${OUT} is out of date.\n\nThe routes or their schemas changed. Regenerate with:\n\n  npm run openapi\n`,
    );
    process.exit(1);
  }
  console.log(`${OUT} is current`);
} else {
  writeFileSync(OUT, spec);
  const paths = Object.keys((JSON.parse(spec) as { paths: object }).paths).length;
  console.log(`wrote ${OUT} — ${paths} paths`);
}
