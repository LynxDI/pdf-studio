// Shared string/number helpers used by more than one layer of the engine:
//
//   renderTemplate  — the {token} vocabulary for output filenames, spoken by BOTH
//                     batch output paths (execute.ts) and split part names (the pdf-lib
//                     adapter). One vocabulary, learned once.
//   parseByteSize   — "5MB" / "4.5MiB" / "500KB" / a bare byte count, for the size
//                     constraints on `split` and `compress`.
//
// Pure functions, no I/O — the opw layer stays free of node/pdf-lib imports.

/** Tokens a template may use, mapped to their concrete values for one item. */
export type TemplateTokens = Record<string, string | number>;

/**
 * Substitute `{token}` and `{token:0N}` (zero-padded) in `tpl`.
 *
 * Padding is accepted as `{i:03}` or `{i:03d}` — the trailing `d` is Python `str.format`
 * spelling, kept so a template can be pasted between `split.name` (TypeScript) and
 * `split_invoices.name` (Python) without editing. Padding applies only to numeric tokens;
 * on a string token the width is ignored rather than throwing, because a filename
 * template is not worth failing a 1,500-part render over.
 *
 * An UNKNOWN token is left verbatim (`{foo}` stays `{foo}`) rather than becoming an empty
 * string: a silent deletion turns "report-{indx}.pdf" into "report-.pdf" for every part,
 * which collides them all. Leaving it visible makes the typo obvious in the output, and
 * the validator warns about it at edit time.
 */
export function renderTemplate(tpl: string, tokens: TemplateTokens): string {
  return tpl.replace(/\{([a-z_][a-z0-9_]*)(?::(0\d+)d?)?\}/gi, (whole, key: string, pad?: string) => {
    const v = tokens[key];
    if (v === undefined) return whole;
    if (pad && typeof v === "number") return String(v).padStart(Number(pad.slice(1)), "0");
    return String(v);
  });
}

/** Every `{token}` name a template references, in order of first appearance. */
export function templateTokens(tpl: string): string[] {
  const out: string[] = [];
  for (const m of tpl.matchAll(/\{([a-z_][a-z0-9_]*)(?::0\d+d?)?\}/gi)) {
    const k = m[1]!;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/**
 * Parse a human byte size into bytes. Returns null when it isn't a size at all.
 *
 *   "5MB" → 5_000_000      decimal, SI — what a "5 MB limit" usually means in prose
 *   "5MiB" → 5_242_880     binary — what most upload validators actually check
 *   "4.5mb" → 4_500_000    fractional and case-insensitive
 *   5_000_000 → 5_000_000  a bare number is already bytes
 *
 * Decimal and binary are BOTH supported and neither is guessed at, because the difference
 * (5 %) is exactly the margin that decides whether an upload is accepted. We do not apply
 * a hidden safety margin either — a file rejected by a limit we silently shaved would be
 * undebuggable. The docs tell people to leave their own headroom (`4.8MB` for a 5 MB cap).
 */
export function parseByteSize(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = UNITS[(m[2] ?? "b").toLowerCase()]!;
  return Math.floor(n * unit);
}

/** Render a byte count the way the parser would accept it, for notes and errors. */
export function formatByteSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}
