# Licensing

Lynx PDF Studio Automation is licensed under the **GNU Affero General Public License, version 3 or
later** (AGPL-3.0-or-later). The full text is in [LICENSE](LICENSE).

## Why AGPL

Several of the optional backends Lynx PDF Studio Automation builds on are themselves AGPL — notably
**PyMuPDF** and **Ghostscript**, both dual-licensed by Artifex Software. Adopting the same
licence removes any question about how this project relates to them: a copyleft work
building on copyleft components is the case those licences were written for.

## What this means for you

**Using it — including at work, including commercially — is free and unrestricted.** The
AGPL constrains *redistribution and modification*, not use. Run it on client documents, in
a regulated environment, on anything you like.

**Nothing leaves your machine unless you ask it to.** Rendering is local, and the
extension reports nothing by default: usage analytics are opt-in
(`pdfStudio.telemetry.enabled`, off unless you turn it on, and anonymous even then — never
file names, paths, contents, or anything from your PDFs). The optional backends are
explicit in the same way: OCR-to-a-remote-service and the AI operations upload document
data by definition, so both are disabled until you enable `pdfStudio.allowRemoteRender` /
`pdfStudio.allowAiRequests`.

**If you redistribute it, or ship a modified version, or offer it to users over a network**,
the AGPL requires that those users can obtain the corresponding source under the same
licence.

## Commercial licence

If AGPL does not suit — embedding Lynx PDF Studio Automation in a closed-source product, shipping it inside
a commercial application, or an internal policy that prohibits AGPL — a **commercial licence
is available**. That removes the copyleft obligations.

This is the same arrangement Artifex offers for Ghostscript and PyMuPDF, and it exists for
the same reason: the licence should not be the thing that stops you.

Contact **[lynxdi.com](https://www.lynxdi.com/pdf)** to discuss a commercial licence or a
custom integration.

## Third-party components

See [extension/NOTICE](extension/NOTICE). Everything bundled with the extension is
permissively licensed (MIT / Apache-2.0 / ISC). The optional tools — Python + PyMuPDF,
Ghostscript, qpdf, LibreOffice, Tesseract, ffmpeg and the rest — are **not distributed
with it**; you install them yourself, from their own publishers, under their own terms.

## Contributing

The source is public and you are welcome to read it, fork it, and open issues — bug
reports and feature requests are genuinely useful right now.

Code contributions are **not being accepted yet**, and that is a licensing question rather
than a lack of interest. Because a commercial licence is offered alongside the AGPL (above),
inbound contributions need an agreement that lets Lynx DI offer the combined work under
both — otherwise a merged patch would quietly make the commercial licence unofferable. That
agreement is not written yet. It will be published here, with a `CONTRIBUTING.md`, before
any pull request is merged.

If you have already written something you would like included, open an issue and say so —
it is worth sorting the paperwork out for.
