---
section: Fixed
---

- **Connections:** the page of an MCP Connection waits for its tools only after a discovery was
  asked for: after a change, after "Read tools again", or while a new Connection's first one is
  not in. It stops as soon as a failure is written after it asked, instead of showing "Reading
  the tools of the server." for 90 seconds. Where nobody is signed in whose sign-in reads the
  tools (the reader on a personal Connection, anybody on a shared one), Discovered tools says so
  at once and leads to the page's sign-in. `connections.get` answers `recordedAt`, when the
  instance last wrote the Connection's state.
