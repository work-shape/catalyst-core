---
section: Changed
---

- A document source may list an item without a size (CS-16). The sync keeps 0 for it, the fetch's bytes decide, and a first pass that waits for its confirmation assumes a size per format for such items, so the estimate is not zero. The contract test kit checks the fetched bytes against the listed size only where the source lists one.
- A catalogue entry whose tools and source parts reach the same host adds it to the egress list once.
