---
section: Fixed
---

- HTTP API query arrays no longer have a fixed 32-value cap. Declared `maxItems` still applies. The connector refuses a final encoded request URL over 8,000 bytes as `input_invalid` with `the request URL exceeds HTTP_API_REQUEST_URL_MAX_BYTES (8000 bytes)`, including long scalar values. Query declaration and validation guidance now lives in the release-config docs. No migration; rolling back restores the 32-value cap and removes the request URL bound.
