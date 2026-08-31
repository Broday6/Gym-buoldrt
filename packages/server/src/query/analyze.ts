import type { ParsedConstraint, QueryType } from '@compass/shared';
import { liftEntities, type EntityIndex } from './entities.js';
import { parseDimensions } from './dimensions.js';
import { STOPWORDS, normalise, singularise, splitCompound, tokenise } from './normalize.js';

export interface AnalyzedQuery {
  raw: string;
  type: QueryType;
  /** Text handed to the retrieval engine after constraints were lifted out. */
  searchText: string;
  terms: string[];
  constraints: ParsedConstraint[];
  /** Set when the whole query is a part number. */
  skuCandidate?: string;
  /** True when the router wants semantic retrieval weighted up. */
  preferSemantic: boolean;
  /** True when typo tolerance must be switched off (part numbers, sizes). */
  exactOnly: boolean;
}

/**
 * A part number looks like BMV4X6X120SM: one token, no spaces, mixes letters
 * and digits, and is long enough that it cannot be a plain size like 4x6.
 */
export function looksLikeSku(token: string): boolean {
  if (token.length < 5 || token.length > 40) return false;
  if (!/^[a-z0-9][a-z0-9\-_.\/]*$/i.test(token)) return false;
  const hasLetter = /[a-z]/i.test(token);
  const hasDigit = /\d/.test(token);
  if (!hasLetter || !hasDigit) return false;
  // `4x6`, `4x6x12` and `12ft` are dimensions, not part numbers.
  if (/^\d+(\.\d+)?\s*[x×]/i.test(token)) return false;
  if (/^\d+(\.\d+)?(in|ft|cm|mm|m|inch|inches|foot|feet)$/i.test(token)) return false;
  return true;
}

const NL_MARKERS = /\b(what|which|how|where|that|for|cover|between|need|looking|something|instead|goes?|fit|hide|seam)\b/i;

export interface AnalyzeOptions {
  /** Index vocabulary used for compound splitting. Optional. */
  vocabulary?: Set<string>;
  /** Brands and product types the catalogue actually carries. Optional. */
  entities?: EntityIndex;
}

export function analyzeQuery(raw: string, options: AnalyzeOptions = {}): AnalyzedQuery {
  const text = normalise(raw);
  if (!text) {
    return {
      raw,
      type: 'empty',
      searchText: '',
      terms: [],
      constraints: [],
      preferSemantic: false,
      exactOnly: false,
    };
  }

  const rawTokens = tokenise(text);

  // 1. Part number path: exact/prefix match, no typo tolerance, no semantics.
  if (rawTokens.length === 1 && looksLikeSku(rawTokens[0]!)) {
    return {
      raw,
      type: 'sku',
      searchText: rawTokens[0]!,
      terms: rawTokens,
      constraints: [
        { field: 'sku', value: rawTokens[0]!.toUpperCase(), source: rawTokens[0]!, kind: 'sku' },
      ],
      skuCandidate: rawTokens[0]!.toUpperCase(),
      preferSemantic: false,
      exactOnly: true,
    };
  }

  // 2. Lift dimensions out of the text so they filter instead of competing as
  //    search terms — "4x6 beam 12ft" should match on "beam" plus three filters.
  const { constraints, residual } = parseDimensions(text);

  let terms = tokenise(residual).filter((t) => !STOPWORDS.has(t));
  if (options.vocabulary) {
    terms = terms.flatMap((t) => splitCompound(t, options.vocabulary!) ?? [t]);
  }

  // 3. Lift the brands and product types the catalogue actually carries, so
  //    "heritage beams" filters to that brand's beams instead of asking the
  //    index whether those characters appear anywhere in a document.
  //    Before singularising, because the entity dictionary holds both forms
  //    and a blind singulariser mangles names ("Columns Direct").
  const entityMatch = options.entities
    ? liftEntities(terms, options.entities)
    : { constraints: [], residual: terms };
  constraints.push(...entityMatch.constraints);
  terms = entityMatch.residual.map(singularise);

  // 3. Natural language: long, or built from question/relation words with few
  //    catalogue nouns left once stopwords are gone.
  const wordCount = rawTokens.length;
  const isNaturalLanguage =
    constraints.length === 0 && (wordCount >= 6 || (wordCount >= 4 && NL_MARKERS.test(text)));
  const entityOnly = terms.length === 0 && entityMatch.constraints.length > 0;

  const type: QueryType = isNaturalLanguage
    ? 'natural_language'
    // "beams" or "ekena beams" is a browse of something specific, not a
    // keyword search that happens to have returned nothing to match on.
    : entityOnly || entityMatch.constraints.length > 0
      ? (constraints.some((c) => c.kind === 'dimension' || c.kind === 'unit')
        ? 'dimensional' : 'entity')
      : constraints.length > 0
        ? 'dimensional'
        : 'keyword';

  return {
    raw,
    type,
    searchText: terms.join(' '),
    terms,
    constraints,
    preferSemantic: isNaturalLanguage,
    // Sizes must match exactly; the words around them may still be fuzzy.
    exactOnly: false,
  };
}
