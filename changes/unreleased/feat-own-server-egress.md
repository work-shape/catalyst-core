---
section: Added
---

- **Connections:** A Connection a person adds for themselves (`ownerOnly`) is judged by its own
  egress rule. It reaches a public `https` host on port 443, also where
  `egress.allowPublicHttps` is off, or another port that a `public` entry of `egress.allow`
  names. A `network: private` entry never admits it. Every DNS answer must be public, and the
  host of `instance.publicUrl` and the Platform Store are refused by name and by every address
  they resolve to. Its redirects, sign-in addresses and token refreshes are judged by the same
  rule. `modules.connections.ownServers.publicHttps: false` leaves only the `public` entries. A
  save refuses plain `http`, another port without an entry, the instance's own host and a private
  address, and says whether an operator entry would admit it. The add stays off until PMCP-5.
