---
section: Added
---

- **Rights on Apps, Data Stores, Knowledge Bases and Workflows for one person (RIGHTS-1c):**
  the Access page and `permissions.grant` give `app.read|write|publish|delete` and
  `data_store.read|write|publish|delete` in one Shared Workspace, on one App or Data Store, or
  for the whole instance; `knowledge_base.delete` and `workflow.delete` on one item or for the
  instance. A new right is never written in a Namespace; rows that had one keep it until the
  Namespace retires.
- **The data of a Workflow's runs** (`workflow.read_run_data`) is given on one Workflow only,
  and giving it, or lifting a deny of it, asks every right of the Service Principal the
  Workflow's published and newest revision name, as a publish does: "This call does not hold
  'connection.use' on the whole instance, and 'workflow-runner' would act with it".
- **Instance scope in the grant operation** for every grantable right no legacy key carries
  (Connections, Apps, Data Stores, Knowledge Bases, Workflows, `guardrail.publish`). Such a row
  is listed on the Access page and revoked there; an instance row of a legacy key's action
  (agents, skills) is still changed on the Users page only.
- The member role gains no `workflow.publish`.
- **Effect on an operated instance:** nothing existing changes; admins can hand out more
  narrowly than the role. Rollback is a redeploy; instance rows written for the new rights
  then stay in the table, unlisted and still evaluated, and are best revoked first.

- New Namespace grant rows are refused for every action, while existing rows stay readable,
  listable and revocable. The New right dialog limits kinds, verbs, scopes and resource choices
  to the giver's effective rights, including denies; the server re-checks every submitted row.
- The local demo seed gives rights on existing assets, including Kai’s prepared drafts,
  without writing new Namespace rows.
