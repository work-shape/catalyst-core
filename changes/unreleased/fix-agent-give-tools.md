---
section: Fixed
---

- **Give to an agent** works on an agent with an unpublished draft. The new operation `agents.give_tools` (`POST /api/v1/agents/{name}/give-tools`, `catalyst agent give-tools`) makes the published agent plus the tools one new live revision, with the rights of a change and a publish (`agent.write` and `agent.publish`), their guardrails, approval policy and audit. A pending draft, also one a release push wrote, keeps its content and author, gets the same tools and moves onto the new live revision, so it stays publishable. The give no longer refuses another person's draft and never publishes a draft. A live change since the give read the agent answers `REVISION_CONFLICT`.
- The agent page names who saved a draft as the subject of the sentence; a draft a release push wrote names "the team that runs this instance" ("das Team, das diese Instanz betreibt").
