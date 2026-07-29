// Static capability metadata + a lightweight registry for compile-time PLAN
// PREVIEWS (never execution). The MCP server and any "what would run this?"
// tooling can resolve capabilities without importing the real adapters — which
// keeps pdf-lib (and the Python sidecar wiring) out of those bundles.

import type { Capability } from "../opw/operations.js";
import type { DocumentKind } from "../opw/model.js";
import { AdapterRegistry, type AdapterResult, type RendererAdapter } from "./adapter.js";

/** Capabilities the bundled pdf-lib backend can execute (kept in sync here so
 *  both the real adapter and preview tooling share one source of truth). */
export const PDFLIB_CAPABILITIES: Capability[] = [
  "merge",
  "split",
  "delete_pages",
  "reorder_pages",
  "move_pages",
  "swap_pages",
  "rotate_pages",
  "insert_blank",
  "title_page",
  "insert_pages",
  "replace_pages",
  "extract_pages",
  "watermark",
  "set_metadata",
  "set_language",
  "compress",
  "crop",
  "scale_pages",
  "add_page_numbers",
  "header_footer",
  "stamp",
  "n_up",
  "overlay",
  "images_to_pdf",
  "single_page",
];

/** Capabilities the optional PyMuPDF / ocrmypdf backend can execute. */
export const PYTHON_CAPABILITIES: Capability[] = [
  "split_invoices",
  "compare_pdfs",
  "annotate",
  "highlight",
  "summarize",
  "translate",
  "extract_text",
  "semantic_search",
  "flip_pages",
  "recolor",
  "scanner_effect",
  "extract_js",
  "set_view_preferences",
  "extract_markdown",
  "extract_images",
  "replace_image",
  "replace_text",
  "redact",
  "ocr",
  "fill_field",
  "fill_form",
  "create_form",
  "extract_form",
  "extract_receipt",
  "pdf_to_epub",
  "epub_to_pdf",
  "images_to_pdf",
  "flatten",
  "encrypt",
  "decrypt",
  "linearize",
  "render_pages",
  "remove_blank_pages",
  "remove_annotations",
  "remove_images",
  "sanitize",
  "auto_redact",
  "set_bookmarks",
  "extract_bookmarks",
  "extract_attachments",
  "extract_links",
  "extract_annotations",
  "add_links",
  "add_attachments",
  "extract_fields",
  "extract_tables",
  "repair",
  "decompress",
  "set_permissions",
  "unlock_forms",
  "pdf_to_pdfa",
  "rasterize",
  "booklet",
  "poster",
  "html_to_pdf",
  "markdown_to_pdf",
  "url_to_pdf",
  "eml_to_pdf",
  "sign",
  "validate_signature",
  "timestamp",
  "pdf_info",
  "check_accessibility",
  "tag_pdf",
  "text_report",
  "inspect_text",
];

/** Capabilities the optional ffmpeg backend can execute. */
export const VIDEO_CAPABILITIES: Capability[] = ["video_to_pdf"];

/** Capabilities the optional LibreOffice backend (soffice) can execute. */
export const OFFICE_CAPABILITIES: Capability[] = ["office_to_pdf", "pdf_to_docx", "pdf_to_pptx", "pdf_to_xlsx", "pdf_to_html"];

/** A no-op adapter carrying only metadata — usable for compile resolution, never execution. */
function capabilityAdapter(id: string, capabilities: readonly Capability[]): RendererAdapter {
  return {
    id,
    kinds: ["pdf"] as DocumentKind[],
    capabilities,
    isAvailable: async () => true,
    apply: async (): Promise<AdapterResult> => {
      throw new Error(`capability-only adapter "${id}" cannot execute`);
    },
  };
}

/**
 * A registry for compile PREVIEWS that mirrors the bundled backend's
 * capabilities without pulling in pdf-lib. Matches {@link defaultRegistry}'s
 * resolution (pdf-lib only) so `opw_compile` reports the same satisfied /
 * unsatisfied capabilities.
 */
export function capabilityRegistry(): AdapterRegistry {
  return new AdapterRegistry([capabilityAdapter("pdf-lib", PDFLIB_CAPABILITIES)]);
}
