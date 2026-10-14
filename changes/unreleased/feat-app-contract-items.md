---
section: Changed
---

- **Breaking for Apps: `connections.call` is removed.** An App reaches a Connection only through
  a named `connection` action in its folder (`actions/<name>.action.yaml` with `connection`,
  `operation` and `effect`, called with `actions.call('<name>', input)`). The route
  `POST /api/v1/app-content-sessions/{pageSessionId}/connections/{connection}/operations/{operation}`
  (`apps.sessions.call_connection`) is gone. An App built against kits 1.1.0 to 1.3.0 that still
  calls `connections.call` gets at once the error `connection_call_removed`, which names the named
  action as the fix (kit 1.0.0 had no call of a Connection). A `connections.call` that waited for
  an approval across the upgrade is ended when it is approved: its run fails with the same
  message and the Connection is not called. The platform operation `connections.call` for the
  CLI, MCP and agents is unchanged.
- **App Kit 1.4.0** is released without `connections` and is the kit version for new Pages and
  Apps. It adds about 485 kB to the `chat-server` package; its size limit moves from 2.1 MB to
  2.7 MB.
- **Reserved App keys:** the build refuses `rights` and `requires` at the top of `app.yaml`,
  `requires` on an action, and an action of `kind: code` or with `reads` or `writes`, as a line
  of the manifest or in its action file, with the code `key_reserved`. The `code` action arrives
  with APP-12; rights inside Apps are not yet decided.
- **App bridge v1 is frozen:** the docs page Reference > App bridge v1 lists its messages and the
  kit's calls. Changes to version 1 are additive, a new call needs a named App that cannot be
  built without it, and a breaking change is version 2 beside it.
