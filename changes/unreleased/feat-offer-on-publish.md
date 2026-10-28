---
section: Changed
---

- **Studio:** Publishing an agent now also says where a chat can choose it. The publish dialog asks "Can be chosen in:" with the places the reader may set: all workspaces for an agent for everyone, or the agent's own team. An agent that is already offered keeps its place; one offered nowhere starts at its own place and may stay in no chat. Once the draft is live, Publish sets the place through `assets.set_availability` and its checks; a publish that waits for an approval or is refused offers nothing. A reader without the right sees the place read-only with the right that changes it; an agent under "Only me" is offered nowhere wider. Agents pushed with the config CLI still start hidden.
