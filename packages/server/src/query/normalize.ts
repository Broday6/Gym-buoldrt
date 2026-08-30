/**
 * Query normalisation shared by the analyser, the synonym engine and the
 * SQLite dev engine. Deliberately light: the retrieval core owns tokenising and
 * stemming for matching, this exists so rules and synonyms compare apples to
 * apples.
 */

export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'what', 'where', 'which', 'will', 'with', 'you', 'your', 'need',
  'looking', 'something', 'want',
]);

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenise(text: string): string[] {
  return normalise(text)
    .split(/[^a-z0-9''\/\-.]+/)
    .map((t) => t.replace(/^[-.']+|[-.']+$/g, ''))
    .filter(Boolean);
}

/**
 * Conservative plural folding. Not a full stemmer: over-stemming ("beams" and
 * "beam" fine, but "moulding" must not become "mould") costs more precision
 * than it buys recall on a millwork catalogue.
 */
export function singularise(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2);
  if (word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

/**
 * Split agglutinated compounds ("crownmoulding" -> "crown moulding") against a
 * vocabulary drawn from the index. Only fires when both halves are known words
 * of at least 3 characters, which keeps "endurathane" intact.
 */
export function splitCompound(word: string, vocabulary: Set<string>): string[] | null {
  if (word.length < 8 || vocabulary.has(word)) return null;
  for (let i = 3; i <= word.length - 3; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    if (vocabulary.has(left) && vocabulary.has(right)) return [left, right];
  }
  return null;
}

/** Levenshtein distance, capped so long non-matches bail out early. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/** Typo budget by word length, per the search-config contract. */
export function typoBudget(
  word: string,
  cfg: { minWordLengthFor1Typo: number; minWordLengthFor2Typos: number },
): number {
  // Anything carrying digits is a part number or a size: no typo tolerance.
  if (/\d/.test(word)) return 0;
  if (word.length >= cfg.minWordLengthFor2Typos) return 2;
  if (word.length >= cfg.minWordLengthFor1Typo) return 1;
  return 0;
}
