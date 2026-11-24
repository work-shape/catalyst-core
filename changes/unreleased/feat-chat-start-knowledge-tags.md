---
section: Added
---

- **Chat:** the empty chat names the Knowledge Bases the agent answers from, as quiet labels above the starters: a knowledge icon and the title, with the description on hover or keyboard focus. A person sees only the Knowledge Bases they may read or search; an agent without any shows none, and more than seven show six and a "+3" label that shows the rest when chosen. The agent list (`config.get`, a workspace's agents) carries them as `knowledgeBases` with the id, the title and a description of at most 240 characters. The interface library gains a `quiet` tone, a `description` and an `accessibleLabel` on `Chip`, and `ChipList`.
