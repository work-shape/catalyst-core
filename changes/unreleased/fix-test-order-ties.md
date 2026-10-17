---
section: Fixed
---

- Fifteen store lists and lookups ordered by a timestamp now end in the row's id (or a membership's user), so two rows written in the same instant come back in one order: a member's, the discoverable and the shared workspaces; a workspace's memberships, also while it is being deleted, and its access requests; a conversation's draft and sent attachments and the attachment found by checksum or by file; a file's and a conversation's managed artifacts; a conversation's structured data; and a conversation's latest agent run. No index or migration changes.
- The asset write history test reads call order from the revision each audit row names, not from the order of the audit list.
