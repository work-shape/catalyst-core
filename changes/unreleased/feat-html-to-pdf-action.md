---
section: Added
---

- **HTML to PDF (PDF-1):** An App makes a PDF with the App Kit's `pdf.download(html, filename, options?)` or `pdf.fromHtml(html, options?)` (kit 1.10.0), and an agent with the `workspace.html_to_pdf` tool, offered to every agent that writes workspace files, which writes the PDF to the workspace and offers it as a download. The instance prints in the isolated preview-capture renderer (`POST /pdf`): no network, no scripts, only inline styles and `data:` addresses. At most 4 MiB of HTML, 50 pages, 10 MiB of PDF and 20 seconds per render, and 10 renders a minute per App frame. Nothing of the document or the PDF is logged or audited. The renderer is off until `PREVIEW_CAPTURE_ENABLED=true`; the Compose overlay now also attaches the agent-run worker to the renderer's network.
