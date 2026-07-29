// Text-level edits to an OPW file's `operations:` list. Works on the raw text
// (not a parse → serialize round-trip) so comments and the exact formatting the
// user wrote are preserved. Pure string functions (no host deps), so they are
// unit-tested in core and reused by the extension's "add / remove operation" UI.

function eolOf(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

/** [firstLineAfter `operations:`, exclusive end) — the block's item lines live here. */
function operationsRange(lines: string[]): { header: number; end: number } | null {
  const header = lines.findIndex((l) => /^operations\s*:/.test(l));
  if (header === -1) return null;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { header, end };
}

/** Indices (into `lines`) of each operation list item within the block. */
function itemLineIndices(lines: string[], header: number, end: number): number[] {
  const out: number[] = [];
  for (let i = header + 1; i < end; i++) {
    if (/^\s*-\s/.test(lines[i]!)) out.push(i);
  }
  return out;
}

/**
 * Where a page-targeted operation must go for its page numbers to mean what the
 * user picked.
 *
 * A page number read off an input document (the object map's "Page 5") is only
 * valid until something renumbers the document. Appending `delete_pages: [5]`
 * to a workflow that already deletes page 1 deletes the WRONG page. So an op
 * carrying input-document page numbers belongs before the first operation that
 * changes pagination.
 *
 * Returns the 0-based operation index to insert at, or -1 for "append" (nothing
 * upstream renumbers anything, so the end is already correct).
 */
export function pageSafeInsertIndex(raw: string, changesPagination: (opName: string) => boolean): number {
  const lines = raw.split(/\r?\n/);
  const range = operationsRange(lines);
  if (!range) return -1;
  const items = itemLineIndices(lines, range.header, range.end);
  for (let i = 0; i < items.length; i++) {
    const name = lines[items[i]!]!.match(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1];
    if (name && changesPagination(name)) return i;
  }
  return -1;
}

/** Append `<op>: <params>` to the operations list, preserving the rest of the file. */
export function insertOperation(raw: string, opName: string, params: string): string {
  return insertOperationAt(raw, opName, params, -1);
}

/**
 * Insert `<op>: <params>` BEFORE the operation at `index` (0-based).
 * `index < 0` or past the end appends, matching {@link insertOperation}.
 */
export function insertOperationAt(raw: string, opName: string, params: string, index: number): string {
  const eol = eolOf(raw);
  const lines = raw.split(/\r?\n/);
  const item = `${opName}: ${params.trim()}`;
  const range = operationsRange(lines);

  if (!range) {
    // No operations block — add one before `output:` (or at end).
    const outIdx = lines.findIndex((l) => /^output\s*:/.test(l));
    const block = ["operations:", `  - ${item}`];
    if (outIdx === -1) return raw.replace(/\s*$/, "") + eol + block.join(eol) + eol;
    lines.splice(outIdx, 0, ...block);
    return lines.join(eol);
  }

  // Inline empty list: `operations: []`
  if (/^operations\s*:\s*\[\s*\]\s*$/.test(lines[range.header]!)) {
    lines[range.header] = "operations:";
    lines.splice(range.header + 1, 0, `  - ${item}`);
    return lines.join(eol);
  }

  const items = itemLineIndices(lines, range.header, range.end);
  const last = items[items.length - 1];
  const indent = last !== undefined ? (lines[last]!.match(/^(\s*)-/)?.[1] ?? "  ") : "  ";
  // Default (index < 0 or past the end): insert at the END of the operations
  // block (range.end), not just after the last dash line — a block-style op
  // (e.g. `set_metadata:` with indented title/author continuation lines) would
  // otherwise be split, producing invalid YAML. Targeting an existing item is
  // safe for the same reason: its dash line starts it.
  const target = index >= 0 && index < items.length ? items[index]! : undefined;
  const insertAt = target ?? (items.length ? range.end : range.header + 1);
  lines.splice(insertAt, 0, `${indent}- ${item}`);
  return lines.join(eol);
}

/** Remove the operation at `index` (0-based), including any continuation lines. */
export function removeOperationAt(raw: string, index: number): string {
  const eol = eolOf(raw);
  const lines = raw.split(/\r?\n/);
  const range = operationsRange(lines);
  if (!range) return raw;
  const items = itemLineIndices(lines, range.header, range.end);
  if (index < 0 || index >= items.length) return raw;
  const start = items[index]!;
  const stop = items[index + 1] ?? range.end;
  lines.splice(start, stop - start);
  return lines.join(eol);
}
