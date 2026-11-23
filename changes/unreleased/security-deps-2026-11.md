---
section: Fixed
---

- **Security:** Sign-in moves to better-auth 1.7.27, which closes the OAuth state, OAuth Proxy, device approval and rate-limit advisories. Validation moves to Zod 4.6.7, which closes the memory exhaustion on oversized collections. The remaining advisories in the parser, HTTP and docs dependencies are closed by patched releases.
- **API:** A timestamp without seconds, such as `2026-09-30T12:00Z`, is now refused where the API asks for a date-time. Date-time parameters of app actions keep taking it. String length limits now count Unicode code points.
