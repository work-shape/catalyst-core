---
section: Added
---

- **Knowledge Bases:** a document type can set `readByModel: true`: every page of its documents
  is read by the instance's page-reading model, where `capabilities.documentProcessing.extraction.ocr`
  names one (KB-10). The type's processor revision gets `+model`, so turning it on or off states
  and reads its documents again with the next publish.
- **Usage:** the purpose `knowledge_page_reading` records the model calls that read Knowledge Base
  pages. It is Knowledge Base ingestion, like embedding and field extraction, and counts against
  no chat budget.
- **Capabilities:** a capability can hand a model images (`{ type: "image" }`, JPEG or PNG).
