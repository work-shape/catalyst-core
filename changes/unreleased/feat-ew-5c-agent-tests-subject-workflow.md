---
section: Added
---

- Agents with platform tools can test the conversation's subject Workflow draft with `workflows.test`, whose release default policy is `allow`, and read progress and step targets and results with `workflows.get_run` and `workflows.list_step_runs`. Test runs act as the person, bounded by the Workflow's principal; changing steps remain Simulated. Testing another Workflow is refused with "An agent may test only the conversation's subject Workflow". These tools expose no "Run live once" switch and do not start published Workflows. The tools also work in standalone Agent Run workers.

- Successful Workflow run and step reads from the UI leave no Operation Run or audit rows; agent calls of the same operations remain recorded.
