---
section: Added
---

- **A role's rights in one place:** each area of a role's page on Settings > Instance > Access > Roles now has **Add**, which opens the New right dialog for the role: a level of rights in one Shared Workspace or on one asset, such as Publish on one agent and on one skill. Everybody who holds the role gets the right at once; the area lists the role's rights by place and its menu removes any of them. The write is the existing `roles.update` with its no-escalation check and `role.updated` audit event, which names actions, scopes and ids only.
