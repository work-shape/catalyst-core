---
section: Fixed
---

- **An App that fills its frame no longer scrolls by a few pixels:** the document the platform frames an App or Page in now holds `html, body { margin: 0 !important }`, so an App's own `all: revert` on `body` no longer brings back the browser's default margin. Existing Apps get it without a rebuild. The `workspace.open` description and the App sandbox docs tell agents to size the root with `height: 100%` (`h-full`), not `100vh` plus padding, and not to reset `html` or `body` with `all:`.
