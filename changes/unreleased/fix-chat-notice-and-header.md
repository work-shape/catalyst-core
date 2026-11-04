---
section: Fixed
---

- **Chat:** From 768 px up a conversation alone scrolls to the window's top again, with the agent picker floating over it on its own opaque backdrop; a browser test now fails if a band covers the top again.
- **Guardrails:** The composer no longer says which parts of a message the guardrails could not check ("Not checked"). Warnings and blocks still show; what went unchecked stays in the guardrail results admins read (GR-4).
