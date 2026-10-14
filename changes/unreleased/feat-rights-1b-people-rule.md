---
section: Changed
---

- **No escalation through people (RIGHTS-1b):** `users.manage` no longer hands out more than
  the caller holds. Giving a person a grant, a role or a legacy key asks every action it
  carries, at the scope given; writing a deny and lifting one ask the action the deny names.
  Nobody writes or lifts a grant of their own (`holder_not_administrable`), and nobody gives
  themselves a role or a key. Changing an account (name, email, status, roles, keys, a sign-in,
  the password, an invitation, deletion) asks every right the person holds: role defaults,
  instance-wide rows and keys, rows in a workspace, a Namespace or on an asset, and memberships
  of Shared Workspaces, a disabled person's included. The person's own Personal Workspace does
  not count. A superadmin follows the same rule; the superadmin-only rules stay as they were.
  A refusal is `403 FORBIDDEN` naming the first missing right, for example "This call does not
  hold 'agent.write' in the Namespace 'kai-', and 'Kai' would hold it. Only a holder of a right
  gives or lends it". Existing rows and accounts are not re-checked and nothing is migrated. A
  holder of `users.manage` without the admin role can therefore change only people who hold
  nothing beyond their Personal Workspace, until RIGHTS-1c lets an admin give them more.
- **A deny counts wherever it lies:** a right given over a Namespace, a workspace or the whole
  instance (a role, a legacy key, a key of a Service Principal, a Workflow's principal) is
  refused while the giver holds a deny of it on anything inside that place, rather than
  narrowed: "'agent.read' on an asset this call may not read is denied to this call, and the
  right in the Namespace 'kai-' reaches it". The asset is named only to a giver who may read
  it. The same holds for changing an account whose rights reach the deny.
- **Permission refs follow the rule:** a reference of a tool is given only by a person who
  holds it, never to oneself, and a person's references count when their account is changed.
  A superadmin who does not hold a reference no longer gives it on the Users page.
- **The account checked is the account written:** a change of a user, a sign-in added or
  removed, and a password set ask the rule again inside the write, under a lock of the user
  that keeps a concurrent change of their level, a grant written for them and a deletion
  request waiting. A user promoted after the first check is refused, not written.
- **Effect on an operated instance:** an admin keeps every change they made before, except
  changing the account of a person who holds `api_access.manage` or `agent_models.manage`,
  which now only a superadmin does, and writing a grant for themselves, which another admin
  or a superadmin now writes. Rolling back restores the earlier rule; no data changes.
