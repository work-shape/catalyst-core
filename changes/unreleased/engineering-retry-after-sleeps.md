---
section: Changed
---

- **Retry advice and waits:** Share the bounded Retry-After parser between Connections and model providers, rejecting oversized headers and non-HTTP dates consistently. Use Node's promise timers for plain sleeps across platform packages while preserving cancellation-aware waits.
