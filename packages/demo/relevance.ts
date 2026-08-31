/**
 * Run the judged queries and compare against the committed baseline.
 *
 *   npm run relevance                 # demo catalogue, compare to baseline
 *   npm run relevance -- --update     # accept the current numbers as the baseline
 *   npm run relevance -- --csv export.csv
 *   npm run relevance -- --no-learn   # without attribute recovery, to price it
 *   npm run relevance -- --verbose    # print the top results for every case
 *
 * The comparison is the point. A suite that only reports pass/fail says
 * nothing when a change moves a case from 9 correct results out of 10 to 4 —
 * still failing, four times worse. Precision per case is recorded, and any
 * drop is a regression that fails the run.
 *
 * `--update` exists because a baseline is a record of what the engine does,
 * not a claim that it is right. Improving the engine is supposed to move these
 * numbers; the review of that commit is where the new numbers get looked at.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildCorpus } from '../server/src/relevance/corpus.js';
import { cases } from '../server/src/relevance/cases.js';
import { scoreCase, summarise, type CaseResult } from '../server/src/relevance/judge.js';
import { generateCatalogCsv } from './generate-catalog.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const BASELINE = value('baseline') ?? 'packages/server/relevance-baseline.json';
const K_PRODUCTS = Number(value('products') ?? 520);

interface Baseline {
  /** What produced these numbers, so a mismatched baseline is obvious. */
  corpus: { products: number; variants: number; learn: boolean };
  score: number;
  cases: Record<string, { precision: number; coverage: number | null; pass: boolean }>;
  generatedAt: string;
}

async function main(): Promise<void> {
  // The demo catalogue by default; a real export when one is handed over. The
  // judgments are predicates rather than SKU lists precisely so that swap
  // costs nothing.
  const csv = value('csv')
    ? readFileSync(value('csv')!, 'utf8')
    : generateCatalogCsv({ productCount: K_PRODUCTS, seed: 20260830 });

  const learn = !flag('no-learn');
  const corpus = buildCorpus(csv, { learn });
  const suite = cases(corpus);

  process.stdout.write(`relevance: ${suite.length} judged queries against `
    + `${corpus.products} products / ${corpus.docs.length} variants`
    + `${learn ? ', attribute recovery on' : ''}\n\n`);

  if (corpus.learned) {
    const l = corpus.learned;
    process.stdout.write(`  recovered ${l.filled} attribute values on ${l.rowsChanged} rows `
      + `(${Object.entries(l.byKey).map(([k, n]) => `${k} ${n}`).join(', ')}), `
      + `declined ${l.declined} as ambiguous\n\n`);
  }

  const results: CaseResult[] = [];
  for (const testCase of suite) {
    const response = await corpus.service.search(corpus.site, {
      q: testCase.query,
      hitsPerPage: testCase.k ?? 10,
    });
    results.push(scoreCase(testCase, response, corpus.lookup, corpus.docs));
  }

  const result = summarise(results);
  report(results, flag('verbose'));

  const baseline = existsSync(BASELINE)
    ? JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline
    : null;

  if (flag('update') || !baseline) {
    const next: Baseline = {
      corpus: { products: corpus.products, variants: corpus.docs.length, learn },
      score: result.score,
      cases: Object.fromEntries(results.map((r) => [r.id, {
        precision: r.precision, coverage: r.coverage, pass: r.pass,
      }])),
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`\n${baseline ? 'updated' : 'wrote'} ${BASELINE}`
      + ` — score ${result.score.toFixed(3)}, ${result.passed}/${results.length} passing\n`);
    return;
  }

  const drift = compare(baseline, results);
  process.stdout.write(`\nscore ${result.score.toFixed(3)}`
    + ` (baseline ${baseline.score.toFixed(3)})`
    + `  ·  ${result.passed}/${results.length} passing\n`);

  for (const line of drift.improvements) process.stdout.write(`  better  ${line}\n`);
  for (const line of drift.regressions) process.stdout.write(`  WORSE   ${line}\n`);
  for (const line of drift.added) process.stdout.write(`  new     ${line}\n`);

  if (drift.regressions.length) {
    process.stdout.write('\nA judged query got worse. Fix it, or run with --update if the'
      + ' new behaviour is intended.\n');
    process.exitCode = 1;
    return;
  }
  if (drift.improvements.length) {
    process.stdout.write('\nRun with --update to record the improvement.\n');
  }
}

function compare(baseline: Baseline, results: CaseResult[]) {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const added: string[] = [];
  for (const r of results) {
    const was = baseline.cases[r.id];
    if (!was) {
      added.push(`${r.id} — ${r.precision.toFixed(2)}${r.pass ? '' : ' (failing)'}`);
      continue;
    }
    // A tolerance, because precision over ten results moves in tenths and a
    // float comparison would flag noise as a regression.
    const move = (label: string, before: number | null, after: number | null) => (
      before === null || after === null || Math.abs(after - before) < 0.001
        ? '' : ` ${label} ${before.toFixed(2)}->${after.toFixed(2)}`
    );
    const delta = move('precision', was.precision, r.precision)
      + move('coverage', was.coverage ?? null, r.coverage);
    const worse = r.precision < was.precision - 0.001
      || (r.coverage !== null && was.coverage != null && r.coverage < was.coverage - 0.001);
    const better = r.precision > was.precision + 0.001
      || (r.coverage !== null && was.coverage != null && r.coverage > was.coverage + 0.001);
    if (worse || (was.pass && !r.pass)) {
      regressions.push(`${r.id} —${delta || ' now failing'}`);
    } else if (better || (!was.pass && r.pass)) {
      improvements.push(`${r.id} —${delta}${!was.pass && r.pass ? ' now passing' : ''}`);
    }
  }
  return { regressions, improvements, added };
}

function report(results: CaseResult[], verbose: boolean): void {
  const width = Math.max(...results.map((r) => r.id.length));
  for (const r of results) {
    const mark = r.pass ? 'ok  ' : 'FAIL';
    process.stdout.write(`  ${mark} ${r.id.padEnd(width)}  `
      + `p ${r.precision.toFixed(2)}  `
      + `c ${r.coverage === null ? '   -' : r.coverage.toFixed(2)}  `
      + `${String(r.totalHits).padStart(4)}/${String(r.expected ?? '-').padEnd(4)}  `
      + `"${r.query}"\n`);
    for (const failure of r.failures) {
      process.stdout.write(`       ${' '.repeat(width)}  ${failure}\n`);
    }
    if (!r.pass || verbose) {
      process.stdout.write(`       ${' '.repeat(width)}  intent: ${r.intent}\n`);
      for (const hit of r.top) {
        process.stdout.write(`       ${' '.repeat(width)}    ${hit}\n`);
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});
