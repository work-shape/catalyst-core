---
section: Added
---

- **Connections:** A person's own MCP server can take a token they paste instead of a sign-in.
  The add dialog asks for it where the server wants one, and offers "Paste a token instead" on
  the sign-in step. The token goes as a Bearer token, or under a header the person names under
  "Technical details". Its card says "Token missing" while there is none and offers "Set token"
  or "Replace token"; so do the cards of an admin's personal MCP Connections that take a token.
  English and German.
- **Connections:** The token is stored encrypted under the person's own binding and is never
  answered back. It goes to the server's own origin only, never to a host a redirect names. A
  401 deletes it and asks for a new one, without repeating the call. A move of the server's
  address or of how the token is sent, Disconnect, the delete, the person's deactivation and an
  admin's revoke delete it. The audit records `binding_connected`, `binding_needs_reconnect` and
  `binding_revoked` with `personal: true` and scheme `static`, never the token.
- **API:** `connections.set_own_secret` (`PUT /api/v1/connections/:name/own-secret`) sets or
  replaces the caller's own token over its version, in a first-party session only, on their own
  server or a personal MCP Connection they may use. `connections.get` answers `ownToken` (set or
  not set, since when, the scheme), and `connections.mine` a `token` on such a row. Mode `user`
  on `mcp` also takes the schemes `bearer` and `header`.
- **Docs:** "Add your own MCP server" covers the token.
