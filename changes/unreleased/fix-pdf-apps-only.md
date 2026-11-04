---
section: Changed
---

- **PDFs from agents:** The instance's HTML to PDF renderer (PDF-1) serves Apps only. Agents have no `workspace.html_to_pdf` tool and make PDFs with the `pdf` skill in their workspace (`pdf_create`, reportlab, LibreOffice), as before; the `platform-docs` skill says so. The preview-capture Compose overlay attaches only the API to the renderer's network, not the agent-run worker.
