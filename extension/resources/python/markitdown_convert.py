#!/usr/bin/env python3
"""Convert ANY file to Markdown via Microsoft MarkItDown, for the extension's
"Convert File to Markdown" command. Standalone (not part of the OPW pipeline) —
it operates on an arbitrary file, not a PDF working document.

Usage:  markitdown_convert.py <input-path> <output-md-path>
Prints a single JSON line: {"ok": bool, "chars": int, "out": str, "error"?: str}
"""

import sys
import json


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: markitdown_convert.py <in> <out>"}))
        return
    in_path, out_path = sys.argv[1], sys.argv[2]
    try:
        from markitdown import MarkItDown
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "MarkItDown not installed: %s" % e}))
        return
    try:
        result = MarkItDown().convert(in_path)
        text = getattr(result, "text_content", None) or getattr(result, "markdown", None) or ""
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        print(json.dumps({"ok": True, "chars": len(text), "out": out_path}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))


if __name__ == "__main__":
    main()
