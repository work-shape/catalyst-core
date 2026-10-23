---
section: Added
---

- An agent a workspace owns stays a draft until a holder of the new right `agent.approve` approves its publish (WS-PUB-1b). The shipped guardrail "Publishing needs an instance admin's approval" now also binds `agent.before_publish` for workspace-owned agents; instance-owned agents are not held by it. An instance admin's own Publish on the agent page is the approval; a Publisher without `agent.approve`, and every CLI publish, files an "Agent to publish" item in the Inbox. `agent.approve` is held by admins by default and can be granted on one agent, in a workspace or for the whole instance; a holder in a workspace decides that workspace's items.
- The Inbox item shows the draft against the live revision: the fields that differ, the tools and models it adds, the skills it names, the instructions, and the workspace it is offered in. The request freezes both revisions and turns stale when either moves.
- The first publish of a workspace's agent that is offered nowhere offers it in its own shared workspace, audited as `config_asset.availability_set` with reason `first_publish`. Later publishes leave where it is offered as it is.
- `catalyst agent publish` asks in the terminal for a workspace's agent and says the publish waits in the Inbox; with `--yes` it waits as a confirmation.
