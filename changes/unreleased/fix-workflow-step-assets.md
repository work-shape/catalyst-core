---
section: Fixed
---

- **A Workflow step calls no asset operation:** an `operation` step that names `assets.*`
  (`assets.list`, `assets.get`, `assets.put`, `assets.publish`, `assets.sync` and the rest) is
  refused when the Workflow is saved or published, with the reason `operation_not_callable` and
  the step's path. A run acts as its service principal, and a principal that holds
  `config_assets.read` or `config_assets.release` could read every agent's and skill's
  definition through a step or reach `assets.sync`. A definition stored before this release is
  listed as not runnable with the same reason, and a run that reaches such a step fails it
  before anything is called. The demo's seeded Workflows, which read agents and skills, now
  read the Connection `sample-accounting`: `accounting-clients` (was `agent-inventory`) and
  Kai Berger's draft `kai-client-years` (was `kai-skill-inventory`). Their principal
  `workflow-demo` holds no permission and one grant, `connection.use` on that Connection.
