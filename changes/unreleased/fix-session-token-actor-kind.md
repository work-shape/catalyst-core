---
section: Fixed
---

- **A session token names only a service principal as its delegated actor:** the issuer refuses
  any other kind (`A session token names only a service principal as its delegated actor`), and
  verification refuses a signed token that names one (`UNAUTHENTICATED`, `Chat session token names a delegated
actor other than a service principal`). Before, a token signed with the session secret that
  named an API key authenticated, skipped resolving its user and was recorded as the CLI. The
  `session_tokens.issue` route accepted only `service_principal` already, so no caller of the API
  changes.
