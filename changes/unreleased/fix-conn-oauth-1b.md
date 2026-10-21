---
section: Fixed
---

- **Connections:** a REST API Connection's client secret and sign-in are bound to the full token, authorization and revocation addresses, the `issuer` its settings name and the client id, no longer to their origins alone: a new path on the same host (another tenant of a multi-tenant provider) or a new issuer ends the sign-in and deletes the client secret. Both now go in the transaction of the config write, not after it, and a refresh or a revocation sends nothing unless the Connection it reads is still bound to the origin the sign-in was made for, so a write landing while a refresh runs cannot have the refresh token or the client secret sent to another token address (CONN-OAUTH-1 review).
- **Connections:** the extra sign-in parameters of a REST API Connection refuse `request`, `request_uri` and `response_mode` too.
- **Connections:** a person-context mapping of a REST API Connection that signs in with OAuth is kept for the API's own origin, so its calls find the mapping and a save of the Connection keeps it; before, every such call answered `person_context_unmapped`.
