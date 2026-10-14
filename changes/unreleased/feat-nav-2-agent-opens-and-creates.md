---
section: Changed
---

- **The agent takes the person to the asset it opens:** when the agent opens a Workflow, an
  App, an agent or a skill, the tab that sent the message and watches the run moves to the
  asset's page with the conversation in the dock, from the chat route, the page of the
  conversation's subject or a page an earlier open moved to. The first move of a run adds one
  step to the history and later ones replace it. From a page the person went to on their own,
  in a second tab and on a run read later nothing moves: the dock says "Opened <name> · Go to
  it". Every open leaves the line "Opened <name>" in the conversation, outside the Work
  history, with a link to the page. The dock's line says "Working on: <name>".
- **An agent's open of an instance-scoped asset waits for the person (interim, until OP-3):**
  `platform.assets.open` on an asset of the whole instance, in a conversation not started from
  its page, sets no subject and moves no browser. It answers `awaitsPerson`, and the dock offers
  "Go to it"; the person's press is the confirmation. It calls the new registered operation
  `conversations.subject.open` (`PUT /api/v1/conversations/:conversationId/subject`), which sets
  the subject of the person's own conversation, records an Operation Run and the audit event
  `conversation.subject_opened` with the tool call it confirms, and then opens the page. Until
  then a changing asset tool on it is refused. Before, such an open was refused outright.
  Once OP-3 exists, the open pauses for the confirmation in the host's prompt instead.
- **No asset beside the chat:** the Workflow canvas, the App draft and the agent no longer open
  as surfaces beside the conversation; "Edit with the agent" opens the asset's page with the
  conversation in the dock. A preview the dock's conversation opens on a page, such as a file or
  a view, covers the page and leaves the dock in view.
- **"Draft · not published":** the page of a Workflow or an App that was never published says
  so.
