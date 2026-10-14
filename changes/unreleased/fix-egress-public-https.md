---
section: Added
---

- **`egress.allowPublicHttps`:** an operator opt-in in release config, off unless set. With it
  on, a Connection may reach a host that no `egress.allow` entry names over `https` on port
  443. Such a target is judged as a `public` entry: every address it resolves to must be public,
  so loopback, link-local, cloud metadata, private ranges and their IPv4-mapped forms stay
  refused. The instance's database host is refused on every port, by name and by address.
  Redirects and download addresses are checked again, and the credential goes only to the
  origin it was configured for. Another port, plain `http` and `postgres` still need an entry. A
  start with the setting on logs a warning. An `egress_denied` refusal now ends with the setting
  that would let the target through, or says that none would.
