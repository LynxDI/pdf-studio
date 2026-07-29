#!/usr/bin/env python3
"""Deep PDF object map for Lynx PDF Studio's sidebar object tree.

Reads a PDF with PyMuPDF (fitz) and emits a JSON object map on stdout:
per-page images (object_name/xref/size/bbox), text/drawing/link counts, plus
document-level fonts, form fields, bookmarks, and metadata. Every feature is
guarded so a quirky PDF or an older PyMuPDF still yields partial data. On any
fatal condition it prints {"error": "..."} and exits 0 (the caller treats a
missing/`error` result as "deep inspection unavailable").
"""

import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: pdf_inspect.py <pdf>"}))
        return
    path = sys.argv[1]

    try:
        import fitz  # PyMuPDF
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "PyMuPDF not available: %s" % e}))
        return

    try:
        doc = fitz.open(path)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "open failed: %s" % e}))
        return

    out = {
        "page_count": doc.page_count,
        "metadata": {},
        "is_form": False,
        "fields": [],
        "fonts": [],
        "bookmarks": [],
        "pages": [],
    }

    try:
        out["metadata"] = {k: v for k, v in (doc.metadata or {}).items() if v}
    except Exception:
        pass
    try:
        out["is_form"] = bool(getattr(doc, "is_form_pdf", False))
    except Exception:
        pass
    try:
        for entry in (doc.get_toc() or []):
            lvl, title, page = entry[0], entry[1], entry[2]
            out["bookmarks"].append({"title": title, "page": page, "level": lvl})
    except Exception:
        pass

    fonts = {}
    fields = []
    for pno in range(doc.page_count):
        page = doc.load_page(pno)
        rect = page.rect
        pinfo = {
            "index": pno + 1,
            "width": round(rect.width, 1),
            "height": round(rect.height, 1),
            "rotation": int(getattr(page, "rotation", 0) or 0),
            "images": [],
            "text_chars": 0,
        }
        try:
            pinfo["text_chars"] = len(page.get_text() or "")
        except Exception:
            pass
        try:
            for img in page.get_images(full=True):
                xref = img[0]
                width = img[2]
                height = img[3]
                name = img[7] if len(img) > 7 and img[7] else ("xref%d" % xref)
                bbox = None
                try:
                    r = page.get_image_bbox(img)
                    bbox = [round(r.x0, 1), round(r.y0, 1), round(r.width, 1), round(r.height, 1)]
                except Exception:
                    pass
                pinfo["images"].append(
                    {"object_name": name, "xref": xref, "width": width, "height": height, "bbox": bbox}
                )
        except Exception:
            pass
        try:
            for f in page.get_fonts(full=True):
                xref = f[0]
                ftype = f[2] if len(f) > 2 else ""
                basefont = f[3] if len(f) > 3 else ""
                name = f[4] if len(f) > 4 else ""
                key = basefont or name or ("font%d" % xref)
                rec = fonts.setdefault(key, {"name": key, "type": ftype, "pages": set()})
                rec["pages"].add(pno + 1)
        except Exception:
            pass
        try:
            for w in (page.widgets() or []):
                fields.append(
                    {
                        "name": getattr(w, "field_name", None),
                        "type": getattr(w, "field_type_string", None),
                        "page": pno + 1,
                        "value": getattr(w, "field_value", None),
                    }
                )
        except Exception:
            pass
        out["pages"].append(pinfo)

    out["fonts"] = [
        {"name": f["name"], "type": f["type"], "pages": sorted(list(f["pages"]))} for f in fonts.values()
    ]
    out["fields"] = fields
    print(json.dumps(out))


main()
