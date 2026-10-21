---
section: Fixed
---

- An App published together with its Workflows (DP-3) is now held when any member's publish would be: a central setting that holds a Workflow's publish holds the joint one, as the Workflows' guardrails already did. The joint `app_publish` item is decided only by someone who holds `app.approve` and `workflow.approve`, and a publisher's own click counts as an approval only when they hold both; before, the App's approver alone made the Workflows live. Approval kinds can name further rights a request needs (`furtherPermissions`), and an operation's approval further actions the caller must hold (`alsoActions`).
