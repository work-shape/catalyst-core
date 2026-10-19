---
section: Added
---

- **Workflows:** Workflow `agent` steps now execute as durable Child Agent Runs under the run's acting principal, with the Workflow's tools and the instance's default model. JSON output is validated, with one repair turn that may call no tools. A confirmation fails the step with `confirmation_unattended`; an approval pauses and resumes the same run. Model usage is attributed to `workflow_step` and its Workflow Run. Draft tests belong to the tester, intersect the tester’s and principal’s rights, and simulate changing calls through the existing draft policy.

- **Workflows:** The step panel shows instructions, tools, usage and, for holders of `workflow.read_run_data`, the transcript and validated output. Run and step result previews in Workflows containing agent steps require that right too, including values forwarded into later steps; App starters retain access to their explicit result. Workflow run threads are unavailable on conversation routes, and their data follows Workflow run-data retention.
