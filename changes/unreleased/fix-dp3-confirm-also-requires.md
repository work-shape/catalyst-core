---
section: Fixed
---

- **Apps:** A person's confirmation of their agent's App publish now approves it only where their own click on Publish would: with every right the held publish asks of who decides it, such as `workflow.approve` on each Workflow and `data_store.publish` on each Data Store published with the App, and only where a guardrail asked. Before, the App's approve right alone made the Workflows live. Where the confirmation does not approve it, the agent's call is refused with `approval_unavailable` and files no approval request; before, it filed one whose approval executed nothing. Known gap: such a call should wait for an approver (events-workflows-and-guardrails.md, check 68); an agent's run cannot yet move on to an approval after its person's click.
