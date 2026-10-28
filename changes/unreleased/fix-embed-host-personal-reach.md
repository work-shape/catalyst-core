---
section: Fixed
---

- **Auth:** A session token signed without a `delegatedActor` now counts as the embedding host acting for the person: the server names the token's issuer as its delegated actor. Before, such a token passed as the person in their own session, so an embedded chat could choose their "Only me" agent, read their confirmation settings and apply their "Always allow", add a Data Store as their own click, and delete their account. Its scopes stay those of the token as signed, and nothing changes at issuance.
