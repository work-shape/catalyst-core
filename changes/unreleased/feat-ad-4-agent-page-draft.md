---
section: Added
---

- The agent page edits the agent's one draft (AD-4). The form starts from the pending draft when there is one, and Save draft writes it on the live revision and the draft revision the page holds. Save after save now works; before, the second save was refused with 412 and the page went on showing the live agent. The head names the draft as "Draft revision n"; the banner under it names the author and the time. Each changed field shows its published value under it.
- Publish sits in the agent page's head. A holder of `agent.publish` can use it; anybody else sees it disabled with the missing right named. Discard draft sits in the "…" menu behind a dialog. Before, both were only offered beside a Build conversation.
- When a save is refused because somebody else saved a newer draft, the page says who saved it and when. It keeps what the reader typed and offers to load the newer draft.
- Build > Agents marks an agent that has a draft, for holders of `agent.write`.
- `agents.draft.get` names the draft's author with `author.name`.
- Studio offers Publish only to holders of the kind's own publish right where the kind names one, as the instance does. Before, the write right on all assets was enough.
- `assets.get` names what the caller may do on the asset in `allowed` (`write`, `delete`, `publish`), decided by the instance with grants and denies on the asset itself. An asset's page in Studio follows it for Save, Publish, Discard and Delete. Before, Studio derived the rights itself and missed a grant or a deny on one asset: a holder of `agent.publish` on one agent saw Publish disabled although the instance would publish.
