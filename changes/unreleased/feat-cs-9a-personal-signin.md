---
section: Added
---

- **Connections:** personal OAuth sign-ins for `http_api` and `mcp` Connections. Each person connects with `connection.use` in their own browser session; calls and refresh leases use only that person's binding. Personal Connections accept only agent exposure and keep their credential mode fixed (`credential_mode_fixed`). The CLI refuses personal sign-in with `personal_connect_in_browser`.
- **Connections:** the API lists the caller's personal Connections and lets Connection administrators list and revoke personal bindings. The owner's Disconnect revokes at the provider; an admin's revoke, a deactivation, an origin change or a Connection delete removes the token set locally without decrypting it. Structured `connection_not_connected` and `connection_needs_reconnect` refusals feed the Connect card in chat.
