---
section: Added
---

- **Give to an agent** (German: **Einem Agenten geben**) gives a Connection's approved tools to one agent in one step: after approving operations for agents in the New connection dialog or on the Connection's page, and on a card in a conversation. It lists only the instance's agents the person may change and publish, names the agent and the tools before anything changes, and the confirmation publishes the agent as one revision with them added, through the agent's own save and publish, with their rights, approval policy and audit. An agent with another person's unpublished draft is refused with that person's name and is not written; the person's own draft takes the tools and is published only where they tick **Publish the whole draft now**. The agent of the conversation can call the tools from the next message.
- The platform tool `platform.connections.offer_to_agent` (module `connections`) shows that card. It reads and changes nothing itself and is offered to platform agents with `platform.connections.draft_tools`.
