---
section: Added
---

- **Workspace > Members:** Each member's row has a Builder and a Publisher switch. For the workspace's Owner or Admin, turning one on asks for it and turning it off takes it back at once. An instance admin who administers people and holds the bundle in the workspace gives it at once. A switch shows "requested" while a request waits and "by role or group" when the member holds the bundle another way, and cannot be turned then.
- **Inbox:** A new `grant_request` item. The Owner or Admin of a Shared Workspace asks for Builder or Publisher for a member, or a member asks for themselves. Only someone with `users.manage` who holds that bundle in the workspace can grant it. Nothing changes until it is granted. A request whose member left, became inactive or already holds the bundle ends as outdated. Granting audits `permission.granted` with the request id. Taking a bundle back audits `permission.revoked`. Neither event records the reason.
- **API:** `workspaces.member_bundles.list`, `.request`, `.grant` (requires `users.manage`) and `.revoke`, under `/api/v1/workspaces/:collaborationWorkspaceId/`.
- **UI library:** `ListRow` takes `below`, a line under a row that does not unfold, for controls that need the row's width.
