---
section: Added
---

- `http_api` operations accept query parameters declared as arrays of scalar items,
  sent as repeated keys in input order. Each array accepts at most 32 values;
  objects and nested arrays are refused before sending. Save and draft validation
  reject non-scalar item schemas.
