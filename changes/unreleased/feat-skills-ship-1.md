---
section: Added
---

- **Skills a capability ships:** a capability names `skills`, and the release seed stores each
  as a read-only skill of the platform with its registry icon and its `summary`, where the
  instance has every tool the skill names in `tools`. The artifact helpers of the capabilities
  repo ship spreadsheets, documents, presentations and pdf this way, so the agent editor, the
  skill chooser and the Skills list show their own icons instead of the generic book.
- **A start that names the fix:** a release that ships a skill the instance holds as its own
  stops with the skill's name and the steps to remove the copy with `catalyst config push`. The
  start deletes nothing. The docs page Config assets says the same under "Skills that ship with
  the release".
- **A proposal to a shipped skill is refused when the agent makes it:** `propose_skill_change`
  on a skill that ships with the release answers `not_allowed` with a sentence the agent can pass
  on (it ships with the release and cannot be changed on this instance; a person can copy it).
  Before, the request was filed and its approval always failed.
