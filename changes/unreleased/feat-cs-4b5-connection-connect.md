---
section: Added
---

- `catalyst connection connect <name>` signs a Connection in with OAuth from the terminal: it opens the provider's page in the person's browser (or prints it with `--no-browser`), waits until the Connection is connected and prints the binding's state, never a token. A Service Principal's key is refused. `catalyst connection disconnect <name>` ends the sign-in and revokes it at the provider.
