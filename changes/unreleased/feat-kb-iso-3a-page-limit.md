---
section: Added
---

- **Knowledge Bases:** A PDF or DOCX of more than `knowledge.maxPagesPerDocument` pages (release config, 500 by default, at most 5,000) fails with the new code `knowledge_file_too_many_pages` instead of being converted. The extract job passes the limit to the extractor, which counts the pages before it reads their text; core also refuses an extraction that answers more pages than the limit. The Documents section says "More than 500 pages" ("Mehr als 500 Seiten") and offers Retry, which extracts the file again once the limit is raised. The limit applies to Knowledge Base extraction only; chat uploads keep their own limits. `KnowledgeExtractor.extract` and `defineKnowledgeExtractHandler` now take `maxPages`.
