---
section: Added
---

- One Publish of an App makes the Workflow drafts it reaches live with it (DP-3). `assets.publish` of an App takes `workflows`, each pending Workflow with the revision the person saw, checked against the App revision's closure (its `workflow` actions, then child Workflows). Rights and guardrails are asked of each up front, a held publish is one `app_publish` approval that names every Workflow, and the publish runs in one transaction, children first and the App last, or publishes none. The answer lists `publishedWith`.
- `apps.publish_review` lists the closure children first, with `lastChangedBy` and `lastTestRun`, and says `publishesTogether`. The App's Publish dialog and an agent's publish confirmation show "Published with it" ("Wird zusammen veröffentlicht"), the Inbox item lists the Workflows, and `catalyst app publish` names and sends them.
