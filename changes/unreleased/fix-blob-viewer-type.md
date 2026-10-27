---
section: Fixed
---

- **Chat UI:** A file the interface fetches itself (a client without browser-managed downloads) and frames or opens as a `blob:` address now takes the type its viewer expects: `application/pdf` for the PDF frame, `text/plain` for text, and a PNG, JPEG, WebP or GIF type for an image (PNG where the fetched type is none of them). Before, an HTML file named `*.pdf` or served as an image kept `text/html` and ran on the interface origin. A cited Knowledge Base HTML or Markdown file opens as plain text, and a cited SVG or any file no viewer shows is saved instead of opened.
