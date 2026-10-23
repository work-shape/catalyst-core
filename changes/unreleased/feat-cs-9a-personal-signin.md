---
section: Added
---

Personal OAuth sign-ins for `http_api` and `mcp` Connections. Each person connects with `connection.use` in their own browser session; calls and refresh leases select only that person's binding. Personal Connections accept only agent exposure and keep their credential mode fixed (`credential_mode_fixed: create a new Connection to change its credential mode`). The CLI refuses personal sign-in with `personal_connect_in_browser`.

The API lists the caller's personal Connections and lets Connection administrators list and revoke personal bindings. Owner Disconnect revokes at the provider; administrative revoke, deactivation, origin changes and Connection deletion remove personal token sets locally without decrypting them. Structured connection and reconnect refusals support the personal Connect card.

Rollback: earlier releases do not accept `credentialMode: user`; remove personal Connections before rolling back. Deleted token sets cannot be restored by reverting a Connection revision. Conversation isolation and the interface are delivered separately.
