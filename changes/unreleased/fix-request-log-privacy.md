---
section: Fixed
---

- **Privacy:** Request logs retain query parameter names while redacting every value except numeric `limit` values. Token-bearing app-content and password-reset paths use stable placeholders, including malformed addresses and route-not-found messages. The shared process logger applies this policy to the API, workers and outside-forms host.
