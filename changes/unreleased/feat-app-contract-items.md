---
section: Changed
---

- **Breaking for Apps: `connections.call` is removed.** An App reaches a Connection only through
  a named `connection` action in its folder (`actions/<name>.action.yaml` with `connection`,
  `operation` and `effect`, called with `actions.call('<name>', input)`). The route
  `POST /api/v1/app-content-sessions/{pageSessionId}/connections/{connection}/operations/{operation}`
  (`apps.sessions.call_connection`) is gone, and the kit source has no `connections` any more.
  An App built against kits 1.0.0 to 1.3.0 that still calls `connections.call` gets at once the
  error `connection_call_removed`, which names the named action as the fix.
- **Reserved App keys:** the build refuses `rights` and `requires` at the top of `app.yaml`, and
  an action of `kind: code` or with `reads` or `writes`, as a line of the manifest or in its
  action file, with the code `key_reserved` and what will bring each: rights inside an App are
  not decided yet, and the `code` action comes with a later slice.
- **App bridge v1 is frozen:** the docs page Reference > App bridge v1 lists its messages and the
  kit's calls. Changes to version 1 are additive; a breaking change is version 2 beside it.
