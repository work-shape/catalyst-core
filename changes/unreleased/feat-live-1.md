---
section: Added
---

- **Workflows:** Workflows may omit `runAs`. Publishing creates a hidden, Workflow-owned technical account with only the named assets' use rights derived from its steps. Every right must be transferable by the publisher. Each publish reconciles those grants, and draft tests use the derived rights as their ceiling. Explicit shared accounts keep their existing checks. Unpublishing removes the owned account and its rights while preserving the draft.
