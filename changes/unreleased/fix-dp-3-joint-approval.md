---
section: Fixed
---

- An App published together with its Workflows (DP-3) is now held when any member's publish would be: a central setting that holds a Workflow's publish holds the joint one, as the Workflows' guardrails already did, and a Workflow the call names that cannot be read refuses the publish instead of narrowing what policy and guardrails are asked. The joint `app_publish` item is decided only by someone who holds `app.approve` and `workflow.approve` on each Workflow it makes live (a deny on one Workflow refuses), and a publisher's own click counts as an approval only on the same terms; before, the App's approver alone made the Workflows live. A request whose members cannot be read is decided by nobody. Approval kinds can name further rights a request needs, each on its own resource (`furtherPermissions`), and an operation's approval further rights the caller must hold (`alsoRequires`); the subject's `publishedWith` members carry their `workspaceId`.
