---
section: Added
---

- An operation step, a step that starts another Workflow and a Workflow's AI tools have their Settings (WF-EDIT-3): the operation is picked by its title, grouped by its source, with whether it reads or changes data, and the form shows one row per field of its input schema, each a fixed value of the field's kind or a field of an earlier result; a required field without a value holds the save back. The child picker offers the published Workflows started by `parent` that the person may read; one the person may not start (`workflow.use`) is shown disabled with the reason. A Workflow's `tools` are picked from the same listing.
- `operations.list_callable` (`GET /api/v1/operations/callable`) lists the operations a Workflow's step may call for the person asking, with title, description, source and whether the instance has them now, as the agent's `platform.assets.operations` does. An operation is listed only where its own check of a call from a Workflow step lets the person call it. The listing advises and grants nothing: the run's call is checked again under the identity the run acts as. Each check is asked dry, with no side effect and no audit event. A source is named by its title only for a person who may read it.
- `platform.assets.operations` answers each operation's title, source and availability.
- `workflows.list` answers each Workflow's `triggers`.
