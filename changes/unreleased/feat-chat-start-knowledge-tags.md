---
section: Added
---

- **Chat:** the empty chat names the Knowledge Bases the agent answers from, as quiet labels above the starters: a knowledge icon and the title, with the description on hover or keyboard focus. A person sees only the Knowledge Bases they may read or search; an agent without any shows none. The labels keep to one line at any width, a phone's included: as many show as fit, and the rest stand behind a "+3" label that opens a small list of them on a click or keyboard focus. The agent list (`config.get`, a workspace's agents) carries them as `knowledgeBases` with the id, the title and a description of at most 240 characters. The interface library gains a `quiet` tone, a `description` and an `accessibleLabel` on `Chip`, and `ChipList`, a line of chips that measures its room and never wraps.
