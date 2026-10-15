---
section: Changed
---

- Trim the published `@work-shape/catalyst-chat-ui` package by scanning its compiled JavaScript for Tailwind classes instead of shipping a duplicate TypeScript implementation. Keep the stylesheet, Vite helpers, types and runtime chunks in the package, and the full source for workspace development.
