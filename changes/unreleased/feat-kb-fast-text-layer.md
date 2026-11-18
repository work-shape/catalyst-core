---
section: Changed
---

- **Knowledge Bases:** the `text` processor is at version 2: the document worker reads a PDF's
  text layer with PDFium instead of pdfplumber, about 30 times faster on long PDFs (a 222-page
  PDF in 0.7 s instead of 18 s on one core). The next publish of a Knowledge Base states the
  documents it reads again and what that costs; they are read again only once it is confirmed.
  Release the platform and the capabilities together.
