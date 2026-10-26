---
section: Changed
---

- The name guard's test support tells customer names from accounting-vendor names. `deniedNames` and `scanProductSource` keep both out by default; a private repository may pass `vendors: false` / `vendorNames: false` so its packages can name the vendors they connect, while customer names stay banned everywhere.
