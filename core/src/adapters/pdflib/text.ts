// Text helpers for the bundled pdf-lib backend: making user-supplied prose safe to draw
// with a StandardFont, and breaking it into lines that fit a column.
//
// Lives beside the adapter rather than in opw/ because it encodes StandardFont/WinAnsi
// knowledge and takes a PDFFont — the opw layer is deliberately pdf-lib-free.
//
// ---------------------------------------------------------------------------------
// The hazard this exists for is NOT the obvious one.
//
// WinAnsi is cp1252, and cp1252 encodes every "smart typography" character people assume
// is the problem: — – ' ' " " … • € ™ † ‡ ‰ ° × and all of Latin-1. A sanitizer that
// rewrote those to ASCII would fix nothing and would DEGRADE correct output.
//
// What actually breaks is a measure/draw asymmetry in pdf-lib itself:
//
//     font.widthOfTextAtSize("a\nb", 12)   ->  THROWS: WinAnsi cannot encode "\n"
//     page.drawText("a\nb", { ... })       ->  fine (drawText runs cleanText/lineSplit
//                                               internally; the measure path does not)
//
// Every centring path in the adapter measures FIRST, so a two-line title written as a YAML
// block scalar throws on the measurement, not on the draw. `wrapText` splits on newlines
// before measuring, which fixes that structurally rather than as a special case.
//
// The genuinely unencodable set is: ligatures (ﬁ ﬂ), Latin Extended (ł č ș ğ ā ő), every
// non-Latin script, arrows and primes (→ ′ ″ −), zero-width marks — and the whitespace
// controls above.

import type { PDFFont } from "pdf-lib";

export interface SanitizeResult {
  text: string;
  /** Characters that could not be represented, deduped, in first-seen order. */
  replaced: string[];
}

/** Characters cp1252 cannot take, mapped to a readable stand-in. Deliberately does NOT
 *  include em dashes, curly quotes, ellipsis, bullets or currency marks — those encode. */
const TRANSLITERATE: Record<string, string> = {
  // Ligatures — common in text copied out of a typeset PDF.
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "ft", "ﬆ": "st",
  // Dashes and minus signs that AREN'T the encodable — and –.
  "‐": "-", "‑": "-", "‒": "-", "⁃": "-", "−": "-",
  "―": "—", // horizontal bar -> em dash (an UPGRADE: the em dash encodes fine)
  // Primes, fractions, misc punctuation.
  "′": "'", "″": '"', "⁄": "/", "№": "No.", "ℓ": "l", "℮": "e",
  // Arrows and relations.
  "→": "->", "←": "<-", "⇒": "=>", "⇐": "<=", "↔": "<->", "≤": "<=", "≥": ">=", "≈": "~", "≠": "!=",
  // Letters NFD cannot decompose (a stroke is part of the glyph, not a combining mark).
  "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ı": "i", "ħ": "h", "ŧ": "t",
  "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ß": "ss", "þ": "th", "Þ": "Th",
};

/** Spaces that aren't U+0020 and aren't encodable (U+00A0 IS encodable — leave it). */
const ODD_SPACES = /[\u2000-\u200A\u202F\u205F\u3000]/g;
/** Zero-width and BOM-ish marks: drop entirely rather than substitute. */
const INVISIBLE = /[\u200B-\u200D\uFEFF\u00AD]/g;
/** C0/C1 controls \u2014 newline deliberately excluded, since wrapText splits on it. */
const CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
/** Combining diacritical marks, for the NFD strip fallback. */
const COMBINING = /[\u0300-\u036F]/g;

/** Can this code point be drawn by a WinAnsi-encoded StandardFont? Probed by asking the
 *  font itself, so it tracks pdf-lib rather than a hand-copied table. */
function encodable(font: PDFFont, ch: string): boolean {
  try {
    font.widthOfTextAtSize(ch, 12);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `text` drawable by `font`, reporting whatever could not be represented.
 *
 * Newlines are PRESERVED — {@link wrapText} splits on them before measuring, which is what
 * keeps the measure path away from a character it would throw on. Tabs become four spaces,
 * matching what pdf-lib's own `cleanText` does at draw time, so our measurement agrees with
 * its rendering.
 */
export function winAnsiSanitize(font: PDFFont, text: string): SanitizeResult {
  const replaced: string[] = [];
  const note = (ch: string) => {
    if (!replaced.includes(ch)) replaced.push(ch);
  };

  // 1. Compose accents: "e" + U+0301 becomes "é", which IS encodable. Free win, and it
  //    catches most text that arrived via macOS filenames or the clipboard.
  let s = text.normalize("NFC");

  // 2. Whitespace and controls.
  s = s
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(ODD_SPACES, " ")
    .replace(INVISIBLE, "")
    // Remaining C0/C1 controls (newline deliberately excluded).
    .replace(CONTROLS, "");

  // 3. Explicit transliteration for the characters cp1252 genuinely lacks.
  s = s.replace(/./gu, (ch) => TRANSLITERATE[ch] ?? ch);

  // 4. Anything still unencodable: strip combining marks (č -> c, ā -> a, ș -> s), then
  //    fall back to "?" and report it.
  s = s.replace(/./gu, (ch) => {
    if (ch === "\n" || encodable(font, ch)) return ch;
    const stripped = ch.normalize("NFD").replace(COMBINING, "");
    if (stripped && stripped !== ch && [...stripped].every((c) => encodable(font, c))) return stripped;
    note(ch);
    return "?";
  });

  return { text: s, replaced };
}

/**
 * Break `text` into lines that each fit `maxWidth` at `size`, honouring explicit newlines.
 *
 * A single word longer than the column is hard-split by character, so a URL or a German
 * compound cannot run off the page.
 *
 * PRECONDITION: `text` must already be WinAnsi-safe (see {@link winAnsiSanitize}) — this
 * measures, and measuring an unencodable character throws.
 *
 * pdf-lib's own `drawText` accepts `maxWidth`/`lineHeight`, but it emits one run at a single
 * x, so wrapped text can only be left-aligned. Centring needs per-line widths, and we need
 * them anyway to compute the block height, so owning the wrap costs nothing extra.
 */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  if (!text) return [];
  if (!(maxWidth > 0)) return [text];
  const width = (s: string) => font.widthOfTextAtSize(s, size);

  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        out.push(line);
        line = "";
      }
      // The word alone may still overflow — hard-split it at the longest fitting prefix.
      let rest = word;
      while (width(rest) > maxWidth && rest.length > 1) {
        let cut = 1;
        while (cut < rest.length && width(rest.slice(0, cut + 1)) <= maxWidth) cut++;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) out.push(line);
  }
  // Trim leading/trailing blank lines; keep interior ones (they are deliberate spacing).
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
