---
section: Fixed
---

- **Personal API keys:** A builder who holds `agent_models.manage` can push an agent's model settings (`modelBindingId`, `reasoningEffort` and the rest) with a personal key. The key covers the right where it covers `agent.write` for that agent, with its workspace and asset, so no key has to be reissued. Before, every such push was refused with `Missing the right 'agent_models.manage'`, since no key scope could name the right.
- **Personal API keys:** A batch item refused because the key does not cover a right its owner holds now says that the key's scope is missing, instead of `Missing the right`.
