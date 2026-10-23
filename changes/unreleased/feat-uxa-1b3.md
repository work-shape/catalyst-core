---
section: Changed
---

- **Audit:** The Audit page's "Subject" column ("Betrifft") and an activity's target say what an event is about in words (UXA-1b3): an asset's title, a person's, workspace's or role's name, or a tool's title, after its kind ("Skill: Prüfbericht"). Where the reader may not read the subject, or it is gone, they read its kind alone; never its id, slug or operation name. Each event in the `evidence` of `GET /api/v1/instance/audit-activities` now carries `about` (`kind`, and `title` or `builtInRole` where the reader may read it), and a target's `label` is the title its reader may read. The server checks the rights the subject's own page asks: an asset's read right, `users.manage` for people and roles, membership for a workspace, and authorship for a conversation.
