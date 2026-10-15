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
  reason. Everyone may read their own effective rights, and principal managers may read
  principal grants and effective rights without `users.manage`; other people’s rights
  remain protected. The instance still refuses an unheld grant itself.
  A holder of `api_access.manage` alone is told that the service principals need the right to
  manage them, instead of "No service principals yet".
- **An agent's page (AGENT-AVAIL-1)** names "Available in" ("Verfügbar in") once, as its
  section's heading, and saves where the agent can be chosen through the page's one save bar
  with the agent's other changes. The section's own "Save availability" button is gone. The
  library's `RadioGroup` takes `labelHidden` for a group whose heading names it already.
- **Settings waits for the platform context** before it sends an address elsewhere: an
  administrator who opened Instance > API access by its address, such as from a Connection's
  page, was sent to Users while the right that shows the page was still loading.
- **Instance > API access** lists every person's own keys only to a holder of
  `api_access.manage`, who alone may read and revoke them; an administrator without it no
  longer meets a refused request on the page.
