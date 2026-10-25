---
section: Added
---

- **Connections:** An operator can declare managed OAuth clients under `infrastructure.oauthClients` in release config: a client id, the name of the host secret that holds its client secret, and an optional tenant. A catalogue part that names one with `managedClient` installs with no field, and each person just connects. The client secret is read from the host when a token is exchanged, refreshed or revoked, and is kept in no table, answer, log or audit record. Only the Connection installed from that part, under its name, may use the client; any other is refused with `managed_client_unavailable`, and the install dialog keeps an own app registration under **More**. Removing the client or changing its id sets the sign-ins made with it to `needs_reconnect` at the next start. The demo's sample OAuth entry uses the managed client `sample`.
