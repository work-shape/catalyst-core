---
section: Added
---

- **The agent's first save creates the asset:** `platform.assets.put` without
  `expectedRevision`, with a `kind` and a `name`, in a conversation that has no subject yet,
  creates a Workflow, a Data Store, an agent or a skill and makes it the conversation's
  subject; the person's tab then moves to its page under the navigation rule, and the
  conversation shows "Opened <name>". It calls the same write as `assets.put` on the API and
  the CLI, with the same rights check (`assets.put` for the kind, in the conversation's
  workspace) and the same validation; nothing else writes. A Workflow and a Data Store start as
  a draft that runs nothing until a person publishes it; the Workflows list shows a Workflow
  never published as "Draft · not published" to who may write Workflows, and to nobody else. A Data Store is saved as files, its
  `store.yaml` and its first migration, through the files write the CLI uses. The person of the
  conversation is recorded as its creator. An agent created so is offered nowhere: no workspace
  and no person's agent list gains it until a person places it. A conversation that already has
  a subject, a kind that is not one of these four and a save without a name are refused.
  `platform.assets.put` also takes `files` for a kind kept as files. Before, the first save of
  an asset that did not exist was refused.
- **New buttons open the dock where an agent builds:** where an agent offered here holds the
  platform tools and new conversations of the open workspace are the person's own (the
  Personal Workspace, or a Shared Workspace whose conversations start private), "New workflow"
  on the Workflows page, and "New agent", "New skill" and "New data store" in Studio when its
  scope is the open workspace, open the dock with a new conversation with that agent and a
  started sentence in its composer; they create nothing. Its first save creates the asset.
  Elsewhere, the New agent and New skill forms stay as before, and so does New agent on the
  Agents page, which leads into Studio. A first save in a conversation others of the
  workspace read is refused, as an open there is. The safe configuration's agent items gain
  the optional `buildsAssets`, set on an agent that holds `platform.assets.put`.
- **Never-rule 5 and the instance-scope floor, for the product lead to align:** by the manager's
  ruling, the first save may create a new instance-owned Workflow draft and make it the
  subject without the person's confirmation. Never-rule 5 and the floor of check 46 protect
  existing instance assets; a draft this conversation just created runs nothing and widens
  nothing, so the move to its page follows normally and publishing stays the person's click.
  An existing instance asset still waits for the person's "Go to it" (interim, until OP-3).
- **A Data Store never published shows its draft:** its page in Studio says "Draft · not
  published", lists the migrations a publish applies and offers Publish to whoever may publish
  it; it reads nothing of a database that does not exist yet. Before, it said twice that the
  store was not available.
- **Studio follows the asset the agent opens:** the answers of `platform.assets.open`, `.get`
  and of a first save name the owning workspace as `workspaceId`, and going to the asset's page
  in Studio sets Studio's scope to that owner, so the page reads it where it is. Studio offers
  the reader's Personal Workspace as the scope "Personal" to whoever Studio is open to, where
  what the agent made in a personal conversation is listed and changed.
- **An administrator's setting holds the first save as it holds the API's put:** the floor of
  a first save is asked of the kind and the name it creates, so a setting on a Namespace
  applies, and a setting on another kind does not. Tools' `policyFloor` is told the call's
  input. A confirmation of an open sent again changes nothing and writes no second audit row.
- **An asset's page in Studio finds its owner:** a page reached by the "Working on" line, by
  its address or after a reload names the asset alone. Where Studio is set to an owner that
  does not have it, the page looks in the other owners Studio offers and sets Studio to the
  one that has it. A Data Store never published says "Draft · not published" in the list
  instead of asking for a state it does not have yet.
