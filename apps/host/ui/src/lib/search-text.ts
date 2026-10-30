/**
 * Text matching shared by the sidebar's session search and the Settings search.
 *
 * Both answer the same question the same way — does a row say every word the
 * operator typed, somewhere in its visible text — so a query that finds a
 * session in one place finds it in the other, and the highlight always marks
 * the reason a row is in the list.
 */

/**
 * The words of a query, lowercased, in typed order.
 *
 * Whitespace separates terms rather than being searched for: "checkout lint"
 * is two things the row must mention, not one phrase it must contain. A term
 * typed twice is kept once so it cannot double its weight in a ranking.
 */
export function searchTerms(query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(terms)];
}

/**
 * Whether every term appears in at least one of the fields.
 *
 * Terms may land in different fields, which is what lets "checkout weili" find
 * the sessions of one project on one machine. No terms means no search, and
 * everything matches.
 */
export function matchesAllTerms(
  fields: readonly string[],
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const haystack = fields.map((field) => field.toLowerCase());
  return terms.every((term) => haystack.some((field) => field.includes(term)));
}

export type HighlightSegment = { text: string; match: boolean };

/**
 * `text` cut into the runs that match a term and the runs between them.
 *
 * Overlapping and touching matches merge into one run, so "check" and "kout"
 * over "checkout" mark one word rather than two adjacent fragments.
 */
export function highlightSegments(
  text: string,
  terms: readonly string[],
): HighlightSegment[] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) {
      ranges.push([at, at + term.length]);
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
      continue;
    }
    merged.push([start, end]);
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
