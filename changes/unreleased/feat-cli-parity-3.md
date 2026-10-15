---
section: Added
---

- Personal API keys can follow their owner's Operation Runs and list and count their own approval requests with `me:read`; withdrawing an own request requires `config_assets:write`. Other callers retain their existing scopes and rights.
- `catalyst operation show <run-id>` follows a held call to its decision, and `catalyst requests [--withdraw <id>]` lists or withdraws the caller's own requests.
- Contract compatibility checks compare all scope alternatives per credential, and the API reference lists each credential once with its alternative scopes.
- A personal key refused a request withdrawal is told it needs `config_assets:write`; other caller kinds keep their existing scope refusals.
