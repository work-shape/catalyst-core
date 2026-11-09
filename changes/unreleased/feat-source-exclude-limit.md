---
section: Changed
---

- **Knowledge Bases:** a source's `exclude` holds up to 500 patterns, up from 50, so a parent folder can be the source with its old folders listed once. A pattern that is a literal path ending in `/**` is now decided by a set of folders, which keeps a full pass over tens of thousands of items in milliseconds. What each pattern matches is unchanged, and `include` stays at 50.
