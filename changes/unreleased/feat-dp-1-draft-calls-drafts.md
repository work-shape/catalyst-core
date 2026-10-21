---
section: Added
---

- In an App's draft a `workflow` action starts a test run of the Workflow instead of a dry run (DP-1): of its draft for a tester who may write the Workflow, otherwise of its published revision, still as a test and admitted by the right to use it. Its reading, model and code steps are real and its changing steps are simulated or go to a test target, so App and Workflow are tried together before either is published. A Workflow never published answers a tester who may not write it `workflow_unavailable`, and no draft starts a live run.
- The run names the App, the draft's revision, the action and which Workflow revision ran (`startedFrom`), and the Workflows pages mark it "Test · from App draft “<App>”". The frame of the draft marks the result "Test run of the draft · Workflow draft" or "Test run · published Workflow", with the number of simulated steps and a way to the run. "Run live once" is no longer offered on a `workflow` action.
- Kit 1.8.0: `useWorkflowRun` and `workflowRuns.get` pass on `mode: "test"`, `workflowRevision` and `simulatedSteps` of a test run. A new App names kit 1.8.0.
