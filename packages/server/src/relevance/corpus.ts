/**
 * The corpus a relevance run is judged against.
 *
 * Built in process from a CSV, held in a `MemoryEngine`, searched through the
 * real `SearchService`. Everything above the engine interface — query analysis,
 * entity recognition, the dimension parser, the tie-breaking cascade, grouping
 * by parent, the business score — is the production code path, so a regression
 * in any of it shows up here.
 *
 * Taking a CSV rather than reaching for the demo generator is the whole point:
 * the same harness runs against a real NetSuite export the day there is one,
 * and the judgments — being predicates about shutters and finishes rather than
 * lists of SKUs — carry over unchanged.
 *
 * No database. Synonyms, redirects, pins and collections all live in Postgres
 * and are therefore absent: this measures what the engine does on its own,
 * which is the layer a code change can break. Merchandising is measured by the
 * experiments that already exist.
 */
import type { SiteConfig, VariantDoc } from '@compass/shared';
import { MemoryEngine } from '../engine/memory.js';
import { SearchService } from '../services/search.js';
import { SiteRegistry } from '../config/sites.js';
import { parseCsv } from '../ingest/pipeline.js';
import { inferMapping } from '../ingest/mapping.js';
import { normalizeRows, toVariantDocs } from '../ingest/normalize.js';
import { learnAttributes, type LearnReport } from '../ingest/learn.js';

export interface Corpus {
  site: SiteConfig;
  service: SearchService;
  docs: VariantDoc[];
  /** Resolve a result back to its document, for attribute judging. */
  lookup: (sku: string) => VariantDoc | undefined;
  products: number;
  /** What attribute learning recovered, when it ran. */
  learned?: LearnReport;
}

export interface CorpusOptions {
  siteId?: string;
  /**
   * Recover attributes stated in text but missing from their column. Defaults
   * to what the ingest pipeline does, so the suite measures what ships; pass
   * false to price the difference.
   */
  learn?: boolean;
}

export function buildCorpus(csv: string, options: CorpusOptions = {}): Corpus {
  const siteId = options.siteId ?? 'ekena';
  const rows = parseCsv(csv);
  const mapping = inferMapping(Object.keys(rows[0] ?? {}));
  const learned = options.learn === false ? undefined : learnAttributes(rows, mapping);
  const { products } = normalizeRows(siteId, rows, mapping);
  const docs = toVariantDocs(siteId, products, mapping.facetable);
  const engine = new MemoryEngine();
  engine.load(siteId, docs);

  const bySku = new Map(docs.map((d) => [d.sku, d]));
  // The ingest offers what the feed carries as filters, and the site adopts
  // them — the same step a real ingest performs. Without it the suite would
  // measure a search that cannot recognise any attribute this feed introduced.
  const registry = new SiteRegistry();
  registry.adoptFacets(siteId, mapping.facetable ?? []);
  return {
    site: registry.require(siteId),
    // The production defaults. A harness that quietly widened the candidate
    // window would report a quality the storefront does not have.
    service: new SearchService(engine),
    docs,
    lookup: (sku) => bySku.get(sku),
    products: products.length,
    learned,
  };
}
