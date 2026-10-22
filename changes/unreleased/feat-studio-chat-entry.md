---
section: Changed
---

- **Studio chat entry:**
  - Every page head shows "Chat" next to its primary action. It opens the dock from anywhere, and ⌘J / Ctrl+J does the same.
    - On an asset's page it starts a conversation about that asset.
    - On a list it opens the dock's last conversation. That conversation is kept in this browser across a close and a reload. If there is none, it opens an empty dock with the agent that builds.
  - In Studio, a conversation that builds is started in the workspace Studio is set to, private where that is not the open workspace. An empty dock that builds says where a new asset will be created, for example "Neue Agenten entstehen in „Team Vertrieb“.".
  - An unchanged new page, and opening or closing the dock, no longer ask before leaving: only a move to another page with unsaved changes does.
  - The dock's head names a skill by its title.
  - The separate "Edit with agent" buttons in the heads of Data Stores, Apps and Workflows are gone. "Chat" replaces them.
- **New:**
  - "New agent", "New skill" and "New knowledge base" open the kind's empty, unsaved edit page under every scope. The first Save creates the asset.
    - The id comes from the name. A taken or invalid id is shown on the page.
    - Where the new asset is available is chosen on the page.
    - Leaving the page with unsaved changes asks first.
    - "Chat" on the new page opens the agent that builds the kind.
  - Kinds without a hand editor (Data Stores, Apps, Workflows) ask one short question, "What should it do?", and then "Build with the agent" opens the dock with the answer in its composer.
