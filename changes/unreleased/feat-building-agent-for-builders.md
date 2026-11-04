---
section: Changed
---

- **Agents:** An agent that builds assets (it lists `platform.assets.put`, as the shipped Workshaper does) is offered to a person in a workspace only where that person may build there: Builder in the workspace, which instance admins hold everywhere; in a Personal Workspace that is an admin. Nobody else gets it in the picker or over the API, also not with a grant of `agent.use` or where the agent is set to Everyone; a start naming it is refused with `FORBIDDEN` naming `agent.use`, as are a scheduled prompt and a subagent start. A deny of `agent.use` still refuses. Its availability still says where it is offered at all.
- **Chat:** The agent picker lists the agents that build last, under "For building" / "Zum Bauen".
- **Workflows:** "Chat" in a Workflow's page head starts the conversation with the agent that builds where one is offered to the person, as an App's does, rather than with the chosen agent.
