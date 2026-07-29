// PDF introspection for the sidebar's "Document" object tree.
//
// Uses the bundled pdf-lib (zero external deps) to read structural facts — page
// count, per-page size/rotation, and document metadata. Content-level detail
// (fonts, embedded images, text) needs the optional Python backend and is not
// covered here.

import { PDFDocument } from "pdf-lib";

export interface PdfPageInfo {
  /** 1-based page number. */
  index: number;
  /** Width in PDF points. */
  width: number;
  /** Height in PDF points. */
  height: number;
  /** Page rotation in degrees (0/90/180/270). */
  rotation: number;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO date (yyyy-mm-dd) when parseable. */
  created?: string;
  modified?: string;
}

export interface PdfInfo {
  pageCount: number;
  metadata: PdfMetadata;
  pages: PdfPageInfo[];
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}

function isoDate(d: Date | undefined): string | undefined {
  if (!d) return undefined;
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString().slice(0, 10) : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read structural facts + metadata from PDF bytes. Never mutates the document. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages().map((p, i) => {
    const { width, height } = p.getSize();
    return { index: i + 1, width: round2(width), height: round2(height), rotation: p.getRotation().angle };
  });
  const metadata: PdfMetadata = {
    title: nonEmpty(safe(() => doc.getTitle())),
    author: nonEmpty(safe(() => doc.getAuthor())),
    subject: nonEmpty(safe(() => doc.getSubject())),
    keywords: nonEmpty(safe(() => doc.getKeywords())),
    creator: nonEmpty(safe(() => doc.getCreator())),
    producer: nonEmpty(safe(() => doc.getProducer())),
    created: isoDate(safe(() => doc.getCreationDate())),
    modified: isoDate(safe(() => doc.getModificationDate())),
  };
  return { pageCount: doc.getPageCount(), metadata, pages };
}
