---
section: Changed
---

- **Tooling:** A right is now added in files of its own kind instead of the same blocks of four shared files. `ACTIONS` is composed from `asset-schemas/src/contract-values/<domain>.ts`, `GRANTABLE_ACTION_SCOPES` from `core/src/grantable-scopes/<kind>.ts`, the Access page's words of a kind (label, place words, sentences, allow notes) from `chat-ui/src/admin/access/kinds/<kind>.ts`, and their messages from `chat-ui/src/shared/i18n/access-<kind>.ts`, each joined in today's order. The actions, scopes, words and messages are the same as before; the per-kind messages that were outside it now also fall under the rights wording guard.
