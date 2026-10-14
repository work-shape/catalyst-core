---
section: Changed
---

- **Words on the rights screens (RIGHTS-WORDS):** Instance > Access, Users, API access, a
  workspace's Members and a Connection's page say every right with one verb per action, the
  same in every dialog, row and refusal: view, use, edit, publish, delete, approve (German
  ansehen, verwenden, bearbeiten, veröffentlichen, löschen, freigeben), so "Read agents" is now
  "View agents" and "Agenten: Lesen" is "Agenten ansehen". No rights screen shows an action id,
  a legacy key, a key scope or an asset id any more: an asset the reader may not see is "An
  asset you cannot see". The German interface calls a service principal "Technisches Konto".
  "Rolle" names the instance role only: the Users page's "Access level" is now "Role", and a
  workspace member's role is their "Membership" ("Mitgliedschaft").
- **Workspace > Members** says what a member gets and what Builder and Publisher add.
- **The principal-rights dialog on API access** offers only rights the person holds
  themselves: a Connection they are denied, or hold no right on, stands disabled with the
  reason. It asks the instance's own evaluator over the person's rights, read where the person
  may read them (`users.manage`); without that the instance still refuses and names the right.
  A holder of `api_access.manage` alone is told that the service principals need the right to
  manage them, instead of "No service principals yet".
