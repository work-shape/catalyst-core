---
section: Fixed
---

- **Connections:** `connections.set_secret` (`PUT /api/v1/connections/:name/secret`) takes `expectedRevision`, the revision of the Connection the writer read, beside `expectedVersion`, and refuses with 409 `CONFLICT` (`connection_changed`) when the Connection changed since. The secret is stored under a held read of the Connection, so a write that changes the token address, the issuer or the client while an admin types a client secret can no longer have that secret sent to the new address (CONN-OAUTH-1c). The New connection dialog, the Connection page, the sign-in step and `catalyst connection secret set`, which reads the revision before its prompt, send it. A caller of the API that sends no `expectedRevision` is refused with `VALIDATION_FAILED`.
