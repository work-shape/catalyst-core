---
section: Added
---

- **Shared skill drafts:** A skill the instance or a Shared Workspace owns now has one shared draft, as an agent has. `skill.write` edits the draft and `skill.publish` makes it live through the `skill.before_publish` guardrail event (no guardrail is bound by default). Holders of the skill's write right read and try the draft, and Try runs an agent with the drafts of the skills it uses only where the person holds write on them; everyone else gets the live revision. Skills of a Personal Workspace stay live on save, and existing skills keep their live revision. The skill page shows the draft badge, Publish and Discard draft. `skills.draft.get` and `skills.draft.discard` read and drop the draft. `catalyst config push` writes skill drafts; `--publish` or `catalyst skill publish` makes them live, and `catalyst skill discard` drops one.
