// Page-list parsing — the one place OPW turns a `pages:`-style param into
// concrete 1-based page numbers.
//
// A page list is an array whose items are either numbers or compact range
// tokens. `split` has always spoken ranges (`ranges: ["1-3", "4-10"]`); this
// makes every other page param speak the same notation, so "delete pages
// 300-800" is one token instead of 501 integers:
//
//   pages: [1, 3, "5-8"]     → 1, 3, 5, 6, 7, 8
//   pages: ["10-last"]       → 10 … final page
//   pages: ["last"]          → the final page
//   pages: ["8-5"]           → 8, 7, 6, 5   (descending — order is preserved
//                              for order-sensitive ops like reorder_pages)
//
// Order is preserved as written and duplicates are NOT collapsed: reorder_pages
// needs the exact sequence, and every other caller wraps the result in a Set.
// Out-of-range pages are dropped rather than throwing — the adapter's long-
// standing batch-friendly behavior (one stray number shouldn't abort 500 files).

/** A page token as authored: 5, "5", "5-8", "5-last", "last". */
export type PageToken = number | string;

const LAST = "last";

/**
 * Check page-list syntax WITHOUT knowing the page count (validate-time).
 * Returns an error message describing the first bad token, or null if the whole
 * list is well-formed.
 */
export function checkPageListSyntax(value: unknown): string | null {
  if (!Array.isArray(value)) return "must be an array of page numbers or ranges";
  for (const item of value) {
    if (typeof item === "number") {
      if (!Number.isInteger(item) || item < 1) {
        return `contains an invalid page number (${item}) — pages are 1-based integers`;
      }
      continue;
    }
    if (typeof item !== "string") {
      return "must contain only page numbers or range strings";
    }
    if (parseToken(item) === null) {
      return `contains an unparseable page range ${JSON.stringify(item)} — use 5, "5-8", "5-last" or "last"`;
    }
  }
  return null;
}

/**
 * Expand a page list to 1-based page numbers, in the order written.
 * Out-of-range and unparseable entries are dropped. `pageCount` resolves
 * "last" and open-ended ranges.
 */
export function expandPageList(value: unknown, pageCount: number): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === "number") {
      if (Number.isInteger(item) && item >= 1 && item <= pageCount) out.push(item);
      continue;
    }
    if (typeof item !== "string") continue;
    const parsed = parseToken(item);
    if (!parsed) continue;
    const from = resolve(parsed.from, pageCount);
    const to = resolve(parsed.to, pageCount);
    if (from === null || to === null) continue;
    // Clamp to the document BEFORE iterating, never inside the loop: an
    // authored "1-999999999" must cost the document's page count, not a
    // billion iterations, in both the validator and the renderer.
    const lo = Math.max(1, Math.min(from, to));
    const hi = Math.min(pageCount, Math.max(from, to));
    if (lo > hi) continue;
    if (from <= to) for (let p = lo; p <= hi; p++) out.push(p);
    else for (let p = hi; p >= lo; p--) out.push(p);
  }
  return out;
}

/** Expand to 0-based indices — what adapters actually index with. */
export function expandPageIndices(value: unknown, pageCount: number): number[] {
  return expandPageList(value, pageCount).map((p) => p - 1);
}

/**
 * The largest page number a list explicitly names, ignoring "last" and
 * open-ended ranges (which have no fixed value). Returns 0 when nothing is
 * named. Used to sanity-check an order against a document it must cover.
 */
export function maxNamedPage(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let max = 0;
  for (const item of value) {
    if (typeof item === "number") {
      if (Number.isInteger(item)) max = Math.max(max, item);
      continue;
    }
    if (typeof item !== "string") continue;
    const parsed = parseToken(item);
    if (!parsed) continue;
    for (const end of [parsed.from, parsed.to]) {
      if (typeof end === "number") max = Math.max(max, end);
    }
  }
  return max;
}

/** True when the list contains a token whose value depends on the page count. */
export function isPageCountRelative(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => typeof item === "string" && parseToken(item)?.relative === true);
}

// --- internals --------------------------------------------------------------

type Endpoint = number | "last";
interface ParsedToken {
  from: Endpoint;
  to: Endpoint;
  /** Depends on the document's page count ("last" appears somewhere). */
  relative: boolean;
}

/** Parse one token. Returns null when it isn't valid page-list syntax. */
function parseToken(raw: string): ParsedToken | null {
  const s = raw.trim();
  if (!s) return null;

  const single = parseEndpoint(s);
  if (single !== null) return { from: single, to: single, relative: single === LAST };

  // A range: "5-8", "5-last", "last-5". Split on the first hyphen only, so a
  // stray "5-8-10" is rejected rather than silently read as "5-8".
  const hyphen = s.indexOf("-");
  if (hyphen <= 0 || hyphen === s.length - 1) return null;
  const lhs = parseEndpoint(s.slice(0, hyphen));
  const rhs = parseEndpoint(s.slice(hyphen + 1));
  if (lhs === null || rhs === null) return null;
  return { from: lhs, to: rhs, relative: lhs === LAST || rhs === LAST };
}

function parseEndpoint(raw: string): Endpoint | null {
  const s = raw.trim();
  if (s.toLowerCase() === LAST) return LAST;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 ? n : null;
}

function resolve(end: Endpoint, pageCount: number): number | null {
  if (end === LAST) return pageCount >= 1 ? pageCount : null;
  return end;
}
