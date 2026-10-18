---
section: Fixed
---

- Create dialogs generate valid addresses from multiword names, umlauts and leading digits using the shared address rule.

- Chat accepts TXT and Markdown files without document processing, while specialized handlers keep precedence when available. Text MIME types preserve known file extensions and do not admit unsupported formats.

- Upload files from disk on Knowledge Base pages. TXT and Markdown work in core; PDF and DOCX require document processing. Per-file status and retry preserve files already added.

- Signing out or changing accounts clears upload notices, composer drafts and cached data before the next account's workspace appears. Late responses cannot restore the previous account's state.
