# Changelog

All platform packages are released in lockstep under one version. Before 1.0 a minor version may
contain breaking changes; a patch version does not.

The entries of the next release are files in `changes/unreleased/`, one per change; a change
adds such a file and does not edit this one (see "Changelog" in README.md). The release folds them
in, and `pnpm changelog` prints the next release's section as it will read.

## 0.8.0-rc.21 — 2026-10-29

### Added

- **Apps:** A person renames an App in place from the "…" menu of its card in the Apps list and of its page (`apps.rename`). Renaming needs `app.write`, the right that edits the App. Only the name people read changes, at once for the draft and what is published and without a new revision; the id stays. The audit event `app.renamed` names the App, not the name (T34).
- **Apps:** A name a person gave by renaming stands over every later write of the App: a save from a Page, `assets.put` with a manifest that names another, and the agent's `app.save`. `app.save` and `app.edit` answer `nameSetByPerson`, and the agent is told never to rename such an App and at most to ask when its change made the App do something quite different (T34).
- **UI library:** `RenameField` edits a name where it is read, and `PageHeader` takes `titleEditor` to stand in the name's place.

### Fixed

- **Execution workspaces:** `workspace.exec` tells agents before a command runs that the sandbox has no outbound network or DNS access. It directs documentation fetches to available web tools, or uploaded files when no web tool is available, and explains that retrying cannot enable network access.
- **Workshaper:** Can be saved and given Connection tools when Apps tools are automatically offered by the assembly. Validation uses the same tool inventory as conversations, and built-in App tools remain subject to module checks. Save draft and Give to an agent show unavailable-tool diagnostics in the selected language, including the instruction line, a next step and confirmation that nothing was saved. `release:check` now checks shipped agent and skill tool references.

### Database

- Migration `0178_app_person_title` adds the nullable column `config_assets.person_title`, the name a person gave an asset. No default, so no row is rewritten.

## 0.8.0-rc.20 — 2026-10-29

### Added

- **A .zip in a project chat's composer:** a `.zip` handed to the composer of a chat in a project is unpacked into a folder of the project, named after the archive, and the archive itself is not kept or attached; the message waits until the folder is in. Chats without a project still attach the `.zip` as one file. The file caps are checked against the real size of each entry while the archive is unpacked, here and on the project page, so an archive that declares small sizes is stopped at the cap with a plain sentence and nothing is sent. An archive with an entry that climbs out of its folder with `..` is refused.
- **Projects:** The project whose page or chat is open unfolds in the rail to its five newest chats the person reads, read with the chat list's own call and its audience, with "All chats" to the project's page (PRJ-5). An open chat older than those stands after them, and a project used earlier than the five listed joins the group while it is open. "Recent" leaves out the chats shown under the project. The drawer at phone width unfolds alike.
- **Projects:** A project's creator shares it with the workspace or makes it private again (`projects.set_audience`), with every chat in it. Going shared is refused while a chat in it carries a personal-data mark or reads a Data Store; going private, the chats of others leave the project and stay shared in the workspace. `projects.impact` gives the counts the dialogs show (PRJ-6).
- **Projects:** A member of both workspaces moves a project with its chats and files to another workspace (`projects.move`). Grants on the project end with the move. Into a Personal Workspace only a project that holds no one else's chat; out of one, the project is private unless the person shares it.
- **Projects:** A project is deleted with its files, their versions and stored bytes (`projects.delete`); its chats stay in the workspace or are deleted too, as the person chooses. The project is claimed first, and a cleanup that fails is finished by the retention job.
- **Projects:** A chat others read enters a private project only when the person confirms that the others no longer see it (`hideFromOthers`); a chat of someone else never enters a private project.
- **Retention:** `retention.projectIdleDays` (release config, empty by default) deletes projects nothing happened in for that many days. Seven days before, the creator and, for a shared project, the workspace's Owners get a notice; any change in the project keeps it. The project's chats stay and expire by their own retention.
- **Projects:** A project names a default agent and skills (PRJ-7). The project page's "Skills & agent" tile opens a panel that sets both; a new chat in the project starts with the default agent, which the composer's agent chooser preselects, and every run in the project is offered the project's skills beside its agent's, readable with `read_skill`. Only what the project's audience may use can be chosen: in a project others read, a person's own agent or skill is greyed with the reason and a share into the workspace. In a private project its creator may use their own, and a chat that does is marked personal. A default or skill that stops applying is kept, shown as not applying, and never offered; new chats then fall back to the workspace's agent. New operations `projects.setup.get` and `projects.setup.set` (`/api/v1/project-settings/:projectId/setup`), audited as `project.setup_changed` with counts only.
- **A project's Knowledge Bases (PRJ-8):** a project attaches up to 20 Knowledge Bases from its own "Wissensbasen" tile, and every chat in it searches them beside its agent's own. Attaching grants nothing. A project others read attaches only what everyone who reads it may search: the person's own is greyed with the share into the workspace, and one not available in the workspace is greyed with the reason. Each run checks again for the person whose turn it is, so a Knowledge Base a reader of the chat may not search never answers there. One that stops applying stays listed as not applying and is searched in no chat. `projects.setup.get` lists `knowledgeBases` and, where the module `knowledge` is on, `knowledgeBaseChoices`. `projects.setup.set` now changes only the fields a call names: `defaultAgent`, `skills` and `knowledgeBases` are each optional. The audit's `project.setup_changed` counts the Knowledge Bases added and removed.
- **Project page layout:** the page body is now a container its layout can measure, so the files sit beside the chats from 1280 px wide, and the tiles stand side by side as far as there is room.
- **Project files:** Chat commands in a project now get a writable `/workspace/project` snapshot, filled from a verified host cache. Local and Docker runners store changed, new and deleted files as project versions attributed to the run, preserve concurrent writes as conflict copies, and keep project files out of the conversation scan. Mounts require the run's person's current project access; subagents use their root chat's folder and Workflow step threads get none. A project sync failure preserves the chat’s own outputs, and timed-out commands save the changes they left. Changes to top-level `AGENTS.md` stay behind the confirmation card. Audit metadata carries project IDs and versions without file paths.

### Changed

- **Release:** The config-cli package may pack to 360,000 bytes: the skill draft commands took it to 302,862.
- **Embedded chat:** The read of the signed-in person (`GET /api/v1/me`) now carries `embedded: true` when the request is an embedding host's session token, and nothing for the person's own browser session. The chat leaves out what the server refuses such a session instead of showing it and failing on click: "Always allow" on confirmation cards, the Data Store add (the card says where it is done), "Problem an Workshape melden", the person's own agents, account deletion, and the Settings pages for confirmations, Connections and personal keys, and a personal skill's "use in my chats". The page learns no more of the host than before.
- **A project's page is a chat start:** the page of a project is the start page of a new chat, with the same composer, agent chooser and attachments as the home start page, and a chip in the composer that names the project. Above the composer stand the project's name and who sees it; below it one row of small controls: "Instructions" opens `AGENTS.md` beside the page to read, edit and see its versions, with a dot while there are none; "Files · n" opens the project's file tree beside the page with its uploads; the "…" menu holds the project's agent and skills, its Knowledge Bases, who sees it, its move and its deletion. Under the controls the project's chats are listed newest first. Files, folders and `.zip` archives dropped anywhere on the page go into the project. The separate project composer and the tiles are gone.
- **The Projects label in the rail links to the page:** the label "Projects" of the rail group is a link to the Projects page, read as a label, underlined on the pointer and reachable by keyboard; its plus stays apart. The "All projects" row is gone. `NavGroup` takes a `labelLink` for a label that leads to the group's page.
- **Projects live in the rail group only:** the sidebar has no "Projects" section row any more. The group "Projects" above "Recent" is their only place: its label carries the plus that "Recent" has, which makes a project, then the projects used last, then "All projects" to the page. Without a project the group shows its label and plus alone. The phone drawer is the same, and the page keeps its address.
- **Sidebar rows draw their focus line inside the row:** the keyboard focus line of a navigation row no longer stands outside it, where the edge of the scrolling list or a pinned group label cut it off.
- **Tests:** cover sharing from Workflow and App pages and greyed picker items at desktop and phone widths, including accepted and declined requests and the requester's resulting view.
- **Sharing:** Workflow and App pages follow a move into a team without reading the former address.
- **Menus:** long action labels stay within the available viewport width on phones.
- **Tests:** wait for menu placement before asserting browser geometry and keep the pointer out of model-picker keyboard navigation.
- **Tests:** allow the Page tool fixture's asynchronous App build to finish before expecting its answer.
- **Skills:** an import can reach the recreate handler for a deleted address whose history the reader may read.

### Fixed

- **Auth:** A session token signed without a `delegatedActor` now counts as the embedding host acting for the person: the server names the token's issuer as its delegated actor. Before, such a token passed as the person in their own session, so an embedded chat could choose their "Only me" agent, read their confirmation settings and apply their "Always allow", add a Data Store as their own click, and delete their account. Its scopes stay those of the token as signed, and nothing changes at issuance.
- **Embedded chat:** A confirmation card in an embedded chat no longer reads its Operation Run, which needs `governance:read` and which a host's session token does not hold: the read answered 403 and the card kept Allow and Deny disabled until it failed. The card has no Inbox item to lead to there, so it answers in the conversation at once.
- **Agents:** A person's "Only me" agent can run itself as a subagent in its owner's own chats. `agents.run` without another agent named was refused because the availability check did not get the chat; it now gets the root chat, so the same rule as for choosing the agent decides. It stays refused for another member's personal agent, for a key, an embedding host or a Workflow step, in a chat others read, and for a personal agent named by another agent.
- **Projects:** A write that carries exactly the bytes a project file has makes no new version and no conflict copy, whichever version the writer had seen. A stale write over a file deleted for good is refused with a sentence (and in a command's folder, reported as a warning) instead of becoming a copy beside nothing.
- **Projects:** A folder or file of a project moves to the top level, by dragging it onto the top level that shows while dragging, or by the Folder menu in "Rename or move" (top level first, then every folder). The dialog now has a folder and a name instead of one path.
- **Projects:** A .zip unpacked in the composer of a project chat leaves a short line where its upload chip was ("3 files put in “Unterlagen”").
- Try commands mount the frozen skill drafts their caller may write, including the draft's files. Other runs keep mounting live skills.
- Approving a change to an existing shared skill saves its draft together with the decision. Live content changes only through Publish and its guardrails; undo refuses newer draft edits.
- Config push refuses a changed skill draft locally before sending writes, using the server's refusal and a pull instruction.
- **Usage attribution:** usage in shared workspaces now groups personal agents by the owning scope captured with the run. Instance and workspace agents keep their own names even when a personal agent later shares that name.

### Database

- Migration `0177_project_idle_notice` adds the nullable column `projects.idle_notice_at`, when the retention job gave notice of an idle project. No default, so no row is rewritten.
- **Project files: author indexes (0176):** a person's deletion clears them as author of every project file version and project file by `client_instance_id` and the author column, which had no index, so each deletion scanned both tables whole. Migration `0176_project_file_author_indexes` adds the partial indexes `project_file_versions_by_user_idx` and `project_files_updated_by_idx`, built with `CREATE INDEX CONCURRENTLY` in a migration of its own so writes are not blocked. A test plans the deletion's two updates and asserts both use their index.

## 0.8.0-rc.19 — 2026-10-28

### Added

- **Apps:** App pages and Edit in chat name other visible workspace members with an unsaved checkout of the current draft, with the checkout time. The hint clears after saving, a newer draft, or 24 hours without chat activity. It exposes no chat title or content.
- **Chat:** An agent under "Only me", owned by a person's Personal Workspace, can now be chosen by that person in any chat they began that nobody else reads: a chat of their Personal Workspace or a private chat in a team. Choosing it marks the chat as holding personal data, so a later move to the workspace is refused. In a chat others read the agent picker shows it greyed with the reason. Nobody else sees it, and a key, an embedding host, a service principal, a subagent of another agent, a Workflow step or a scheduled start cannot use it. `workspaces.agents.list` returns such agents as `ownChatAgents`; the same chat-audience rule (`mayUseOwnInChat` in core) now also decides personal skills in chats. The publish dialog's "Can be chosen in" for such an agent reads "In your own chats". In the usage of a shared workspace such an agent counts to the workspace under one row, "Personal agents" (`PERSONAL_AGENTS_KEY`), never by its name.
- **Project files:** A project has a folder of files with versions. Its page shows the file tree, takes files, folders and `.zip` archives (unpacked into a folder), and shows each file's versions with who made them and a restore. Uploads in a chat of a project land in its folder; a chat's contents have a "Project" section, an attachment can be saved to the project, and a file of another project the person reads can be added to a message. The agent of a chat in a project lists, reads, writes and edits the folder at `project/` with the file tools and is told its files in the system message; a write over a file that changed since the agent read it is kept beside it as a conflict copy, and the turn shows each change with an Undo. Only the project's audience reads or writes its files. `projects.files` sets the caps on files, bytes and kept versions. A deleted project, workspace or user takes the project files along; a deleted user's private projects go too.
- **Projects:** A project's `AGENTS.md` at the root of its folder holds its instructions. Every run in the project takes them after its agent's own instructions (cut at 16,000 characters), records the version it took and keeps it when it resumes. Only a run whose person reads the project gets them; a subagent gets its root chat's, a Workflow step none. Each read is audited by project and version only.
- **Projects:** The project page has an Instructions tile that shows, edits and lists the versions of `AGENTS.md`. When the agent writes or edits it, the run waits on a card that shows the change and that it applies to everyone in the project, also where changing calls are allowed. A chat whose instructions changed elsewhere since its last answer shows a line that opens the change.
- **Projects:** The agent's description of a project folder now says to keep what the team needs in one file per topic, name the source file and record personal data only where needed.
- **Projects:** The Projects page has a scope filter, "This workspace" and "All my workspaces". Across workspaces the projects stand in one group per workspace, each card with its workspace's chip, and opening a project of another workspace switches to it. `projects.list_mine` (`GET /api/v1/projects`) lists them from the person's memberships under the audience of each project: a private project only for its creator, and no grant, bundle or instance role adds one. A project in a list now carries how many chats it holds and when it was last used (PRJ-5).
- **Projects:** The rail shows the five projects of the open workspace used last in a group above "Recent", with a plus that makes a project and a row to all of them.
- **Shared skill drafts:** A skill the instance or a Shared Workspace owns now has one shared draft, as an agent has. `skill.write` edits the draft and `skill.publish` makes it live through the `skill.before_publish` guardrail event (no guardrail is bound by default). Holders of the skill's write right read and try the draft, and Try runs an agent with the drafts of the skills it uses only where the person holds write on them; everyone else gets the live revision. Skills of a Personal Workspace stay live on save, and existing skills keep their live revision. The skill page shows the draft badge, Publish and Discard draft. `skills.draft.get` and `skills.draft.discard` read and drop the draft. `catalyst config push` writes skill drafts; `--publish` or `catalyst skill publish` makes them live, and `catalyst skill discard` drops one.
- **Workflows:** The Workflow canvas draws a `parallel` block as a frame with its branches side by side and a join after them, and a `condition` as a fork with its paths; a chain of else-conditions is one fork with one exit per path. Each branch shows its last run's status and duration, and a parallel frame shows its step counts.
- **Workflows:** A run's page has a timeline that plays the run back moment by moment: a bar per step and per branch shows which branches ran at the same time and how long each took, and the canvas shows the run as it stood at that moment.
- **UI:** `Timeline` shows bars on one time axis with an optional cursor; flow groups take `lanes` and a `joinLabel`.

### Changed

- **Release:** The artifact-helpers package may pack to 9,000,000 bytes: it ships the standalone helper bundles, skills and the Python file tools.

### Fixed

- **Release:** The artifact-helpers package publishes its `runtime` folder, the Python file tools the file helpers run.
- **Workflows:** On the Workflow canvas, every test in a chain of else-conditions ("Otherwise if: …") is now a row of the fork you can select. It opens that test's own panel and shows its run status and duration. Before, only the first condition could be opened.
- **Workflows:** Durations on the canvas (steps, branches, a parallel frame) are given to the second, as the run's timeline gives them: "1 min 54 s", not "1 min".
- **UI:** A `condition` exit can name a `part` (`FlowExitPart`: id, status, meta). Its row is then selected by that id and shows the part's status and time. `FlowNodeRow` takes `status`, `meta`, `onOpen`, `selected` and `partId`.
- **Agent Runs:** Workers restore a starter's personal API key scopes when rebuilding the caller, including after a pause and in subagents. Tools keep the key's operation access and the scope ceiling on its owner's current rights; Data Store row tools can no longer inherit the owner's wider access. A revoked or expired key stops the run before execution.
- **Projects:** The plus of the rail's Projects group is named "Add project", so it is no longer read out with the same name as the Projects page's "New project" button.
- Admin screens and the remaining chat interface messages use “Everyone” / “Alle” for a place and “all workspaces” / “alle Arbeitsbereiche” for organization-wide settings and rights, following SCOPE-WORDS. English and German no longer expose “instance” / “Instanz”; technical identifiers stay unchanged.
- An agent's Knowledge Base chooser shows the Knowledge Bases of the reader's other places greyed, with the reason and, where the ladder goes up to the agent's place, "Share with everyone…" / "Share with {team}…", as the skill and Data Store choosers do.
- An agent's skill chooser shows the skills of the reader's teams greyed with the reason and the share step, instead of hiding them; only names and titles the reader may list, never contents.
- A Knowledge Base and a Connection of everyone say beside their place where agents may use them, or that none may yet, which leads to "Available in".
- **Teilen…:** a person who belongs to a team but holds no right on its assets is offered that team in the dialog, beside Alle, and can send a request to share with it. Before, only Alle was offered, because Studio names a team only where the person holds such a right. The dialog now reads the person's own memberships; the instance already decided and filed the request.
- **Asset page head:** a browser check at 390 and 320 px that the head of a skill and of an agent with a draft keeps every control inside the window, and that Replace and History stand in the "…" menu.
- **Skill import:** Importing a skill again under the address of a deleted skill creates it anew, as a page opened empty does, instead of saying the address is taken.
- **Workflows:** Continuations preserve open parallel and condition blocks, resume unfinished branches without repeating completed effects, and retain a single block with its branch records for run replay. Calls already in flight settle before the handoff.

### Database

- Migration `0173_project_files` adds the tables `project_files` (each file of a project as it is now) and `project_file_versions` (its kept versions), keyed to the project's asset with `on delete cascade`. Both are new and empty, so nothing is rewritten or validated.
- `agent_runs` gains the nullable columns `project_id` and `project_instructions_version`: the project a run's chat was in and the version of its `AGENTS.md` the run took. No row changes.
- Migration `0174_skill_draft_file_set` adds the nullable `file_set_id` column to `agent_change_proposal_revisions`: the folder a skill draft revision holds. Existing rows keep `NULL`; no row is rewritten.

## 0.8.0-rc.18 — 2026-10-28

### Added

- **Workspace files:** Execution workspaces inspect unfamiliar files before declaring them unsupported. Both runner system layers include archive, mail, HEIF and iWork programs; file helpers receive the configured workspace byte ceiling before extraction.
- **Files:** Agents with both workspace file tools can receive any nonempty source file within the configured size limit. Uploads carry the selected agent, checked against access in the conversation workspace; source manifests describe the type detected from the first bytes, including renamed archives and unknown binary data.
- **Files:** HEIC, HEIF, TIFF, BMP and AVIF attachments keep their original bytes and receive an upright, bounded JPEG or transparent PNG view. Multi-page TIFFs use a canonical PDF for page viewing and OCR. Views follow attachment retention; images exceeding conversion limits remain available to workspace tools with an explanation in model context.
- **Studio:** An agent page has a "Data" / "Daten" section. It gives the agent Data Stores to "read" / "lesen" or to "read and change" / "lesen und ändern", and saves them as the store's existing row tools in the agent's tool list (`data_store.<store>.describe`, `.query` and `.preview_rows`, plus `.insert`, `.update` and `.delete_rows`). The runtime is unchanged. A store the agent cannot use, such as the reader's own for an agent of everyone or a team's for an agent of another place, is greyed with the reason. One line says that every call still checks the rights of the person in the chat. These tools no longer show by their names under Tools.
- **Studio:** An agent page's head says where a chat can choose the agent: "Can be chosen in: All workspaces" / "Wählbar in: Alle Arbeitsbereiche" or the workspaces it is offered in. Where none can, it says "Cannot be chosen in any chat" / "In keinem Chat wählbar" and, for a reader who may change that, links to the "Available in" section. This replaces "Offered nowhere yet".
- **Chat:** An agent can ask the person one question with two to four answers (ASK-1). The conversation shows it as a card, the recommended answer first; the agent's turn ends there. Picking an answer, or writing one on the card or in the composer, sends it as the person's message and the agent goes on. An answered card shows the answer and takes no other, also after a reload.
- **Agent tools:** `ask_question` is offered to every agent of a conversation, not to subagents or Workflow steps. Its description tells the agent to ask only about outcomes the person cares about, in everyday words, and to decide technical choices itself.
- **Agent tools:** `platform.files.list` answers `href` for the conversation that holds each file, so the agent links that conversation instead of naming it.
- **UI library:** `Choice` and `ChoiceList`, answers to a question as full-width buttons.
- **Workshaper:** Before building, it breaks the request into small steps, says what works on the instance and what needs an administrator or Workshape, asks open choices with the question card, and builds and tests the smallest working piece first. It links the conversation that holds an App's files and names no interface path it has not seen in the docs or tools. The Workflow authoring skill asks for a plain description of every step and for data loaded once, with independent items in a loop with `concurrency`.
- Edit an existing App from any private chat in its workspace with `app.edit`. The current draft and all source files load into the chat, and saves advance its checkout atomically. A stale save names who saved and when, then directs the agent to reload and reapply its change. Existing build chats keep working.
- **Edit in chat** ("Im Chat bearbeiten") on an App's page and its draft: opens a new private chat with the Workshaper beside the draft, which already holds the App's current draft with all its files, so the person says what to change and the agent saves it as the next draft. Offered only to people who may edit the App; `conversations.create` takes `checkout: true` for it and creates nothing without `app.write`.
- **Projects:** With the instance module `projects` switched on (off by default), every Collaboration Workspace has projects (PRJ-1): named folders of chat work in exactly one workspace. A project is shared with the workspace or only for the person who made it; a new one takes the workspace's default for conversations, and in a Personal Workspace it is always the workspace's. A conversation in a project is read by exactly the project's audience and takes its visibility on entry; leaving a project keeps the visibility. A private conversation cannot enter a shared project, a conversation with personal data or a person's subject stays out of a shared one, and only the conversation's creator moves it in. Moving a conversation to another workspace takes it out of its project. Chats without a project are unchanged.
- **Rights:** `project.read`, `project.write` and `project.delete` come only from workspace membership. No role default, grant or Builder bundle opens a project; the superadmin reaches the shared projects of a Shared Workspace as its Owner. A project outside a person's reach answers `404`, also by link.
- **API:** `projects.list` (`GET /api/v1/workspaces/:collaborationWorkspaceId/projects`), `projects.get` (`GET /api/v1/projects/:projectName`), `projects.create` (`POST /api/v1/projects`) and `conversations.set_project` (`PUT /api/v1/conversations/:conversationId/project`). `conversations.create`, `conversations.runs.create` and `conversations.list` take a `projectId`. Audit events `project.created` and `conversation.project_set` record ids and the audience only.
- **Chat:** The rail has a Projects row; the projects page lists a workspace's projects and makes new ones, the project page shows its conversations and starts a new chat in it, and a conversation's menu moves it into or out of a project.
- **Skills:** A skill of a person's Personal Workspace has the switch "Use in my chats" ("In meinen Chats verwenden") on its page (SCOPE-MYCHATS). Switched on, every agent the person chats with, the Workshaper included, is told of it and may read it, read-only, like its own skills; the page head shows "In my chats". The agents themselves stay as they are, and nothing is shared: only runs the person started themself in a chat they created that no one else reads (in their Personal Workspace, or private) get it, as for a personal Connection. A chat other people read gets none, whoever's turn it is; so do a subagent, a Workflow step, and a run started or acting with a key, a service principal or an embedding host. A read of such a skill marks the chat as a personal Connection's call does, so it cannot be moved to or shared with a team.
- **API:** `me.chat_skills.list` (`GET /api/v1/me/chat-skills`) lists the skills of the signed-in person's Personal Workspace with their switch; `me.chat_skills.set` (`PUT /api/v1/me/chat-skills/:name`) switches one. Only the person signed in themself reads and sets their own; another person's skill answers `404`, a key `403`. Each switch records the audit event `user.chat_skill_changed` with the skill's name and the value.
- **Database:** Migration 0167 adds the table `personal_chat_skills`: one row per switched-on skill, removed with the skill.
- **Sharing an asset (SHARE-1):** `assets.move` shares a skill, agent, guardrail, Workflow, Data Store, Knowledge Base or App up the ladder, from a Personal Workspace to a Shared Workspace or the instance, and from a Shared Workspace to the instance, never down or sideways.
  - **Who may move it:** only the owner of a Personal Workspace moves what lies in it. From a team, the person must be allowed to change everything that goes along.
  - **What moves:** what the asset uses from its owner moves with it.
  - **Edit rights:** they follow the new place. The move drops grants to change the moved assets, and drops read or use grants that reach beyond the new place's readers. It also drops what a moved Workflow's run account held at the old place.
  - **Refusals:** each one names its reason in a plain sentence.
  - **Direct or by request:** with the write right at the target, the move happens at once. Without it, the move files a `<kind>_move` approval request. Someone who holds that right accepts or declines it in the Inbox. When the request is decided, the requester is checked again: they must still be active, a member of the target team, the owner of the Personal Workspace, or, from a team, allowed to change everything that goes along.
  - **Dry run:** `assets.move_check` answers what moves, what breaks, which grants go, whose data goes along, and who reads and edits it afterwards.
  - **Audit:** the move records `asset.moved` with ids only, in one transaction with the owner change, or with the decision of the request.
- **Teilen mit… (SHARE-1):** every asset page head in Studio, and the Workflow and App heads, offer "Teilen…". The dialog names the rungs above the asset (a team the person belongs to, or Alle; Apps go to teams only), and shows what the instance's check says: what moves along, what data goes with it and who reads it, who uses and changes it afterwards, the rights that end, and what stops working, which needs an explicit confirmation. With the right at the target the button reads "Teilen", without it "Anfrage senden"; a refusal shows the instance's sentence. After a move the page shows its new place.
- **Inbox:** a request to share (`<kind>_move`) says who asks to share what with whom, shows the same summary, and offers Annehmen and Ablehnen; a request that no longer moves what was asked offers only Ablehnen, and an ended one says why.
- **UI library:** a disabled picker option can carry an action, such as "Für alle teilen…" on a skill an agent cannot use from where it sits.
- **Apps:** Adds the dark SRV-1 preview capture service: isolated, sandboxed Chromium, a stub App bridge, bounded request jobs and short-lived content addresses. The `preview.capture` tool keeps using the browser; the deployment-kit image and Compose overlay are opt-in and no deployment is enabled. Migration 0168 adds nullable server request and diagnostic fields; apply committed migrations before enabling. Startup refuses with "preview-capture refused startup: check its isolated environment and renderer sandbox" without the required Linux sandbox. Captures refuse with `capture_busy` when the queue is full and `capture_failed` on failure. Roll back by disabling `PREVIEW_CAPTURE_ENABLED` and the Compose profile; keep the added columns while workers drain.

- **Preview capture fixes:** Each concurrent capture slot owns its browser, so a deadline or renderer memory refusal affects only that capture. The two-slot Compose defaults reserve 1 GiB of memory, 512 MiB of shared memory and 384 process slots for the independent browsers. DNS prefetch is disabled and WebRTC constructors are unavailable in captured documents. Rights refusal coverage independently checks active users, conversation access, App write rights and the conversation's subject or created assets; capture proofs receive the exact invalid-session refusal for App actions.
- **Data Stores:** Agents can describe a Data Store before they have its row tools: fields in words, row estimates, published dependencies, the person's rights and whether this chat can read records. The same metadata is available to outside keys without exposing rows, samples, SQL or defaults. Workshaper is instructed to name only interface paths returned by tools.
- **Chat:** An agent can add a Data Store to the chat for reading, next to what the chat is about (STORE-USE-1). `data_store.use` adds the store's `describe`, `query` and `preview_rows` tools, never tools that change records, and the agent uses them in the same turn. The person's own store, in a chat of their Personal Workspace, is added at once. Any other store shows a card, "Read “…” in this chat?" / "„…“ in diesem Chat lesen?", whose "Allow" / "Erlauben" adds it and lets the agent go on. A chat others read gets no store: the agent says to start a chat of your own. A chat that reads a store stays private: moving it to a Shared Workspace for the workspace to read is refused.
- **Rights:** Adding a store grants nothing: every read still checks the person's `data_store.read`. Only the person can add a store, in their own turn: a subagent, a Workflow step, a scheduled start, a run started with a key and an outside client cannot. A Personal Workspace's store is read only in its owner's own chats there. The audit log records each add as `conversation.data_store_added`, with ids only.
- **API:** `POST /api/v1/conversations/:conversationId/data-stores` (`conversations.data_stores.add`) is the card's confirmation. It takes the store and the agent's call it confirms, and only the person whose turn asked for it may send it.
- **Agent tools:** `platform.data_stores.describe` names `data_store.use` as the next step where the chat has no tools for the store's records. A tool now learns whether the call is a subagent's, a Workflow step's, a scheduled start's or a first-party run's.
- Agents can list a Workflow's recent runs and inspect historical failures and step timings with the same rights and run-data restrictions as the Workflow run page.
- **Shipped agents:** An agent that ships with the platform, such as Workshaper, has "Additions of this instance" ("Ergänzungen dieser Instanz", `additionalInstructions`): text the agent follows after its instructions, which a release never changes. The platform's instructions stay closed on the agent page until "Change platform text" opens them. Where the instance changed a field and a release changed it too, the field shows both versions with "Take new version" and "Keep mine"; the definition names such fields under `shippedNewer`, which only a release adds to. A pending draft of a shipped agent is moved onto each release, so publishing it no longer writes the previous release's text back.
- **Chat:** Where another agent answers from within a conversation, its history shows a quiet line above that message, such as "Ab hier: Persönlicher Assistent", so it is clear why the tools differ. The line is read from the runs' agents, so every reader of the conversation sees it, after a reload too; the thread snapshot names the agent of each run by the message that started it (`runAgents`). A newly made agent becomes neither the default nor the agent of an existing conversation; a test pins it.
- Workflows run independent analyses in `parallel` branches, joining after every branch ends, and choose a path with `condition`. Branch results, nesting, progress counts and step timings use the existing run reads. The authoring skill recommends loading shared data once, describing every step plainly and running independent work together. Continuation checkpoints reject branch frontiers they cannot preserve.

### Changed

- **Release:** The api-contract package may pack to 400,000 bytes: its schemas and declarations grow with every API operation.
- **Release:** The ui package may pack to 600,000 bytes: it ships the source and compiled components, which grow with the interface.
- **Studio:** Publishing an agent now also says where a chat can choose it. The publish dialog asks "Can be chosen in:" with the places the reader may set: all workspaces for an agent for everyone, or the agent's own team. An agent that is already offered keeps its place; one offered nowhere starts at its own place and may stay in no chat. Once the draft is live, Publish sets the place through `assets.set_availability` and its checks; a publish that waits for an approval or is refused offers nothing. A reader without the right sees the place read-only with the right that changes it; an agent under "Only me" is offered nowhere wider. Agents pushed with the config CLI still start hidden.
- **Studio:** One set of words for where an asset sits, the same on every screen: "Only me" / "Nur ich" for the reader's Personal Workspace, a team by its workspace name, and "Everyone" / "Alle" for the instance. The list filter is called "Where" / "Wo" and lists the places in that order. Studio no longer says "Instance", "Scope" or "Geltungsbereich" for a place.
- **Studio:** Every list row and asset page shows where the asset sits as a chip. An agent page also shows who uses the agent when that is not everyone: the workspaces it is offered in, nobody yet, or only people with the right to use it. The read-only notice says it in the same words.
- **Studio:** An agent's skill chooser shows the reader's own skills greyed out, with a one-line reason, when the agent belongs to everyone or to a team and so cannot use them.
- **Studio:** When an asset is refused because it uses something from another place (`invalid_scope` with a reference), the message says where the asset sits, what it used, and what to do: make the item in the right place, or ask an admin.
- **Studio:** Data Stores are listed as "Data" / "Daten" and Knowledge Bases as "Knowledge" / "Wissen". A Knowledge Base over a data store's tables is offered as "Knowledge from your data" / "Wissen aus deinen Daten".
- **UI library:** `ScopeChip` takes `scope: "personal"` for the reader's own place.
- **Studio:** For an agent, Knowledge Base or Connection that is "Only me", the availability fields and the New dialog's "All workspaces" stand greyed with the reason, as the instance refuses them.

### Fixed

- **Rights:** Something shared never relies on or exposes something a Personal Workspace owns. One check, `assertOwnerReach` (the decision `ownerReachRefusal` in core), now refuses: offering a Personal Workspace's agent, subagent, Knowledge Base or Connection in a Shared Workspace, in every Personal Workspace or everywhere (`assets.set_availability`, `owner_reach`); widening such a Knowledge Base as an agent's dependency; creating such an agent with `availableIn` `all` or another workspace; publishing such an App for the whole instance, which the Publish dialog no longer offers (`app_instance_needs_shared_workspace`, MOVE-1 check 65); and an instance Workflow naming such a Data Store, Knowledge Base or App (`invalid_scope`). A Shared Workspace's asset offered in another workspace or to the whole instance is allowed as before. What is shared today keeps running until its next change; `scripts/preflight-owner-reach.sql` counts it read-only, and `scripts/preflight-reference-owners.sql` now counts an instance Workflow's references to a Personal Workspace.
- **Chat:** The refusals say "Nur ich" / "Only me" and the next step: create it in a team or for everyone, or ask an admin.
- **Chat:** Workspace commands that mount a person's switched-on chat skills mark the conversation as containing personal data before they run. The same locked audience check as `read_skill` keeps the chat private and refuses the command if it cannot be marked.
- **Scope:** A publish that is made but cannot set where the agent is offered now says why and keeps the dialog's choice as an unsaved change on the agent page, to save again. `canSetAvailability` is false for what a Personal Workspace owns, and the missing-dependencies list no longer offers to make a personal Knowledge Base available. A reference to something only its owner has is refused in the caller's language with where it sits and the next step ("Teilen…" or ask an admin).
- **Model calls:** Premature model stream endings are reported as retryable provider timeouts. Calls retry up to three attempts while no answer, reasoning or provider tool activity has reached the reader; visible output is never silently replayed. When a run times out, the chat explains in German or English that it was interrupted, completed steps are kept, and “continue” resumes the work.
- **Data Stores:** The Data Store list in Build shows the "Draft" badge on a store whose saved draft waits to be published, as the Agent list does, so the row no longer reads only "Ready". The badge goes away once the draft is published.
- **Chat:** A picture or file can be sent without text. The send button and Enter take a message whose only content is its attachments, on the start page and in an open conversation, and the agent gets it as a normal turn. A picture pasted into the composer uploads like a picked file, so it goes with the message instead of being dropped. A message with neither text nor attachment is still refused: `conversations.runs.start` answers it with `VALIDATION_FAILED`, and `conversations.runs.create` refuses an empty first message before it makes a conversation.
- **CLI:** The CLI sends its version and checks the server release before parsing responses, with an exact npm install command when they differ. Unexpected success responses identify the reached URL, content type and body category without exposing content. `catalyst doctor` checks address, sign-in, versions and effective key rights in four shareable lines. CLI installation and update docs include Windows PowerShell 5.1.

  Version mismatch refusal: `Catalyst CLI <cli-version> does not match server <server-version>; run: npm install --global @work-shape/catalyst-cli@<server-version>`. The CLI for that server release must be published before users can follow the command. Older servers without version headers retain their existing request behavior; rolling back the server requires installing its matching CLI version. Existing CLI binaries need an update to gain these diagnostics.
- **Chat:** HTML, CSS, JavaScript, SVG and XML files can be attached as source files for the agent to read. Source files remain downloads and are never rendered or run in the chat.
- **Chat:** A conversation opens with the agent it was held with and keeps answering with it. The agent picked for a new conversation, or in another one, no longer carries over into an open conversation; the thread snapshot names the agent of the conversation's latest run (`agentName`).

### Database

- Migration `0170_projects` adds the table `projects` (a project asset's audience and creator) and the nullable column `conversations.project_id`, with its key and check added `NOT VALID`; no row is rewritten. `0171_project_conversations_index` builds the index of a project's conversations concurrently, and `0172_projects_validate` validates the key and the check in a transaction of its own, so reads and writes pass during the scan.
- Migration `0169_conversation_data_stores` adds `conversation_data_stores`: one row per Data Store a person added to a conversation for reading, with the store's id, who added it and when. Rows go with their conversation, store or account. It is a new, empty table; no row is rewritten.

## 0.8.0-rc.17 — 2026-10-28

### Changed

- **Release:** The outside-forms package may pack to 450,000 bytes: it ships two built web pages, the public form page and its preview beside the chat.

## 0.8.0-rc.16 — 2026-10-27

### Added

- A capability's asset kind can bring a preview of its draft (`AssetKindPreview`): a document of its own and the files it loads. The instance serves it in the frame of a Page, under the Page guard and the same Content-Security-Policy with `connect-src 'none'`. Of the revision's own files it serves only style sheets, images and fonts. `POST /api/v1/assets/{kind}/{name}/preview` (`assets.preview`) mints the frame address for a writer of the asset. The agent can create such a kind in chat. A save with `platform.assets.put` answers `preview: true`, and the interface shows a card and opens the draft beside the chat. The preview reports into the conversation about the asset, or the one that created it.
- A run or a tool that fails for a platform reason offers "Problem an Workshape melden" in the conversation. A small dialog says what is sent (the run's id, the error code, the instance and the time; nothing of the conversation, its files or logs), takes an optional note and sends. `POST /api/v1/conversations/{conversationId}/runs/{runId}/platform-report` (`platform_report.send`) checks the failure again from the run's records and mails the release config's new `support.email` from the instance's own sender; Reply-To is the person only when they tick "Antwort an mich". One report per run and person, five per person an hour. The audit records `agent_run.platform_reported` with the run, the report and the code, never the note. Without `support.email` or mail the action is not shown.
- The agent can look at the preview (`preview.capture`). The picture is taken in the browser of the person whose turn the run serves, from the preview they have open: the platform's guard in the Page frame draws the document into a canvas through an SVG `foreignObject`, with no prompt and no server rendering. The picture is a WebP of at most 1280 by 1600 pixels and 400 KB, given to the model of that run as an image and kept as an artifact of the conversation with its retention. A run takes at most 3 pictures and a person's runs at most 20 an hour (`capture_limit`). A browser that cannot take one, such as Safari, answers `capture_unavailable`; with no preview open the run is told `preview_not_viewed` within 10 seconds; a preview whose actions reach a personal connection is never pictured (`preview_personal_data`). The tool is offered only on a model route with image input. Only the person's own frame of the revision asked for can answer: `GET /api/v1/conversations/{conversationId}/preview-captures` (`apps.preview_captures.pending`) lists the caller's own requests, and `POST /api/v1/app-content-sessions/{pageSessionId}/captures/{captureId}` (`apps.sessions.capture`) takes the answer with the frame's proof. Neither writes an Operation Run or an audit event.
- The picture the agent took of the preview (`preview.capture`) shows small on that call in the run's work and opens larger in the file viewer beside the chat. It is read through the conversation's artifact content and gets no card of its own. A call that took no picture says why in the reader's language: the preview was not open, the run or the hour had taken as many as it may, the preview reads data through a personal connection, or the browser cannot take one. Workshaper and the tool's description look only for a visual change the preview's report cannot judge, such as layout, colours or a chart, at most once per change, and leave errors to the report.
- The agent learns what the preview it opened did. Before its next model request, a run that opened a revision adds a short note to the `workspace.open` result: whether the page loaded, whether the kit's bridge connected, whether the page drew anything, and up to a few hundred characters of its errors and failed calls. It reads only the report of the person whose turn the run serves, never another member's. It waits at most 6 seconds, and only while that person has a preview of the conversation open; otherwise the note says "not viewed" at once. A report that arrives later is noted once before a later model request. No extra model call or tool is spent. The interface now sends the settled report right after the mount instead of 5 seconds later, and repeats an unchanged report every 30 seconds while the preview is visible, so a run knows someone is looking.

### Fixed

- **Apps:** History names the agent that saved each draft, keeps recreated Apps separate, and omits publication dates that are unknown.
- **Chat:** Keep the conversation header opaque behind its controls at every width, so scrolled messages never show through the agent picker.
- The local deterministic model reads a `/tool` command's input as its first JSON value. A later preview report that the run adds to the person's message no longer turns the command into invalid JSON, so the call runs instead of failing silently.
- App publish confirmations show bound Data Stores that are still updating, even when the agent names no store.
- Images that fail to decode show file fallbacks in message parts, attachments and blob artifact previews. A new image source is tried again.
- **Apps:** Preview error reports resolve bundle positions to the App's source file and line using revision-specific source maps kept on the server. Source maps are never served to the preview frame.
- **Chat files:** Attachments, message files and artifact thumbnails use the same supported raster image types as the file viewer. SVG and other unsupported image types appear as file chips.
- **Workflows:** Pruning a run's values now also clears answers and comments that were missed. The run's own step calls lose a changing call's answer. Decider comments are removed from every call and request of the run, including the comment on a declined call. That holds for a call running at prune time and for a request approved but not yet carried out. A call approved before the prune and run after it is carried out as usual but stores no answer, and neither does a request decided after the prune. Such a request also loses its error message and the input of its call, and no decision message is added to the pruned thread. Who decided, when and the outcome stay. Without attachment handlers, file copies in a run thread are removed along with their records when their bytes are in the files store. Retention version 4 cleans up runs pruned earlier.
- Data Stores record `job_exhausted` when a provision or migrate job loses its final lease. An App publish refuses promptly with a reason and recovery step in German or English; manually retrying the job clears the store failure. The job executor also runs `onExhausted` for non-retryable failures.
- A Workflow a credential published (a personal API key, its Inbox confirmation, a Service Principal's credential or a run), by the newest publication of its revision, starts only while its reach, child Workflows included, is open to outside clients, asked at every start: by hand, by a schedule, by an App, by a parent, from outside and at a continuation. A child a person re-published to read a Connection kept from outside clients, or `outside` taken off an operation, now stops the next start with `reach_person_only` (`CONFLICT`, naming no Connection; a schedule's due time is skipped with that reason) instead of letting a scheduled Workflow keep copying the data into a Data Store. A person's publish of the same revision makes it the person's again; a revision published before publications were recorded counts as a person's.
- A credential no longer publishes a Workflow that a live Workflow with a reach closed to outside clients starts, directly or through Workflows between, by a `workflow` step, an operation step or an agent's tool: refused with `reach_person_only`, naming only the Workflows the publisher may read. A child a credential published is not started, nor continued, by a run whose reach, or that of a run above it, is closed: a parent, the run whose operation step or agent step's agent started it, and so on up. A parent a person publishes later cannot hand it a closed Connection's data either. The step fails with `reach_person_only`, and the Workflow's page says a person publishes it again.
- A Workflow run that an operation step or an agent step's tool started now keeps the run behind that call, including the platform's `workflows.start` operation, and every continuation keeps it too. Before, a credential-published child could be started or continued past a closed starter in two cases: after the run continued as new, which drops the start call, or after the start call was pruned by age. A run opened before this change reads its starter from its first history's start call once more at its next continuation, while that call is still kept, and passes it on. When retention has cleared a starter's own definition, the starter is read from the revision it names. A starter that cannot be read counts as closed.

### Database

- Migration `0166_platform_reports` adds `platform_reports`: one row per platform problem report, with the run, the person and the error code, never the note. It holds the limits of one report per run and person and five an hour; rows go with their person, and a daily job removes them after 90 days.
- Migration `0163_preview_captures` adds `preview_captures`: one row per picture a run asked of a person's preview, with where the request stands and the artifact of the picture, never the picture. Rows go with their conversation, their person or their file set, and the hourly preview-report job removes them after a day.
- Migration 0161 adds `preview_viewer_reports`: one preview report per conversation, file set and viewer, with the digest of the report a run last noted. Rows go with their conversation, file set or account, and the hourly job deletes rows older than 24 hours. `preview_reports` is no longer written; its remaining rows are pruned the same way, and a later migration drops it.
- Migration 0164 rebuilds the two Workflow retention indexes for retention version 4 and adds `operation_runs_workflow_run_idx`, so the calls of a run's own steps can be found when its values are pruned. All indexes are built concurrently.
- Migration 0165 adds the nullable column `workflow_runs.starter_run_id`. It has no default and rewrites no row, and there is no backfill.

## 0.8.0-rc.15 — 2026-10-27

### Added

- A capability's asset kind can read its own files into its manifest and config, and its kind's publish can carry a guardrail: `form_page.before_publish` is the first, for the form pages of outside forms.
- Capabilities reach the published revisions and files of the asset kinds they bring, and the scope of the Workflow an Operation Run serves.
- The shipped guardrail "Publishing needs an instance admin's approval" holds a form page's publish as a `form_page_publish` request, which a holder of `app.approve` decides.
- A Page or App draft preview reports on itself to its conversation. The report says whether the frame loaded, whether the kit greeted within 5 seconds, and whether the page drew anything. It lists uncaught errors, unhandled rejections, `console.error` calls, content policy violations, and failed calls by action name and refusal code. Each report holds at most 10 distinct entries with counts, 200 characters per message and 2 KB in all. Quoted text over 24 characters, digit runs, address queries, mail addresses and IBANs are scrubbed in the browser and again on the server. No audit event, log line or Operation Run holds a report. Only the latest report per conversation and file set is kept, for 24 hours.

### Changed

- Workshaper hands over at the end of a build step in up to four short parts: what is done, the person's one next step, what it does next, and what must be settled and by whom. The person's step is a card or a link to the place, never a click path in words; a publish step ends with the publish card, which carries the App's pending Workflows and Data Stores, and Workshaper carries on once it is answered. It names a need only an administrator or Workshape can meet before it starts building.

### Fixed

- Check an App's stored files, bound Data Stores, SQL action rights and Workflow contracts before publishing its named Data Stores. A refusal from these pre-checks leaves the stores unchanged. The checks use the named revisions and run again when the App goes live.
- Check only rendered mail fields when testing notice digests for sensitive content, avoiding false failures from random message identifiers.
- **Apps:** At a phone's width the draft's head of a published App showed neither "Live: version n" nor "Draft: changed since version n": the head gave the state up for its buttons. The state now keeps its own line above the tabs there, as the state of an App never published did, and stands at the end of the tab row on a wide screen for every App alike.
- **Apps:** History no longer counts a save that became a version as a draft save too. An App saved once and published once shows "Version 1" alone; under each version are only the saves made after it, and a publish of an earlier version again is its own version, with "Publish again" on an earlier one. The list and the draft head name the same states the same way: "Draft · not published" and "Draft: changed" in place of "Draft only" and "Unpublished changes", and the draft line says "Version 4 published by …" instead of "Published by …".
- Creating a personal API key or confirming a CLI connect code now says, beside the choice to use Connections, that the results of these calls are copied to the computer that holds the key. The choice stays off by default.
- A Workflow test run started with a personal API key now says in its own words why it stopped: the key was revoked or expired, the key lacks a right the person holds, or the step needs a right no key can carry. Each says what to do next, in English and German.
- **Apps:** Checkout previews name the App for readers without write access and keep save actions for writers. Previews of unreadable Apps show a neutral state without revealing the App's name or claiming it is unsaved.
- Align publish tool guidance with the build handover: offer the confirmation card at the end of a build step that leads to going live, and include pending Data Stores alongside Workflows when publishing an App.
- Outside-start publish refusals name only readable Connections, Knowledge Bases and child Workflows, and operations from readable definitions; they count the rest. An outside client reads a child run under an outside-started root with its existing run-data rights, and only where it started the root or may read the root's run data. A Workflow step refused for Connection exposure points to the exposure setting instead of asking for a grant.
- Only a person signed in to Catalyst publishes a Workflow that outside clients (CLI, MCP) can start, or one that reads data not open to them. A personal API key, a Service Principal's credential or a run is refused with `outside_switch_person_only` when the revision has that switch on, also where the published revision has it on already, and with `reach_person_only` when the revision, through its child Workflows too, calls a Connection operation not exposed to outside clients, reads a Knowledge Base or calls another closed operation, whatever the switch says. The refusal names only what the publisher may read. A key still writes drafts, and publishes a Workflow whose reach is open to outside clients with the switch off. Before, a key that may publish Workflows could publish a Workflow copying a Connection's data into a Data Store, or re-publish a child an outside Workflow starts, and read through an outside Workflow data the Connection keeps from outside clients.

### Database

- Migration 0159 adds `preview_reports`: one report per conversation and file set. Rows are removed with their conversation or file set, and an hourly job deletes rows older than 24 hours.
- A Workflow run key is held per starter: the person, each of their API keys, or the Service Principal that started the run; a child run holds its key for its root's starter. A start with a key another starter holds is a new run, answered exactly as a key no run holds, so a key no longer tells whether someone else uses it. A repeat by the same starter still answers its run. Migration `0160_workflow_run_keys_per_starter` replaces the run key's unique index with one per starter, built concurrently.

## 0.8.0-rc.14 — 2026-10-27

### Added

- **Chat:** A link in an answer to a page of the app, such as a Data Store's page, a Workflow, an App's draft or an Inbox item, opens that page in place with the conversation docked beside it. A click with a modifier key opens the page's own address in a new tab, without the conversation. Every other link behaves as before.
- **Agent tools:** `platform.assets.get`, `platform.assets.open`, `platform.assets.list`, a created draft of `platform.assets.put`, the entries of `apps.publish_review` and the request of `propose_skill_change` answer `href`, the path of the page where the person acts, so the agent links the place instead of describing the way there.
- **Apps:** An App's Publish carries the Data Stores its manifest binds (GOLIVE-1). `apps.publish_review` lists each store whose draft is not published, with its live level, the level the App needs and its pending migrations, and refuses a store whose draft stays below the App's `minSchema` (`data_store_draft_below_min_schema`). `assets.publish` of an App takes `dataStores: [{ name, revision }]`: each store is published as its own publish does it and its migrations applied, and the App and its Workflows go live once every store reached its level. A failed migration (`data_store_migration_failed`) or a wait over 60 seconds (`data_store_migrating`, retryable) publishes neither the App nor its Workflows. The publisher needs `data_store.publish` on each store; a held publish carries the stores in `publishedWith` and only a holder of `data_store.publish` on each decides it. The Publish dialog, the agent's confirmation, the Inbox item and `catalyst app publish` name the stores, and the dialog says the store refusals in German and English.
- **CLI:** Workflows can be pulled, pushed and compared as CLI folders with `workflow.yaml` and `steps/`, using the App folder machinery. Unchanged Workflow pushes create no revision or commit; stale folders are refused. Workflow folder writes warn about possible secrets without refusing the write or printing the matched text.
- **Workflows:** Code steps name an `entry` anywhere in their revision's source tree (`.py`, `.js`, `.mjs`). Shared modules, SQL, tests and unused files travel with the run through later publishes and deletion. The worker reads the revision's immutable file set, never git, and copies it through a byte-budgeted LRU disk cache into a read-only sandbox with the tree root as its working directory and on the language module path. Operator settings `workflows.source.*` bound files, tree, history and cache and are reported in platform context.

- **Workflow compatibility:** For one release, `file` remains an alias relative to `steps/` with its original writable scratch cwd and relative input.json/output.json IO; it also gets the tree read-only on its module path. Referenced legacy scripts under `steps/` that fit the previous 256 KiB per-script / 2 MiB aggregate bounds are still written to `config.files` for rollback. Current runs read that field only for revisions without a file set. Tree scripts read JSON on stdin or `WORKFLOW_INPUT_FILE` and print JSON or write `WORKFLOW_OUTPUT_FILE`, outside the read-only source root.
- `assets.adopt_repository` (`POST /api/v1/assets/{kind}/adopt-repository`) and `catalyst workflow adopt --all | <name>` adopt the Workflows written before their writes were commits (WF-GIT-2). Every revision gets the folder its config makes as its file set, where it names none, and one commit through `asset_repo.commit`, oldest first, on the commit of the revision before it; the author is the revision's opaque actor id and the time its `created_at`, so a second run changes nothing and a run after a stop makes the same commits. A deletion keeps the commit before it. A revision a write adds meanwhile is committed next. The operation is kind-neutral, asks the release right (`assets.release`) on the instance and the key scope `config_assets:release`, and walks every workspace, so its answer holds counts and asset ids only (`adopted`, `revisions`, `commits`, `refused`, `adoptedAssetIds`, `refusedAssetIds`), never a name or content. One call works for about 30 seconds and answers `done` and `after`; the CLI calls until done and prints progress. Each adopted asset writes the audit event `asset.repository_adopted` with its id and its numbers of revisions and commits. A kind whose content is no repository on the instance is refused with `kind_without_repository`.
- Deploy: no migration. Run `catalyst workflow adopt --all` with the release key as a step after the deploy, once per instance whose Workflow writes are commits (deployment kit README, After the deploy); nothing runs it at startup. Rollback: the release before reads and runs adopted Workflows unchanged, and refuses a save of one, as of every Workflow this release committed (`repository_write_without_commit`).

### Changed

- **Apps:** A conversation shows one card per App, at its newest `app.save`, with the App's name, its live state ("Saved · only for you, not published yet", "Draft saved · not published yet" or "Published"), "Open" and "Publish". Earlier saves become a "Draft saved" line in the run's work, and earlier previews of a folder a "Preview updated" line; a folder saved as an App has the App's card stand for its previews. "Share" on the save line is gone: the card's button says "Publish". A publish from the card tells the conversation, so its agent carries on.
- **Apps:** A version is a publish. The draft's head says "Live: version 4 · since Oct 26", adds "Draft: changed since version 4" while the draft differs, and says "Draft · not published" before the first publish; no member text shows a revision number any more (the list says "Published", the agent's save line "Draft saved", the publish dialog "this state"). History lists one row per version, newest first, with who published it and when, and folds the draft saves made after it under it ("3 draft saves"); each save names the person, "Workshaper for {name}" when an agent saved it, or "Saved from the preview". "Publish this save" on a save publishes it as the next version. `assets.get` of an App answers `liveVersion` and `draftChangedSinceLive` for a reader of its draft in place of `publication`; `assets.publications.list` lists an asset's versions; a revision an agent writes carries the origin `agent_run`, or `byAgent` on its Page origin.
- **Core:** Consolidated equivalent record guards in core, model providers and server assets into one shared `isRecord` helper. The existing JSON-object guard reuses the same check; array-accepting transport-error handling stays unchanged.
- Remove the unused deprecated PostgreSQL connector exports `CreateDataSourceQueryToolsInput` and `createDataSourceQueryTools`; use `CreateDataSourceToolsInput` and `createDataSourceTools` instead. Remove `moduleOffTools` from config asset references; use `unavailableTools` instead.
- Share signal handling and cleanup across client-assembly workers, preserving Agent Run draining and existing shutdown logs.
- **Paging:** Share the JSON page cursor codec across HTTP lists, Data Store rows and flagged records, and Knowledge Base document and source item lists, preserving existing cursor bytes and validation errors. Filesystem object listings retain their raw-key cursor format.
- **Retry advice and waits:** Share the bounded Retry-After parser between Connections and model providers, rejecting oversized headers and non-HTTP dates consistently. Use Node's promise timers for plain sleeps across platform packages while preserving cancellation-aware waits.
- **Skills:** Folder validation in the server, CLI and browser now shares the same limits from the API contract: 2 MiB per file, 8 MiB per folder and 500 files. The limits are unchanged.
- **Apps:** The preview beside a conversation says what it is under its name: "Preview · not saved yet" for a folder no App holds, and "Preview of “{App}” · data stores and workflows run only in the app" for an App's folder. There the header's main action is "Open app", which opens the App's draft with the conversation in the dock, and "Update app" becomes the secondary "Save to draft". Its question says nothing is published, and its done state says "Saved to the draft", "Not published yet", with "Publish" for whoever may publish and "Open app" for everybody else; it no longer shows a check mark. When a call of the preview is refused because a preview reaches no Data Store, a notice under the header says so, with "Open app".
- When a run or a tool fails for a platform reason (`sandbox_unavailable`, `platform_error`, `no_worker`, a missing runner command or file store), the text the agent reads, the platform rules and Workshaper's instructions say it is a problem of the platform, not of the person's input, suggest trying again later and name no operator, administrator or help contact as the one to fix it. The conversation's notice for a command no worker took says the same in English and German, without "ask an administrator".
- A Workflow no longer hands an outside client data a Connection keeps from outside clients. An API key, a Service Principal's credential, the CLI or the platform MCP server starts a Workflow only when its trigger names `outside` ("By outside clients (CLI, MCP)" in its Settings, off for every Workflow), and only while every Connection operation the run calls, in its child Workflows too, is exposed to `outside`; it reads no Knowledge Base and calls no other operation than a Data Store's and `mail.send`. Publishing such a revision is refused with `outside_not_exposed`, naming the Connections; a start is refused with `no_outside_trigger` or `connection_exposure:outside`, asked again at every start, child start and continuation. A run an outside client started records the trigger `outside`; an outside client reads the result, step inputs and outputs, datasets and transcripts only of such runs and of its own test runs, also where a run key answers another run, and passes on as input only datasets of such runs. A person, an agent in the chat and an App start Workflows as before. Keys that start Workflows today need the Workflow's switch turned on and published.
- What a local agent or another outside client with a personal key can reach is written down and no longer guessed: the docs page "Connect a local agent" says a key reads no Data Store rows, calls no Connection operation not marked for outside clients and reads no conversations or other people's runs, and that a key with the Use level can start a published Workflow and read what its run returns. Workshaper and the platform orientation send such questions to that page instead of answering from the agent's own tools.
- **Operations:** Share canonical JSON for connection fingerprints and a Node-only core SHA-256 helper across stored call, file, CLI and form hashes. Preserve existing serialized bytes and hash formats, with golden tests for compatibility and comments on serializer variants that intentionally differ.
- Split the agent runtime regression tests by topic so they can run in separate test shards.
- Every write of a Workflow is a commit in its own repository, as an App's is (WF-GIT-1). A write of the config (the canvas, the agent's tools) renders `workflow.yaml` from the manifest, its keys in the order of the definition schema, and a write of the folder (`assets.put` with `files`) keeps `workflow.yaml` as sent and reads it into the config. Either stores the folder as a file set of the revision and commits it on the draft's commit through `asset_repo.commit`, authored by the caller's opaque id. A new Workflow starts its repository at its first write; a Workflow from before this release gets the file set and no commit until it is adopted (WF-GIT-2). The config `{ name, manifest, files }` does not change, so the release before this one runs every Workflow this one wrote. Of two saves from one revision the second is refused with `412 REVISION_CONFLICT` and adds no commit.
- `assets.put` and `assets.get` take a Workflow as its folder (`files`), as they take a skill. `assets.sync` refuses a Workflow where its writes are commits, as it refuses an App: "A workflow holds files: it is written with 'assets.put' and deleted with 'assets.delete', one at a time". A step file outside `steps/` is refused with `code_file_invalid` before anything is stored, as before.
- A `config` asset kind may name `content: "repository"` where it has `revisionFiles`; the registry refuses one without them. A job kind, operation, tool or kind two modules list counts as on while either module is.
- Deploy: a Workflow's writes are commits where `modules.workflows.enabled`, a `files` store, `executionWorkspaces.enabled` and a sandbox are all configured (or `apps` is on); the API and the workspace command worker ask the same. That worker of this release serves `asset_repo.commit` and `asset_repo.sweep` with `workflows` on, not only with `apps`, so it must run: without it a Workflow save is refused with "No workspace command worker takes commits to repositories on this instance" (`commit_unavailable`). Any other instance writes Workflows as config revisions, as before. Rollback: the release before reads and runs every Workflow as before, but refuses a save of one whose draft this release committed ("The content of workflow '<name>' is a repository: a write of it names the commit it adds", `repository_write_without_commit`), so those stay read-only, and one deleted after its first commit cannot be created again under its name, until the instance is on this release again.

### Fixed

- **Apps:** Refusals of the App, Data Store and Workflow publish paths now read in the interface's language, from one refusal table in `chat-ui`. A refusal that names a Data Store or a Workflow offers the way to it beside the sentence in the Publish dialog and the App's head, to a reader who can open that page, and a refused call of an App's frame carries the viewer's language with its code unchanged. A reason the table does not know keeps the server's sentence.
- **Workflows:** Config saves preserve comments, blank lines and existing key order in `workflow.yaml`, including edits from the canvas and agent tools. If the YAML edit cannot reproduce the sent manifest exactly, the save uses a full render and logs a fallback without content.
- **Audit:** Make two-factor audit event names visible to the event registry completeness check when platform and capabilities are checked together.
- **Apps:** App builds now refuse unsupported browser APIs with a runtime rule, source location and repair. The build, workspace.open guidance, platform-docs skill and sandbox docs share one rule list. Existing stored revisions remain usable and publishable.
- **Chat UI:** A file the interface fetches itself (a client without browser-managed downloads) and frames or opens as a `blob:` address now takes the type its viewer expects: `application/pdf` for the PDF frame, `text/plain` for text, and a PNG, JPEG, WebP or GIF type for an image (PNG where the fetched type is none of them). Before, an HTML file named `*.pdf` or served as an image kept `text/html` and ran on the interface origin. A cited Knowledge Base HTML or Markdown file opens as plain text, and a cited SVG or any file no viewer shows is saved instead of opened.
- The public `catalyst` CLI keeps its own SHA-256 helper instead of bundling core's, so the release guard accepts it again.
- **Deployment:** Deployment checks now observe every Compose project container after a 60–90 second settle period and after the upload check. Restarting or exited services, new restarts and healthchecks that are not healthy fail with the service name and 30 masked log lines. Successful one-shot services are recognized from Compose completion dependencies. The upload check waits for document-worker readiness, streams processing progress and allows 10 minutes each for readiness and processing, configurable with `UPLOAD_CHECK_TIMEOUT_SECONDS` in the host app env file.
- **Apps:** A person's confirmation of their agent's App publish now approves it only where their own click on Publish would: with every right the held publish asks of who decides it, such as `workflow.approve` on each Workflow and `data_store.publish` on each Data Store published with the App, and only where a guardrail asked. Before, the App's approve right alone made the Workflows live. Where the confirmation does not approve it, the agent's call is refused with `approval_unavailable` and files no approval request; before, it filed one whose approval executed nothing. Known gap: such a call should wait for an approver (events-workflows-and-guardrails.md, check 68); an agent's run cannot yet move on to an approval after its person's click.
- Workflow agents can read uploaded documents using the run-file ids in their task input. Reads resolve to the task's own attachments, stay scoped to its run and principal, and preserve file references passed to later steps.
- When a Workflow run's values are pruned, its run threads keep no name or content of the copies of its files that its agents got: the attachment, file and prepared-document rows go with the bytes, while the messages stay as empty rows and the audit keeps ids, sizes and sha256. Runs pruned before are cleaned on the next pass.
- When a Workflow run's values are pruned, its run threads keep no answer of a changing tool call, no input or sign-in context of a settled approval or confirmation, and no comment of who decided: the Operation Runs and requests stay for their audit age with ids, status, hashes, counts, who decided and when. A copy of a run's file that no attachment handler removed, as where none is configured, keeps its object key, size and sha256 but no name or prepared metadata. Runs pruned before are cleaned on the next pass.
- **Workflows:** Agent steps no longer repeat run-file attachment setup after a pause when every file type is unsupported.
- Another site can no longer frame the interface. The interface image's nginx sends `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` with the interface, and the API sends `X-Frame-Options` with its HTML documents; the view shell now also says `frame-ancestors`, with the instance and the interface origins (`allowedOrigins`), like Page content. Behind a proxy that serves the interface on another origin than the API, that origin must be in `allowedOrigins`, as it already must for the API.
- The API no longer serves a stored file inline when a browser would run it. A conversation file, an agent's artifact or an operation's download goes out inline only as a PNG, JPEG, WebP or GIF image, a PDF or plain text, whatever a capability's `isInlineDisplayMimeType`, the file name or the caller asked for; HTML, SVG, XML and every other type go out as an attachment, and the conversation file routes now send `X-Content-Type-Options: nosniff`. Before, an HTML file named `*.pdf` or promoted by the agent as an image ran on the API origin.
- **Knowledge Bases:** Document listings reject malformed or tampered cursors with HTTP 400 and reason `invalid_cursor` instead of an internal query error.
- A test run started with a personal API key that reaches a step needing a right no key can carry, such as `mail_sender.use` of a `mail.send` step, fails with `tester_key_cannot_carry` and says to start the test run signed in to the app. Before, it failed with `tester_missing_right` and told the person they lacked a right they hold. A right a key can carry and this key does not name fails with `tester_key_scope`. No key gains `mail_sender.use`.
- `workflows.start` and `workflows.test` with an API key that may not read the Workflow answer another person's run key with the `NOT_FOUND` a missing Workflow gets, instead of that run's id, status and starter. A run the same key started is answered as before, and so is a person signed in to the app; a run its person started otherwise is answered to the key only with `workflow.read`.
- The key `catalyst setup` asks for no longer starts with `connection.use` ticked: it is a separate choice, off by default (connections-and-secrets.md, Exposure to outside clients). The rest of the use level stays ticked.
- A test covers a key's held call that another person approves after the key was revoked: the call is denied and does not run.
- **Models:** Model checks and `catalyst models list --instance` accept a personal API key with the `system.view` scope when its owner holds that right. This scope reaches only the read-only infrastructure check; service keys remain refused. Issue a new personal key to add the scope to an existing CLI login. The CLI explains a missing right or key scope, announces rate-limit waits, and prints the model provider's id. The model setup docs explain the inherited `openai` provider in demo-based configs.
- **Privacy:** Request logs retain query parameter names while redacting every value except numeric `limit` values. Token-bearing app-content and password-reset paths use stable placeholders, including malformed addresses and route-not-found messages. The shared process logger applies this policy to the API, workers and outside-forms host.
- **Apps:** An App's Publish that carries Data Stores asks the App's own checks (its audience, its revision and the asset set) before it publishes any store, so their refusal leaves every store as it was (GOLIVE-1 follow-up). A Publish of the App also waits for a bound store that is live and still applying the migrations the App's `minSchema` needs, which an earlier Publish whose wait ran out (`data_store_migrating`) left behind: publishing again carries on instead of refusing with `data_store_below_min_schema`. It waits only for a store the publisher may publish (`data_store.publish`); a store whose job ended in a failure is refused at once with `data_store_migration_failed`. `apps.publish_review` lists such a store with `pending: false`; the dialog shows it as "Being updated" / "Wird umgestellt" and the dialog, the agent and `catalyst app publish` do not name it in `dataStores`.
- **Data Stores:** A provisioning or migrate attempt that fails and is tried again no longer writes its failure onto the store's record; only the last attempt's failure is written and audited. An App's Publish waiting on the store no longer refuses with `data_store_migration_failed` while the job still has attempts left.
- **Knowledge Bases:** What a publish processes again is said in the reader's language (German or English) and in plain words wherever the server states it: the publish question, the refusal of an unconfirmed publish and the CLI. It reads as the Studio publish dialog does, for example "3 documents are read again with the new settings. Reading them is free. Embedding the results costs an estimated 0.50 USD to 2.00 USD, possibly more." `KnowledgeBases.publish` now requires `actor`, so a publish always starts the re-index it confirms.
- A run an outside client started asks every Connection call of its steps, an agent step's included, whether the operation is still exposed to `outside`, also when an approved or waiting call runs: a Connection whose admin took `outside` back after the start is no longer called. Refused with `connection_exposure:outside`.
- The `outside_not_exposed` refusal of a publish names only the Connections the publisher may read or use and counts the others, so a child Workflow's Connections stay hidden from a publisher who may not see them.
- An outside client that reads a run no outside client started no longer sees the Connection the run failed at: the failure of the run and of its steps keeps its code and drops the Connection, its title, a Connection operation and the sentence that named it.

### Database

- `0158_config_asset_publications`: the table `config_asset_publications`, one row per publish of an asset with a draft, numbered from 1 per asset. It backfills version 1 for every asset published now, credited with the time and the person of its newest retained successful publish event of that revision, or else the asset's last change and nobody. The account deletion empties a person's name in it as it does in `config_asset_revisions`, and the backfill copies no audit actor whose account is gone. Expand only; a rollback leaves the table unread. The migration sets a lock timeout of 5 seconds and adds the foreign key after the backfill, so its scan of `audit_events` holds no lock on `config_assets`. A publish made by a worker of the previous release while it drains is not recorded: such an App's head says "Published" without a number until it is published again, which takes the next number.
- `0156_workflow_retention_version_2`: the two retention indexes of Workflow runs rebuilt concurrently for retention version 2, so runs pruned under version 1 are found for repair.
- `0157_workflow_retention_version_3`: the two retention indexes of Workflow runs rebuilt concurrently for retention version 3, so runs pruned under version 2 are found for repair.

## 0.8.0-rc.13 — 2026-10-26

### Added

- Files of a Workflow run: a capability keeps a file in the run it serves (`runFiles.create`), and step data names it by `{ $file, name, mimeType, bytes }`. Each is a Managed File owned by the run, its bytes below the run's prefix in the files store, capped at 25 MiB a file and 200 MiB a run, and recorded as a `workflow_run.file_kept` audit event with size, digest and type, never its name. Every step refuses a reference to a file that is not its run's, and a definition may not name one. An agent step gets a copy of each file its input names as an attachment of its task, prepared before its first turn; a file still being prepared after ten minutes fails the run with `files_unavailable`. The files and the copies go when the run's values are pruned.
- A tool may declare `auth: "principal"` to serve a run whose principal is a service principal, such as a published Workflow's agent step; a tool that declares none still serves a person only.
- The audit events `outside_form.requested` and `outside_form.mail_failed` are registered, with the recipient's domain and the form's field and page counts.
- `resolveInstanceModules` takes `shippedOnly`, for a process that serves part of the instance: a module switched on that its build does not ship is left out instead of refused.

### Database

- `0155_managed_file_owner_index`: an index on the owner of Managed Files, created concurrently, for the files of a run.

## 0.8.0-rc.12 — 2026-10-26

### Added

- Capabilities: a capability gets the instance's name, accent colour and logo (`brand`) for a page it shows outside the instance; the logo comes as its bytes, read from where the release config points, against the instance's address.

### Changed

- A document source may list an item without a size (CS-16). The sync keeps 0 for it, the fetch's bytes decide, and a first pass that waits for its confirmation assumes a size per format for such items, so the estimate is not zero. The contract test kit checks the fetched bytes against the listed size only where the source lists one.
- A catalogue entry whose tools and source parts reach the same host adds it to the egress list once.
- `createPostgresCapabilityRecords` takes the `capability` it opens the records for and answers `access.problems`: each way its database role reaches beyond those records (superuser, `BYPASSRLS`, owner of the table, membership of another role, privileges on another table, column, sequence or schema, a definer function, a record of another capability). It no longer reads the migration ledger with a role that may not read it.
- The deployment kit's policy check refuses an outside forms host in `docker-compose.prod.yml` that receives `DATABASE_URL`, `POSTGRES_USER` or `POSTGRES_PASSWORD`, sets a variable from `DATABASE_URL`, or has no `OUTSIDE_FORMS_DATABASE_URL`.
- Operator runbook: the outside forms host's database role (Operate > Deployment). An instance that already runs the host creates the role and changes its Compose file before it deploys this release.
- The name guard's test support tells customer names from accounting-vendor names. `deniedNames` and `scanProductSource` keep both out by default; a private repository may pass `vendors: false` / `vendorNames: false` so its packages can name the vendors they connect, while customer names stay banned everywhere.

### Fixed

- A personal API key no longer reaches a Connection's data through a surface other than an operation exposed to `outside`. `apps.try_action` refuses an API key or a service principal (`user_only`).
- A test run of a Workflow draft started with a key carries the key into its steps, with the key's scopes. Each step's call then needs what the key's own call would need:
  - A Connection operation, from an operation step or as an agent step's tool, needs exposure `outside` and `connection.use` on the key. It is refused with the same reasons as the key's direct call (`connection_exposure:outside`, `outside_key_scope`).
  - A Data Store or Knowledge Base step needs the operation scope of its call. A key never carries `data_store_rows:*`, so these steps are refused (`outside_key_scope`).
  - A revoked or expired key stops the run (`tester_key_unusable`).
  - A draft without such a step test-runs with a key as before.
- An agent step's worker in such a test run keeps acting for the key, so its tool calls are asked the same.
- A call made for a key that another person approves runs with that key's scopes, and does not run once the key is revoked or expired. A call its own person confirms in their Inbox still runs as that person's own click.
- For runs it did not start, an API credential (a key, or a service principal's) reads step outputs, code step logs, loop item labels, run labels, run keys and the result only with `workflow.read_run_data`. This applies to `workflows.list_step_runs`, `workflows.get_run`, `workflows.list_runs`, `workflows.cancel_run`, and to the run that `workflows.start` or `workflows.test` answers for a key another run already holds.
- Without that right, a key may not list runs by `keyPrefix`, finds by `key` only a run it started itself, and `workflows.download_dataset` needs the run to be the key's own. A run records the key it was started with. A person signed in to the app reads what they read before.
- `connections.source_folders`, `knowledge_bases.source_items` and `knowledge_bases.locate` refuse an API key (`connection_exposure:outside`): the names, paths and links of a source's folders and items belong to the outside system, and nothing exposes them to `outside`.
- **Release:** The outside-forms capability package publishes its `skills` folder, which its capability reads at runtime. In 0.8.0-rc.11 the package was published without it, so the capability failed when assembled.
- A workspace command whose sandbox could not start (`docker run` exiting 125 with the Docker client's own error, such as an image that cannot be pulled) is now a start failure of the sandbox, not the command's own exit. `workspace.exec` tells the agent with `details.reason` `sandbox_unavailable`, the command's id and time, and without the worker's cause, that the failure is the platform's and not the person's to fix. A lost worker or a runner error comes back the same way with `platform_error`, and no worker with `no_worker`.
- The platform rules tell every agent to put a platform failure on the platform's operator with its time and id, never on the person in the conversation or a named contact. `platform.context`'s `helpContact` is for questions about the instance's content and access, never for a platform or infrastructure failure.
- The platform orientation says that `platform.assets.operations` shows what the agent can call, not what an outside client (CLI, MCP, a personal key) can reach. Asked about an outside client, the agent opens its answer by saying that it depends on the Connection's "Outside clients" exposure and the key's scopes and that it has not checked them.
- An Agent Run worker (`agentRunWorker: "separate"`) starts with `modules.apps` on without `CHAT_SESSION_TOKEN_SECRET` or `BETTER_AUTH_SECRET`. Only the API signs and checks the content tokens of Pages and Apps, so only the API derives their key; a worker still gets the `files` store and the same startup checks for it.

### Database

- Migration `0154_capability_records_row_security` turns on row-level security for `capability_records` with two policies: a permissive one that keeps every role's access as its grants give it, and a restrictive one that holds every session that logged in as, or switched to, a role whose name starts with `catalyst_outside_forms` to the rows of the capability `outside-forms`. The platform's role owns the table, or is a superuser, and is not subject to either. The migration creates no role and needs no `CREATEROLE`. A backup made by a role that neither owns the table nor is a superuser needs `pg_dump --enable-row-security`, or it stops at this table.

## 0.8.0-rc.11 — 2026-10-26

### Added

- A capability can bring operations of its own, `completion: async` included, and end the runs of its own operations later; a Workflow `operation` step waits for them as for the platform's (ADR-0033).
- A capability keeps the working state of its own process in its own records, and gets the instance's mailer and work that runs in the API process alone.
- The module `outsideForms`, off by default, for a capability that serves forms to people outside the platform.
- An operation whose `timeoutMs` is above 24.8 days, the longest a Node timer keeps, is cut at that bound instead of at once.
- **Knowledge Bases:** A new knowledge base asks first where its knowledge comes from: uploaded files, a connected document source (marked "Connected"), or the tables of a data store. Source types with no connection yet are named under the choice, with New connection.
- **Knowledge Bases:** A synced source's folders are chosen by name in a folder browser instead of typed as IDs. The chosen folders are shown by their paths, and folder IDs and file patterns are under Advanced settings. A source type without folder browsing still takes typed IDs.
- **Connections:** `GET /api/v1/connections/:name/source-folders` (`connections.source_folders`) lists the folders inside one folder of a document source, for anyone with `connection.use` on the Connection. It answers folder names and IDs only and goes through the Connection's credential, egress check and source limits. A document source type offers it through the new optional `folders` call of the `document_source` capability, and a Connection's list entry says `browsesFolders` where it does.
- **CLI:** `catalyst models add azure|vertex|bedrock|openai-compatible` writes a model provider, a binding on it and its price into the release config of a deployment repository and names the one secret to set. It only adds lines, so comments and layout stay; it never asks for or writes a key, refuses a region other than `eu` with the reason, refuses a Bedrock profile of another account or region by the rule the instance applies at startup, and refuses a list that an environment file would take from the file it extends. `catalyst models check <id>` runs the instance's infrastructure check, which needs the right of the Infrastructure page (`system.view`), and prints the provider's state in the product's words, never a provider's text. `catalyst models list` shows the release config's providers, and with `--instance` what the instance reports. New docs page: "Use your own model provider".
- **Platform:** the rule for secret names, the rule for Bedrock application inference profiles and the merge of a release config file over the one it `extends` moved into `@work-shape/catalyst-asset-schemas`, so the instance and the CLI apply the same ones. No behaviour changed.
- **Models:** A chat binding may name a fallback in release config (`modelBindings[].fallback`): another chat binding of the same region that answers when the binding's model is overloaded or cannot be reached. A rate limit switches the run at once instead of waiting up to a minute; a server error, timeout or lost connection switches after the two short retries. A run switches only while the failed call has shown nothing, at most once, and stays on the fallback to its end; the next run starts on its own binding. It covers chat runs, subagents and Workflow agent steps, not system calls or embeddings. Usage is admitted and recorded on the binding that answered. Startup refuses a fallback that names its own binding, a missing or embedding binding, or one in another region.
- **Models:** Under an answer from a fallback, one line names both models, such as "Answered with GPT-6.1 Sol, GPT-5.6 Sol was overloaded", from the message's new `modelFallback` metadata. The log gets a `model_fallback` warning.
- **Agents:** "Use fallback model" (`useModelFallback`, on by default) turns the fallback off for one agent. It shows in the agent editor where one of the agent's models has a fallback, and is a model setting under `agent_models.manage`. A Shared Workspace whose model list leaves out the fallback gets no switch.
- **CLI:** `catalyst models add --fallback <binding>` writes the new binding's fallback, refusing a binding that is missing, an embedding binding or one outside `eu`.
- **Models:** When a provider refuses the reasoning stored from the last run (`invalid_encrypted_content`), only that reasoning is dropped: the request goes on from the conversation's compaction checkpoint instead of its whole history. A refused checkpoint is dropped after it. Reasoning a run stores after a fallback is kept for the model that answered.
- **Sign-in:** Two-factor sign-in for accounts with e-mail and password: a code from an authenticator app after the password, with ten single-use backup codes. "Trust this browser for 30 days" at the code step skips the code in that browser for 30 days from when the code was entered; a sign-in there does not extend it. Codes by e-mail or SMS are not offered.
- **Settings > You > Security:** A person turns two-factor sign-in on (password, QR code drawn in the browser, first code, backup codes once), turns it off with the password, makes new backup codes, and stops trusting every browser.
- **Instance > Users:** "Reset two-factor sign-in" on a user deletes their second factor and trusted browsers and ends their sessions, so their next sign-in with the password leads to the setup. `POST /api/v1/instance/users/:userId/two-factor/reset` (`users.two_factor.reset`) needs `users.manage` under the same target rule as a password reset and is refused on one's own account.
- **Release config:** `auth.standalone.twoFactor.required` (default `false`) requires two-factor sign-in of every account with a password, existing sessions included: until a person has set it up, every operation but `me.get` answers 403 `FORBIDDEN` with `details.reason: "two_factor_setup_required"`, and the interface shows only the setup screen. A personal API key of such an owner is refused the same way; service principals are not affected.
- **Audit:** `user.two_factor_enabled`, `user.two_factor_disabled`, `user.two_factor_reset`, `user.two_factor_backup_codes_regenerated`, `user.two_factor_backup_code_used` (with the number left) and `user.two_factor_locked`. None holds a secret, a key address or a code.
- **API:** `me.get` and `me.update` carry `twoFactor { required, enrolled }` for a person signed in with a password; `users.list` carries `twoFactorEnabled` for each user with a password sign-in.

### Changed

- **Models:** Every model call sends a prompt cache key: the conversation's id, the parent conversation's for a subagent, the Workflow Run's for a Workflow step. The steps and later turns of one conversation then reach the same cache on the provider. A key longer than 64 characters is sent as its hash.
- **Models:** A turn sends the earlier turns as the last run sent them, so the provider's prompt cache holds across turns: tool results and tool call inputs are compact JSON with their keys in order, however storage ordered them. The encrypted reasoning the last run ended with is sent again while the conversation stays on the same provider and model. After a model switch, or when the provider cannot decrypt it, the turn goes on from history alone. A continuation keeps only the reasoning of the tool calls its request holds.
- **Models:** A tool result is cut for the model above 12,000 estimated tokens instead of 60,000 (`modelContext.toolOutput.maxTokens`). The cut keeps its start and end and is the same every turn. Its note names the result, its size and the characters left out, and how to read them. A deployment that sets `maxTokens` keeps its value.
- **Agents:** Every agent with tools is offered `tool_result.read`, always as its last tool. It reads a cut result in parts, from the whole result its conversation stores, and each answer names the offset to go on with. A run reads only the results of its own conversation. Where a tool can narrow its own result (`workspace.read_file`, `workspace.exec`, a `.query`), the note names that way too.
- **Agents:** the tool definitions a platform agent sends with every model request are about a third smaller: about 12,100 instead of 18,300 tokens for the Workshaper's tools in the demo, measured with o200k. Descriptions say each rule once, in the tool that needs it; prose that repeated the platform orientation or the docs is gone, and the plain-HTML styling notes of `workspace.open` moved to the App sandbox docs page. The tools, their order and what they accept are unchanged.
- **Tools:** the JSON Schema a model is shown leaves out what tells it nothing: a `pattern` beside a `format`, a minimum length or item count of one, a maximum length of 1,000 or more, the safe-integer bounds and string-only `propertyNames`. The tool's own schema still checks every call. `deriveInputJsonSchema` is exported from `@work-shape/catalyst-tool-sdk`, so a tool can show the model a narrower schema than the one it validates with.
- **Tools:** `mail.send` shows the model only the recipient forms an agent writes. `platform.connections.propose` shows one object instead of a union at the root of its input, which Anthropic models, also on Bedrock, refuse.
- **Agents:** the platform orientation no longer repeats how a Connection is proposed or drafted, how operations are paged or what the asset list answers; the tools that do it say so.

### Database

- Migration `0152_capability_records` adds the table `capability_records`, which a capability's records live in (ADR-0033). It references no other table.
- Migration `0153_two_factor` adds the table `two_factor` (one row per account with a second factor: the encrypted secret and backup codes, the failed-attempt count and the lock time; unique on `user_id`, deleted with the user) and the column `user.two_factor_enabled` (not null, default `false`). Additive, without a backfill: every existing account starts without a second factor.
- **Models:** Migration `0151_model_provider_continuation_message_indexes` indexes the message each stored provider continuation came with, in `model_provider_continuations` and `model_provider_turn_continuations`. Deleting a conversation's messages removed their continuations by reading the whole table once per message. The indexes are built concurrently and move no data; the migration can run while the previous release serves.
- **Models:** Migration `0150_model_provider_turn_continuations` adds the table `model_provider_turn_continuations`. It holds one row per conversation and model provider: the encrypted provider state the conversation's last finished run ended with, the model it was made on, and the message it was stored with. The row is removed with the conversation, with that message, and when the provider refuses it. It is created empty and moves no data. Apply it before starting the new API and worker. The previous release does not read the table; remove it only through a later committed migration.

## 0.8.0-rc.10 — 2026-10-25

### Added

- **Repository:** A `Names` check refuses a customer or vendor name in what a change adds (lines, file paths, commit messages) and in a pull request's title and body. It reads the hashed name list from the base revision and reports only where a name is, never the name.
- **Knowledge Bases:** A Knowledge Base that searches by meaning can name its embedding model in `indexing.embedding.binding`, one of the bindings release config approves. Publishing another binding first states the passages, estimated tokens and cost and whether the store has room, and starts only with that statement's confirmation (`confirmProcessing`, CLI `--confirm`). The re-index embeds every passage into a new index beside the active one, which search keeps reading; nothing is extracted or chunked again. When every passage has its vector, search switches to the new index in one transaction and the old one is dropped. `knowledge_bases.reindex` (`POST /api/v1/knowledge-bases/:knowledgeBase/reindex`, right `knowledge_base.publish`) and `catalyst knowledge-base reindex <kb> [--confirm <token>]` state first and start with the confirmation. `knowledge_bases.get` names the model in use, the one it is set to and the progress of a re-index. While the index's model is gone from the instance, search answers by words and titles alone and the page says it needs a re-index. The Knowledge Base page shows the model, the re-index progress and a Re-index action with its statement.
- **Knowledge Bases:** A source's first pass stops at 10,000 items when it holds more, for a connector's first sync and a Workflow's first `ingest` alike. It takes in the first 10,000, lists the rest, and waits as "Waiting for confirmation" / "Wartet auf Bestätigung" in "Sources" / "Quellen" with the count, the size and an estimate as ranges: passages, tokens, the embedding cost priced from the rate card ("12,000 files, 318 GB, estimated embedding cost €250.00 to €380.00" / "12.000 Dateien, 318 GB, geschätzte Kosten der Einbettung 250,00 € bis 380,00 €"), and whether the store has room. Every reader of the page sees the state; only a holder of `knowledge_base.publish` gets "Continue import" / "Import fortsetzen". `knowledge_bases.sync` takes `confirm: true` and the CLI `catalyst knowledge-base sync <kb> --source <id> --confirm`; the confirmation is audited as `knowledge_base.first_pass_confirmed` with counts and the estimate, never a name. `knowledge_bases.sources` carries the estimate as `confirmation` while a source waits. The `ingest` calls of one Workflow run count together, so a run that splits its items over several calls stops at the same place. A Workflow's waiting `ingest` step keeps waiting; a confirmation after its run ended lets the pass go on, which then withdraws nothing. A pass whose ended run's dataset has expired ends `knowledge_ingest_cancelled`, confirmed or not, instead of waiting. A later pass, and a source of up to 10,000 items, never waits. No migration: the stop is kept on the sync run's progress.
- **Knowledge Bases:** A data Workflow puts documents into a Knowledge Base that keeps documents with `knowledge.<id>.ingest` (KBW-1). One call takes items inline or as a dataset of its run, is one Operation Run that ends once every item is indexed or failed, and answers `{ accepted, done, failed, failures, withdrawn }` with the failures as a dataset of the step: one invalid item fails alone, and a failure row carries the item's identity, never its text. Items carry `text` for now; `fileId` items and `fetch` items fail per item until Workflows read Managed Files and CONN-DL, a `fetch` naming a Connection the Workflow's account may not use with `knowledge_fetch_not_allowed`.
- **Knowledge Bases:** The source of kind `workflow` (`workflow:<workflow>@<revision>`, the revision that created the Workflow) is made by a Workflow's first call and listed by `knowledge_bases.sources`; its documents are searchable and keep their copy. `knowledge.<id>.withdraw({ itemIds })` takes items of the calling Workflow's source out of search at once.
- **Knowledge Bases:** `complete: true` withdraws the items of the source its Workflow run did not name, only once that run ended `done`; a run that ended otherwise, or one of whose passes failed, withdraws nothing, an item the pass named but could not take keeps its earlier version, a call whose run ended while it waited for its turn ends at once, and the pass's sync run ends with `knowledge_ingest_cancelled` where its run ended before it. A withdrawal above `withdrawShareConfirm` of the source (20 percent by default) waits for a confirmation in the publisher's Inbox.
- **Studio:** The Knowledge Base page lists a Workflow-fed source with its Workflow, its last run, "Stand: letzter Lauf vor …" and a note that the Workflow's runs decide what it holds, with no Sync now or Try again.
- **Knowledge Bases:** An `ingest` pass asks its Workflow account's grants afresh before every page and before a complete pass withdraws (KBW-2a). A pass whose account lost `knowledge_base.write` writes no further page and ends `failed` with `knowledge_source_refused`; what it wrote stays, and it withdraws nothing. A `fetch` item is checked against the account's `connection.use` on the page that reads it, so taking the right away mid-pass fails the remaining items of that Connection with `knowledge_fetch_not_allowed`.
- **Knowledge Bases:** A person who may change a Knowledge Base removes a Workflow-fed document by hand, with Remove on its page or `remove_documents` (KBW-2b). It leaves search at once, is purged as any removal is, and stays out: a later pass that names it reports `knowledge_item_removed` and leaves it out, and a complete pass does not count it as unnamed. Only someone who may publish the Knowledge Base lets it back in, with Allow again on the source or Retry on the source's items; the Workflow's own account cannot. `locate` shows when it was removed. The removal and the lifted hold are audited with the source and a count, never a name.
- **Knowledge Bases:** Deleting a Workflow ends its source in every Knowledge Base it fed (KBW-2c): the source leaves the Sources section, takes no further pass, and every item is withdrawn at once and purged as any removal is; a run of the deleted Workflow still going gets `knowledge_workflow_source_ended`. The question before the delete, new in Studio under the Workflow's "…" menu ("Delete" / "Löschen"), names each Knowledge Base the Workflow put documents in with how many it holds there, and counts those the reader may not open (`GET /api/v1/workflows/:workflow/knowledge-sources`, for who may delete the Workflow). The source key names the revision that created the Workflow, so a Workflow created later under the same name starts with an empty source of its own and none of the old items comes back. Each ended source is audited as `knowledge_base.workflow_source_ended` with its key and item count.
- **Knowledge Bases:** New right `knowledge_base.ingest` ("Put documents into knowledge bases from workflows" / "Dokumente aus Workflows in Wissensbasen einspielen") on one Knowledge Base or on all of them (KBW-3). It lets a Workflow put documents in and take back its own: `ingest`, `withdraw` and `put_processed` need it, and nothing else does. It is not `knowledge_base.write`, and neither gives the other. `admin` holds it by default, the Access page offers it like the Knowledge Base's other rights, and a personal key carries it at the use level.
- **Workflows:** Publishing a data Workflow with an `ingest`, `withdraw` or `put_processed` step gives its own account `knowledge_base.ingest` on that Knowledge Base, and needs the publisher to hold it there. A refusal names the right. The publish question's account line says so: "Runs as its own account “…” and may put documents into …" / "Läuft unter einem eigenen Konto „…“ und darf Dokumente in … einspielen". A revision without the step takes the grant away at its publish. A step that needs `knowledge_base.write`, such as `remove_documents` or `sync`, is still refused at publish with `action_not_grantable_to_principal`.
- **API access:** A service principal can be granted `knowledge_base.ingest` and `knowledge_base.read` on one named Knowledge Base. `knowledge_base.write`, `publish` and `delete` stay refused with `action_not_grantable_to_principal`.
- **Usage:** Spend limits at three levels. An admin sets money per UTC day and month for the instance, for every shared workspace or one of them, and for every user or one of them; a model call is admitted only while the user, the workspace and the instance are all under their limits. The release config's values stay the ceiling of the instance. A Personal Workspace has no workspace limit. Titles, guardrail checks and other calls the product adds count against the workspace and the instance and not against the person; calls with no person count against the workspace and the instance; Knowledge Base ingestion counts against no limit. An answer that crosses a user or workspace limit finishes, and the next message is refused. With a limit set, a model without a price is refused (ADR-0014).
- **Usage:** `usage.limits.get` and `usage.limits.set` read and change the limits for the screen, the API and the CLI (`catalyst limits show`, `catalyst limits set --from <file|->`). Both require the new right `limits.manage`, which administrators hold by default and workspace owners do not. Each change is recorded in the audit log as `governance.usage_limit_changed` with its old and new value. `me.usage.get` gives a person their own consumption against their limit, and whether a workspace's or the instance's limit stops them.
- **Usage:** Settings › Instance › Limits shows the ceiling, edits the limits and lists who is near one; it is shown to holders of `limits.manage`. You › Usage shows every person their own consumption today and this month. The composer is closed by a sentence naming the limit that stops the person and when it resets, and shows a dismissible note from 80 percent of the person's own limit on. A person sees their own amounts, a workspace's only as its owner or an admin, and the instance's never.
- **Usage:** Settings › Instance › Usage has the tabs Overview, Breakdown, Users and Recent calls. Overview adds a straight-line projection of the month, spend per day drawn by the library chart, and the people active and the conversations, Agent Runs, App actions and Workflow Runs of the month. Breakdown groups a period by workspace, agent, App, Workflow, model or origin, and a row opens into the next dimension, narrowed to it. Every Personal Workspace is one row, "Personal workspaces", for everyone. Recent calls name the workspace and never the person; a call in a Personal Workspace shows "Personal workspace". New operations `usage.breakdown.get` and `usage.users.list`.
- **Usage:** The right `usage.view_users` shows usage by named person: each person's own month, listed by name and never ranked. Superadmins always hold it; the built-in admin role holds it by default, and an instance that does not want that takes it off the role in the role editor. An admin role edited before this release gets it only as a pending change a superadmin decides. It is granted for the instance or for one shared workspace. Every opening of usage by person writes the audit event `governance.usage_users_viewed` with the actor, the month and, for a workspace, its id, and no figure or name.
- **Workspaces:** Settings › Workspace › Usage shows a shared workspace's Owners and Admins what it used and its Breakdown; with `usage.view_users` for the workspace, also what each member used there. New operations `workspaces.usage.get` and `workspaces.member_usage.list`.
- **Docs:** A page in German for works councils says what is recorded per person, who sees it and how long it is kept.
- **Connections:** An operator can declare managed OAuth clients under `infrastructure.oauthClients` in release config: a client id, the name of the host secret that holds its client secret, and an optional tenant. A catalogue part that names one with `managedClient` installs with no field, and each person just connects. The client secret is read from the host when a token is exchanged, refreshed or revoked, and is kept in no table, answer, log or audit record. Only the Connection installed from that part, under its name, may use the client; any other is refused with `managed_client_unavailable`, and the install dialog keeps an own app registration under **More**. A Connection on the managed client keeps its part's endpoints, base address and headers. Removing the client or changing its id sets the sign-ins made with it to `needs_reconnect` at the next start; a rotated, missing or refused secret keeps them. The demo's sample OAuth entry uses the managed client `sample`.
- **Connections:** An OAuth Connection can name `oauth.adminConsent`: the provider's admin-consent address, on the origin of its authorization address, and the error codes that mean an administrator of the person's organisation has to approve the app first. A sign-in refused with one of them lands as `oauth_admin_consent_required`, and the Connect card and the sign-in step say that the organisation's IT has to approve once, with the approval link to copy. The link carries the client id, the Connection's scopes, its redirect URI and `state=admin_consent`, never a secret; the start's answer and the Connection's detail carry it as `adminConsentUrl`, and the Connection's page shows it to who may change the Connection. The administrator comes back to the same callback, which lands on `admin_consented` without a sign-in on the instance and changes nothing; the person then connects again. The demo's sample OAuth entry names the sample server's admin consent, which `SAMPLE_OAUTH_REST_ADMIN_CONSENT=required` switches on.
- **Connections:** A Connection on a managed OAuth client that was installed from an earlier version of its catalogue entry is refused every change with `catalogue_update_required`, since it keeps the settings of the entry's current version only. Its page offers the update to the current version: it writes that version's settings and link and keeps the tools as they are. People stay signed in where the new version keeps the endpoints and base address, and connect again where it moves one. Every write is still held to the entry's settings exactly.
- **Connections:** The page of a Connection where each person signs in with their own account says that each person connects, in chat or under Settings, instead of "Not configured" and a key to enter, also right after it is installed or saved. On the operator's managed OAuth client it says the instance brings the app registration. The list says the same.
- **Data Stores:** "Review" (German "Prüfen") on the page of a store with records rules lists the fields the documents do not settle on their own: where evidence disagrees, where no candidate's quote stands on its page, and where the rule asks a person to confirm. Each object shows its flagged fields, and each field its candidates side by side, each with a chip that opens the cited page. A person confirms a candidate, corrects it to the value the page holds, or assigns a document whose path names no object to one. A confirmed or corrected value stays through later syncs. Candidates are shown only from Knowledge Bases the reader may use, and only of documents that are still there to open.
- **Data Stores:** `data_store.<store>.records.flagged` and `.records.decide`, with `GET /api/v1/data-stores/:store/records/flagged` and `POST /api/v1/data-stores/:store/records/decide`. Both need `data_store.records` on the store; a decision also needs `knowledge_base.use` on the Knowledge Base of every candidate it settles, and is taken only from a person, on the page or with their own key on the CLI: a Workflow step, a schedule or a service principal is refused with `record_decision_person_required`. The audit event `data_store.record_decided` names the table, field and action, never the value or key.
- **Data Stores:** A sync that leaves fields waiting files one Inbox notice per store for whoever may decide them, with the number of fields that wait when it is read. A store with a pending notice gets no second one.
- **CLI:** `catalyst data-store review list <store>` and `catalyst data-store review decide <store> --table --key --field --action confirm|correct|assign` do what the page does.
- **Workflows:** A Workflow's card and its page name the Apps that start it ("Started by the app “Orders”"), each a link to the App. The card names two and counts the rest; the page names every one. The list is derived from the App drafts and published revisions the reader may open, in one pass per list request; Apps the reader may not open are left out. Nothing is stored. `assets.list` and `assets.get` of a Workflow carry the new optional `appCallers`.

### Changed

- **Repository:** Add the PolyForm Strict License 1.0.0. Run PR and nightly checks on GitHub-hosted runners, with static checks and eight unit and database shards for PRs. Keep nightly suites timed as a whole and reject self-hosted runners in workflows.
- **Release:** Raise the packed size limits of client-assembly, core, chat-ui and docs by about a fifth to fit what they ship now.
- **CI:** Run pull request lint, type checks and tooling checks in parallel to shorten the required check.
- The default theme's neutrals lose their brown cast: a clean off-white in light mode and a cool near-black in dark mode, so surfaces, borders and muted text read clearer. Light: surface `#fafaf8`, background `#f3f3f0`, text `#1c1c1b`, muted text `#5e5d5a`, border `#e1e0dc`. Dark: surface `#18181a`, background `#131315`, text `#ececeb`, muted text `#a9aaac`, border `#2d2d30`. The accent is unchanged. An instance that sets its own theme colours is not affected.
- The person's own message sits on a neutral fill instead of the accent tint.
- The info tone is now a soft blue (`#32669a` light, `#6fa8dc` dark) and serves as the quiet second accent beside the orange: it marks work that runs. The dock's running dot and the running count on Settings > Jobs use it; badges and banners in the info tone follow. `CountBadge` has a new `info` tone.
- The activity row of a running answer (spinner, time and what the agent does) is in the accent colour instead of muted grey, like the running mark of a conversation in the sidebar.
- **Knowledge Bases:** An `ingest` pass now asks its Workflow account for `knowledge_base.ingest`, not `knowledge_base.write`, before every page and before a complete pass withdraws. A Workflow account that holds `knowledge_base.write` from a grant written by hand, and no `knowledge_base.ingest`, is refused from the next page on; grant it `knowledge_base.ingest` on the Knowledge Base, or publish the Workflow again.
- **Connections:** `modules.connections.personalModelRegions` in release config lists the regions a model route may declare for a run to call a personal Connection. Unset, it is `[eu]` and nothing changes. A route without a region is still refused, and an empty list or an entry that is not a region stops startup with the field named. The `personal_connection_region` refusal now names the allowed regions and never a route. The operator widens the list only on the customer's written instruction, filed in the deployment repository; there is no switch in the interface and no new right. Instance › Infrastructure shows the list read-only, and a model region it has no name for, such as `us`, is shown as stated instead of as Global.
- **Data Stores:** A correction in "Review" (German "Prüfen") no longer writes over what the document reads. The candidate keeps the value read, with its page, quote and evidence, and the person's value stands beside it. "Review" shows a corrected candidate as "Read" and "Corrected" (German "Gelesen" and "Korrigiert"), with who corrected it and when. Replacing a correction with another decision drops the person's value, and the candidate counts again as what its document reads, with its evidence as checked; it is no longer marked as not holding until the document is read again. The customer's table still holds only the winning value, and the audit event `data_store.record_decided` still holds no value.
- **Data Stores:** `records.flagged` and `GET /api/v1/data-stores/:store/records/flagged` give each candidate `correctedValue`, the person's value, set while its state is `corrected` and `null` otherwise; `value` is what the document reads. Each candidate a person decided also gives `decidedByName`, that person's name as the instance shows it now, left out where the account is gone or its deletion was requested; "Review" shows that name, or only the date, never the account id. `catalyst data-store review list` prints both values.
- **Access:** `connection.write`, `connection.delete` and `connection.approve` can be granted on one Connection or on the whole instance, as `connection.read` and `connection.use` already could. Instance > Access offers them. A grant on one Connection covers that Connection only; creating a Connection still needs write on the whole instance. The no-escalation check applies as for every other grant. Changing the host a Connection calls still clears its stored key, so a writer of one Connection cannot send the key elsewhere.
- **Connections:** Every check of these rights asks the Connection it is about. The connector types are readable by anyone who may write any Connection; the chat's Connection proposal asks write on the Connection it names when that Connection exists; Studio's Connection page offers its switches, exposure boxes and tool approval to a writer of that Connection; and Studio offers "New connection" to whoever holds `connection.write` on the instance rather than the general Studio permission.
- **Approvals:** `connection.approve` decides a held call on its Connection, one of its operations or a change or deletion of its definition, beside `operations.approve`. The Inbox lists those requests to its holders. The call still runs as the person who made it, so the approver gains no right on the Connection. Deleting a Connection ends the calls still waiting for an approval on it, so a Connection made again under its name decides none of them.
- **Chat:** A person who may change only the Connection an agent's proposal names can open that Connection's page from the proposal's card.
- **Access:** Deleting a user and retrying a background job are rights: "Delete users" (`users.delete`) and "Retry jobs" (`jobs.retry`). Superadmins hold both by default and can give them to a person or a role at instance scope. Admins do not hold them. Deleting still needs "Manage users" and every right the account holds; only a superadmin deletes a superadmin, and nobody deletes their own account. A refusal names the missing right. The Users and Jobs pages offer delete and retry by the right, not by the role.
- **Settings:** Jobs, Operations, Modules and Infrastructure move into one folded group "System" at the end of Instance, shown by the new right "View the System pages" (`system.view`). Superadmins hold it by default and can give it at instance scope; admins do not hold it. The reads behind these pages need it too: `instance.jobs.summary`, `instance.jobs.list`, `operations.list_runs`, `instance.modules.list`, `instance.infrastructure.get` and `instance.infrastructure.check`, which before took `audit.view` or `users.manage`. One Operation Run stays readable by its caller and by `audit.view`, and the audit log stays with `audit.view`. The technical detail under a refusal and what a database server leaves open around a Data Store are shown by `system.view` instead of a role.
- **UI library:** A `SubRail` group can fold (`collapsible`): it starts folded and opens while one of its items is open.
- **Repository:** A test checks every superadmin role check in the packages against the named list in the access spec, and every gate of its sweep against its right.
- **Access:** "Manage service principals" (`service_principals.manage`) can be given to a person on the whole instance on the Access page, by whoever holds it. Before, a person got it only through a role. Admins and superadmins still hold it by default.
- **Mail:** Who may mail the members of any Shared Workspace (`mail.send` with a `{ workspace }` recipient) is decided by "Manage users" (`users.manage`) on the whole instance instead of the admin or superadmin role. A custom role or a key that carries it counts, and a deny takes it away. Everybody else still mails only the Shared Workspaces they are a member of, and nobody mails a Personal Workspace.
- **Data Stores:** `data_stores.get` answers what the database server leaves open around a store (`conditions`) only to a reader with `system.view`. Everybody else gets an empty list, as the page already showed them.
- **Access:** The "New right" dialog offers the instance's own kinds (Users, Jobs, System, Usage, Service principals) to whoever holds their rights. Before, it listed only kinds with assets, plus Workspaces and Roles, so rights held on the whole instance could not be given there.

### Fixed

- **Configuration:** Config and settings defaults now parse nested objects and arrays independently for each config. A shared schema-walking regression test covers omitted and empty branches.
- **Accounts:** Deleting an account now empties every stored copy of the person's name, e-mail address and identity-provider id outside the audit log, in the same transaction that deletes the account: on approval requests and their decisions and reversions, on held calls (including how the caller was signed in and the audience person an App publish names), on approval decision notes in Conversations (the metadata and the note the model reads), on operation runs and their decisions, on agent runs and queued follow-up messages (how the person was signed in), on Workflow Runs, on asset revisions, on handled feedback, on guardrail and live-once switches, and on the Conversations the person created. The account id beside each copy stays. The person's own connection sign-ins are deleted. A repeated or interrupted deletion ends in the same state. The audit log keeps the name until `retention.auditDays`.
- **Accounts:** Wherever a person is named by their account, the name is read as the account has it now. An account that is gone, or whose deletion was requested, is shown as "Deleted account" (German "Gelöschtes Konto"), never as a blank or the account's id: in the Inbox, in approval decisions in chat, on Workflow Runs, in an asset's history, in Review on a Data Store, on the operations page, on a switched shipped guardrail and as who published an App. Text a model reads says "a deleted account".
- **Repository:** A schema test fails when a new column copies a person's label, actor or sign-in and is neither erased on deletion nor listed as kept, with a reason.
- **Connections:** Once a personal Connection has been used in a chat, every later model request in that conversation goes only to a route in `modules.connections.personalModelRegions`. This covers later turns, subagents, siblings whose personal call lands mid-run, and guardrail judges. Before, only the run that made the call was checked. A subagent's routes now include its parent's, so an `eu` subagent under a parent on another region is refused the personal call with `personal_connection_region`. A run start or queued message that names a blocked model, or falls back to one, is refused with `personal_data_model_region` before the run is created. A request refused mid-run ends the run with that code. A blocked judge answers "could not be evaluated", so a blocking guardrail stops the call. A document extraction that names the conversation is refused the same way, in the API and in the document worker, and a Knowledge Base search in it embeds no query on such a route: it answers from words and titles. Configured models carry `personalDataBlocked` when their route is outside the list. In such a conversation the model picker shows them disabled with "Not allowed in a conversation with data from personal connections" / "Nicht für Unterhaltungen mit Daten aus persönlichen Verbindungen freigegeben" and preselects the first allowed model. When none is allowed, the composer points to "New conversation" / "Neue Unterhaltung". Workflow runs, conversations without personal data and instances whose routes are all in the list are unchanged. There is no new setting, right, migration or audit event.
- **Give to an agent** works on an agent with an unpublished draft. The new operation `agents.give_tools` (`POST /api/v1/agents/{name}/give-tools`, `catalyst agent give-tools`) makes the published agent plus the tools one new live revision, with the rights of a change and a publish (`agent.write` and `agent.publish`), their guardrails, approval policy and audit. A pending draft, also one a release push wrote, keeps its content and author, gets the same tools and moves onto the new live revision, so it stays publishable. The give no longer refuses another person's draft and never publishes a draft. A live change since the give read the agent answers `REVISION_CONFLICT`.
- The agent page names who saved a draft as the subject of the sentence; a draft a release push wrote names "the team that runs this instance" ("das Team, das diese Instanz betreibt").
- **Chat:** The agent goes on by itself after the person approves the tools it drafted on a Connection's page, or gives a Connection's tools to an agent from its card. The tab of the conversation the card stands in sends one message as the person (CHAT-CONN-1), naming the Connection and the tools, and for a give the agent that now has them. A refusal, a conflict, a draft left unpublished or a wait for an approval sends nothing, and so does the same action opened outside that conversation.
- The test of a scheduled start's late tick sets the worker's clock instead of reading the real one, so it no longer fails when the suite runs inside a repeated hour after the clock is set back. Scheduling did not change: a schedule runs once for every time of day it names, on both days a year the clock changes. A time the clock shows twice is due the first time only, and times the clock skips are due once, together, at the first minute after the gap. New tests cover both changes in Berlin, New York and on Lord Howe Island (half-hour change), forward and backward, and a late tick in each.
- **Data Stores:** The page of a Data Store never published says in words what it will store: each table's fields with the kind of value, whether a field must be filled, the key and the values a check allows. The migrations' SQL stands folded below, for advanced users. While the agent in the dock is still working on the store, its page says so and holds Publish back until the agent is done.
- Cancelling a document fetch while database admission is pending no longer produces an unhandled rejection or dispatches the adapter after cancellation. Acquired admission is still released.
- **Configuration:** Separate release configs now receive independent web-access defaults, so changing one config's search or fetch settings cannot affect another.
- Give client image dependency builds a 6 GiB Node heap and build one package at a time to avoid running out of memory when generating client-assembly type declarations.
- **Knowledge Bases:** Publishing in Studio now confirms what the publish processes or embeds again. The publish dialog shows the count and cost and passes the confirmation it read, so a draft that changes the embedding binding or the document types, written by the CLI, YAML or an agent, can be published from the page. Before, that publish was refused with a line meant for the API. If the numbers change before the publish, it is refused with "What this publish processes or embeds again changed in the meantime. Publish again to see the new numbers." / "Was diese Veröffentlichung neu verarbeitet oder einbettet, hat sich inzwischen geändert. Veröffentliche erneut, um die neuen Zahlen zu sehen." `assets.get` returns the confirmation as `publishConfirmation`, and its `publishQuestion` no longer includes the line on how to pass it.
- **Knowledge Bases:** A first import that waits for confirmation on a Knowledge Base that does not search by meaning now shows only the count and size. It no longer shows token and passage ranges or a room warning, and its audit event has no token range. In `knowledge_bases.sources`, `confirmation.tokens`, `passages`, `room` and `addedBytes` are now optional and are left out where nothing is embedded.
- **Knowledge Bases:** When there is not enough room for a first index, the "Embed passages" dialog now says "The store has no room for the embedded passages" / "Der Speicher hat keinen Platz für die eingebetteten Passagen" instead of naming both indexes.
- **Operations:** The answer of an operation whose run continues after the call now shows the run as it is stored. A confirmation of a Workflow source's import ends its run at once, and its answer now shows that run as `done`. Before, the answer said `running`, and `catalyst knowledge-base sync --confirm` printed a running run. It now prints the finished run and exits 0.
- **Knowledge Bases:** Setting `indexing.embedding.binding` back while a re-index to another model is still building now drops the half-built index. New documents are no longer embedded into it, so nothing more is paid for it. A job of `knowledge_base.reindex` drops it after the publish; a waiting re-index of that model ends without an embedding call.
- **Knowledge Bases:** Turning `semantic` off now drops the Knowledge Base's embeddings, as the spec says. Turning it on again embeds every passage after the confirmed statement, as for a first index.
- **Studio:** A Knowledge Base that searches by meaning, has searchable documents and no index yet, as one published before semantic search embedded existing passages, says so on its page and offers "Embed passages…" ("Passagen einbetten…") to whoever may publish it. The dialog states passages, tokens, cost and room before anything starts.
- **Knowledge Bases:** The publish dialog in Studio now words what a publish processes again in the reader's language. Before, it showed the API's English sentence ("Reprocess N affected contents …") to German readers too. It now reads, for example, "3 Dokumente werden mit den neuen Einstellungen noch einmal gelesen." with the estimated cost in plain words. `assets.get` returns the same count and cost as `publishProcessing` (`count`, `line` and `cost`, which is `none`, an `estimate` with `min`, `max` and `currency`, or `unavailable`), where `line` is the index of the English sentence in `publishQuestion`. The sentence stays in `publishQuestion`, in the publish refusal and in the CLI.
- **Agent tools:** A call of an operation whose work continues after the call now answers `done`, with its run id, when the operation has already ended its run, and answers its failure when the run failed. Before, an agent that confirmed a Workflow source's first import was told `running` for a run that was done. The API already answered this way.
- **Knowledge Bases:** Turning `semantic` on for a Knowledge Base that already holds passages now embeds them. The publish states the passages, estimated tokens, cost and room first and starts only with that statement's confirmation (`confirmProcessing`, CLI `--confirm`), as a change of the embedding model does. Search answers by words and titles until every passage has its vector. Where an index of the same model is left from before `semantic` was turned off, only the passages it lacks are embedded. Turning it on over no passage asks nothing. `knowledge_bases.reindex` (`catalyst knowledge-base reindex`) also embeds a Knowledge Base that searches by meaning but has passages and no index yet.
- **Studio:** A new Knowledge Base of documents searches by meaning and by words where the instance names a default embedding binding (`knowledge.defaultEmbeddingBinding`), and by words alone where it names none. Its page says which. The instance config the interface reads carries `knowledge.semanticSearch`.
- **Operations:** `operations.get_run` answers the run of a held call to the person it waits on, as long as it waits: whoever decides its pending request (its addressee, or who holds its deciding right, such as `connection.approve` on its Connection) reads that one run without `audit.view`. Once the request is decided, or for any other run, it is governance evidence again: its caller and holders of `audit.view` read it, and the list still takes `system.view`. A deny on the deciding right takes the read away, and a personal key still follows only its owner's calls.
- **Chat:** A run the model provider stopped for too many requests now says so in the person's language instead of the provider's English sentence, and says what happens next: the run does not go on by itself, the steps already done are kept, and writing "continue" in about a minute picks up where it left off.
- **Data Stores:** The number on a store's Inbox notice of fields to review is now counted for the person who reads it: only fields with a candidate from a Knowledge Base they may use, and from a document still there to open, as "Review" (German "Prüfen") lists them to that person. It used to count every waiting field of the store, including those from Knowledge Bases the reader may not use.
- **API access:** After a service principal is created, the page shows that principal and brings it into view where it stands under the list. Before, it showed the first principal of the list until the list was read again, so a principal created with "View configuration" looked as if it had no configuration rights. The rights were always stored as chosen.
- **API access:** A refused save of a service principal or a key is said in its dialog, which stays open with what was entered. Before, the message stood on the page behind the dialog.
- **API access:** The list and the chosen principal stand side by side only where the page has room for both. Before, beside the navigation and the settings rail on a 1280-pixel window, the chosen principal ran past the page's edge and the list's status badges were cut off.
- **Workflows:** The Workflows page lists every Workflow at first. Data flows no longer wait behind a filter, so a list that holds only data flows (as the Workflows an agent builds for an App often are) no longer reads as empty. Where both kinds are listed, a choice of All, Processes and Data flows stands above the list, and a data flow's card says so.

### Database

- **Knowledge Bases:** Owned-store migration 13 `workflow_ingest` (the platform role applies it to every Knowledge Base store at the next start, no platform migration): sync runs take the mode `ingest` with their Workflow run, dataset, `complete`, `accepted` and the state of a complete pass, and source items the last pass that named them (`named_run_id`). The unique index of a running sync per source stays as it is: one pass of a Workflow's source runs at a time, and a further call waits in the new table `ingest_waiting` until it is its turn. New tables `ingest_failures` and `ingest_items` hold a pass's failure rows and inline items only until it ends. Existing rows keep their values; the migration adds nullable or defaulted columns only. A rollback leaves the columns and tables unused: a pass in flight then ends failed and withdraws nothing, and Workflow-fed documents stay out of search until this release is back.
- **Knowledge Bases:** Owned-store migration 14 `item_removal_hold` (applied to every Knowledge Base store at the next start, no platform migration): source items get a nullable `removed_at`, set only on an item a person removed by hand, with a check that such an item is withdrawn and a partial index for counting them. Every existing row keeps `removed_at` null, so the check holds on them as they are. A rollback keeps the hold: a pass of an older release that names a removed item fails on the check rather than bring it back, so remove the hold (`update catalyst_kb.source_items set removed_at=null`) only where a person decided to.
- **Knowledge Bases:** Owned-store migration 15 `workflow_source_end` (applied at the next start, no platform migration): a Workflow's source row gets `workflow_revision`, the revision that created its Workflow, and `ended_at`, and its key may carry that revision (`workflow:<workflow>@<revision>`); one source per Workflow and revision. Sources from KBW-1 keep their key `workflow:<workflow>` and a null revision, which the check still allows: the next `ingest` of a Workflow adopts such a source where all its passes came after the Workflow was created, and otherwise ends it and withdraws its items, as a deleted namesake's. A store not yet at 15 holds back the end of a deleted Workflow's sources, which is retried until it is. A rollback leaves ended sources ended and withdrawn; an older release feeds a source under the old key beside a revision-keyed one, so a Workflow's items start over there.
- **Usage:** Migration `0147_usage_spend_limits` adds `usage_spend_limits`: the spend limits an admin sets per UTC day and month for the instance, as a default for every shared workspace and every user, and for one workspace or one user. A value of a workspace or a user is removed with it. Admission keeps counters of shared workspaces in the existing `model_usage_counters` under the scope `workspace`.
- **Usage:** Migration `0148_usage_rollup_dimensions` adds `workspace_key`, `app_name` and `workflow_name` to `model_usage_daily_rollups` and widens its primary key, under the same name, to them. Migration `0149_usage_period_indexes` builds, concurrently, the indexes the Usage page reads by period: usage events by workspace and time (replacing `model_usage_events_workspace_idx`), Agent Runs, conversations and Workflow Runs by instance and time.
- **Deploy step:** The reconciliation with scope `all` re-keys the daily sums from the usage events, so the Breakdown by workspace, App and Workflow covers the time before the upgrade. It runs by itself: the first scheduled usage reconciliation after the upgrade finds a record without the new keys and reads every event. Until then, and while a process of the previous release still runs, sums of the rollout day may stand under empty keys and show as "Not attributed"; the scheduled runs after it move them. A rollback keeps the wider key; the previous release's processes write under empty keys, and the first reconciliation after the next upgrade moves them. A reconciliation the previous release runs on the wider key, during a rollback or in the rollout window, counts a day whose sums stand under several keys twice: the Usage page shows too much for the current and the previous month until the first reconciliation of this release corrects it. Spend limits are held against the counters and are not affected.
- **Data Stores:** `catalyst.record_fields` in every store gets `corrected_value jsonb`, with a check that it is set exactly while the state is `corrected`: owned-store migration 16 `record_corrected_value` for a Knowledge Base's store, and the same step in every other store's schema setup at its next job. No platform migration. A field corrected before the upgrade had the person's value written over the value read, which is lost: that value is copied to `corrected_value`, so the customer's table keeps it, and the candidate's evidence is marked `value_not_parsed`, so it never counts as read once the decision is replaced. A store that has not taken the step refuses `records.propose`, `.decide` and `.flagged` with `record_store_upgrade_required` until it has. A rollback leaves the column and check in place: an older release's correction or replaced decision then fails on the check, and an object it projects again writes the value read, not the person's, into a corrected field until this release or a later one projects that object again. Decide fields only on this release or later.

## 0.8.0-rc.9 — 2026-10-24

### Added

- **Connections:** Connection catalogue parts can declare OAuth endpoints, personal and shared modes, and scope groups derived from approved operations. Declared query parameters can use a separate wire name such as `$top`.
- **Assemblies:** Assemblies can register HTTP result shapers. The demo includes a vendor-free OAuth catalogue entry and a sample shaper.
- **Connections:** New connection installs an OAuth catalogue part in one dialog. Admins choose whose account it reads with where the entry allows both. The checklist names the instance's exact redirect URI for the part's fixed name, and the dialog takes the client ID and a write-only client secret. Verbinden saves the Connection without a test. The review groups the operations by the access they ask for and says when a further group needs more access at the next sign-in. Freigeben enables the ticked operations and writes their scopes. A shared part then signs in with exactly that access. For a personal part, admins may connect their own account at once; everyone else connects under Settings > You > Connections. The tools can then be given to an agent.
- **Connections:** An OAuth catalogue part can be installed again after its Connection was deleted. The dialog says a deleted connection had the address and installs it anew. The write lifts the denies the delete kept, so the new Connection starts with the access of a first install, and records `connection.access_reset` with the number of rows lifted; a revert still restores them.
- **Chat:** Chat Connection proposals can select an offered catalogue entry or draft a complete custom OAuth Connection with personal credentials and GET read operations. Proposal results include viewer rights and personal binding state.
- **Agents:** Platform context exposes offered services and setup readiness without prompts or checklists.
- **Chat:** A Connect card in chat. When an agent proposes a catalogue entry or an OAuth Connection, or a call of a personal Connection is refused because the person has not signed in or must sign in again, the conversation's owner sees "<Service> verbinden" with one button. Connect signs in through a popup (or a new tab where popups are blocked) and then sends "<Service> ist verbunden" as the person, so the agent carries on.
- **Chat:** A Connection that is not set up offers Einrichten to people who may write Connections, and anyone who may not set it up or use it is asked to contact their administration.
- **Agents:** The agent reads such a refusal as `connection_not_connected` or `connection_needs_reconnect` with one sentence telling it to wait for the person. Refused tool results carry a host-only `connect` field with the Connection's name, title, service, catalogue link and the refused agent, never an account or a token; the person's word goes to that agent.
- **Connections:** personal OAuth sign-ins for `http_api` and `mcp` Connections. Each person connects with `connection.use` in their own browser session; calls and refresh leases use only that person's binding. Personal Connections accept only agent exposure and keep their credential mode fixed (`credential_mode_fixed`). The CLI refuses personal sign-in with `personal_connect_in_browser`.
- **Connections:** the API lists the caller's personal Connections and lets Connection administrators list and revoke personal bindings. The owner's Disconnect revokes at the provider; an admin's revoke, a deactivation, an origin change or a Connection delete removes the token set locally without decrypting it. The caller's list asks the key scope `me:read`; sign-in start, its check and Disconnect keep their `config_assets` scopes. Structured `connection_not_connected` and `connection_needs_reconnect` refusals feed the Connect card in chat.
- Personal Connection calls now require an owner-authorized agent run in a conversation only that owner can read. Workflow steps, App actions, delegated sessions, API keys and outside clients are refused before a credential is resolved. Subagents inherit their root chat's privacy; authorized scheduled starts use their owner's binding while signed out.
- A conversation's first personal call permanently marks it, including failed calls. Marked conversations cannot widen their readers through a move, visibility change or feedback transcript copy. Agent-origin changes outside the owner's personal Connections require at least confirmation.
- Personal Operation Runs retain outcome, input hash, timing and result byte count, with no input reference or output. Completed results cannot be replayed from the run; recovery after a worker completed a confirmed call returns completion metadata only. Personal calls that would freeze input in an approval or Inbox item are refused; conversation confirmations retain no input reference on the Operation Run.
- Switch off native web search and web fetch after a personal Connection call, including failed calls. Later runs and subagents inherit the conversation's personal-data mark, and late web fetch calls are refused before fetching, including calls resumed after confirmation. Custom runtime hosts enabling web access must supply personal-data readers.
- **Workflows:** The canvas shows a Send email step (`mail.send`): "Sends an e-mail" with the sender's icon (the assembly's `system-mail` mark, else the generic mail icon) and name, a line with the first recipient, how many more and the subject, and "Sent to 3 at 07:42", a test send or "Simulated" once it ran. The transport is never named.
- **Workflows:** The panel of a Send email step shows the mail in the instance's frame: the sentence, From, To, Cc, Bcc, the subject and text with each value of an earlier step as a chip, the text folded to 12 lines, "Replies go to", the language and where the instance may send. "This run" shows the mail as sent, simulated or sent as a test, its body only to a reader who is given the step run's input.
- **Workflows:** The Settings of a Send email step write the sender's display name, To, Cc and Bcc (people, workspaces, typed addresses or one list field of an earlier step), the subject and the Markdown text with "Insert a value" chips in the `text` form, a preview with the last run's values, and "Replies go to" and the language under "More". An address outside the instance's recipient domains is marked before Save. The palette's "Send an e-mail" adds the step as the instance's own sender.
- **UI library:** `MailPreview`, `RecipientField` and `TemplateTextField` (with `TemplateText`), each with a gallery entry.
- **Workflows:** `operations.list_callable` (and the agent's `platform.assets.operations`) offers a Workflow step `mail.send` where the instance has outbound mail and the person holds `mail_sender.use` on a sender, so the palette can offer "Send an e-mail".
- **Workflows:** `workflows.list_step_runs` gives the output of a simulated or test `mail.send` step (its subject, recipients and rendered body) only to a holder of `workflow.read_run_data`, like the step's input.
- **Personal Connections:** Require every model route of the run to declare `region: eu`. Missing or non-EU regions fail before credential resolution with `personal_connection_region` and a plain explanation instead of a Connect card. Model provider regions accept optional short strings in release config.
- Held operation calls keep their run's model routes and check them again after confirmation or approval, before resolving credentials. Missing stored routes fail closed for personal Connections.
- **Confirmations:** A person's own confirmation settings (OP-6): per operation Always allow, Ask me or Never, for the calls their own agents make, chat and scheduled runs alike. A confirmation card in chat and a confirmation in the Inbox offer "Always allow" only where it would let the next call run; a floor, a guardrail, an approval or an admin's lock keeps asking. Never refuses the call before it runs and keeps the tool from the agent. Settings are listed and changed under Settings > You > Confirmations through `me.operation_settings.list` and `me.operation_settings.set`, by the person in their own session only, never with a personal API key, an embedding host's token or for a delegated actor; each change is audited as `user.operation_setting_changed` with the operation and the value alone. Always allow reaches only runs the person started in their own first-party session, their scheduled starts and subagents of those; a run started with a key or for a delegated actor still asks, while Ask me and Never apply to it too. Workflow calls and other people's calls are never affected.
- **Confirmations:** Release config `policy.alwaysAllow.locked` names operations exactly, or every operation under a prefix such as `connection.crm.*`, for which nobody may set Always allow. A malformed entry (`*`, `name*`) fails config load, and one that names no operation of the instance fails startup. Only reversible operations permit it at all; irreversible, outward and undeclared ones never do.
- **Connections:** Settings > You > Connections lists each personal Connection a person may use, with their own account's state, since when it is connected and the last day it was used. One click on Connect opens the provider in a small window (a new tab where the browser opens none), whose own page shows the permissions; Disconnect asks once.
- **Connections:** A personal Connection's page connects the reader's own account in its Sign-in section and shows holders of `connection.write` a People section with Revoke, which says that the grant at the provider stays.
- **Connections:** The New connection dialog asks "Whose account" (Shared or Personal, Shared by default) for an MCP server and a REST API that signs a person in; the Connection page shows the choice locked. An agent's tools carry a "Personal" chip on a personal Connection.
- **API:** `connections.list_tools` marks a personal Connection with `personal: true`, and `connections.people` names each person by the display label the list of users shows.
- **Connections:** Catalogue OAuth endpoints can bind named path segments, so a tenant field configures the authorization and token URLs together without changing their hosts.
- **Connections:** A catalogue setup checklist line valued `{redirectUri}` shows the instance's redirect URI for that part.
- **Connections:** Declared HTTP query parameters support fixed `const` values hidden from tool input, and defaults when omitted, so read-only mail presets can fix the response format and cap page sizes.
- **Skills:** Skill reads list scripts and assets for workspace use alongside text resources. File changes update a skill's source version and make pending proposals stale. Skill writes warn about secret-like text by path and line without exposing it.
- **Skills:** Every `workspace.exec` command of an agent run finds the whole folder of each skill the run may read, read-only at `/skills/<name>/`, at the revision that was live when the command was queued, so an agent can run a skill's scripts on its assets and write the results into the workspace. Other skills are never mounted, a Workflow's code step mounts none, and the sandbox keeps `--network none`. The worker keeps verified, read-only copies below its temp root and removes idle ones with the idle-workspace cleanup. A folder that cannot be read fails the command with `WORKSPACE_SKILL_MOUNT_FAILED`. `read_skill` names the folder for an agent with `workspace.exec`.
- **CLI:** The working copy pulls, diffs, validates and pushes whole skill folders, including scripts and binary assets. Folder writes preserve file bytes, check skill limits before sending, and use the pulled revision; text-resource edits stay in release batches. `skill put --from` now sends every file of a skill folder. Older working-copy baselines need one pull before pushing.
- **Skills:** Studio imports a skill from a folder or a .zip, as public skill libraries ship one ("Import skill" on the Skills list). The browser unpacks it: one top folder is stripped, `__MACOSX/`, `.DS_Store`, `.git/` and the CLI's state files are skipped, links are refused, and sizes are checked before and while inflating (8 MiB per skill, 2 MiB per file, 500 files). A preview shows the name, title, description and every file with its size; an address that is taken offers to replace that skill's files instead.
- **Skills:** A skill's page offers "Replace from folder": the files added, changed (by SHA-256) and removed are listed before the save, which writes the whole folder at the page's revision and files an approval request where a save does.
- **UI:** `@work-shape/catalyst-ui` adds `FileDropZone`, and `FilePicker` chooses a folder with `directory`.
- Workflow step facts now identify `mail.send` sources as mail senders and include the system sender's title, icon, address and recipient-domain policy. These facts accompany the existing revision-specific operation facts, schedule, step input previews and problem paths without changing the stored definition or adding a right.
- **Agents:** An agent a workspace owns stays a draft until a holder of the new right `agent.approve` approves its publish (WS-PUB-1b). The shipped guardrail "Publishing needs an instance admin's approval" now also binds `agent.before_publish` for workspace-owned agents; instance-owned agents are not held by it. An instance admin's own Publish on the agent page is the approval; a Publisher without `agent.approve`, and every CLI publish, files an "Agent to publish" item in the Inbox. `agent.approve` is held by admins by default and can be granted on one agent, in a workspace or for the whole instance; a holder in a workspace decides that workspace's items.
- **Agents:** The Inbox item shows the draft against the live revision: the fields that differ, the tools and models it adds, the skills it names, the instructions, and the workspace it is offered in. The request freezes both revisions and turns stale when either moves. An approver who holds neither `agent.read` nor `agent.write` on the agent is told the instructions are withheld instead of reading them.
- **Agents:** A workspace's agent made by someone without `agent.approve` in that workspace (agent page, Build, CLI push or key) starts at version 1 offered nowhere: only its creator and approvers see it. Its first publish needs no draft and files an item that reviews version 1 as "First version". A creator who holds `agent.approve` keeps the agent offered as before.
- **Agents:** The approval of the first publish of an agent hidden by that rule offers it in its own shared workspace, unless an availability was set since, audited as `config_asset.availability_set` with reason `first_publish`. Later publishes leave where it is offered as it is.
- **Agents:** `catalyst agent publish` asks in the terminal for a workspace's agent and says the publish waits in the Inbox; with `--yes` it waits as a confirmation.

### Changed

- **CI:** a `v*` tag push no longer starts the hosted Check, since the release branch's Check already proved that commit; a manual Check dispatch is accepted only on `release/**`.
- **CI:** the Postgres image workflow runs only on a push to `main` that touches `docker/postgres/**` or the workflow, or on dispatch; tag pushes and pull requests no longer start it.
- **Checks:** Run browser coverage on six duration-balanced shards with a minimum group count and a matching Playwright container, avoiding browser dependency installation per shard. Transfer the shared build as a run-scoped artifact so both host and container jobs can restore it. Leave scale tests out of the release Check for the Mac mini nightly run.
- Browser checks omit covered duplicate cases, use three layout variants, capture screenshots only with `E2E_SHOTS_DIR`, and advance polling clocks or release held reads once their loading state is verified.
- Move account administration, reasoning-effort explanations and private-view raster-image assertions into focused render and server tests. Keep browser coverage for routing, private-view network silence, modifier clicks, applied styles and Chromium parsing.
- **Tests:** The per-test and per-file time budgets and their reporters are gone. The nightly
  instead fails when the unit suite's or the browser suite's total time is over 15 minutes on
  16 cores (scaled by 16 / cores), and runs the scale tests as a separate, untimed step.
- **Tests:** cover source-listing retries, duplicate fetch claims, failed-source summaries, unchanged-content embedding reuse and one-row Workflow batch views in the normal suite.
- **Tests:** Reuse worker module graphs for pure tests, keep persistence and module mocks isolated, use narrow chat UI test entries, and move volume checks into the opt-in scale suite.
- Test projects share Postgres worker modules while retaining per-file databases and isolated exceptions. Tooling tests run separately with `pnpm test:tooling` in local, PR and nightly checks.
- **Repository:** The README now says what the repository holds, how to run and test it and how a
  change lands; `tests/README.md` is the one page on which command runs which tests and how to get
  a test Postgres. Release, GHCR and Postgres-image notes moved to `scripts/release/README.md`.
- **Repository:** Removed the broken agent-stories runner (`pnpm test:agent-stories`), the
  migration 0020 preflight (`pnpm db:preflight:collaboration-workspaces`), the unused root
  `.env.example`, `skills-lock.json`, `components.json`, the demo's unused `deploy/Caddyfile` and a
  stray preview config. The reference client reads its environment from `clients/demo/.env`.
- The landing tooling is gone: affected-test selection (`pnpm check:affected`), duration sharding and its measured durations, the hosted path selection, the image retry wrapper, and the baseline and check-limit guards. The hosted Check runs every job on each release run and shards the browser suite with Playwright's `--shard`; `pnpm test:agent-stories` no longer needs the workspace browser lane helper.
- A quality baseline count is now a ceiling: a count above its entry fails, a count below it passes, so a repair needs no baseline edit.
- **Workspace tools:** Removed `workspace.apply_patch` and its unified diff implementation. Use `workspace.edit_file` with exact text edits instead. There is no alias and patch inputs are unsupported. Existing release configs and stored agents that still name the retired tool start with a warning naming `workspace.edit_file`; the retired tool is never offered or executed.
- **Tooling:** every runner labelled `catalyst-check` takes PR checks, one per machine, and each run starts its own test database on a free port.
- **Tooling:** Every pull request runs a check on the Mac mini runner: format, lint, types, migrations, unit and database tests, and the upgrade test. A nightly run on the same runner adds the scale, compatibility, docs, release, image and full browser checks. The database script also counts cores on macOS.
- Replace customer names in demo content and test fixtures with generic examples, and keep package name guards using SHA-256 vocabulary digests.
- Core owns the hook at every before-event: `BeforeActionCheck`, its input and call context, `NO_BEFORE_ACTION_CHECK` and `combineBeforeActionChecks` in `@work-shape/catalyst-core`. The guardrail runner is one such check. A capability can contribute another through `beforeActionCheck` on its contribution; the assembly combines it with the guardrails and hands the result to operation calls, the event emitter, the approval-request workflow and the publish question, and the strictest answer of all is the event's. `createOperationCalls` now requires `checks`, so a process that forgets the wiring fails to build; a process that checks nothing passes `NO_BEFORE_ACTION_CHECK`. Behaviour is unchanged.
- The capability SDK gains seams for a capability that keeps platform records: `stores` on the context (the guardrails' store and the published config assets), `instanceSeed` (runs in the API process before it takes a request), `retention` (deletes past the audit retention in the transaction of the audit prune and names its counts in `audit.pruned`), and the model purpose `guardrail_judge` with `instructions` and `reasoningEffort: "configured"` on a model call. A capability's model call that returns a tool call fails.
- The guardrails run as a capability the platform ships built in: their check, their release seed and the deletion of their hits come through these seams, and the `guardrails` module ships with it. A deployment that passes a capability named `guardrails` replaces it. The hits are deleted on time also while the module is off. Release guardrails stay under the `guardrails` key, and the kind, operations and rights stay registered by the platform for now.
- An instance whose `guardrails` module is on refuses to start where the capability that ships the module contributes no check.
- A capability brings asset kinds through its contribution (`assetKinds`, product-owned `CapabilityAssetKind` from core, re-exported by the capability SDK). The platform registers each beside its own and refuses a kind it already has. The guardrail kind now registers only through the built-in guardrails capability, while its module is on; nothing changes for an instance. `defineGuardrailAssetKind` is the kind as the capability brings it; `createGuardrailAssetKind` stays for a server assembled by hand.
- Guardrails are a module, `modules.guardrails`. Off, their operations answer 404 `module_off`, the `guardrail` asset kind and its rights are gone, release guardrails are not seeded, and every before-event allows: only policy, floors and rights decide. For one transition release a config without the switch keeps guardrails on, so an upgrade to a build without their code refuses to start instead of dropping them quietly.
- A release config that sets `guardrails` while the module is off is refused at load, naming them.
- A check that throws or does not answer within 75 seconds refuses the action with `GUARDRAIL_BLOCKED` and the new error detail `details.reason: "check_unavailable"` (`details.guardrailId` then names the event). Before, a throwing check failed the call as `INTERNAL`. API change: the error description of `GUARDRAIL_BLOCKED` in the OpenAPI document, and `reason?: "check_unavailable"` on the guardrail denial of an operation result.
- **Studio chat entry:**
  - Every page head shows "Chat" next to its primary action. It opens the dock from anywhere, and ⌘J / Ctrl+J does the same.
    - On an asset's page it starts a conversation about that asset.
    - On a list it opens the dock's last conversation. That conversation is kept in this browser across a close and a reload. If there is none, it opens an empty dock with the agent that builds.
  - In Studio, a conversation that builds is started in the workspace Studio is set to, private where that is not the open workspace. An empty dock that builds says where a new asset will be created, for example "Neue Agenten entstehen in „Team Vertrieb“.".
  - An unchanged new page, and opening or closing the dock, no longer ask before leaving: only a move to another page with unsaved changes does.
  - The dock's head names a skill by its title.
  - In a narrow window, where the dock lies over the page, "Chat" is its icon alone, still named "Chat". At 768 px a Connection's head with a long name puts its actions under the name.
  - The separate "Edit with agent" buttons in the heads of Data Stores, Apps and Workflows are gone. "Chat" replaces them.
- **New:**
  - "New agent", "New skill" and "New knowledge base" open the kind's empty, unsaved edit page under every scope. The first Save creates the asset.
    - The id comes from the name. A taken or invalid id is shown on the page.
    - Where the new asset is available is chosen on the page.
    - Leaving the page with unsaved changes asks first.
    - "Chat" on the new page opens the agent that builds the kind.
  - Kinds without a hand editor (Data Stores, Apps, Workflows) ask one short question, "What should it do?", and then "Build with the agent" opens the dock with the answer in its composer.
- **Chat under Instance:** A chat started in Studio under the scope Instance creates agents, skills and guardrails that the instance owns, where the person may create them there. Otherwise the dock says "Du darfst hier keine Agenten der Instanz anlegen", and the save is refused with that reason: nothing is created, also not in a workspace. The target is set when the conversation is created, and the agent cannot change it. A refusal is audited as `conversation.instance_create_refused`, with the conversation and the kind only. Data Stores and Workflows keep their rule.
- **Audit:** The Audit page's "Subject" column ("Betrifft") and an activity's target say what an event is about in words (UXA-1b3): an asset's title, a person's, workspace's or role's name, or a tool's title, after its kind ("Skill: Prüfbericht"). Where the reader may not read the subject, or it is gone, they read its kind alone; never its id, slug or operation name. Each event in the `evidence` of `GET /api/v1/instance/audit-activities` now carries `about` (`kind`, and `title` or `builtInRole` where the reader may read it), and a target's `label` is the title its reader may read. The server checks the rights the subject's own page asks: an asset's read right, `users.manage` for people and roles, membership for a workspace, and authorship for a conversation.
- **Jobs:** Debug logs show each worker pass's queue filter and claim decisions, including local slots, global concurrency and skipped candidates. Job tests retain these decisions and queue metadata on failure to diagnose intermittent missed work.
- The scope rename tool accepts repeatable `--assembly <name>` options for private deployment packages.

### Fixed

- Tool timeouts without an exposed message tell the agent that the tool did not answer in time and that its outcome must be checked before repeating a change; provider details stay private. Exposed timeout messages remain handler failures, preserving causes such as a cancelled Postgres query so the agent can narrow its query.
- Tool validation messages name the offending field and the validation issue, alongside the structured details.
- Workflow authoring guidance tries Connection reads before using their results, offers missing tools with `platform.connections.offer_to_agent`, and explains MCP JSON-in-text results and parsing before mapping fields.
- App and Workflow guidance names the runner's existing PyYAML installation; documentation references need only be loaded once while they remain in the conversation context. The task-sized App guide and the corresponding Connection guidance already exist on main.
- **Dependencies:** Update Vite to the patched 8.x line and ExcelJS’s UUID dependency to 11.1.1 to address security advisories.
- **Tests:** Retained the sandbox observation windows, background conversation isolation and author-only Send now checks while reducing browser-suite runtime.
- **Tests:** Preserve rights, scope and isolation checks while moving redundant browser coverage to API and render tests.
- **Tests:** Restore the German Connection draft prefill check, exercise agent form layout variants without screenshots, and clarify the known-open WebRTC probe's timeout.
- **Personal Connections:** Close personal-data exits from marked conversations: store new HTML displays with the static renderer, use script-free HTML file previews when marked or unknown, refuse Workflow starts and scheduled prompt creation or updates, and require at least confirmation for shared MCP calls and system mail. Keep stricter policy and earlier views unchanged; fail closed on unreadable conversation marks and preserve web tools for known Workflow agent steps.
- **Workflow starts:** Share the run-aware personal-data check with ModelInput so a known Workflow agent step can start another Workflow while marked chats remain refused. Preserve Workflow- and workspace-scoped use rights.
- **Page head:** A detail head that is drawn again while the browser reports sizes, such as a Workflow's head after its draft is discarded, no longer causes a "ResizeObserver loop" error. The head keeps one observer for its life and observes each element once.
- Workflow Settings name the visible Workflows whose draft or published steps call this one, with a link to each caller.
- Child Workflow steps check dataset values against the child's draft inputs when the tester may write that draft, retaining published checks for live runs and other testers.
- **Assets:** Asset list searches and summaries respect draft access: readers see and match published titles, while writers and publishers can also search draft titles.
- The first letter typed into the composer no longer fails with "Maximum update depth exceeded. The result of getSnapshot should be cached" when a deployment's install resolves @assistant-ui/tap 0.9.13 or later beside @assistant-ui/core 0.2. chat-ui keeps the thread list state of its chat runtime the same object until a field changes, which is what core 0.3 does upstream, so the composer no longer depends on the deployment's lockfile resolving the pinned assistant-ui versions.
- **Data Stores:** try every resolved database address until one connects, so hosts with both IPv6 and IPv4 addresses work when Postgres listens on only one stack.
- A message submitted just as a conversation finishes loading is sent even when the form last rendered with sending disabled.
- Opening a newly published Knowledge Base shows its sources immediately while its document store is being prepared, instead of briefly failing with a conflict.
- The model picker uses the matching selectable binding's label and vendor for agents running on their provider's own model, without offering the binding twice. Runs from that entry keep the same provider and model, and saved binding preferences still resolve.
- The Connect card in a conversation keeps waiting for a person's sign-in when the thread draws it anew at the end of the run, so a person who connects while the agent is still finishing is shown as connected and the agent carries on.
- The nightly browser suite passes again: the skill-file test presses the file's own Replace and not the page's "Replace from folder", the Connect card test re-creates its Connection at the revision of an earlier spec's delete and runs on a model route that says `eu`, and the access test expects the agents' Approve right beside the levels. The release check allows the api-contract tarball 340,000 bytes, as its operation schemas, declarations and OpenAPI document grow with the API.
- **Workflows:** a start field or an answer field whose title changes while its Save is under way keeps the key that Save sends, instead of renaming a field the instance already holds.

### Database

- Migration `0143_personal_connection_isolation` adds nullable `conversations.personal_data_at` and `operation_runs.result_bytes`. Existing persisted run authorization already records first-party or owner-authorized scheduled starts; no new run column is needed.
- **Confirmations:** Migration `0146_user_operation_settings` adds `user_operation_settings` (a person's own Always allow, Ask me or Never per operation, removed with the person) and nullable `operation_runs.offers_always_allow`.
- **Workspace commands:** Migration `0144_workspace_command_skill_mounts` adds the nullable jsonb column `workspace_commands.skill_mounts`, which holds the name, revision and source version of each skill a command mounts, never content. Existing commands keep nothing and mount no skill. It moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API and worker. The previous release does not read the column; remove it only through a later committed migration.
- **Conversations:** Migration `0142_conversation_creation_target` adds the nullable column `conversations.creation_target`, which holds only `instance` or nothing. Existing conversations keep nothing and behave as before. It moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API. The previous release does not read the column, so after a rollback of the application a chat started under Instance creates in its workspace again; remove the column only through a later committed migration.
- **Agents:** Migration `0145_agent_awaiting_first_publish` adds the column `config_asset_availability.awaiting_first_publish` (boolean, default false, not null). It marks a workspace's agent that its maker, who holds no `agent.approve` there, left offered nowhere: only the approval of its first publish offers it in its workspace, and every later availability write clears it. Existing agents keep false, so no approval re-offers an agent an admin hid. It moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API. The previous release does not read the column; remove it only through a later committed migration.

## 0.8.0-rc.8 — 2026-10-22

### Added

- **Connection Catalogue (CAT-1):**
  - A release ships catalogue entries: data about one outside service, each with a `tools` part, a `source` part or both. `loadCatalogueEntries` reads one folder per entry. An assembly passes them as `catalogue`, and release config names the offered ones in `catalogue.entries`.
  - Every shipped entry is checked at start, as the instance would check the Connection it makes. The start stops when an entry is broken, when `catalogue.entries` names an entry the release does not ship, or when a named entry has no part this build can install. Only a named entry's hosts join the egress list.
  - New connection shows the offered entries under "Dienste", with a `ServiceMark`, and greys an entry the operator has not named. A part installs through the form of its Connector type, with the checklist and a sentence on the shared account placed before the secret. A tools part then lists its operations for review, with the reading ones the entry recommends ticked.
  - An entry only recommends. It cannot hold an exposure, enabling, grant or agent. A changing operation is never ticked in advance. The install enables only what the admin approves and grants no right.
  - A Connection keeps a `catalogue` link (`entry`, `part`, `version`). A write that sets or changes the link is refused with `catalogue_entry_not_offered` unless the entry is offered and its part makes a Connection of that type. A link that stays the same, or is removed, is always accepted.
  - `connections.connector_types` answers `entries` beside `types`.
- **UI:** `ServiceMark` in `@work-shape/catalyst-ui` shows a service either by its official logo, supplied and drawn unchanged, or by a white initial on the service's colour. The library holds no vendor's logo.
- **Connections:** A Connector type form's `service` must be a lowercase slug, such as `box`. A type that names it in words is refused when it registers. A typed Connection now stores that `service`.
- **Access:** The right `agent.use`, to converse with an agent, grantable on one agent, in a workspace or on the whole instance, to a person, a role or a group. Each agent says who uses it where it is available: everyone who may work there (the default, which every existing agent keeps) or only people and roles with the right (`agents.use.set`, decided like its availability). Both must allow: a right never opens an agent where it is not available, and a deny of `agent.use` keeps one person or role from an agent everyone else uses. The chat's agent picker, a message or start by agent name over the API, a queued follow-up, a scheduled prompt (when made, at its tick and before its run), and a subagent start all decide it; a refusal answers `FORBIDDEN` naming `agent.use` and is recorded as `agent.use_refused` with who, which agent, where and through which entry, never what was asked. `admin` and superadmins hold the right by default. In the New right dialog it is the agents' lowest level, "Verwenden" / "Use".
- Release config Connections can name an offered catalogue part with `fromEntry` and `part`. Startup expands its settings and operations, keeps its entry, part and version, and refuses unknown or unavailable parts. OAuth parts are refused in release config with a setup message.
- `catalyst catalogue list` lists the instance's entries. `catalyst connection init <name> --from <entry> [--part tools|source]` writes a local `connections/<name>/connection.yaml` with defaults and catalogue provenance, with operations disabled and unexposed, without overwriting an existing file.
- **Connections:** a REST API (`http_api`) Connection signs in with OAuth (CONN-OAUTH-1). Its settings name the authorization server under `settings.oauth` (`tokenUrl`, `clientId`, `scopes`, and for a sign-in `authorizationUrl`, optionally `revocationUrl`, `authorizationParams`, `tokenAuthMethod`, `issuer`). The auth scheme `oauth` signs a person in with the authorization code, PKCE and refresh, through the same sign-in, refresh, keep-alive and disconnect as an MCP Connection, without discovery, Dynamic Client Registration or an RFC 8707 `resource`. The auth scheme `oauth_client` uses the client credentials grant; its token is kept in the memory of the process only, shared by concurrent calls and fetched again after a 401. The client secret is the Connection's own secret, bound to the token, authorization and revocation addresses and the client id: a change of them ends the sign-in and deletes the secret. Every address of the server must pass the egress list at the save and at each request.
- **Studio:** the New connection dialog and the Connection page offer "OAuth sign-in" and "OAuth client credentials" for a REST API, with the server's addresses, the client and the permissions; the sign-in step shows the redirect URI to copy.
- **Demo:** the sample MCP server serves a REST provider under `/oauth-rest` where `SAMPLE_OAUTH_REST_CLIENT_ID` and `SAMPLE_OAUTH_REST_REDIRECT_URI` are set, with the client secret from `SAMPLE_OAUTH_REST_CLIENT_SECRET`.
- **Agents:** `platform.context` lists `oauth` and `oauth_client` among a REST API's sign-ins, and Workshaper, the orientation, `platform.connections.draft_tools` and the Connection docs no longer say OAuth for REST APIs is to come: for an API that needs the provider's sign-in an agent uses the provider's MCP server where one exists, and otherwise proposes a REST API whose OAuth sign-in the person sets up in the dialog with an app they registered with the provider.
- In an App's draft a `workflow` action starts a test run of the Workflow instead of a dry run (DP-1): of its draft for a tester who may write the Workflow, otherwise of its published revision, still as a test and admitted by the right to use it. Its reading, model and code steps are real and its changing steps are simulated or go to a test target, so App and Workflow are tried together before either is published. A Workflow never published answers a tester who may not write it `workflow_unavailable`, and no draft starts a live run.
- The run names the App, the draft's revision, the action and which Workflow revision ran (`startedFrom`), and the Workflows pages mark it "Test · from App draft “<App>”". The frame of the draft marks the result "Test run of the draft · Workflow draft" or "Test run · published Workflow", with the number of simulated steps and a way to the run. "Run live once" is no longer offered on a `workflow` action.
- Kit 1.8.0: `useWorkflowRun` and `workflowRuns.get` pass on `mode: "test"`, `workflowRevision` and `simulatedSteps` of a test run. A new App names kit 1.8.0.
- An agent tries an App's draft as the person's click does, before anything is published: `apps.try_action` calls one action of the draft of the conversation's subject App, or of an App the conversation created, with the same draft context and answer as the button. A `workflow` action starts a test run of the Workflow's draft (or its published revision for a person who may only use it) and the answer names the run and the revision that runs; the call is the button's own run, with the conversation in its origin. It asks the person's right to write the App.
- `apps.publish_review` reads what publishing an App's draft comes to: the App and the Workflows its actions call, what is pending in each, the sentence each publish question leads with, and each missing right or check that would refuse a publish now. It changes nothing. `publishesTogether` is `false` until one Publish of the App also publishes its Workflow drafts.
- Both are agent tools offered with the App tools. Workshaper, the `workflow-authoring` skill and the docs pages "App or Workflow" and "Workflow actions" say to try through `apps.try_action` and never to ask the person to publish in order to try something.
- One Publish of an App makes the Workflow drafts it reaches live with it (DP-3). `assets.publish` of an App takes `workflows`, each pending Workflow with the revision the person saw, checked against the App revision's closure (its `workflow` actions, then child Workflows). Rights and guardrails are asked of each up front, a held publish is one `app_publish` approval that names every Workflow, and the publish runs in one transaction, children first and the App last, or publishes none. The answer lists `publishedWith`.
- `apps.publish_review` lists the closure children first, with `lastChangedBy` and `lastTestRun`, and says `publishesTogether`. The App's Publish dialog and an agent's publish confirmation show "Published with it" ("Wird zusammen veröffentlicht"), the Inbox item lists the Workflows, and `catalyst app publish` names and sends them.
- A step of a Workflow has a Settings tab for a person who may change the Workflow (WF-EDIT-1): its name and what it does, the list a loop runs over with how many entries run at once and what happens when one fails, a notice's recipients, channel, title, text and link, and the values a result returns, each a fixed value or a field of an earlier step's result. Each Save is one revision of the draft; the published revision stays until it is published. The instance checks the form when a field is left and on Save, and what it refuses stands under the field it names. A save after the agent saved meanwhile carries the change over without a question, keeps the person's value with the agent's under it and "Take it" where both changed the same field, and says the change was dropped where the agent deleted the step. On the canvas a step shows whether it is new, changed, removed or not saved against the published revision, and a changed field shows the published value under it. Steps of other kinds point to the agent.
- An AI step and a script have their Settings (WF-EDIT-2): an AI step's instructions, what a step gets (named values, each fixed or picked from an earlier result, which write the step's input schema from the kinds of the values), and what it answers with (a list of fields of text, numbers, whole numbers, yes or no, a choice, a list of texts, a group of fields or a list of groups, required or not, which writes its output schema; a group holds no group). A script is edited in place and saved as the step's file of the draft, so the next test run runs it. The language and the packages of a script stay read-only, and an answer the form cannot show stays with the agent.
- Switching a value to "From a step" in a step's Settings keeps it a pick until a field is chosen, and the save waits for it; before, the value turned fixed again.
- An operation step, a step that starts another Workflow and a Workflow's AI tools have their Settings (WF-EDIT-3): the operation is picked by its title, grouped by its source, with whether it reads or changes data, and the form shows one row per field of its input schema, each a fixed value of the field's kind or a field of an earlier result; a required field without a value holds the save back. The child picker offers the published Workflows started by `parent` that the person may read; one the person may not start (`workflow.use`) is shown disabled with the reason. A Workflow's `tools` are picked from the same listing.
- `operations.list_callable` (`GET /api/v1/operations/callable`) lists the operations a Workflow's step may call for the person asking, with title, description, source and whether the instance has them now, as the agent's `platform.assets.operations` does. An operation is listed only where its own check of a call from a Workflow step lets the person call it. The listing advises and grants nothing: the run's call is checked again under the identity the run acts as. Each check is asked dry, with no side effect and no audit event. A source is named by its title only for a person who may read it.
- `platform.assets.operations` answers each operation's title, source and availability.
- `workflows.list` answers each Workflow's `triggers`.
- **Workflows:** A Workflow's builder adds, deletes and moves steps by hand on the canvas. A "+" on every edge, on every path of a condition and at the end of a loop's body opens the palette of the step types this release runs: callable operations under "Data and systems", the AI step and scripts, the loop and "Start another workflow", and under "People" a message and, where the person may send, an e-mail. The new step opens in its Settings, unsaved, with an id made from its name that stays when it is renamed. "Delete step" and "Move" are in the step panel's "…" menu: a delete asks once and names how many steps go with a block, and a step whose result another step reads is not deleted (the dialog names the readers and goes to the first). A move shows "Move here" targets; a move the instance refuses saves nothing and says which step would no longer see the result it reads. Each delete and move is one revision of the draft. A step's settings say a required value is missing only after the field is left or Save is tried, so a new step does not open in red.
- **Packages:** `WORKFLOW_EXECUTED_STEP_TYPES` moves to `asset-schemas` and is exported by `catalyst-core` instead of `catalyst-workflows`. A refusal whose issue names its place as one dotted path keeps that place. In the UI library, `FlowInsertPoints.around` wraps a "+" in what it opens, `SidePanel` takes `actions` for its head, `Dialog` takes `initialFocus`, and a zoomed-out node leaves its change to the frame instead of squeezing its title.
- **Workflows:** A Workflow has a Settings tab beside its canvas and its runs. Its builder changes the name and the description, turns the ways it starts on and off (on a schedule, by hand, from another Workflow), sets the schedule with the schedule field instead of cron, and edits the fields it asks for at the start; each Save is one revision of the draft. A schedule the field cannot show is said in words and left as it is. The result, what happens on failure, the limits, the account it runs as, its owner and who may start it are shown read-only. The trigger step's own Settings point to this tab.
- **Scheduled:** A schedule's time zone is said as the schedule field says it ("Berlin time"), never by its id, on the canvas trigger, in the Settings tab, on the Scheduled page, in its dialog's zone list and in the chat's schedule confirmation; `scheduleZoneWords` is exported from the UI library.
- **Workflows:** a workspace owns the Workflows made in it (WS-OWN-1b). The agent's first save in a conversation creates the draft in the conversation's workspace; `assets.*` on `workflow` take `workspaceId`, and `workflow.read`, `use`, `write`, `publish` and `delete` are grantable at workspace scope, reaching that workspace's Workflows alone. Membership gives no Workflow right. `workflows.list` names the owning workspace (`workspaceId`), and the Workflows page lists the open workspace's Workflows beside the instance's, with the workspace's chip. A workspace Workflow's `workflow` step may name a Workflow of its own workspace or of the instance only.

### Changed

- Hosted Check runs for releases only: release/** branch and v* tag pushes, and a dispatch on those refs. The nightly hosted run on main is gone; the full suite runs every night on the Mac mini instead.
- Hosted Check runs nightly at 03:17 UTC and for releases only. PR labels no longer trigger it, and manual dispatches outside release branches and v* tags fail before checkout. Release pushes and release-branch dispatch cancellation remain supported.
- Usage and API keys in Settings say a refusal at once: a read the instance refused is no longer asked for again three times, about seven seconds, before the page names whom to ask.
- The browser suite opens a development build of the interface served as files, not the Vite dev server: a page load asks for about 25 files instead of about 1,000 modules. The slowest browser tests load each look once, and PUBQ-1 and SHARE-1 run outside the serial Inbox journey.
- The slowest unit test files start their processes from one bundle and cut a workflow step's backoff short instead of sleeping through it.
- Workshaper builds an App's colours from the interface's theme variables, so the App follows light and dark, and uses fixed colours only where a look of its own is asked for. The App guide names the variables the kit keeps on every page and says that dark mode also sets `color-scheme`.
- The App is the gate for the Workflows its actions start (DP-1b): a person who may use a published App starts its Workflow through the App's `workflow` action without a right on the Workflow, and publishing the App asks the publisher the right to use each such Workflow, refused with `workflow.use` named, as for the Data Stores of its `sql` actions. Sharing an App no longer breaks its button for people without that right. In the App's draft the tester's own rights still apply.
- A parent's test run runs a child Workflow's draft, in mode `test`, when the person testing may write the child by their own rights (DP-4); otherwise the child's published revision, as before. A live run never runs a draft. `WorkflowDefinitionSource` gains an optional `draft(id)`.
- **Access:** Instance > Access > Data access is an overview per declared dimension: every person and each group and service account that holds values, with their values or "All values" and where each comes from (assigned directly or through a group), values never shown in plain words, and each person without values marked. A holder's values change in a dialog with a chip field; groups and service accounts are chosen by name. Without a declared dimension the tab is not shown. A new read, `scope_assignments.overview`, gives the page every assignment the reader may see with each active person's groups and effective values (SCOPE-UI-1).
- **UI library:** `ChipInput`, a field that holds a list of short values as chips.
- Member and admin screens use the words of the product (UXA-1b): "the team that runs this instance" for operator, "the instance's setup" for release config, "version" for revision, "protected store" for Secret Store, "Agent instructions" for System prompt and "cards" for widgets, in English and German. A test reads every message of both catalogs and refuses these words, audit keys and error codes outside named exceptions (the System group of Jobs, Operations, Modules and Infrastructure, and the provider words MCP server and Bearer).
- The Audit page says each activity, event, target and reason in English and German words (UXA-1b2), not in the server's English labels, event types or reason codes. An activity of `GET /api/v1/instance/audit-activities` now carries the `type` of the event that titles it and, for a tool's event, its `action`, in place of the English `label`; the words live in the interface catalogs, keyed by event type. A type or reason without words reads "Other activity" or "No description for this reason.", never the code. Every audited event of the event registry has words in both catalogs, and the plain-words test renders the German audit view and refuses event types and codes in it.
- **Workflows:** A start field (Settings tab) and an answer field of an AI step or a script are named by their title, such as "Monat", and no longer by their key (WF-EDIT-5c). A new field's key is made from its title as a new step's id is made from its name ("monat"; lowercase letters, digits and `_`), follows the title until the field is saved and then stays when the title changes, because later steps and the start form read the field by it. The key shows only as a small detail under the title. A new field opens without a word against its missing title: it is said once the field is left, or by the first Save, which saves nothing.
- **UI library:** `FieldListEditor` takes `titled` and `keyHint`: a person edits each field's `title`, and the key (`name`), which the caller derives, shows under it. `FieldListItem` gains `title`, and the labels `fieldTitle`, `fieldKey` and `field` (a field without a title yet is "Field 2").
- **Workflows:** On the canvas, the "Not saved", "Changed" or "New" tag of a step stands on a line of its own under the type, never beside the title, and a title wraps between its words only: at 73 % beside an open panel, "Belege prüfen" no longer breaks inside its words.
- **Tooling:** Balance the browser suite across eighteen isolated shards with refreshed duration weights from recent Check job logs. Use the upper quartile of initial attempts and reserve the largest observed retry cost per title, so long Settings scenarios and the serial Inbox journey no longer share shards with work estimated from stale timings. The extra shards leave room for the runner variation measured in the validation run. Keep the tests, one worker per database and timeouts unchanged.
- **Tooling:** `catalyst-quality types:packages` and `types:tests` check each file in the program built for it: a package's source in its package's check, a test in its part of the tests. A program still reports what it imports when no check owns that file. Before, every part of the tests checked the source of most packages again and every package the packages it imports, so the hosted `static` job took 9 to 14 minutes. The parts of the tests run three at a time, like the lint. The tests baseline loses the unused declarations it counted twice, in package sources the packages baseline already counts.

### Fixed

- **Connections:** a REST API Connection's client secret and sign-in are bound to the full token, authorization and revocation addresses, the `issuer` its settings name and the client id, no longer to their origins alone: a new path on the same host (another tenant of a multi-tenant provider) or a new issuer ends the sign-in and deletes the client secret. Both now go in the transaction of the config write, not after it, and a refresh or a revocation sends nothing unless the Connection it reads is still bound to the origin the sign-in was made for, so a write landing while a refresh runs cannot have the refresh token or the client secret sent to another token address (CONN-OAUTH-1 review).
- **Connections:** the extra sign-in parameters of a REST API Connection refuse `request`, `request_uri` and `response_mode` too.
- **Connections:** a person-context mapping of a REST API Connection that signs in with OAuth is kept for the API's own origin, so its calls find the mapping and a save of the Connection keeps it; before, every such call answered `person_context_unmapped`.
- **Connections:** `connections.set_secret` (`PUT /api/v1/connections/:name/secret`) takes `expectedRevision`, the revision of the Connection the writer read, beside `expectedVersion`, and refuses with 409 `CONFLICT` (`connection_changed`) when the Connection changed since. The secret is stored under a held read of the Connection, so a write that changes the token address, the issuer or the client while an admin types a client secret can no longer have that secret sent to the new address (CONN-OAUTH-1c). The New connection dialog, the Connection page, the sign-in step and `catalyst connection secret set`, which reads the revision before its prompt, send it. A caller of the API that sends no `expectedRevision` is refused with `VALIDATION_FAILED`.
- Update esbuild and scope transitive security overrides for KaTeX and the documentation CSS parser to reviewed patched versions. Keep Vite at 8.0.16 pending a separate dev-server performance comparison.
- **Apps:** An App following a Workflow Run it started through `apps.sessions.get_workflow_run` (kit `useWorkflowRun`, `workflowRuns.get`) now gets the run's whole output up to 256 KiB as JSON (`APP_WORKFLOW_RUN_OUTPUT_MAX_BYTES`, the size of an action result), instead of the interface's 2,000-character preview. Before, an output longer than 2,000 characters came back as `{ status: "done", outputTruncated: true }` with no output. `outputTruncated` is now set only above 256 KiB (DP-0b).
- An App published together with its Workflows (DP-3) is now held when any member's publish would be: a central setting that holds a Workflow's publish holds the joint one, as the Workflows' guardrails already did, and a Workflow the call names that cannot be read refuses the publish instead of narrowing what policy and guardrails are asked. The joint `app_publish` item is decided only by someone who holds `app.approve` and `workflow.approve` on each Workflow it makes live (a deny on one Workflow refuses), and a publisher's own click counts as an approval only on the same terms; before, the App's approver alone made the Workflows live. A request whose members cannot be read is decided by nobody. Approval kinds can name further rights a request needs, each on its own resource (`furtherPermissions`), and an operation's approval further rights the caller must hold (`alsoRequires`); the subject's `publishedWith` members carry their `workspaceId`.
- **Chat:** The dock's title for the asset a conversation is about is read in the conversation's own workspace. On a Studio page after a reload, it was read before the workspace list arrived, without the workspace, and an asset that workspace owns answered 404.
- The release job builds packages one at a time, which keeps the build inside the hosted runner's memory, and shows the build output, so a failed release build says why.
- **Tests:** The writers that the code step tests start to prove the sandbox ends what a script leaves running now stop by themselves after 120 seconds or 64 MB, and the cleanup also kills them by the pid they record. A test run killed before its cleanup no longer leaves a writer that fills the disk.
- A start of a workspace's Workflow through `workflow.<id>.start` (agent tool, API, child step) asks its rights with the Workflow's workspace, so a grant there admits it, a deny there refuses it, a builder of the workspace finds it among the callable operations and its workspace's guardrails see it.
- Deleting a workspace deletes its Workflows by the Workflow's own delete: their open runs are cancelled, their accounts retired with their grants, and each name stays taken as a deleted Workflow of the instance, so a new Workflow of that name in another workspace no longer reads the old runs. The same holds for a Personal Workspace deleted with its account.
- Unpublishing or deleting a Workflow names only the live Apps the caller may read among those that start it, and counts the others.

### Database

- **Access:** Migration `0141_agent_use_limits` adds the table `agent_use_limits`: one row per agent that only holders of `agent.use` may use, removed with its agent. It is created empty, so every agent stays usable by everyone where it is available; it moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API. The previous release does not read the table, so a rollback of the application ignores any limit set meanwhile; remove the table only through a later committed migration.
- **Workflows:** Migration `0140_workflow_run_started_from` adds the nullable column `workflow_runs.started_from` (jsonb): the App draft, action and Workflow revision that started a test run, by name. Apply it before starting the new API. It preserves compatibility with the previous release and moves no data. Rolling back the application leaves the column unread; remove it only through a later committed migration.

## 0.8.0-rc.7 — 2026-10-21

### Added

- **Roles screen:** Settings > Instance > Access has a Roles tab. It lists User, Admin and Superadmin, then the custom roles; a new role copies the rights of another, and a custom role is renamed and deleted from its row. A role's page shows its rights by area in the sentences of the Rights tab and edits them, resets User and Admin to their default, and decides each right a release added to or took from an edited default (Add / Leave out, Remove / Keep). Superadmin is read-only. The Access page shows a notice while a decision is open.
- **Rights:** A new instance right, `roles.edit_built_in` ("Edit the built-in roles User and Admin"), edits, resets and decides for `user` and `admin` (amends ADR-0028, point 1). Superadmins hold it by default and can give it to a person or a role. Its holder still adds only rights they hold; rights only a superadmin hands out stay with superadmins; `superadmin` is never written; the last superadmin stays. A refusal of such an edit now names `roles.edit_built_in` instead of the operation.
- **Access:** A person's detail on **Instance > Users** shows **Effective rights**: every right the person holds, grouped by kind, each with where it applies, whether it holds and where it comes from: a role by its name ("Rolle Buchhaltung"), a right given directly, or a membership, and the deny that refuses it. The server decides each right by the rule that guards requests and serves it through `permissions.rights` (`GET /api/v1/instance/access/rights`). The **Check** tab of **Instance > Access** now reads its answer from `permissions.check` (`GET /api/v1/instance/access/check`) instead of deciding in the browser, so a custom role is named and a right in the workspace that owns the asset counts. Both only read, under the rule for reading effective rights: a person reads their own, others need `users.manage`, a technical account needs `service_principals.manage`. Both say what the evaluator enforces: an App available to everyone, or only to its publisher, decides its use and is named as the reason ("Verfügbar für alle"); a use a workspace's availability gives names the workspaces it holds in only, because a call from another workspace is refused it; assets are named by their title. See [Effective rights on the Users page](/operate/rights-for-one-person/#effective-rights-on-the-users-page).
- Connecting from chat (CHAT-CONN-1): `platform.connections.propose`, a tool of the Module `connections`, lets an agent propose a new Connection of any Connector type with its id, name and, for `mcp` or `http_api`, an https address without credentials and the key's header name. The tab that sent the message opens the New connection dialog filled with it, the conversation docked beside it, and the card in the conversation opens it again. The key or sign-in stays in the dialog. Once the Connection is ready, that tab sends the conversation a message as the person naming the Connection and the approved tools, never an address or a key, and the agent goes on. The audit record of a proposal names the id and the type only.
- **Connections:** A Connector type can declare a form (`form` on its definition: title, description, auth scheme, fixed settings and fields with English and German labels). The New connection dialog offers each such type as a card beside an MCP server and a REST API, asks for the fields it declares, and Connect writes the definition, sends the secret and runs the type's test. A refused secret empties the field and says so. The new read-only operation `connections.connector_types` (`GET /api/v1/connector-types`) lists these types to whoever may make a Connection. A Connection of such a type shows its settings read-only on its page and waits for no discovery.
- `catalyst connection connect <name>` signs a Connection in with OAuth from the terminal: it opens the provider's page in the person's browser (or prints it with `--no-browser`), waits until the Connection is connected and prints the binding's state, never a token. A Service Principal's key is refused. `catalyst connection disconnect <name>` ends the sign-in and revokes it at the provider.
- `catalyst connection connect` stops waiting once the browser came back without connecting the Connection, because the sign-in was refused or completed in another person's browser, and says so instead of waiting until the sign-in expires. `connections.oauth_start` answers the sign-in's `signInId`, and the new `connections.oauth_sign_in` (`GET /api/v1/connections/{name}/oauth/sign-ins/{signInId}`) answers whether a sign-in the caller started still waits for its callback.
- **Apps:** Where release config sets `apps.draftHosts.enabled` (off by default), a builder can allow an outside host a draft lists for their own preview of the draft, before it is published, with **Allow for my preview** on the draft of an App or on a Page in a conversation (`apps.allow_draft_host`). Only that person's frame connects to it, and only after a click in their own signed-in browser. Hosts with a scheme, port, path or wildcard, IP addresses and names of private networks are refused. The allowance ends once the draft no longer lists the host, and with a publish or a discard. Each allowance is recorded as `app.draft_host_allowed` (an App) or `app.page_draft_host_allowed` (a Page), without the draft or what it read. The preview says when the draft reads data an allowed host could receive. See [Outside hosts in a draft](/configure/release-config/#outside-hosts-in-a-draft).
- **Conversations:** `runs.start` takes `followUp: "steer"` (FU-2). While the sender's own run is going, under the same credential, the message is taken in by the running turn after all tool results of its current step and before its next model call. It is stored as a user row at that moment, with `steered` delivery metadata, and every tab is told with the new `user_message_steered` run event. A steer the turn does not read before it answers becomes a queued follow-up and starts the next turn. A steer into someone else's run, or one with attachments, is queued. `message.created` is audited with `delivery: steered` and the run, without the text. Follow-ups gain the mode `steer` and the status `consumed`. Provider tests cover a steered message after tool results on Bedrock, OpenAI-compatible providers and Vertex.
- **Chat:** What Enter does during the person's own run is a setting on You > Language and appearance, under chat display: Steer (the default) gives the message to the running turn after its current step, Queue sends it once the agent has finished the whole answer (FU-2). It is kept with the account (`followUpMode` on `me.get` and `me.update`, audited as a field of `user.profile_updated`), so it is the same on every device. While a run goes, Enter sends in the person's mode and Cmd+Enter (Ctrl+Enter) in the other; with no run both send. The send button's tooltip names the mode, a pending steer in the queue says it is read after the current step, and in someone else's run the composer says the message waits for the answer.
- **Chat:** A message steered into a run is shown where the run took it in, between the step it followed and the answer it led to, in every open tab, once the run completed and after a reload (FU-2). The run projection gains the part `user_message` (`messageId`, `text`, `createdAt`) at that place; a client that renders projection parts should skip or show it.
- **Chat:** A message the run's person steers in while their confirmation card waits declines that call: nothing runs, the Operation Run ends `denied` with reason `steered`, decided by that person, and the run goes on with the denial and then the message (FU-2, check 87). A call waiting for another person's approval keeps waiting, and the steer is read when the run resumes.
- **Knowledge Bases:** a capability's document tools can read the document of a Knowledge Base search hit by its file id (`knowledgeDocuments` on the capability context). They find it only where the person may use that Knowledge Base in the workspace of the conversation the agent answers in, and read its text as the index read it.
- **Knowledge:** A Knowledge Base of documents shows its synced sources on its page (SRC-2). Its editors add a source from a Connection that can sync documents, set its folders and file patterns, see each published source's state (initial import, up to date, unreachable, refused, failed) with found, searchable and failed counts, start a sync and try failed items again. Readers see the state without buttons or editable fields.
- **Studio:** Publishing a Knowledge Base first reads and shows the instance's publish question, such as who can then find what in which folders and through which shared account, in the reader's language. The publish waits until the question is read.
- **Connections:** A Connection's asset read marks connector types that sync documents with the `documentSource` attribute.
- **Fixed:** Saving a Knowledge Base on its page no longer drops its sources, document types and extraction settings.
- Workshaper, the agent that ships with the platform (SA-1), behind the Module `workshaper` (off by default). The release seed creates it offered in no workspace and never changes where it is offered; where the instance names no default agent it is the default in the workspaces that offer it. Each release merges into the instance's changes field by field, tools and skills one by one; the agent page marks fields that differ from what shipped and resets them. Its name is reserved and it cannot be deleted. `catalyst config pull` brings it like any agent; what the release shipped stays on the instance and out of the file.

### Changed

- **Tooling:** `platform-docs.json` holds each page's `body` as an array of lines, so two changes to different paragraphs of one docs page no longer meet on one JSON line. The `platform-docs` skill's references read the same as before.
- **Tooling:** The reviewed pin of every API operation's id, method and path is one file per area, `tests/__snapshots__/api-paths/<area>.txt`, read from the new `operationAreas` export of `api-contract`, so two changes to different areas no longer edit the same pin. The number of retired paths is pinned directly instead of being worked out from a list of every operation added since.
- **Tooling:** The agent's asset calls are one file per family (`server/src/platform/asset-calls/`: subject, put, app-save, skill, discovery) over one shared scope; the asset tools are one file per tool (`tool-execution/src/platform-asset-tools/`), each with its part of the port, and the late binding forwards every method without a hand-kept table; the platform orientation is one file per paragraph (`client-assembly/src/orientation/`). Tool definitions, the orientation text and every call's behaviour are unchanged.
- **Tooling:** `AssetWorkflow` answers its publish, revision-right, put, revert and delete calls with verbs in files of their own under `server/src/assets/verbs/`, over one shared scope, so two changes to different verbs no longer edit the same file.
- **Tooling:** The browser suite uploads every screenshot a spec keeps for review in one step, as the artifact `evidence-<shard>`: a spec names such a file `evidence-<name>.png` and no longer adds an upload step to `check.yml`. The release tooling job runs every `scripts/release/*.test.mjs`; the real pnpm proof is `scripts/release/mirror-proof.mjs`, still run by `pnpm test:release:mirror`. `catalyst-quality aliases --write` writes the paths of `tsconfig.base.json` sorted by name, so a new package's line lands beside its neighbours by name.
- **Tooling:** chat-ui's development-only subpaths are one export pattern, `"./*": { "development": "./src/seams/*.ts" }`: a new seam is a file in `src/seams/`, not a `package.json` edit, and `catalyst-quality aliases` gives a pattern one alias per file it matches. The test support for chat-ui is split by area under `tests/support/chat-ui/`, still imported as `./support/chat-ui`.
- **Tooling:** The CLI's commands are registered as groups in `config-cli/src/command-groups/<group>.ts`, one line each in `command-groups/index.ts`; `--help` and `commandNames()` are derived from them. Each asset verb lives in `config-cli/src/asset-verbs/<verb>.ts` and declares its own options. The CLI tests are split into `tests/config-cli/<area>.test.ts` over `tests/support/config-cli.ts`, and the CLI reference into `configure/cli/<group>.md` with a generated sidebar. Commands and options are unchanged; `--help` lists the same lines with its sections in group order.
- **Tooling:** Each browser spec's own seed users live in `tests/fixtures/e2e-users/<spec>.yaml`; `scripts/e2e-config.mjs` composes them into the suite's config in file name order and refuses an email listed twice, so two specs no longer edit the same lines of `tests/fixtures/e2e-app.yaml`.
- **Tooling:** A page error that one spec's tests cause on purpose is allowed in that spec, with `test.use({ allowedPageErrors: [...] })`, instead of in the shared `e2e/allowed-page-errors.ts`, which keeps only the 6 entries several specs meet. Every entry is unchanged.
- **Tooling:** A spec names its own allowed page errors as `test.use({ allowedPageErrors: { errors: [...] } })`. Playwright read a bare list given to `test.use` as a value and its options, which broke every spec with two or more entries.
- **Tooling:** A right is now added in files of its own kind instead of the same blocks of four shared files. `ACTIONS` is composed from `asset-schemas/src/contract-values/<domain>.ts`, `GRANTABLE_ACTION_SCOPES` from `core/src/grantable-scopes/<kind>.ts`, the Access page's words of a kind (label, place words, sentences, allow notes) from `chat-ui/src/admin/access/kinds/<kind>.ts`, and their messages from `chat-ui/src/shared/i18n/access-<kind>.ts`, each joined in today's order. The actions, scopes, words and messages are the same as before; the per-kind messages that were outside it now also fall under the rights wording guard.
- **Tooling:** Each platform module is declared in a file of its own under `client-assembly/src/platform-modules/`, so a change to one module's operations no longer edits the same file as another's.
- **Tooling:** The store's `schema` is built from one namespace import per table file, so a new table needs no hand-kept list. The hand list had missed 13 tables; adding them changes nothing, because nothing reads tables through Drizzle's relational query builder.
- **Tooling:** Each domain declares its platform events in `core/src/events/<domain>.ts`, joined into `EVENTS` by `joinEvents`, which refuses an event name two domains declare.
- **Tooling:** The tool runner projects `knowledge.search`, `knowledge.add_files`, the knowledge query tool and `run_agent` through `TOOL_PROJECTIONS`, one file per tool under `tool-execution/src/tool-projections/`, each naming the effect of the operations it calls and what it adds to their answer. The projection of an operation's outcome onto a tool result is `operation-tool-result.ts`, still one exhaustive switch. Calls answer as before.
- **Tooling:** The Build frame's types are one file per part under `chat-ui/src/studio/build-area/build-kind/` (asset, editor props, create dialog, list lead, kind), still imported from `build-asset-kind`. An asset page's draft capabilities are one `draft` object (`state`, `canPublish`, `onRead`) in place of `draftState`, `canPublish` and `onDraftRead`, and the control-plane model takes the agent and dock callbacks as one `agentActions` object that it hands the Settings and Build pages as it is.
- The `chat-ui` package may be up to 800,000 bytes packed, up from 650,000 (Felix, 2026-10-21). The role and effective-rights screens took it to about 660,000.
- **Tooling:** The hosted Check gives `static` and each unit test shard 14 minutes instead of 9; a release run, which adds the scale tests, hit the old limit without a failing test.
- CI job timeouts are no longer check limits (Felix, 2026-10-21): changing `timeout-minutes` needs no `chore(limits)` pull request. Size caps and baselines stay limits.
- A Knowledge Base of documents created on its page is published at once, where the creator may publish it, and available in no workspace, so files can be added right away; later changes still go through draft and publish. Before its first publish a Knowledge Base page shows one notice under its head instead of empty Documents, Status and Test sections, and where no Connection can sync folders yet, its Synced sources section says in one neutral line which systems the instance can sync from and offers New connection.
- **Chat:** Steer is the default of "Enter while an answer runs" on You > Language and appearance, and the setting lists it first. `me.get` answers `followUpMode: "steer"` for a person who has not chosen; without a user record it still answers `queue`, and a message in someone else's run is still queued. The queue says plainly when a message goes out: a queued one is sent once the agent has finished the whole answer, a steer is read after the agent's current step, and where every message steers the queue is headed "Steering". A queued message of your own gets **Steer now** while your own run goes: the new `conversations.follow_ups.steer` hands it to that run as if it had been sent as a steer, keeping its place, under the same rules (your own run, the same credential, no attachments); otherwise it answers CONFLICT and the message stays queued.
- **Rights:** A deny held through a role or a group, `user` and `admin` included, no longer applies to a superadmin; a deny written on the superadmin still does, except on `users.manage`. Before, a deny of `roles.edit_built_in` in `user` took the right from every superadmin at once.
- **Rights:** "Reset to default" and applying a pending right of a built-in role are checked like an edit: the caller must hold every right the change gives back, and every right a deny it lifts refused.

### Fixed

- A Knowledge Base of documents opens right after its first publish. Its store is ready before its tables are made, and reading the Knowledge Base in that moment answered `422` with SQLSTATE `42P01`; it now asks no processing question of a store without tables.
- **Apps:** Publishing an App whose `workflow` action names a Workflow that is not published, or not in the App's workspace or on the instance, is refused with `workflow_unavailable`, and a mapping that leaves out a required input of the Workflow's published revision or fills one it does not declare is refused with `workflow_input_invalid`. Before, such an App went live and failed at every click. A live App whose Workflow was taken back answers its action with `workflow_unavailable` and the Workflow named, and `workflows.unpublish` and `assets.delete` of a Workflow answer a warning naming each live App that starts it (DP-0).
- An App action's input schema names a key a parameter does not take, such as `pattern`, with the keys that parameter's type does take, in place of "Invalid input". An agent step's output schema that no binding supports is refused with the field and the key at fault.
- The runner images (the release's `runner` and the platform's `workspace-command-runner`) carry PyYAML 6.0.2, so an agent's workspace command can read and write YAML in Python.
- Kit 1.7.0: a call made when the interface that shows the App never answered rejects with `not_connected`, which is no longer retryable, and its message says the fault is the page around the App's and that trying again inside the App does not help. A new App names kit 1.7.0; Apps on older kits keep theirs.
- The App guide is split into pages an agent reads on their own, one per task: the folder and manifest, sandbox and storage, actions, one page per kind of action, examples, and failures. `workspace.open`, the platform docs skill and the orientation no longer tell an agent to read the whole guide before building or diagnosing an App; they name the page each task needs.
- Before it builds on a Connection, an agent gives itself the Connection's tools with `platform.connections.offer_to_agent` and calls each reading operation once, so it builds from real answers; the guide, the orientation and Workshaper say so, and no longer send a person to the agent's Tools to add them by hand. The guide shows how to read an MCP tool's data from `structuredContent` or from JSON in `content[0].text`.
- The guide and the `workflow-authoring` skill say that a Workflow feeding an App returns structured fields from its agent step's `outputSchema`, with an example that uses only the supported keys and the list of refused ones, and that an App shows a clear message where to find the run when its output comes with `outputTruncated`.
- An OpenAI model's inline web citation markers (such as "cite turn1view2" between private-use characters) no longer reach the answer, streamed or stored, also when a delta splits one; the sources stay as chips, and a citation's range counts the text without the markers.
- `platform.context` answers, where the module `connections` is on, the kinds of Connection the instance can make (`connectorTypes`) and how each signs in. Workshaper, the orientation, `platform.connections.draft_tools` and the Connection docs tell an agent to read them before it researches a provider, and to draft REST tools only for an API that answers with no sign-in or with a key a person enters. For an API that needs the provider's OAuth sign-in it drafts nothing: it uses the provider's MCP server where one exists, or says what is missing and that a custom Connection can be set up once OAuth for REST APIs is available.
- One thing at a time: Workshaper, the orientation and the draft and offer tools of a Connection say to show a card the person confirms or approves only once its way is clear, never in the same answer as a question or while that way is blocked.
- The card of a Connection draft says what it is: "Tools the agent drafted for the Gmail API · Not connected yet" ("Werkzeuge, die der Agent für die Gmail-API entworfen hat · Noch nicht verbunden"), with the number of reading tools, in place of "Tools for Gmail · Draft · 2 tools, reading". A title that already ends in API gets no second one, and a long title wraps.
- **Rights:** Applying a release's removal of a right from a built-in role takes away only the role's allow on the instance; a deny a superadmin wrote on purpose stays.
- **Rights:** A role's page holds back "Reset to default" and a release's Add or Remove where the server would refuse them, and names the missing right or says only a superadmin may make the change.
- From 768 px up, a conversation with no surface beside it scrolls to the very top of the window again. The chat header is no longer a solid band there: the agent picker floats over the thread on a light fade, as it did before the phone-width fixes. At phone width, beside a surface and outside a conversation the header keeps its band. At rest the first message still starts below the picker.
- A tool call with a long input, such as a long command, keeps its row inside the thread. Its title ("Run command") stays on one line, and the preview of the input takes the rest of the row and ends in an ellipsis instead of running past the thread to the window's edge. Opened, the call still shows the whole command.
- An App or a Page opened from the chat dock beside another page, such as a Workflow or the Agents, loads again. Its surface stood outside the interface's page host, so nothing answered the kit's `ready` and after 10 seconds the App said "The interface did not answer." It is now told who looks at it, as it is beside a conversation.
- **Deployment kit:** The deployment image builds again: the `runner-system` stage of `deployment.Dockerfile` now stands before the `api` and `artifact-preview-worker` stages that copy from it, which BuildKit refused since 0.8.0-rc.5. A test of the kit fails when a Dockerfile names a stage defined later; `CATALYST_DOCKER_CHECK=1` adds `docker buildx build --check`.
- **Tooling:** The browser test of config assets takes the Connection writers' turn, since the agent page reads every Connection: a Connection another spec deleted meanwhile no longer fails it with a 404.
- **Chat:** A steered message kept its `steered` metadata when the client read it through the API, so it no longer showed a second time once its run completed or after a reload, where the thread broke on the repeated message id. The message metadata schema of a user message gains the optional `steered` object (`runId`, `followUpId`, `authorUserId`, `typedAt`).
- **API contract package:** `operationAreas` is typed as a record of areas instead of its inferred type, which repeated every operation's type in the published declarations. The package's tarball is back under its size limit; its declarations shrink from about 3 MB to 1.7 MB.

### Database

- **Apps:** Migration `0138_draft_host_allowances` adds the table `draft_host_allowances`: one row per person, App or Page, and outside host allowed for that person's preview of a draft. Its rows go with their App, Page or person. Apply it before starting the new API. It preserves compatibility with the previous release and moves no data. Rolling back the application leaves the table unread; remove it only through a later committed migration.
- Migration `0137_user_follow_up_mode` adds `product_users.follow_up_mode` (text, not null, default `queue`). The constant default adds the column without a rewrite; the migration waits at most 5 seconds for its lock. Migration `0139_user_follow_up_mode_steer` then makes Steer the default. Apply both before starting the new API. The previous release ignores the column, so a rollback keeps it and every person sends with Queue until the next upgrade.
- Migration `0139_user_follow_up_mode_steer` sets the default of `product_users.follow_up_mode` to `steer` and moves every row that holds `queue` to `steer`. No release carries `0137_user_follow_up_mode`, so no person has chosen Queue yet. The update touches one row per person and waits at most 5 seconds for its lock. A rollback keeps the column and its rows; the previous release ignores them.

## 0.8.0-rc.6 — 2026-10-21

### Changed

- **Tooling:** The hosted Check gives `static` and each unit test shard 14 minutes instead of 9; a release run, which adds the scale tests, hit the old limit without a failing test.

### Fixed

- The deployment image Dockerfile defines `runner-system` before the `api` and `artifact-preview-worker` stages that copy its package manifest, so deployment image builds no longer fail with "cannot copy from stage".

## 0.8.0-rc.5 — 2026-10-21

### Added

- `catalyst docs` and `GET /api/v1/context/docs` read the instance's stored release documentation; `catalyst context` prints an update notice when its CLI version is older than the instance names.
- Changed: `instanceActions` is narrowed by the credential's callable operations; unknown CLI commands exit 2 even with `--help`.
- `catalyst keys --help` and `catalyst instance --help` show the named commands, and a kind's id such as `data_store` is accepted for help.
- `catalyst skill pull` writes a skill folder with checked hashes and preserves local edits; `catalyst init` binds a working copy and writes agent guidance.
- Add the explicit local `test:agent-stories --stories S2,S5,S14` command, isolated from deterministic test discovery, for partial real-model App persistence, Workflow safe-test and live skill consent journeys. Reports distinguish case results from unautomated story clauses and use private, minimized evidence with owned-stack cleanup and trial usage ceilings.

- Make cold-stack private-directory setup idempotent and include all-call token/cost deltas and elapsed time in each case report. Startup failures identify the last controlled process phase without retaining service logs.

- Exercise cold startup against the committed commented Postgres pin and seed adapter, preserve shipped setup rights, keep Playwright artifacts separate from stack metadata, and retain accounting when a case reaches its deadline. Deterministic probes catch each startup boundary without model access.

- Read generated assets in their owning scope and representation, test the active Workflow draft, and delete fixtures through the owner’s confirmed lifecycle before warm reuse. Cleanup failures retain the primary case evidence.

- Follow required App sharing review in the normal Inbox, isolate Workflow names across retained revision history, recognize the normal demo’s idle maintenance schedules, and keep warm-start accounting separate from inherited spend.
- Roles are data (ADR-0028). `user` and `admin` hold their release default until a superadmin edits them with `roles.update`; from the first edit their grants are rows, and an edit changes what every holder may do on their next call. `roles.reset` puts either back to the release's default. `superadmin` is the floor: it holds every action of the release except `assets.release`, and `roles.update`, `roles.reset` and `roles.delete` refuse it with `holder_not_administrable`.
- Custom roles: `roles.create`, `roles.update` and `roles.delete` under `/api/v1/instance/access/roles`, for a holder of `users.manage` who holds every right the role gives. A role's grant is any action except `assets.release` on the whole instance, or on one Shared Workspace or one asset where a person's grant can be, and `app.use` on one App or on the Apps of one Shared Workspace, which a person holds through membership. A role holds at most 500 grants. A custom role takes no built-in role's name (`role_name_taken`) and is deleted only once nobody holds it (`role_in_use`). `users.create` and `users.update` refuse a role the instance does not have with `unknown_role`. Taking away a role that denies gives back what it denied, so it asks the caller to hold those rights, and nobody takes such a role from themselves (`holder_not_administrable`). Saving a user's profile on Instance > Users keeps the custom roles they hold.
- Only a superadmin edits, resets or decides for `user` and `admin`, and gives or takes, in any role or by assigning one, a right of `SUPERADMIN_GRANTED_ACTIONS` (`api_access.manage`, `agent_models.manage`). A refusal ends the Operation Run `denied`.
- A release that changes the default of a role a superadmin edited leaves the role as it is: each added or removed action waits in `pendingActions` until a superadmin decides it with `roles.pending.decide` (`apply` or `dismiss`). An unedited role takes the new default. The migration step records each change as `role.reconciled`.
- Every role write is an audit event (`role.created`, `role.updated`, `role.reset`, `role.deleted`, `role.pending_decided`) with the grants added and removed. `permissions.effective` names the role of an entry held through one (`roleId`).
- Connection pages explain accepted REST calls and MCP inputs, offer per-operation switches and editable names and descriptions, and list readable published Apps, Workflows and Knowledge Bases alongside agents. The create dialog asks for a description. Connection list rows show runtime health.
- **Workflows:** Workflow `agent` steps now execute as durable Child Agent Runs named `workflow.<workflow>.<step>`, under the run's acting principal, with the Workflow's tools and the instance's default model; an agent asset of the same name is never consulted. JSON output is validated, with one repair turn that may call no tools; a second-check failure names the field. A confirmation fails the step with `confirmation_unattended`, naming the operation; an approval pauses and resumes the same run. Cancelling the Workflow run cancels its step's Agent Run. A step's agent is never offered `run_agent`, and a Workflow with an agent step whose tools start subagents is refused at save. Model usage of a published run is attributed to `workflow_step` and its Workflow Run.

- **Workflows:** Draft tests belong to the tester, intersect the tester's and principal's rights, name the bounding principal in each Operation Run's origin (for a Workflow that runs as its own account, the rights its definition needs bound the test), count model usage to the tester, and simulate changing calls through the existing draft policy. A draft test whose agent calls a `confirm` operation fails as the published run would.

- **Workflows:** The step panel shows instructions, tools and usage and, for holders of `workflow.read_run_data`, the validated output and the transcript, which it loads on open from the new `workflows.get_step_transcript` (`GET /api/v1/workflow-runs/:runId/steps/:stepRunId/transcript`), bounded to 100 messages with long texts cut. `workflows.list_step_runs` carries no transcript. Run and step result previews in Workflows containing agent steps require that right too, including values forwarded into later steps; App starters retain access to their explicit result. Workflow run threads are unavailable on conversation routes, and their data follows Workflow run-data retention.
- HTTP API Connections can set `settings.personContextHeader`. An administrator maps each person and service principal on the Connection page. Every outgoing call sends that acting identity's value; an absent, revoked, or origin/header-mismatched mapping fails before dispatch with `person_context_unmapped: the acting identity has no person context on this Connection`. Workflow publication checks each definition's own principal, including children. The setting is off by default.
- Expand `connection_bindings` to store token-free person-context rows, with a scheme/secret constraint and a separate validation migration. Run committed migrations before starting new app and worker processes. Previous releases can drain on the expanded schema; rolling back the application does not undo mappings or preserve person-context enforcement. Disable calls to a scoped Connection before rolling back to code that does not enforce it. Do not reverse the nullable-secret schema while mapping rows exist.
- **Give to an agent** (German: **Einem Agenten geben**) gives a Connection's approved tools to one agent in one step: after approving operations for agents in the New connection dialog or on the Connection's page, and on a card in a conversation. It lists only the instance's agents the person may change and publish, names the agent and the tools before anything changes, and the confirmation publishes the agent as one revision with them added, through the agent's own save and publish, with their rights, approval policy and audit. An agent with another person's unpublished draft is refused with that person's name and is not written; the person's own draft takes the tools and is published only where they tick **Publish the whole draft now**. The agent of the conversation can call the tools from the next message.
- The platform tool `platform.connections.offer_to_agent` (module `connections`) shows that card. It reads and changes nothing itself and is offered to platform agents with `platform.connections.draft_tools`.
- `http_api` operations accept query parameters declared as arrays of scalar items,
  sent as repeated keys in input order. Each array accepts at most 32 values;
  objects and nested arrays are refused before sending. Save and draft validation
  reject non-scalar item schemas.
- **Connections:** Document-source Connections share configured concurrency and rate limits across syncs and enforce the source folder boundary when fetching files.
- The demo sample accounting server also serves authenticated REST arrays in Enterprise and Gateway shapes, from the same deterministic ledger as MCP. It includes page/offset paging, fixed profile scopes, health, optional fault injection and a shared volume divisor that keeps one large client at 100,000 bookings per month. The demo release config declares `sample-accounting-rest`; the seed grants its use to active demo users and `workflow-demo`. Automatic paging remains with EW-13p; array query declarations follow CS-5e. No migration or deployment change.
- Workflow dataset producers, streaming storage, dataset loops and child contracts, with access checks and retention.

- Refuse foreign dataset references in free-form Workflow outputs and operation dataset replays; a child hands its parent only datasets it can read. Changed pending retries fail with `dataset_retry_changed`. Dataset cleanup removes reader holds and empty per-run byte counters.
- Workflow result datasets can be downloaded as streamed JSON Lines or CSV by the run starter or a holder of `workflow.read_run_data`. Downloads and loads audit ids, counts and sizes without rows.
- Data Store queries with a Workflow `dataset` destination read the full cursor into dataset parts. Ordinary queries retain their inline result caps. `dataStores.queryTimeoutMs` sets the whole-cursor deadline (10 minutes by default).
- Data Store loads use the instance's authorized dataset reader and record one result per step run in the platform-owned `catalyst.loads` table, atomically with their rows. Existing stores create this additive internal table at first load; no platform migration or rollback data movement is required. Store migrations still refuse the reserved `catalyst` schema.
- Operators may set `dataStores.load.rows`, `.bytes` and `.timeoutMs` (defaults 100,000 rows, 64 MiB and 10 minutes). A call beyond the row or byte ceiling is refused with `load_too_large`; produce smaller datasets for separate calls or raise the operator ceiling. Rolling back removes these settings from release config first; the internal table may remain.
- **Workflows:** Reading operation steps page into datasets with `paginate`, using the accepted Connection's page, offset, cursor or next-link settings. One Operation Run stores counts only; complete pages checkpoint their continuation for crash recovery. Rights are rechecked per page and next links stay on the checked origin and base path. Source rate limits defer without spending an attempt; transient pages get three attempts, with spent attempts kept across source deferrals. Operator ceilings `workflows.datasets.pageBytes` (8 MiB), `pages` (10,000) and `workflows.limits.pagedStepMinutes` (60) are adjustable; a Workflow may set `limits.pagedStepMinutes` within that ceiling. A ceiling fails the step with `dataset_limit` and its name; no partial dataset reaches a consumer. Paging requires a reading operation with declared paging and `dataset.at`. No migration. Rollback: remove paging settings and drain paged runs before starting older workers, which refuse these settings and cannot resume paged datasets safely.

- **Paging recovery:** The minute sweep observes the paged step's deadline and checkpoint progress, including planned backoff and source deferrals. Transient page failures wait the step's exponential backoff. Slot queue time does not consume `pagedStepMinutes`. A changed page replaces only its uncommitted reservation; `dataset_retry_changed` still protects replay of nonpaged streams and already committed parts. A repeated cursor fails with `paging_repeated_cursor`. Disabling a Connection stops with `connection_disabled`, and removed exposure refuses the next page without retries. Relative next-links resolve against the current page, including after worker recovery, under the same host and base-path checks.
- A Workflow `code` step reads and writes datasets (EW-14a). A dataset in its input reaches
  the script as a read-only file of JSON Lines, named in the input as
  `{ "path": "/work/in/<field>.jsonl", "rowCount": n }`. The script writes a dataset as a file
  directly in `/work/out/` and names it in its result as `{ "path": "/work/out/<name>.jsonl" }`;
  the command worker stores it, checking every line against the row schema, and a line that
  does not fit fails the step with its line number and no content. The container keeps no
  network. The worker opens only a regular file directly in `/work/out`, without following a
  link, and stops at the bound while it reads: a link, a pipe, a folder, a nested path or a
  name that leaves the directory fails the step (`code_dataset_file_invalid`,
  `code_dataset_path_invalid`). The input files and what a script writes to `/work/out` are
  bounded together by the new release setting `workflows.codeSteps.diskBytes`, 2 GiB unless
  set (`code_disk_limit`); a dataset the input names twice is written once. The
  code step reads only datasets its run may read, checked when the step is staged and again
  by the worker. A dataset into an `agent` step stays refused (EW-14b).
- **Scheduled prompts:** Scheduled prompts now save a prompt, an available agent and an IANA-zone schedule under Scheduled / Geplant. They run on the shared executor as their owner with current access and private result conversations, and their usage counts against the owner like a chat run. A start runs at most every 15 minutes; a more frequent schedule is refused. Owners can create, edit, run now, pause, resume and delete starts. Deactivating a person pauses their starts at once; instance admins can list, hand over or delete a deactivated owner's starts. Agent scheduling tools ask for confirmation. Unattended confirmations wait in the owner's Inbox and skip overlapping ticks.
- **Workflows:** Workflows can continue a long loop into a new history with `continueAsNew: { position: offset }`. A successor starts on the then-published revision with the next position as input; histories keep their key, labels and failure policy and appear as one expandable run with numbered parts. Input incompatible with a republished revision records a failed successor naming the field. Dataset views and waits transfer without copying rows or double-counting work.

- **Deployment:** Deploy migrations 0116–0118 before starting app or workers. 0116 adds nullable continuation/checkpoint/label columns and expands the run status check; 0117 validates the status check in a separate transaction; 0118 builds the replacement key and parent-step indexes concurrently before dropping the old guards. A cancelled index build is rebuilt on the next migration run. Stable v0.6.3 predates Workflows; earlier release candidates cannot read `continued`. Rollback after a continuation requires a release that understands this status and the successor relationship; do not restart an older Workflow engine against active chains.

- **Continuation safety:** Reserve nested iterations before admitting concurrent items and drain to a quiet frontier. Cancel by any part stops the live Lauf, including a cancel queued during handoff. Repeated cursors fail with `continuation_no_progress`; draft test runs keep their original revision and labels.

- **Continuation budget edges:** Item admission reserves the non-loop tail at every enclosing level so completed loop work keeps its output and does not end at `step_limit`. Publishing and draft tests refuse budgets smaller than the prefix, loop containers, one item and tail: `The loop '<id>' needs at least <count> step runs for steps before the loop, one item and the tail, above limits.stepRuns of <budget>`.

- **Continuation publish guards:** Until EW-CAN-RESUME carries a resume position and finished outputs, publishing and draft tests refuse an earlier changing step (`Step '<id>' cannot precede continueAsNew loop '<loop>'`) or a later loop at the same or an enclosing level (`Loop '<id>' cannot follow continueAsNew loop '<loop>'`). Refusals include English and German rules. Existing saved drafts stay editable; they must meet these rules before publishing or testing. No migration change; an older release lacks these guards.

- **Continuation runtime:** A child successor inherits dataset access from its predecessor, restricted to its own chain and datasets handed down by its parent. An opening refusal records `continuation_invalid` without retrying a completed write. Loop output counts (`total`, `done`, `failed`) cover the whole Lauf, including child and cursor-page chains. Checkpoint counts use the existing JSON column; migrations are unchanged.

- **Continuation tail reservation:** Oversized items and nested plain loops checkpoint before consuming the enclosing tails, including an item that exactly fills a fresh history. Migrations remain 0116–0118.

- **Continuation failure reporting:** Failed-item rollups include preceding parts so the grouped Lauf and latest-run badges retain earlier failures even when older pages are not loaded. Parent and notice counts count the final part once. Successor opening errors name their AppError code unless dataset access was refused.

- **Continuation ancestor concurrency:** Publishing and draft tests also refuse `concurrency` above 1 on any loop enclosing a continuing loop: `Loop '<outer>' cannot use concurrency above 1 while enclosing continueAsNew loop '<inner>': a continuation checkpoint cannot record unfinished sibling items. / Schleife '<outer>' darf keine concurrency über 1 verwenden, wenn sie die continueAsNew-Schleife '<inner>' umschließt: Ein Fortsetzungspunkt kann den Fortschritt noch laufender Geschwisterelemente nicht speichern.` Concurrency on the continuing loop itself remains allowed. No migration change; rollback to an older release removes this guard and can skip or repeat outer items.
- A Workflow sets the bounds of its runs with `limits` in `workflow.yaml` (`duration`, `stepRuns`, `loopItems`, `concurrency`) under the operator's ceilings in `workflows.limits` (by default 7 days, 1,000,000 step runs, 1,000,000 loop items; the concurrency ceiling is `workflows.stepSlots`). A raise is named in the publish question on the canvas; a value above its ceiling is refused with `limit_above_ceiling`, naming the ceiling. `datasetBytes` and `pagedStepMinutes` are read and refused above their defaults with `not_supported_yet`.
- A Workflow that sets `limits.concurrency` holds at most that many step slots across its runs and their child runs, held at claim so two workers do not overshoot it. Without it a Workflow may use every step slot (`workflows.stepSlots`), as before.
- Time a run spends waiting, for an operation whose work ends later or for a waiting child, counts toward no limit: the deadline moves later by the time waited. The `timeout` of an operation step is no longer capped by the run time and accepts days (`3d`).
- **Workflows:** Workflows may declare `packages: [pypdf]` in `workflow.yaml`. Publishing checks the runner image's build-generated installed-package manifest and refuses an unknown name with `Workflow package '<name>' is not available in the runner image`. The shipped authoring skill lists names and versions. No package-count cap or import enforcement is added; publishing and running install nothing and the sandbox stays without network.

- **Workflows:** A missing or invalid manifest keeps startup running with an empty allow-list and an Infrastructure notice; every declared package is then refused at publish. Release API images carry the manifest from their runner stage at `/usr/local/share/catalyst/runner-packages.json`. Deploy API and runner images together. An older image without the manifest cannot publish declarations; existing workflows without declarations keep working. Rolling back to an engine predating `packages` refuses manifests that declare it until the field is removed. No database migration.
- A field of a step's input that takes a string also takes text joined from parts (EW-TEXT): `{ text: ["Prüfergebnis ", { ref: { step: monat, path: label } }] }`, beside `{ value }` and `{ ref }`. A referenced part is a string, a number or a yes-or-no value, and `null` joins as empty text. A run label and a child's run key still take a literal or a reference only.
- Save and publish check each part like a reference: a part that names no step, a later step or an undeclared field is refused, and so is a part that references an object, a list outside a Markdown field or a dataset. A refusal (`text_part_invalid`) names the step, the field and the part.
- In a field whose schema has `format: markdown`, such as the body of `mail.send`, every referenced value is escaped as Markdown text, a referenced list of strings joins as a bulleted list and a list of flat records as a table in the order of its row schema, at most 100 rows and 8 columns. A longer list, a wider record, a record that is not flat and a dataset fail the step with `input_invalid`, as does a joined text longer than the field's `maxLength`. No message holds a value.
- The Workflow authoring skill describes the `text` form, and the step panel counts a part's reference among the step's sources.
- KB-ISO-2: `defineClientInstance({ knowledgeWorker: "separate" })` and `runKnowledgeWorker()` move Knowledge Base ingestion out of the API, with independent platform and Data Store pools. The default remains `in_process`. A worker started with that default refuses with `The knowledge worker requires knowledgeWorker: "separate" in defineClientInstance`. Search, operations and retries remain in the API; an absent worker leaves ingestion queued and its page reports that it is waiting.
- Demo and Musterbau assemblies include the knowledge-worker entry, resource-limited Compose services, a six-connection worker pool default (`KNOWLEDGE_WORKER_POOL_SIZE`), and a Compose gate. Document workers in the paired capabilities release select `DOCUMENT_WORKER_ROLE=chat|knowledge|all` (default `all`); dedicated knowledge extraction serves two conversions apart from chat uploads. The release smoke waits for a fresh index-worker report when the knowledge module is on.
- Release order: publish core and paired capabilities together, then bump the deployment to that release before activating its new wiring. This does not enable a module. Rollback requires restoring both placement and services together: reverting only the worker service while keeping `separate` leaves ingestion queued. Staging CPU overrides are 0.5 each; production defaults require the release owner to verify the live server size before deployment.

- Rollout fixes: the remote deploy uses only Ubuntu base utilities and Docker to discover knowledge services and their entrypoint, with a no-`jq` host fixture. Readiness tests require a post-rollout heartbeat; both successful and failed syncs wake a waiting Workflow step once.

- Service discovery captures Compose output once before matching optional workers, so SIGPIPE cannot skip their replacement or readiness checks under `pipefail`. A repeated streaming-Docker fixture covers the regression.

- Rebase integration: source-boundary reconciliation joins the central ingestion registry, so the API cannot claim it when a separate knowledge worker owns ingestion.
- **Knowledge Bases:** A PDF or DOCX of more than `knowledge.maxPagesPerDocument` pages (release config, 500 by default, at most 5,000) fails with the new code `knowledge_file_too_many_pages` instead of being converted. The extract job passes the limit to the extractor, which counts the pages before it reads their text; core also refuses an extraction that answers more pages than the limit. The Documents section says "More than 500 pages" ("Mehr als 500 Seiten") and offers Retry, which extracts the file again once the limit is raised. The limit applies to Knowledge Base extraction only; chat uploads keep their own limits. `KnowledgeExtractor.extract` and `defineKnowledgeExtractHandler` now take `maxPages`.
- Freeze the Knowledge Base write contracts for data Workflows: ingestion and withdrawal, pending documents, processor write-back and field extraction; batch descriptors and per-item failure datasets; Workflow `process`/`data` kind (default `process`). These contracts add no executable operations. `fetch` is refused with `not_supported_yet` until CONN-DL. `records` in `kb.yaml` is refused with a pointer to `store.yaml`.
- Owned Knowledge Base stores advance to `catalyst_kb` migration 6 (`workflow_sources`), after SRC-3a's migration 5: connector cursors retain their data and gain a kind; Workflow sources reserve `workflow:<workflowId>`. No platform migration. Older releases can read the existing connector rows; they cannot operate Workflow-fed sources once those are introduced by KBW-1.
- Ingestion and materialized processor text reuse the existing 25 MiB per-document file limit; names, paths and origin links follow the connector bounds (1,000 characters for names, 4,000 for absolute paths and HTTP(S) links). Processor write-back takes page text only as a dataset reference, as pending does. Page count is enforced at runtime by `knowledge.maxPagesPerDocument` (KB-ISO-3a); the schema adds no fixed count. Omitted Workflow kind stays absent in the parsed manifest to preserve revision fingerprints; lists present it as `process`.
- **Workflows:** Workflows may omit `runAs`. Publishing creates a hidden, Workflow-owned technical account with only the named assets' use rights derived from its steps. Every right must be transferable by the publisher, on an asset the publisher may read (`not_visible`), of a kind whose module is on. Each publish reconciles those grants, and draft tests use the derived rights as their ceiling. Explicit shared accounts keep their existing checks. Unpublishing removes the owned account and its rights while preserving the draft.

- **Withdrawal:** `workflows.unpublish` preserves the draft and run datasets, removes its owned account and grants, stops schedules, and records `workflow.unpublished`. An explicit `runAs` cannot borrow another asset's owned account (`run_as_owned`).
- **Rollback:** Before reverting to a release that requires `runAs`, replace omitted `runAs` definitions with explicitly administered shared accounts and republish them. Older releases reject the new definitions; their owned accounts and grants otherwise remain.

- **Connection cleanup:** A CLI sync deletion now runs the existing transactional cleanup, revoking person contexts and ending its sign-in just as an interactive deletion does.
- Feedback on agent answers, in the module `feedback`, which is off unless release config turns it on (`modules.feedback.enabled: true`). A finished answer carries **Feedback** beside copy: a written comment, with a box, ticked when the field opens, that sends the question and this one answer along for the reviewer. `feedback.exchangeSnapshot: false` removes the box. The author reads under the answer whether the comment was sent or handled, and changes or withdraws it until it is handled.
- The right `feedback.review`, for the instance or a workspace, which instance administrators hold for the instance. Its holders get each comment on the agents it covers as an Inbox item of kind `feedback_review`, with the agent and its revision, the author, the date and the exchange where it was sent along. They mark it handled with an optional note, open the agent in Studio, and filter the Inbox by agent. The operations `feedback.send`, `feedback.update`, `feedback.withdraw`, `feedback.list_own`, `feedback.list`, `feedback.get`, `feedback.mark_handled` and `feedback.annotate` reach the same through the API, the CLI and MCP.
- The audit events `feedback.received`, `feedback.handled` and `feedback.pruned`, which carry ids and counts, never the comment. A comment is kept for `retention.feedbackDays` (365 by default) and then removed with its Inbox item by the daily job `feedback.prune`; deleting an account removes the comments it wrote.
- Freeze the contract of `mail.send` (MAIL-0): its input (`sender`, `to`, `cc`, `bcc`, `subject`, `body` as Markdown, `senderName`, `replyTo`, `locale`), its output (counts and the provider's message id, no address), the simulated answer with the mail's `preview`, the refusal codes `recipient_not_allowed`, `no_recipient` and `mail_rejected`, and the params of the template `workflow-message`. This registers no operation, sender or template; MAIL-1 does, and only while outbound mail is on.
- `infrastructure.mail.outbound` in release config: `enabled` (default `false`), `recipientDomains` (lowercase domains, `*.domain` for subdomains, `*` alone for every address; default none outside the instance), `limits` (`perWorkflowPerHour` 200, `perInstancePerDay` 1000) and an optional plain-text `footer` per language. Nothing reads it yet.
- The right `mail_sender.use` and the resource kind `mail_sender`. The `admin` and `superadmin` roles hold the right by default; members do not. A service principal may be given it once MAIL-1 registers the kind; until then the grant is refused with `action_not_grantable_to_principal`. It has no grant scope for people yet.
- The audit events `mail.sent` and `mail.refused` in the registry, with counts and domains only; nothing emits them yet.
- The `text` value form (`{ text: [...] }`) and its Markdown limits as types, the step-facts source kind `mail_sender` and the mail sender's facts. `workflowInputValueSchema` does not take the `text` form until EW-TEXT.
- `mail.send` sends one e-mail from a Workflow's `operation` step or an agent's tool call, as the instance's system sender (`infrastructure.mail.sender`, with the step's `senderName` on the From line). It exists only where `infrastructure.mail.outbound.enabled` is true; elsewhere a step on it is refused at save with `operation_not_found`, and no agent is offered it.
- Recipients are addresses, people (`{ user }`) and Shared Workspaces (`{ workspace }`), in `to`, `cc` and `bcc`, at most 50 addresses once expanded, with an optional `replyTo`. A person's address is always accepted; any other address only in a domain of `outbound.recipientDomains` (`*.x` for its subdomains, `*` for all). A literal address outside the rule is refused at save and at publish, a referenced one fails the step with `recipient_not_allowed` naming the domain and sends to nobody, and a mail with nobody in `to` fails with `no_recipient`.
- The body is Markdown rendered on the server into an HTML and a text part in the template `workflow-message`, in German and English: the instance's name and embedded logo, its accent colour, a footer naming the Workflow or the person an agent acted for, and the operator's `outbound.footer`. Raw HTML is shown as text, images are dropped, links keep only `https`, `http` and `mailto` targets, and the HTML loads nothing from a host.
- The Mailjet and capture adapters carry several recipients, cc, bcc, Reply-To, the From name and the inline logo; the captured-mail list shows them (`from`, `recipients`, `replyTo`, `inlineImages`). A provider refusal fails the step with `mail_rejected` and the provider's code, a connection that was never made is tried again by the step, and a lost answer fails it with `operation_interrupted` without a second mail.
- The right `mail_sender.use` is granted on the sender `system` alone, never at instance scope; admins hold it by role. A member without it is not offered `mail.send` in chat, and a Workflow with a `mail.send` step is published only once its account holds it, which the publish screen gives.
- A test run answers the mail as it would go out (`preview`) and sends nothing. The events `mail.sent` and `mail.refused` carry counts, domains, the outcome and the reason, never an address, a subject or a body. The Workflow authoring skill says when to use `notify` and when `mail.send`, and the demo client captures outbound mail to `example.test` and its people.
- "Run live once" on a `mail.send` step of a test run (MAIL-2) sends one mail to the tester alone: "[Test]" before the subject, the recipients it would have reached in a box above the body, no Reply-To. Its Operation Run and `mail.sent` have target `test`. Every other test run still simulates the mail, and a referenced address outside `recipientDomains` fails the test step as it would live.
- `outbound.limits` hold: `perWorkflowPerHour` counts the mails of a Workflow's runs and their child runs, `perInstancePerDay` those of the instance, across worker processes. A step over a limit waits queued until the window has room, and spends no attempt; a run whose deadline comes first ends with `duration_limit`. An agent's mail over a limit is answered `RATE_LIMITED` with `reason: "rate_limited"` and `retryAfterSeconds`. Test sends are not counted.
- Guardrails at `operation.before_call` read a mail as `{ subject, body, attachmentNames, recipientDomains }`, the body as the call resolved it and no address, so a pattern for e-mail addresses does not fire on every mail and a pattern on a domain stops mail to it.
- An agent's `mail.send` waits for its person with the mail as it will go out: the confirmation card shows the sender, the recipients, the subject and the rendered body as text. A pending confirmation carries the operation's own `simulation` beside its input (`simulation` in the run projection and the API's decision), and a call the simulation refuses fails before anyone is asked.
- A `{ workspace }` recipient must be a Shared Workspace its author may see: a member, or an instance admin. The author is who saves, publishes or tests the Workflow, or for whom the agent calls; a published run's author is the person who published its revision. It is checked at save, at publish and at run, a refusal is `workspace_not_allowed` and names no member, and a test preview reads no member of such a workspace. A Personal Workspace, or one that does not exist, is now refused where MAIL-1 skipped it.
- The publish question says whom each `mail.send` step mails and as which sender ("e-mails Anna Berg and the workspace “Team” as “Kanzlei” <noreply@…>"), and once that an address outside the instance holds no data scope.
- A Markdown field mapped as one plain reference, such as a mail's body from an agent's answer or a child Workflow's text, keeps the value's Markdown (emphasis, lists, tables), but each of its links shows its address after its label, `label (<https://…>)`, with the host in ASCII. A reference-style link is shown alike, an image is left out, and raw HTML stays text in the mail. A body the author typed keeps its links; a text joined from parts still escapes its referenced values.
- **Notices:** The platform can leave a notice for people of the instance (NOTIFY-a), the port a Workflow's `notify` step will call (NOTIFY-b). `createNotices(...).send({ from, to, title, text, link, channels })` reaches the active users and the members of the Shared Workspaces it names, each once, and counts the people named who are not active; no address is taken from the caller. An id that names no user or no Shared Workspace of the instance refuses the whole notice and is named in the refusal (`VALIDATION_FAILED`, `details.unknownRecipients`), and a notice that would reach no active person is refused (`CONFLICT`, `details.reason: no_active_recipient`), so no notice is lost without a word. Each person gets an Inbox item of the new kind `notice` that only they see, count and answer: its title, one paragraph, a link to a Workflow run or an App, and "Mark handled" ("Als erledigt markieren"). Not even its sender sees it. With `mail` they also get the new `workflow-notice` mail, which links to their item and holds no word of the title or the text, so nothing the author wrote leaves the instance by mail. The audit event `notice.sent` holds counts only: addressees, people named who are not active, mails sent and unsent. No migration.

Handled notices show a neutral “Done” / “Erledigt” badge in the Inbox item and list.

- **Fixed:** A request addressed to a person is no longer in its requester's "My requests" (`GET /api/v1/approval-requests/mine`) or in their `mine` counts of `GET /api/v1/approval-requests/pending-count` unless they are the addressee. It is the addressee's alone, as reading it by id already was.
- **Workflows and notices:** Workflow `notify` steps deliver Inbox notices as the run's principal, resolving literal and
  reference title/text mappings. Test runs address only their tester. Each root run produces
  one failure notice for its revision's publisher, with a count of failed or limited runs.
  Publishing discloses each notify step's user and Shared Workspace recipient ids and channels.
  `onFailure: workflow.<id>` remains refused as `not_supported_yet`, naming EW-13.

- **Mail delivery:** Notice mail uses the existing typed mail adapter and a durable outbox. Digests carry only
  notice counts and an Inbox link; title, text, client names and findings remain inside the
  instance. `infrastructure.mail.notices.batchSize` defaults to 100 recipients per tick and
  `digestIntervalMs` to 300000; both are positive operator settings with no business cap. An interval outside the supported
  date range is refused as `digestIntervalMs must produce a valid delivery date`.
  Digests count only notices still waiting in the Inbox; handling them all suppresses the mail.
  Provider failures remain queued for a later tick; disabled recipients are suppressed.
  Delivery is at least once: a process crash after provider acceptance can repeat a digest.

- **Database:** Apply migration `0114_notice_mail` before API/worker startup. It adds outbox references,
  revision publisher attribution and root-notice deduplication without changing existing
  notice items. Existing revisions are attributed from retained publication audit events;
  where those events are gone, republish to establish the publisher. A missing migration is
  refused at startup as `The database is behind this release. Run the migration step before starting. Missing migrations: 0114_notice_mail`.
  Rollback leaves these additive tables in place; the previous release sends notice mail
  inline and does not drain this release's outbox. No provider or customer account is set up.
- **Document processing:** Knowledge Bases classify documents with `documentTypes` rules on path, name and MIME type, defaulting unmatched documents to `default`. Built-in `text` and `tables` processors share the frozen output validator and the instance page limit. Each type selects page, heading, sheet-row, section or whole-document chunking. JSON Schema files in CLI definitions are resolved locally and stored in the revision; fields outside the schema fail with `knowledge_processor_output_invalid`. Custom processors and `documentTypes[].workflow` are refused with guidance to use data Workflows; OCR remains unavailable until KB-9.

- **Document processing:** Owned-store migration **7, `document_processors`**, adds nullable type, processor `id@version` and processing fingerprint columns. No platform database migration. It runs through the existing owned-store upgrade path. Deploy core before the paired capabilities processor change. Rollback leaves additive columns in place; older workers can still read extraction pages but do not enforce typed processing, so drain older workers before confirming a processing change.

- **Document processing:** Publishing a changed type or processor revision first refuses with `knowledge_processing_confirmation_required`, stating the affected content count, local processing cost and estimated re-embedding cost. Review the statement and retry `assets.publish` with its `confirmProcessing` token, or `catalyst knowledge-base publish NAME --revision N --confirm TOKEN`. A stale token refuses the publish. After confirmation a durable job reprocesses only affected contents; released source originals are fetched again only when the processor changes. These reviews walk metadata in pages of 100 and cost O(contents + existing passage tokens), without loading document text.

- **Documentation:** Package guidance is in `packages/data-stores/knowledge-processors.md`.
- Extract declared Knowledge Base fields through the approved extraction model binding with JSON-schema output, exact page/quote evidence checks and counts for unsupported fields and failed evidence. Failed evidence remains in the frozen handoff for records review and is withheld from projection. The operation and its HTTP route use `knowledge_base.read`; values and document text are never retained in Operation Runs, audit, errors or logs.
- Add the optional per-Knowledge Base monthly extraction budget and per-document token budget, with atomic admission and “Fields pending” / “Felder ausstehend” while extraction waits. Documents remain searchable. Raise and publish the budget to allow the Workflow's next call; refusals say “Field extraction could not complete” with `knowledge_field_budget_reached` or `knowledge_field_token_budget_reached`.
- Owned Knowledge Base store migration 10 adds counters and pending markers (9 is reserved by SRC-3b); no core migration. Upgrade owned stores before calling the new operation. Rollback may leave the additive tables and column in place; never remove applied migration records. Only calls with unknown billed cost keep their conservative reservation. Reported costs settle even for invalid output, and a pre-call content change releases the reservation.

- Owned-store migration audit counts use the SQL migrations actually applied, preserving accurate counts when another lane reserves a migration number.

- Monthly-budget publish refuses an unpriced extraction binding, naming the binding and missing `usage.costs.customer.models` row; startup remains available. Token refusals retain their estimate and configured limit for distinct EN/DE recovery copy.

- Field evidence uses the instance content locale consistently in extraction and records, independent of caller language. Estimate input at ceil(UTF-8 bytes / 4) with the default 8000-token budget; accept joined or retained line-end hyphens and German/English month names with four-digit years.

- Reserve max(512, 64 × declared schema fields) output tokens before admission; input estimate plus reserve must fit the unchanged 8000-token default. Token refusal details and EN/DE pending copy name the estimate, output reserve and limit. A line-end hyphen never admits a partial word; inline hyphens remain word boundaries. Data-store migration jobs are opt-in in sync test fixtures.
- Publish reviews for Apps and Workflows lead with a plain sentence in the reader's language describing when they run, whose account they use, what they read, write and send, and who sees the stored data. Details retain the existing data, rights and revision review. The interface, interactive CLI and held publish Inbox item warn about steps that an active approval guardrail will stop.
- Publish warnings dry-evaluate the runtime policy and guardrails for operation and child Workflow steps, using each operation's resource workspace. They also name policy approvals, distinguish known pattern matches from conditional checks, and show one Details fold with locale-correct English and German copy.
- Runtime policy resolution (`packages/core/src/operation-policy.ts`) identifies an operation's minimum policy as `policy_floor` when it raises a central setting, so publish warnings name the policy that actually stops a step.
- Publish narration checks up to four steps concurrently under a shared three-second budget. Failed or unfinished input checks name steps that may stop; a failed summary leaves Details and publishing available in English and German. Published guardrails are read once per narration.
- Data Store row tools can update and delete rows by primary key from chat, with atomic refusal, confirmation, counts-only results and the existing call-key replay protection. Tables managed by published records rules direct corrections to records review.
- People can receive separate insert and change/delete row rights on one Data Store, a workspace's stores or the instance. Conversations about a published store offer its row tools to agents with platform tools; drafts store no rows until a person publishes them.
- Row-write confirmations share one summary and show the table with their inputs. Insert refusals respect the person's language, including the 1,000-row cap; row-write audits name their Operation Run, and size refusals describe writes for inserts and updates.
- The publish question of a Workflow lists the rights its technical accounts lack, for the Workflow and for each child it starts: Connections, Data Stores (including `data_store.execute` for a load that replaces or updates rows), Knowledge Bases, child Workflows and every other operation its steps and agent tools call. Each line says whether the publish needs it or only the run. An administrator who holds the rights gives them all in one confirmed step; each one goes through `permissions.grant` with every rule of that write and its `permission.granted` audit event. Anyone else is told who can give them. The new read `GET /api/v1/workflows/:workflow/principal-rights` (`workflows.principal_rights`) answers it to whoever may publish the Workflow, with ids only where the caller may give the right. A child Workflow the caller may not read is only counted (`hiddenWorkflows`), and an asset the caller may not read is given by its kind alone and offered to no one (`not_visible`).
- One derivation (`workflowNeededRights`) feeds both the screen and the publish check, so the refusal `child_use_forbidden` and the list cannot disagree. The refusal now names the child under `details.workflow`, and so does `no_parent_trigger`.
- A refused Workflow publish (`child_use_forbidden`, `no_parent_trigger`, `child_unpublished`, `workflow_cycle`, `run_as_*`, `user_only`, a right the publisher lacks) is said in plain English and German instead of the instance's English message.
- Giving a service principal a right on an asset now also needs the giver's read right on that asset (`<kind>.read`, decided with the workspace that owns it, as its own read is): `permissions.grant` refuses it with 403 and the reason `not_visible`, before the rule of no escalation, and the API access page and the publish question say so in English and German.
- **Data scope:** Declare one text data scope in release config and assign values or all values on Instance > Access. Scoped Data Store tables declare `tables.<table>.scope.<dimension>: <column>` and require a text `NOT NULL` column. Preview, rows, individual values and every SQL read filter by the caller's assignment. Administrators have no implicit assignment. The App host and row preview explain missing assignments. A person's revocations take precedence over group allowances. Nobody saves or lifts their own assignment, also through a group they belong to; a service account's assignment needs the right to administer service accounts. A sign-in replaces the person's stored groups with the ones it carries, so group assignments need an identity provider that sends groups.

- **Data scope:** Every SQL read of a scoped store is filtered where it runs: direct `query`, App SQL actions in drafts and published revisions, Knowledge Base named queries and Workflow steps. Each scoped table a statement names reads only the caller's rows, so `OR true` or a `UNION` branch cannot widen the result, and `WHERE` clauses, joins and aggregates work. `$viewer.scope('dimension')` and `$viewer.scope_all('dimension')` remain available as server-owned parameters; publishing no longer requires them. Refused on a scoped store: schema-qualified names of scoped tables, `U&"..."` identifiers, functions that read a table by name or run SQL from text, and `pg_stats`. A migration that leaves a partition, `INHERITS` parent or child, or view of a scoped table undeclared is refused. Free SQL on scoped Knowledge Base tables is refused with `Free SQL on scoped tables is refused. Use a published named query.` Inserts and loads refuse missing scope values; scoped mutations check old and new values. Known limits: `onConflict: "skip"` and `"fail"` reveal whether a unique key exists in another scope's rows; `describe` shows estimated row counts; functions defined by a store's migrations run unfiltered. Declare assignments before enabling scoped tables. Rolling back to an older application removes these guards and requires restricting the store's audience first.
- **App sharing:** Apps ask who may use a published revision: only the publishing person, its owning workspace, or the whole instance when the publisher has the instance publish right. The selected audience is stored in the existing availability and changes atomically with publication. Every publish by a person without `app.approve` is held by the default publish guardrail; its Inbox review names the audience and records `publish_widens` for GR-PUB-2. An audience-only change goes through the same publish path. Saving still asks nothing and offers Share beside the result.

- **CLI:** The CLI asks for the audience before its publish review. For unattended App publication, pass `--audience self|workspace|instance` with `--yes`; omitting it refuses with “Choose who may use the App with --audience self|workspace|instance. Nothing was published.” Existing published Apps keep their workspace audience. No database migration is required: a private audience selects the publishing person's existing personal workspace in availability. On rollback, the previous release does not enforce App availability; do not roll back while private published Apps exist.

- **Agent confirmation:** `assets.publish` offers an App publish through the existing operation path. The person chooses the audience and confirms before a guardrail approval or any publication. Omitted audiences on first publishes default to Only me; later publishes preserve the live audience. Reviews show allowed narrowing choices, audience counts, additional grant holders and instance admins. No migration is added.
- SRC-3a: synced sources apply change feeds, reconcile complete listings and withdraw documents with the existing purge job. Large full-pass withdrawals wait for publisher confirmation in the Inbox. Publishing a narrowed or removed source immediately excludes its documents from search. Runs and change cursors are pinned to their source boundary, so delayed confirmations and old cursors cannot apply to a changed definition.

The Knowledge Base owned-store migration is 5 (`source_withdrawal`), following 4 (`source_counts`); no platform-database migration is needed. Existing synced items remain searchable while their parent metadata is unknown (`parents: []`); include and exclude rules still apply. A complete pass learns their folder membership before folder narrowing can withdraw them. Connector items require at least one parent, so the empty list is reserved for unknown ancestry. Apply the owned-store upgrade before serving this release. Rollback keeps the added columns and triggers; it cannot restore purged documents, which must be fetched again from the source. Changing the Connection of an existing source id is refused with `knowledge_source_connection_changed`; remove it and add a new source id for a different Connection.
- **Agent dock:** Agent pages offer Build | Try (Bauen | Ausprobieren), a Preview mark, the running draft revision or published-version fallback, and revision separators between turns. Try keeps its own conversation and stays out of Recent and the address, including when the person leaves before a run is accepted. Publishing or discarding the draft opens a fresh Try conversation.
- **Agent Try:** Try runs a frozen snapshot of the agent's shared draft, or its published version when no draft exists. Each turn records the revision; usage belongs to the person trying and is tagged preview. Preview omits platform asset tools and skill change proposals. Reading calls use the person's rights and changing calls simulate what would have happened, with the draft provenance on the Operation Run and no Run live once, including Workflow test targets started from Try. Moving a Try conversation is refused with "A preview conversation stays with its agent". Rollback does not remove stored preview transcripts or usage.

- **Preview rollout:** Apply migrations, deploy the new Agent Run workers and fully drain the old workers before exposing the new Try API. Old workers cannot enforce preview isolation. An old queued Try turn without a valid snapshot now fails with "The preview snapshot is not available. Send the message again in Try." instead of running the published agent. Retry the turn in Try after upgrading.
- **UI:** Library parts for editing: change marks beside a step's status, insert points that `FlowCanvas` places on edges, exit rows and group ends (with a "Move here" mode), a panel footer and tall sheet, sourced values (grouped by step, or from a step only), named field lists with choices, and schedules with the time zone in words, with English and German labels and gallery examples.
- Workflows separate business processes from data flows. Knowledge Base and Data Store pages derive “Filled by” and “Processed by” links from published data flows; completed data runs that handled no items can be expanded from a folded row.
- Publishing a process Workflow with a Knowledge Base write or a records proposal refuses with `process_workflow_write_operation`: “Operation '<operation>' writes data. Set kind: data in workflow.yaml before publishing this Workflow.” Drafts remain editable.
- Apply migration `0113_workflow_empty_runs` before app and worker startup. It adds the empty-run marker with a false default; old releases remain compatible. Rollback leaves this additive column in place. Existing runs are left visible.
- Builder and Publisher in a workspace (WS-BUILD-1): one grant row each, action `builder` or `publisher` at workspace scope, written by an instance admin on Instance > Access ("Building in a workspace"). Builder reads and writes every kind the workspace owns, Publisher publishes it; neither deletes, and neither publishes a guardrail or a Workflow. A deny on one asset still wins. Instance admins hold both by role. Giving either is refused (`denied`, naming the action) to a giver denied any action the bundle carries on an asset the workspace owns, as giving that action directly is.
- A holder of either bundle who is no member of the Shared Workspace starts and continues private conversations of their own there and lists only those; a member's conversation answers `NOT_FOUND`. Only a granted row opens this, not the bundles an instance admin holds by role. Revoking the row ends it on the next call. In the web interface such a holder opens the address of an App draft of the workspace (`/w/<workspace>/app-drafts/<app>`); every other address of it still leads to their own workspace.
- Instance > Workspaces (`users.manage`) sets a Shared Workspace's build limits: the tools and model bindings the agents it owns may use, through `workspaces.limits.list` and `workspaces.limits.update`. Every save of such an agent is checked, an instance admin's included, and refused with `tool_not_allowed`, `model_not_allowed` or `model_binding_required` naming the workspace ("Tool 'x' is not allowed in workspace 'Kai Spezis'"). A Builder picks a listed model without `agent_models.manage`. Changes are recorded as `collaboration_workspace.updated`.
- The demo seed adds Fabian Wolf, Builder and Publisher in Nordlicht Beratung without membership.
- Workflow loops accept `batch: N` over a dataset. Each iteration receives a view of at most N
  rows under the parent dataset's permissions and lifetime, without copying its objects; the
  loop item limit counts iterations. Code steps and Data Store loads honor these views.
  An inline list with `batch` fails with `batch_requires_dataset` ("batch on a loop needs a
  dataset"). Batch operations return `done`, `failed` and a failures dataset; partial item
  failures leave the step done. Malformed aggregates fail with `batch_result_invalid`.
  Failure messages must name only a field and code, never item content. No migration is needed.
  Rollback: remove `batch` from definitions, drain runs carrying dataset views and expire
  their retained dataset results before returning to an older engine, which does not
  understand the optional reference `offset`.

- Code steps resolve their current dataset loop item or batch before staging the worker input.
  Start refuses in-schema dataset views outside the stored row range. Data Store loads check
  the byte size of part-aligned views before reading and retain their streaming byte bound.
- Freeze Data Store records rules, evidence and operation contracts (`records.propose`, `records.decide`, `records.flagged`), the `data_store.records` right, and the transaction-bound withdrawal outbox port. These contracts register no callable records handlers yet; merge/projection, decisions, withdrawal delivery and review arrive in REC-1a/1b/2.
- Provision platform-owned `catalyst.record_fields` provenance SQL in each Data Store. Document identity includes both Knowledge Base and document IDs, including uniqueness. No core or Knowledge Base owned-store migration is added.
- Publish table/key migrations and records rules together. Every migration checks the latest published records keys inside its own transaction, after its SQL and deferred triggers, coordinated with concurrent publishes by the store lock. A broken key rolls back the migration with `record_key_invalid`, naming `records.<table>.key.<column>` and saying `Nothing of it was applied.` Rules published while migrations are queued are checked against the schema they actually meet. Without pending migrations, invalid keys still refuse publish immediately.
- Records calls accept at most 1,000 proposal items per batch, 1,000 fields per item, and 10,000 flagged fields per page. Split larger proposals into batches and follow `nextCursor` for further flagged pages; these bounds do not limit stored capacity. Export `RecordColumn` for `itemSchemaFor` consumers.
- Rollback: remove the records block before running a release whose strict manifest schema predates it; the unused provenance table can remain. A refused migration leaves its schema and signed ledger unchanged; correct the pending migration and republish.
- Data Store records proposals merge document evidence by published precedence and document date, keep unresolved keys and conflicts for review, and project winning values through the atomic load SQL with the same table constraints and size ceilings. Proposal values and quotes stay out of errors, logs and audit. Store provenance lists records Workflows and their readable Knowledge Bases.
- Owned-store migration 8 creates missing pre-REC-0 provenance tables and adds `catalyst.record_fields.content_sha256` with `ADD COLUMN IF NOT EXISTS`; customer stores receive the same additive setup before their first proposal. No platform migration is required. Rolling back leaves the nullable hash column and existing candidates in place; the older release has no proposal handler.

- `records.propose` runs only as a step of a Workflow Run, which owns its failures dataset. Direct chat, App and CLI calls are refused before store work with `workflow_dataset_owner_required`: "`records.propose` runs only as a step of a Workflow Run." The operation is not offered as an agent tool.

### Changed

- **Tooling:** Limit affected-test package-path detection to test sources and keep quality-baseline-only edits scoped to tests that read the baseline. Keep the browser source scan selected for changes to every package it reads.
- **Tooling:** `check:affected` selects the tests that reach a changed file through their imports, and no longer every test that reaches any file of the changed package or of a package depending on it. A changed file no test imports (SQL, a template, a worker started by its path) still selects the tests of its whole package, and a test that reads a package with fs or runs its CLI still runs for that package and the packages it depends on. Lint and type checks keep their package scopes.
- **Tooling:** `check:affected` follows a named import through a barrel to the files that define the imported names, and a type-only import adds no edge, so a change to one core file no longer selects every test that imports `@work-shape/catalyst-core`. The graph lives in `scripts/affected-graph.mjs`. A module that a barrel re-exports and a test does not import by name still runs when the barrel loads; a side effect at its top level is not followed.
- `pnpm check:local` runs the steps of `pnpm check` after the build side by side instead of one after another: format, lint, the three type checks, the API checks, the test suite and the upgrade test. Each line carries its step's name, every step runs to its end even when another fails, and the output of each failed step is repeated at the end. The suite runs on the machine's cores less four (at least half of them); `CATALYST_TEST_WORKERS` sets the number for any Vitest run, and `CHECK_LOCAL_SERIAL=1` runs the steps one after another.
- `pnpm check:affected` refuses a test Postgres whose `max_connections` has room for fewer test files than it would run at once, before it builds anything, and prints the `docker run` command for one of the right size. Vitest used to fall back to two files at once on Postgres's default of 100, and a large affected run took hours.
- Hosted Check no longer runs on a push to main. The lander pushes only batches that passed the full gate locally, and a nightly run at 02:00 UTC is the hosted record. A newer dispatch on a branch cancels the older one. A release of a main commit needs a successful Check on main from a push, a dispatch or the nightly run.
- The demo client turns on the Data Stores module, so a Workflow can load findings into a store and an App can read them with `sql` actions.
- The demo's Compose file passes the sample accounting server's REST fault switches and volume divisor from `clients/demo/.env`, all off unless set. An empty `SAMPLE_ACCOUNTING_REST_UNAVAILABLE_CLIENT_ID` now means off instead of failing the sample server's start.
- **Tooling:** Each browser spec's own seed users live in `tests/fixtures/e2e-users/<spec>.yaml`; `scripts/e2e-config.mjs` composes them into the suite's config in file name order and refuses an email listed twice, so two specs no longer edit the same lines of `tests/fixtures/e2e-app.yaml`.
- **Tooling:** `packages/core/src/index.ts` holds one re-export per statement, sorted by module and then by name, and the lint rule `catalyst/sorted-barrel` keeps it so. A new export goes to its place in the file instead of after the last line, so two feature PRs no longer collide there. The barrel exports exactly the same names as before.
- Keep release tarball overrides sorted with a short comment per package, removing the shared history paragraph that parallel feature PRs conflicted on. All size limits stay unchanged.
- **Workflows:** Each step type is one module in `packages/workflows/src/steps/<type>.ts` (its file form, what of it this engine does not run and what must hold of one step) with what the authoring skill says of it in `<type>.reference.ts`; the skill's sections live in `authoring-skill/sections/`. Behaviour-neutral: the same definitions are accepted and refused with the same issues in the same order, and the skill text is byte-identical.
- **Tests:** The scale tests, files `tests/**/*.scale.test.ts`, leave `pnpm test`, `pnpm check`, `pnpm check:local` and the lander's gate, and run in the nightly hosted check, a dispatched one and a release push, which set `CATALYST_SCALE_TESTS=1`. They are the loop over 1,000 items, the 600 child runs four at a time, the child-run budgets of 600 children and the continue-as-new budget scans. `tests/durations.json` is measured again, for all 825 files, from a hosted run with the scale tests on.
- `pnpm test:agent-stories` runs the owned stack's agents on gpt-5.6-luna at reasoning effort `xhigh` by default instead of gpt-5.5 at `high`. `--model <bindingId>` and `--reasoning <effort>` choose another demo binding and effort for a rerun. The Runs line shows the chosen model and effort and the models agent runs actually called.
- No deny takes `users.manage` on the instance from a superadmin any more, also not a legacy `!users.manage` revocation. `scripts/verify-permissions.ts` reads such a revocation as held.
- `users.update` refuses to remove the role `superadmin` from, or to deactivate, the last active superadmin, and `me.delete` refuses the last active superadmin's own deletion, with `VALIDATION_FAILED` and `last_superadmin`, as `users.delete` refused its deletion. The one check is `requireActiveSuperadminRemains`.
- Show who can use an App and which stored data its SQL actions expose before publishing, including the terminal prompt and held publish review. Explain that published SQL actions use the store's app role, with store rights checked against the publisher. The summary describes only Data Stores a publish of the App would reach; any other store is named as unavailable, with nothing more about it. Approve on a held App publish waits until that summary has loaded.
- Namespaces are retired (NS-RETIRE). Instance > Access has no Namespaces tab and Studio shows no Namespace on an asset. The `namespaces.*` operations, the `namespaces` of `platform.context`, the `namespace` of an asset and of a grant, and `namespace:` in a working copy's `catalyst.yaml` are gone. A right is given on the instance, a workspace or one asset; build limits are a workspace's (`workspaces.limits.list`, `workspaces.limits.update`). A grant with `scopeKind: "namespace"` is refused with `VALIDATION_FAILED`.
- A personal API key's scope names an action, a workspace by its id or one asset in it: `agent.write`, `agent.write:<workspace>`, `agent.write:<workspace>/<name>`. A scope that names a workspace the instance does not have is refused at issuance (`unknown_workspace`); one the person holds no right in is refused naming the action and the workspace. Settings > API keys picks the workspace from a list.
- An `assets.sync` batch other than a release names its workspace (`workspaceId`), otherwise it is refused: only a release writes the instance's own assets. A working copy without `workspace:` pushes a release only.
- A CLI of an earlier 0.8.0 release candidate reads `namespaces` from `platform.context` and refuses this server's answer. Update the CLI with the server.
- The demo seed puts the held skill calls and Elif's build limits on the workspace `Personalwesen / HR` instead of the prefix `hr-`.
- A `workspaceId` with a NUL byte on an asset route is refused with `VALIDATION_FAILED`, as a name is, instead of failing in the database.
- Instance > Access opens on **Rights**, its first tab.
- The **New right** dialog offers one level per kind (Use, View, Edit, Publish, Delete, each including the ones below it; for Workflows and Connections View comes before Use, because using one acts with its own rights) in place of a check box per action. Rights that are no level, such as adding rows to a Data Store or reading a Workflow's run data, are ticked under **Further rights**. A deny sits behind **Refuse instead** and refuses the chosen level and every one above it.
- Each grant row reads as one sentence, such as "may view and edit agents in Kai Spezis" ("darf in Kai Spezis Agenten ansehen und bearbeiten"). The Rights tab counts these rows.
- The Check tab picks the asset from a list by the title the rows name it by; nothing is typed. A row decided by the role names the role.
- A refusal on the Access page, and a refused Connection call in a Page or an App, names an instance admin to ask, never the Access page.
- The Settings rail shows a single workspace as the same outlined row as the picker of several, without the chevron.
- **Data Stores:** Dependency reads name live agents carrying a store's row tools, and the store list includes visible Apps that use each store. Hidden dependencies stay unnamed.
- **Knowledge Bases:** The state read names visible live agents assigned to a Knowledge Base. The first document page includes the total retained documents, last successful ingestion and ingestion state.
- **Store pages:** Later Data Store drafts can be published from the live page, with the pending migration SQL shown before confirmation. Data Store deletion names the store in its confirmation. Data Store and Knowledge Base heads open the agent beside the page with starters for that kind, in a conversation of the workspace that owns the store, and only for members of that workspace; Knowledge Base pages show assigned agents and additional use rights, and their list shows documents, last ingestion and ingestion state in English and German.
- **Data Store deletion:** A published App, Workflow or Knowledge Base reference, or a live agent reference now refuses deletion with “This data store is still used. Remove its references before deleting it.” The check pages through all live references and rolls back the attempted removal. An unreferenced standalone store still uses the existing retirement behavior: its database remains until removed by the operator. No database migration is required.
- **Agent row-tool assignments:** Well-formed Data Store tool names pass static release validation and are checked against the live operation source. Missing and malformed tools remain refused.
- Check passes its build between jobs through a cache scoped to the run and commit, with a required exact cache hit that survives re-running failed jobs. Diagnostic artifact uploads no longer fail checks when artifact storage is unavailable; durations and screenshot evidence expire after three days, and failed-run traces after seven days. Shard balancing continues to use committed duration measurements.
- The demo's `sample-accounting-rest` Connection declares `listPostings.filter` as an array
  of strings, sent as repeated `filter` keys, so one client's month is three values: client,
  first day and the day after the month. A paged Workflow step reads the large client's
  100,000 bookings of a month in one run.
- The published Apps under the Apps row of the rail fold behind a caret at the row's end, and stand folded until the person opens them; the browser keeps the choice. The row itself still opens the Apps page. Each App shows its mark under the Apps label and its whole name on the pointer, five at most, then "All apps". Opening an App opens the fold for it.
- `NavItem` takes `trailingShown`: the trailing slot shows at rest too, for a control the row is read by, such as a caret that folds the items under it.
- Cover records rules published while an earlier migration batch is queued or running, with a key-dropping file before the end of the batch. Assert that splitting a key swap across migrations is refused with `record_key_invalid`, and document how to replace the key inside one migration. Runtime behavior is unchanged.

### Fixed

- **Knowledge Bases:** `knowledge.maxPagesPerDocument` accepts values above 5,000. The default remains 500 and the value must be a positive integer. Documents that exceed the limit show the configured value in English and German. No migration is required. Before rolling back, lower any value above 5,000: an older release refuses that configuration at startup. Retry a failed document after raising the limit and restarting the API and knowledge extraction worker.
- **Workspace availability:** Knowledge Bases and Connections have an admin-managed "Available in" control. Members inherit only use in the conversation's workspace; explicit denies win. Agent publish and availability saves list missing dependencies and offer authorized people one choice to make them available together. Missing use rights give localized help naming an instance admin. Audience counts include availability-derived readers. Agent tool calls carry their stored conversation workspace on the first call and after a decision, so workspace policy applies consistently.
- **Upgrade:** No database migration or deployment order change is needed. Existing assets keep their availability unchanged. Reverting the release does not undo availability an administrator explicitly saved, and restores the previous lending behavior.

- **Rights transfer:** Membership and availability allow use in place and never supply a right handed to another holder. Workflow publishing, ingestion principals, grant choices and key issuance use the core transfer rule; explicit grants, denies and key scopes still apply. A refused Workflow publish says `This call does not hold 'connection.use' on an asset this call may not read, and 'workflow-runner' would act with it. Only a holder of a right gives or lends it` when the caller cannot read that Connection.
- **Citations and help:** Cited originals check use on their Knowledge Base in the citing conversation's workspace, after checking access to that conversation. Direct KB grants work without conversation context. Self-checked reads retain the resolved asset identity and owner before policy; self-checked writes retain their declared creation scope for guardrails. API access and model-binding help names an active superadmin; general use-right help may name an admin. An unreadable KB's missing-dependency label is neutral in English and German.
- **Calls across workspaces:** An agent call on a Data Store another workspace owns checks rights against that stored owner. The conversation's workspace controls policy and is retained on the Operation Run and approval request. Generic operation approvals still require instance-wide `operations.approve`; a grant scoped to either workspace does not decide them.
- Messages no longer show the Edit and Regenerate buttons, which never worked.
- A conversation whose run waits for the person's decision shows "Waits for you" instead of the spinner.
- The Apps page offers "New app" in its head to a person who may build one.
- An Inbox item about an App or Workflow publish links to the draft, the live App or the Workflow, when the reader may open it.
- The Inbox lists can be filtered by kind and workspace, and each row names its workspace.
- The App draft says it reads live data and simulates changes, and who published the live version and when.
- The App draft shows where its data comes from, as the open App does.
- A saved App offers "Open the draft" beside Share.
- An App action that waits for an approval is shown over the frame, with a link to its request in the Inbox.
- A dataset row that does not fit its row schema no longer puts a key of the row into the
  error stored with the run and step: the error names the line and the place of the field by
  position (`field 2, item 1`), never a key or a value.
- Keep test type checking within the heap ceiling by checking bounded groups in separate processes, retaining shared script and ambient declarations and counting imported diagnostics once.
- **Document worker:** The deployment kit's document worker image now includes OCRmyPDF, Tesseract and German and English language data for local Knowledge Base OCR. Rebuild the worker image when updating with capabilities KB-9; the native OCR dependencies increase its image size. Rollback leaves retained extraction results unchanged.
- **Asset texts:** The language switcher stays beneath the editor's header while scrolling. Section links account for the pinned controls so headings remain visible, including narrow screens and a wrapped header.
- **Workflows:** Workflow asset reads now include per-step facts resolved under the reader's rights, including source names and service icons, operation schemas and availability, child Workflow titles, a model the AI step declares, and the published schedule's time zone and next due time. Operation nodes use these facts for their chips and effects. Step runs expose a bounded preview of their resolved input beside the output preview, only to holders of `workflow.read_run_data`; a step run stores only that cut preview, keeps none of an input holding a dataset row, and pruning removes it. Definition problems retain their step paths. No migration or new right is required.
- Create dialogs generate valid addresses from multiword names, umlauts and leading digits using the shared address rule.

- Chat accepts TXT and Markdown files without document processing, while specialized handlers keep precedence when available. Text MIME types preserve known file extensions and do not admit unsupported formats.

- Upload files from disk on Knowledge Base pages. TXT and Markdown work in core; PDF and DOCX require document processing. Per-file status and retry preserve files already added.

- Signing out or changing accounts clears upload notices, composer drafts and cached data before the next account's workspace appears. Late responses cannot restore the previous account's state.
- **Language and orientation:** Conversation refusals explain the person's missing right and name an administrator who can help. Orientation and asset names follow the person's language and current workspace; conversation titles follow the conversation language and preserve business names. Studio uses plain German and English labels for guardrails, uploads and Connections. Inaccessible links explain why they cannot open, attachments wait for Send before creating a conversation, and language changes update the document language. Teaching drafts stay out of normal agent pickers, and rights pickers have an opaque surface.

- **Demo:** Fresh seeds keep Kai’s teaching draft out of agent pickers. Existing availability choices are preserved when re-seeding.

- **Review follow-up:** Subagents pass the operation that still needs confirmation back to their parent, while replies to the person keep technical ids out. Tool refusals name the right in plain language and explain who can help. Guardrail hit summaries follow the reader's language.

- **First-message retries:** A failed staged send keeps its conversation until a message is accepted, including retries after all staged files are removed or after the first-message request fails.
- Apps published to the whole instance from a personal workspace open for other members and read their stored data. Data Store provenance names the published audience and counts agents writing from conversations.
- Data Store and Workflow pages refresh after jobs and chat writes. Team workspaces offer private build conversations and preserve a refused request when continuing privately.
- Confirmation cards name Knowledge Bases and files, show the publish review, and localize row actions and boolean values. App titles, publish hints and API account rights stay readable and current.
- Review an agent's missing Knowledge Base and Connection availability before creation, availability changes, and publication, with one explicit choice to make its dependencies available too.
- Clarify stale Inbox requests, Skill titles and requesters, workspace contacts, Studio scope defaults, row confirmations, and agent names. Use readable titles, translated booleans, and field hints that match the current value.
- Accept PDF, DOCX, and JSON chat source files alongside the existing formats, preserve specialized document extraction when configured, name supported types on refusal, and discard empty drafts after rejected first uploads. The demo guardrails now use German display names and reasons.
- Explain refused row writes in English or German with the affected column and type, without SQLSTATE or database diagnostics.
- Keep Skills' opening scope local to Skills, explain approval before a member saves a skill, and warn when a Workflow account cannot use a required Connection.
- Clarify sign-in failures and correct labels, dates, refreshes, attachment warnings, Inbox comparisons, and continuing a conversation privately.
- Show approval before a member creates a skill on the new-skill page and in `platform.context`, and return `saveApproval` from `read_skill` as `platform.assets.get` does.
- Name only approvers whose grant covers the request, point an agent at `platform.assets.get` for a skill it does not hold, and say in plain words why `read_skill` refuses one.
- Keep the outage message of a refused row write, and tell the caller to check the table before writing again when a keyless write may already be stored.
- Batch personal App storage writes about every 250 ms, coalescing each key and preserving awaited kit saves. Flush on pagehide and hidden visibility is best effort; closing or reloading before a save completes can lose a write.
- Share the Personal Workspace owner-name rule between interface and publish narratives.
- Document shared draft/published personal state, unsupported sessionStorage, and localStorage shim limitations in the App build guide and platform-docs skill.
- Apps allow form submit events and downloads while keeping an opaque origin and blocking form navigation. Saved Apps provide a `localStorage`-compatible runtime backed by private per-App, per-person state; unsaved previews use temporary state. Kit 1.6.0 adds `storage.get/set` for JSON values with awaited persistence. The App-building guidance names the form, storage and network rules and directs shared records to Data Stores.
- Publishing uses the localized workspace name consistently and shows the App's published state immediately. A chat view that fails or times out shows LoadError with retry.
- Workflows built from chat discover active technical accounts instead of copying an invented `workflow-runner` default. The authoring guide resolves notification recipients from the caller or a name/email search within the caller's directory rights. Account refusals explain who the Workflow runs as and point to Settings > API access.
- Notify steps in draft test runs simulate the intended recipients and frozen message. Their results show Simulated without creating Inbox items or queuing mail; published runs still send normally.
- Workflow builders can discover shared run-account names without administering accounts; draft tests still act as the tester, bounded by the account, and publishing keeps its no-escalation check.
- Notify nodes and details name recipients using labels the reader may see. Builder docks greet and suggest requests for their subject or the new kind being built, instead of the demo agent's welcome.
- Edit with the agent remains visible beside an open dock and reopens the same conversation safely. The demo's HR prefix is clearly labelled, and personal work does not imply a domain prefix.
- Technical-account refusals use plain English/German and point to Settings > API access.
- The published chat-ui build clears stale chunks and removes whitespace from its compiled JavaScript, so the package fits its size budget again; names, exports, declarations and the classes Tailwind finds stay the same.
- Lower per-person token safeguards to 200 million per UTC day and 4 billion per calendar month; keep 20,000 calls per day. Own and product calls retain separate buckets. Reduce the unattended factor from 10 to 7: its 1.4 billion tokens/day allow at most 23 h 20 min at 2 million counted tokens/minute even across a UTC reset. Explicit overrides retain their configured values.
- Name the exhausted metric, period, own/product/instance scope and UTC reset in usage refusals and English/German chat notices. The optional `error.usageLimit` carries `period`, `metric` and `scope` through observations and reloads. Older run errors without these details keep a generic notice. An own-call refusal reads: `Daily model call safeguard has been reached for your own calls. Resets at midnight UTC.`
- Share attachment-only conversation title placeholders between title replacement and the chat dictionary.
- Keep Knowledge Base embedding and field-extraction ingestion usage out of chat safeguard and spend counters, including settlement, lazy initialization and reconciliation, as required by KB-ISO and the limits spec section 3.1. Query embeddings still count as chat.

- Use settled daily and monthly spend excluding Knowledge Base ingestion for Usage budget bars and headroom; keep ingestion costs in totals, history and attribution.

Rollback restores the higher token defaults and can count ingestion against chat again; reconciliation must complete to correct counters left by the previous release. No migration is required. Assemble the paired capabilities change after this core change to classify KB field-extraction calls as `knowledge_field_extraction`; older capabilities keep their existing classification.
- Keep normal multi-person agent use below the shipped runaway-loop safeguards, isolate personal usage from other people's safeguards, and retain instance-wide money budgets. Operators must review existing explicit safeguard overrides when upgrading; the release-config and capacity documentation describe the new defaults and scope. Older releases interpret explicit safeguard values as instance-wide and impose no safeguards when the block is omitted; restore the previous release config when rolling back.
- Show localized usage-limit notices with a next step, using the code `MODEL_USAGE_LIMIT_REACHED`, and label the Usage safeguards as per person.
- Explain refused Connections in EN/DE with who can change the configuration. Keep technical details in a collapsed section for instance admins.
- Ask before a Data Store is published, and show what the database server leaves open around a store only to a superadmin, as steps to take.
- Name generated conversation titles, the temporary title of a conversation started with files, and the agent's created and opened lines in the language of the account or run. Authored text such as skill descriptions and Workflow names stays as written.
- Studio opens on its first section, Agents for most, regardless of the previous visit; Settings › Workspace says the workspace it shows is a shared one.
- Build Agent first saves of agents and skills now wait for confirmation before writing live assets, even under an allow policy. Existing agent changes continue to save shared drafts. The shipped guidance distinguishes record writes from previews, migrations and tests, reports the actual workspace owner, names the exact agent availability steps and points to real navigation. German Knowledge Base labels consistently use Wissensbasis/Wissensbasen.
- Workflow tests no longer queue or deliver failure notices, including jobs left by older workers. Published failures still notify their publisher.
- Workflow account discovery excludes release and integration accounts and accounts whose rights the publisher cannot lend. The authoring agent chooses the sole suitable account and offers the publish confirmation.
- Scheduled Workflows retain their time zone, default to the instance zone (UTC when unset), and name it in schedule and publish text. The demo uses Europe/Berlin.
- Publish details follow the current triggers, and a refused Connection step names its account and Connection with a direct next step for administrators.
- Older v1 context responses without schedule metadata remain readable by the CLI.
- Connection drafting is available to platform agents and conversations opened from Connections. Asset creation from chat checks the exact definition and the person's rights before asking for confirmation; new agents use the default model unless a model change was requested.
- Connection pages retest replacement keys, show the last tested state, warn before removing a key, explain blocked destinations, and prevent approval of unsupported HTTP writes. MCP tool approval lets editors choose the accepted effect.
- **Knowledge Bases:** Answers render openable source citations, freshly published bases wait for provisioning before listing documents, and plain full-question searches fall back to matching relevant words. The picker explains workspace mismatches, and creation lists the formats the instance supports. Platform agents can add conversation attachments to an existing published Knowledge Base through `knowledge.add_files`, using the same permissions, confirmation policy and independent file copies as the Documents page.
- Inbox skill approvals keep their title and original comparison after a decision, refresh when the approved call finishes, and warn when a newer revision prevents the requested change. Pending saves name visible approvers in a neutral notice. Inbox details omit internal namespace prefixes, show progress while opening their page, and name an administrator to ask when access is missing.

- Approval decisions, withdrawals and reversions return the same reader-gated view as opening an item. Readers without the asset read right receive no skill comparison shape or content. Approver help is cached per request revision and excludes e-mail labels. Approved changes stop automatic refresh after a bounded wait and offer a manual refresh.
- Retained Workflow runs keep their asset authorization identity after deletion, so asset denies still apply and permitted readers retain access.
- Workflow needed rights carry the owning workspace through derivation and evaluation, and retain asset denies on deleted children at publish.
- Operations declaring a required right resolve incomplete asset resources before authorization, including paged and resumed calls; unresolvable registered assets ask the kind-level right, answering the same 403 as no grant or 404 for authorized callers without executing. Custom operation execution integrations must provide `RunOperationDeps.resolveResource`; server assemblies supply it.
- Operation listings and App action checks resolve declared resources through the same identity lookup as direct calls.
- Make `catalyst skill pull` refuse unbound folders before walking their contents, reject non-skill commands before contacting an instance, reject dot path segments and targets containing the process working directory, clean up new parent folders on failure, and ignore only `.DS_Store` metadata during refresh and staging. Help lists the skill pull command once.
- Keep `catalyst init` quiet about an existing `@AGENTS.md` import and recognize the same instance by URL origin, including host case and default ports.
- Retrying an Inbox confirmation after its call moved to a newer approval request keeps reporting the call as held, instead of incorrectly marking the confirmation expired.
- Preserve all authored schema fields when canonicalizing agent and skill config, including subagents, Knowledge Bases, false values, empty collections and skill frontmatter. Map key order and server-carried skill metadata (`files`, `icon`, `origin`) do not count as edits. Removing all extra skill frontmatter sends an empty map to clear it. Each asset baseline records its canonical-form version. Push refuses older baselines before any write, including unchanged files: `<kind>:<name>: baseline uses an older canonical form. Run 'catalyst config pull' first, then push again.` Preserve local edits before pulling: pull refetches older baselines even at the same revision, restoring previously omitted fields from the instance. A scoped pull upgrades only its selected assets. Downgrading the CLI restores the field-loss risk.
- Check changed guardrails before applying a config push batch. An invalid definition reports `Validation failed for guardrail:<name>: <count> issue(s) (<paths>); nothing was applied.` Separate writes still enforce rights, revisions and approvals at execution time.
- Guard availability changes with the asset id and previously read availability, and default selections with the selected asset id.
- `pnpm check:affected` without `AFFECTED_BASE` compares against the first of `origin/main`, `github/main` and the `main` of a remote whose URL names work-shape/catalyst-core that exists, and says what it tried when none does, so lane worktrees whose remote is named `github` no longer need `AFFECTED_BASE` set by hand.
- The tests refuse to start against a Postgres whose major version differs from the pinned image's, read from `docker/postgres/Dockerfile`, instead of failing query-plan tests on it.
- The agent's draft of REST API tools can name a test path. The card's New connection dialog starts with it, so the test on Verbinden reads a path that needs the key, rather than only reaching the base address, which many APIs answer without one.
- The New connection dialog opens Technical details when the draft names a test path, and a test path that answers without success asks to check the address, the key and the test path, rather than saying no server answers.
- **Agent context:** Agent platform context now includes workspace-scoped asset rights, so a workspace skill writer can discover the right to create a skill and request its confirmation. Workspaces without usable rights remain hidden.
- Opening the address of a conversation that is gone (deleted, expired, in a workspace you do not reach, or never there) showed an empty chat with only the composer. The chat now says "There is no conversation at this address." / "Unter dieser Adresse gibt es keine Unterhaltung." with a New chat button, and the address stays as it was opened. The dock beside a page still opens such a conversation empty.
- Refuse App exposure (`bridge`) on a Connection with a person context header until Apps support person context, whether adding the header or enabling App exposure. The API returns 422: "Person context is not available in Apps yet. Remove App exposure or the person context header." The interface explains the refusal in English and German. Removing either setting allows the save.
- Stop startup on release config that defines a Connection with both a person context header and App exposure. The release seed and an administrator's save ask the same rule.
- Refuse any call an App action makes of a Connection that sends person context as `person_context_app_unavailable`, before any request reaches the outside system, whoever calls the action: a frame, an agent that carries the action as a tool, or anything else. This also covers a Connection stored before the save refusal and one the action reaches by agent exposure. An agent's or a Workflow's own call of the Connection still sends the mapped value.
- Clarify that Workflow tests send the tester's mapped value on root and child runs, and require a bounded `SET lock_timeout` for migration DDL that takes table locks.
- **Discovery:** Discovery lists use cursor pages instead of limiting the number of published Workflows, App actions, or stores an instance can reach. Workflow schedule repair and store maintenance retain a continuation between bounded jobs. Studio choosers, the uploaded file picker, and Workflow run steps retain cursors so later items remain reachable.

- **API:** `workflows.list` and `apps.actions.list` accept `limit` and `cursor`; readers must follow `nextCursor`. The App actions `truncated` field remains for compatibility and reports whether another page follows. No database migration is needed. The CLI `app actions` follows every page. Store scans run as retryable page jobs, including their first page, and recover after an expired worker lease. New store tick/page kinds and the Workflow schedule-repair kind must drain before rollback; older workers cannot serve them. Legacy empty store ticks remain registered for rolling upgrades.

- **Extensions:** Custom `WorkflowDefinitionSource.list` readers must honor the supplied `StorePage` limit and exclusive Workflow-id cursor. Built-in asset and folder readers implement that contract.

- **Maintenance:** Call-ledger setup shares the existing database grant turn with store migration and provisioning, so concurrent maintenance cannot race on Postgres schema catalog grants.

- **Workflow runs:** The run page reads every step page automatically, drawing steps as pages arrive.
- **Data Stores:** Constraint errors now identify the constraint and table in English and German, including dataset loads and records proposals, without exposing rejected row values. PostgreSQL 17 not-null errors identify the table and column because the server supplies no constraint name. Database detail text is discarded.
- **Data Stores:** Errors retain constraint and table names only when PostgreSQL identifies a constraint-checking routine and the constraint or index still exists on that table in the store's catalog after rollback, read as the platform role. Not-null errors check the column on that table instead. The error path makes one catalog query per candidate failure, with no per-row cost. PL/pgSQL `RAISE`, missing routine metadata, unverified names and objects created inside the rolled-back transaction use the fixed SQLSTATE sentence, keeping row values out of answers, logs and Operation Runs in EN and DE. Existing unique (including migration-created unique indexes), check, foreign-key, exclusion and not-null violations retain their names.
- **Accepted residual:** A schema author can choose which existing constraint to break based on a value, leaking it one choice at a time. The schema author already controls the store's schema by design, so this is accepted.
- Data Stores published at once no longer fail to provision with SQLSTATE XX000 ("tuple concurrently updated"). Every store takes CONNECT on the platform database from PUBLIC, and two of those grants at the same moment collided on the one catalog row of that database; they now take turns under an advisory lock. The rest of provisioning still runs side by side, so how many stores are provisioned at once is unchanged.
- Knowledge Bases published at once on one Data Store no longer fail with HTTP 500 and the same error. The grants to their reader roles write onto the same catalog rows of the store's database, its schema `public` and its tables; they now take turns under an advisory lock of that store's database. Grants on different stores do not wait for each other.
- Keep Data Store migration credential reads on the held Platform Store transaction, so cold migration connections complete even when the platform pool has only one connection.
- The browser tests that start a second API (infrastructure, knowledge fields, knowledge upload, modules) give that setup two minutes instead of the default 30 seconds, so a busy suite no longer fails them while they wait for their turn.
- The browser test of a queued job whose module is off no longer fails when the jobs list is still loading as the page reloads.
- Three browser specs no longer depend on how fast the host runs them: the radio check holds
  the arrow key until the focus has moved instead of for a fixed 50 ms, and the agent chip and
  the plain Page read their narrow width once the layout has settled after the resize.
- Workflow runs exclude time spent waiting for a run linked by run key from `limits.duration`, including waiting ancestors. The linked run keeps its own duration budget.
- A keyed link to the calling run, its ancestors, or a run already waiting on it is refused with `run_key_cycle`: “The key for Workflow '<workflow>' is held by a run in its own call chain”. No run key or input value is exposed. Rolling back removes this guard and restores counting keyed waits toward duration.
- Concurrent keyed links serialize per client instance before taking run row locks, so simultaneous links cannot close a wait cycle or deadlock each other. Unkeyed child creation does not take this lock.
- Prevent unused Data Store test fixtures from deleting another fixture's live databases during teardown and leaving stale assets that fail subsequent Knowledge Base extraction setup with HTTP 412.
- **Sessions:** Sign-out cancels the previous session's reads before revoking its cookie and prevents those queries from refetching for the next person in the same tab.
- A page's title and the Settings area name no longer rest under the chat header's band and fade. From 768 px up the band is gone outside a conversation, and in a narrow window it gives way to a sub-rail that shows its area's name beside the sidebar button. The fade shows only over what has scrolled up under the band.
- The test for the job summary on a large queue passes on a test server that commits asynchronously (`synchronous_commit = off`), such as the Mac mini's. It commits its 500,000 jobs synchronously, so the vacuum marks every page all-visible, and it checks that before it asserts the index-only plan and the pages read.
- The Knowledge Base extraction test no longer fails when a random Operation Run id happens to contain the digits it checks for.
- **Knowledge Bases:** PDF conversion time now grows with the detected page count, bounded by the operator’s configured page limit. A conversion that still exceeds its deadline fails with `knowledge_conversion_timeout`; English and German document errors name the detected page count. Files above the configured page limit still fail before text conversion. No migration or new page ceiling.

- **Deployment:** Deploy the paired core change before the updated document worker. On rollback, roll back the worker first; retry stored conversion-timeout failures on a compatible core.
- Publishing more Knowledge Bases at once than the platform database pool has connections no longer stalls every publish. A publish on a Data Store read the store, the store's role passwords and, when it opened a connection as a store role, that role's password through a second connection of the pool while its own transaction held one. With every connection held by a waiting publish, none could go on. Every one of those reads now goes through the publish's transaction, as does the removal of such a Knowledge Base and the processing review of a republished Knowledge Base with documents. A target of the Postgres executor may now name where the password of a connection it opens is read.
- Serialize unscoped replacement loads on each Data Store table before taking group locks, so concurrent streamed loads with reversed groups across chunks both complete without a deadlock. Unscoped replacements of one table now take turns; scoped replacements of disjoint groups still run concurrently. Lock waits count against `limits.timeoutMs` (`dataStores.load.timeoutMs`, default 600 s).
- A table-lock timeout answers `load_replace_timeout`: "Another replacement of table '<table>' was running. Waiting reached limits.timeoutMs (<limit> ms, dataStores.load.timeoutMs). Safe to retry." Group and row timeouts after the table lock is granted remain `TIMEOUT` (SQLSTATE `57014`). A row deadlock answers `load_concurrent_rows`: "The load ran into a concurrent write to the same rows. Nothing was loaded; safe to retry." Both have English and German messages; rolled-back loads remain eligible for the existing Workflow step retry. No migration; rollback restores the earlier lock behavior and generic database errors.
- **Access and agent context:** Protect private continuation and pending Inbox content from other members, hide unreadable Connection names in publish dependencies, identify the current workspace in agent context, restore localized guardrail hit reasons, bound Data Store state polling, and exclude Workflow agent steps from conversation writer counts.
- Row updates and deletions accept computed primary-key columns as selectors while keeping computed columns read-only. Operation input validation uses the caller's English or German language, including schema limit refusals.
- Row-write event contract coverage requires the writing Operation Run, matching the existing audit writer.
- Workflow failures carry the called Connection name alongside the missing right, so run summaries can name it without reading a later definition. This is an optional API field; no migration is required, and older runs retain the plain-language fallback.
- Workflow run summaries name their recorded account and Connection in plain English and German; administrator advice explains how to allow Connection use.
- A newer draft of HTTP Connection tools replaces an earlier approval list, so the first draft cannot silently keep its old operations.
- Platform agents receive English and German wording guidance for App titles, saved drafts and the columns that identify rows.
- Inbox lists no longer carry `input`. An opened held asset save also withholds executable input and technical input fields unless its preview establishes read access, including when the asset's module was disabled while waiting.
- Data Store updates refuse changes to the source columns of generated primary keys with `key_column_in_set`, keeping row identity stable.
- German callers receive localized unreadable and deeply nested operation input errors. Workflow test refusals name the right in plain language, and historical step panels show the run's account.
- Agent guidance uses plain save and creation wording, supplies revision numbers when asked, and explains how a member submits a skill change for an administrator's decision.
- Repair pending Inbox requests left behind by ended calls before retention pruning, and remove settled held-call requests whose run is gone in bounded batches.
- Report missing Knowledge Base and Connection availability when the first default agent is created or synced, keeping those dependencies visible in publish review without blocking sync.
- Mark stale held asset saves consistently across asset kinds, localize unreadable Knowledge Base tool input in German, and derive unsupported attachment formats from the accepted file types.
- Reset the workspace route before mounting another person's session, and have the old workspace ignore a membership list read for the next person, so neither triggers a closed-link notice or read of the person before's workspace.
- The notice privacy test no longer fails when a random id happens to contain its number marker.
- Refuse approval-held OAuth calls with `approval_stale` when the Connection reconnects during slot, egress, or credential-opening waits, before executing the connector.
- Enforce operation deadlines and abort signals on direct calls as well as approved calls. A timed-out call records and returns `TIMEOUT`, replays that failure under the same idempotency key, and cannot replace it with a late success. Recovery sweeps remain the backstop for abandoned runs.

- Preserve the stored outcome when a recovery sweep ends a call first. Refuse dispatch after a deadline or caller abort, name the effective timeout limit in English and German, and keep interruption guidance for agent tools.

- Distinguish executor deadlines from caller cancellation through a typed abort reason. `workspace.exec` retains its deadline cancellation reason and returns `timed_out` with the command id, while its Operation Run remains `TIMEOUT`. Web fetch, Page build and repository-save waits also classify executor timeouts as deadlines.
- Callable-operation discovery now returns cursor pages of at most 200 authorized operations, supports exact-name and prefix filters, and includes Workflow starts. Agent guidance explains how to reach later pages before reporting an operation missing.
- A paged `cursor` or `next_link` step fails with `paging_repeated_cursor` as soon as the
  source returns a continuation the step has already read, such as A, B, A. Before, only a
  continuation repeated twice in a row was caught, and a cycle ran on to the page limit and
  failed with `dataset_limit`. The step rebuilds the continuations it has read from its
  dataset's page checkpoints, so the check holds across a deferral or a worker restart.
- **Chat runtime pins:** chat-ui now pins `@assistant-ui/react` 0.14.26, `@assistant-ui/core` 0.2.20, `@assistant-ui/store` 0.2.19, `@assistant-ui/tap` 0.9.3, `ai` 6.0.224 and `@ai-sdk/react` 3.0.226 exactly (server pins `ai` too). A lock-free deployment install had resolved react 0.14.29 with tap 0.9.23, which loops with "Maximum update depth exceeded" on the workspace start page and on every keystroke in the composer. The fresh consumer gate now fails when a consumer resolves any of these to a version other than core's. The gate also signs in to the consumer's built UI in Chromium and types in the start-page composer; with the floated versions it fails there.
- **Knowledge Bases:** Knowledge Base asset reads skip processing review unless the draft changes processing. Changed drafts and publish-time confirmations use set-based counts grouped by effective processing fingerprint, without loading individual contents into the API. Publish still checks stored processor revisions and invalidates stale confirmations. Selective processing tests now assert physical content and chunk row identity.

- **Knowledge Bases:** Uploads without passage tokens or source-size metadata receive an explicitly conservative file-limit estimate, so processing confirmation does not wait on the indexing it needs to authorize.
- **Knowledge Bases:** Reviews include released processor-version changes on asset GET and require confirmation for revision-only reprocessing, including contents created before owned-store migration 7. Processing estimates read chunks through the content/revision index only for affected contents.
- **Data Stores:** Every migration preserves records keys that held before its pending batch, rolling back with `record_key_invalid` naming the offending migration, rule and key. The final migration also checks keys created by the batch, allowing a table and its unique key in separate files. If a new table's batch fails before adding its key, the table remains and the failure says the records key is not there yet. Migration jobs keep the latest published rules and target revision when another publish arrives during a running migration.
- Records proposals run no schema or role DDL. Fixed catalog/replay reads use the platform connection, and the installed frame performs customer writes as the app role. Customer stores install the content hash column and persistent app-privilege projection frame in their existing publish/provision schema step, under the per-store transaction lock. Owned-store release 12 installs the frame through the existing scheduled upgrade path; release 11 supplies the column. No released instance needs an operator step: records.propose is in no release yet, and adding a `records:` rule means publishing the store, which runs the ensure. A customer store on a main build between REC-1a and this change gets the frame on its next publish; until then proposals refuse: `Data Store '<name>' needs its upgrade for records.propose. Publish the store again; a store Catalyst runs finishes its upgrade on its own.` / `Der Data Store '<name>' benötigt sein Upgrade für records.propose. Veröffentliche den Store erneut; ein von Catalyst betriebener Store schließt sein Upgrade selbst ab.` Rollback leaves the additive column and frame in place; older binaries still execute proposal-time DDL.
- Owned schema creation and grants share the store setup lock. Gapped owned releases show as provisioning in the Data Store list. Proposals whose source and destination share an owned database reuse their transaction connection.
- Records proposals use search's source-visibility decision and record a per-item failure for withdrawn, unavailable, or narrowed documents, including while cleanup is pending. Other items continue.
- Publishing refuses `extraction.budget.maxTokensPerDocument` below the shared 512-token extraction reserve, naming the field, supplied value, and minimum: `extraction.budget.maxTokensPerDocument: <value> is below the extraction minimum 512.` / `extraction.budget.maxTokensPerDocument: <value> ist kleiner als das Minimum 512 für die Extraktion.`
- Enforce asset reference ownership when saving or publishing a source and when creating its
  target. A workspace asset may name its own workspace or the instance. Refusals carry
  `invalid_scope`; forward references name both owners with English and German kind labels.
  The owner rule reads: "An asset may reference only assets of its own workspace or the instance; an instance-owned
  asset cannot reference workspace assets." Target-creation refusals disclose no source names
  or owners: "This asset cannot be created because an asset of another owner references it."
- Preserve two exceptions: instance-owned Workflows may name workspace Apps and App actions,
  Data Stores and Knowledge Bases, and link notices into workspaces; every run call still
  requires its principal's current rights. Guardrail filters govern events and consume no
  referenced asset; their separate workspace reach rule remains enforced.
- Align agent Knowledge Base and App action choosers with ownership and reference access.
  The unnamed App action catalog also accepts use of a published App; named action details
  still require read. Use-only holders see only action name, description and effect, without
  configuration or a call preview. Readers retain the full action view. Use-held Connections
  list safe summary fields, including title and connector type, while
  configuration, history and secrets remain hidden. Reference refusals also use English or German.
- Existing invalid pairs keep running; a save or publish of their source, or creation of a
  previously missing target, checks them. Editing an existing target remains allowed because
  owners never change. Unrelated edits remain possible. The read-only preflight reports draft
  and live violations with the same exceptions. No stored data is rewritten. Rolling back
  removes enforcement and leaves stored assets unchanged.
- Localize Workflow publishing, publisher failure notices and counts-only digest mail for English and German recipients, and show recipient display names.
- Show completed Workflow runs with failed descendants as needing attention in run lists, Workflow cards and run headers, and keep loop panels and canvas states consistent. Persist failed loop-item counts once at finalization; item-only and nested failures remain visible on every read surface. Aggregate descendants only for API reads through the partial tree index, never on engine `readRun`. Migration 0115 adds nullable locale/item-count columns without a backfill and builds the failure index concurrently; interrupted builds can replay the nullable additions safely. Run the migration step before startup; rollback can leave these additive columns and index in place.
- Correct Workflow authoring guidance for failure notifications and keeping a rules revision in one place for keyed child runs.
- Send `catalyst data-store publish --yes` unattended like other publishes: it waits in the caller’s Inbox for confirmation and exits 3 when held, instead of claiming to have published.
- Allow `load` to name `replace.values` alongside `replace.by`, so empty reruns clear only their explicit group. Values must name exactly the group columns with non-null scalars; rows outside it are refused with `replace_scope_mismatch`. Existing dataset-derived groups keep their semantics. Roll back by removing `replace.values` from definitions before using an older runtime; it rejects that new field.
- Include pinned pandas and numpy in the demo runner and verify their installed package manifest in the sandbox.
- **Tests:** The Workflow scale tests that ran past their time limit in the full suite on a loaded machine, while each passed alone, get a limit sized to their work: 20 minutes instead of 5 for the 1,000-item loop and the 600 child runs, and 2 minutes instead of 30 s for the continue-as-new tests that run a chain of histories to its end. What they assert is unchanged.
- Synced documents from before owned-store migration 5 remain searchable without another sync. A null listing key remains visible: no operated instance has synced document-source items yet (the only connector is `fixture`; Box arrives in CS-6), so these legacy rows exist only in tests. A published boundary change hides unknown-parent items whose listing key belongs to a different boundary and queues a full pass. Only a person's full sync (including a personal API key) replaces a pending withdrawal confirmation; changes polls, Workflows, retries and answered confirmations join the held pass. Competing decisions return `CONFLICT` (409). Replaced passes end as `superseded` without a source failure.
- The quality checks start with a 6 GB heap: the type check of the tests outgrew 4 GB.
- `mountChatWidget` passes every prop of the chat shell to it, not only the address, the token and the class name.
- The Apps area offers New, Build with the agent and Save as app by the App rights the reader holds in the open workspace, never by rights in another workspace. Edit, Publish and Delete of one App follow what the instance says the reader may do to that App in list and detail answers, so a grant or deny on that App alone controls Edit, Edit with the agent and Delete. Asset-only draft writers can reach the editor from the list, and a failed App record read offers Try again.
- Asset list and detail answers include the caller’s `read` right in `allowed`. Update the server and UI together: an older server’s `allowed` omits `read`, so the new UI hides Details on that answer.
- The Knowledge Base chooser of an agent and the Data Store chooser of a Knowledge Base list those of the asset's own workspace beside the instance's, as the skill chooser does. The instance still checks each reference when it is saved.
- Publishing an agent's draft from its page refreshes the lists of offered agents and the configuration. A publish that waits for an approval refreshes nothing.
- The page of a Workflow run says when the steps of the run could not be loaded, also when a later reading fails after steps were shown, and Try again reads the run and its steps again. A failed run refresh keeps the existing notice that the instance has not answered, even when the steps also fail.
- **Workflows:** Lists, pages, runs and asset choices use each Workflow's returned rights, with the owner’s actions as fallback. Grants and delete denies on one Workflow override broader rights without affecting another Workflow. Workflow draft writers and publishers can discover the same draft in the asset list that they can read directly, a publisher can reach the draft through the Workflows area, and a write-only holder can open its private editing conversation. Failed reads offer the shared retry control.
- `assets.validate` (and `catalyst <kind> validate`) now runs the kind's check against what is stored, as `assets.put` does. A Workflow whose child is unpublished, whose child mapping does not fit, or whose dataset row does not fit a code step's input is answered `valid: false` with the put's message, instead of `Valid.` followed by a refused save.
- **Workflow retention:** One exhaustive owner now covers run snapshots, checkpoints,
  step inputs and outputs, all code attempts, staged inputs, raw outcomes and logs.
  Keys and labels remain as governance identifiers, preserving done-run deduplication and keeping labels queryable.
  Names, status, times, error codes, counts and structural child/continuation IDs remain.
  Pruned run pages show status, times, errors, links, reached steps and loop counts; without the
  snapshot they omit concurrency and unreached loop-body steps, and expose no value previews.
  Stored code, output and continuation schema failures name positions, never checked data keys.

- **Deployment:** Migrations 0120–0121 add a shared retention version, separate expiry and repair
  indexes, and allow expired run definitions to be removed. The existing scheduled retention job repairs already marked rows in bounded
  run/step batches, preserves their original prune time, and safely resumes or runs twice.
  The repair shares the normal owner rather than copying its field list into a data migration.
  Deploy migrations before app/workers. No new refusal text. Rollback cannot restore erased
  values; older workers may leave version-zero rows for the next upgraded sweep. Keep the
  previous release's prune index until its workers have drained.
- **Workflows:** Workflow Runs now refresh failed-item counts when an attempt finishes after cancellation, preserving the failure rollup of a continued Lauf. Run-row locks share one root, parent, child order, so a keyed child start returns `run_key_cycle` instead of deadlocking with a concurrent root transition.

- **Deployment:** Deadline wakes requested while the current deadline job runs are retained and queued after that attempt. Migration `0119_job_wakes` adds the durable wake table before API or worker startup. Startup on an older database refuses with `The database is behind this release. Run the migration step before starting. Missing migrations: 0119_job_wakes`. The migration is additive and supports draining workers from the previous release. On rollback, leave the table in place; pending wakes need the new executor and must be drained before reverting workers.
- **Workflows:** Schedules now record a refused published definition as a skipped tick with its reason and queue the next due time. Schedule repair at process startup is covered by a restart regression. Concurrent due times of one Workflow serialize overlap admission within the run transaction. No migration or job payload change is required.
- Concurrent Workflow publishes with Data Store dataset contracts no longer stall when they fill the default platform database pool. Operation definitions read during publication use the publish transaction's handle.
- HTTP API query arrays no longer have a fixed 32-value cap. Declared `maxItems` still applies. The connector refuses a final encoded request URL over 8,000 bytes as `input_invalid` with `the request URL exceeds HTTP_API_REQUEST_URL_MAX_BYTES (8000 bytes)`, including long scalar values. Query declaration and validation guidance now lives in the release-config docs. No migration; rolling back restores the 32-value cap and removes the request URL bound.

### Database

- Add the table `roles` (0127, additive): a custom role, or `user` and `admin` once a superadmin edited them, with the default the role was last reconciled with and its pending actions. A role's grants are rows of `permission_grants` with `holder_kind = 'role'`. The migration step reconciles the stored `user` and `admin` roles with the release's defaults after the migrations, writes `role.reconciled` audit events and removes role grants of actions the release no longer knows. Apply the migration before startup. The previous release ignores the table and every role row: on a rollback `user` and `admin` hold the previous release's code defaults, custom roles give nothing, and the rows wait for the next upgrade.
- **Workflows:** Migration `0130_workflow_agent_usage` adds a concurrent partial index on model usage by instance and Agent Run, used by Workflow agent-step usage summaries. Apply it before starting the new API and workers. It preserves compatibility with the previous release and moves no data. Rolling back the application may leave the index in place; remove it only through a later committed migration.
- Migration `0109_workflow_run_datasets` adds dataset records, access holds and byte counters. Run migrations before app/worker startup. Dataset parts use the `files` object store; exclude `workflow-runs/` from backups. After a restore with missing parts, reads answer `dataset_expired`. Limits refuse only the producing step with `dataset_limit` and the limit name. Keep these additive tables when rolling back to the previous release; that release does not clean dataset objects.
- Migration `0128_scheduled_agent_starts` adds saved scheduled prompts and their run history. Apply it before app and worker startup; a database behind refuses startup with the missing migration name. The previous release can run with these additive tables. Roll back application code without dropping the tables; dropping them deletes saved schedules and their history.
- Add `platform_jobs.concurrency_limit` and `workflow_runs.limits`, `waiting_since` and `waited_ms` (0110, additive). Apply the migration before startup; the previous release can read the expanded schema and ignores the new columns, so a rollback runs every Workflow under the fixed defaults again.
- Add the table `feedback` (0136, additive). Apply the migration before startup; the previous release does not read the table, so a rollback keeps the comments and shows none of them until the release is back.
- Migration `0126_operation_run_admitted` adds the nullable `operation_runs.admitted_at` and the concurrent partial index `operation_runs_admitted_idx`; a `mail.send` call holds its place in `outbound.limits` by it. Additive and repeatable after an interrupted build; apply it before startup. The previous release ignores the column, so a rollback sends without limits again.
- Migrations `0131_retire_namespaces`, `0132_permission_grants_scope_unique` and `0133_drop_grant_namespace` retire Namespaces in one step. Run them before app and worker startup.
  - Any Namespace deny stops `0129` before it changes anything, naming the instance, holder, action and prefix of each. On the release before, deny the same on the asset or the workspace, revoke the Namespace deny on Instance > Access, and migrate again.
  - Each Namespace allow becomes an allow, for the same holder and action, on every active asset the instance owns whose kind is the action's and whose name starts with the prefix: the assets it covers now. An asset created later under the prefix is not covered. A row the holder already has on such an asset, an allow or a deny, stays as it is. No workspace row is written, so nobody gains a right.
  - A personal key loses each scope limited to a prefix (`agent.write:kai-`); a key left with none covers nothing until it is replaced.
  - Every change writes the audit event an administrator's change writes (`permission.granted`, `permission.revoked`, `namespace.deleted`, `api_access.personal_key_narrowed`), with no actor, the reason `namespace_retired` and the correlation `migration:0131_retire_namespaces`.
  - `0129` drops the `namespaces` table with its build limits, `0130` builds the grant uniqueness without the prefix concurrently, and `0131` drops `permission_grants.namespace`. The previous release reads both, so roll back by restoring the backup taken before the migration.
- **Data scope:** Add migration `0124_scope_assignments` for per-instance data scope assignments to people, groups and service accounts. It adds the assignment table and an empty-by-default identity-group column on users; existing users receive no scope assignment. Run migrations before starting the application and workers. Older binaries ignore assignments; rolling back the application removes data scope enforcement, so keep scoped stores unavailable to staff until the scoped release is restored.
- **Agent Try:** Rekey agent Try conversations by agent and person with migrations 0134–0135. Existing previews keep the newest current conversation per person; older links remain available for retention cleanup. Publish, Discard and agent deletion remove previews; Build deletion leaves them. Migrate before starting the new API and workers. New refusal texts: a queued Try turn without a valid snapshot ("The preview snapshot is not available. Send the message again in Try."), a tool Try does not offer ("This tool is not available in Preview") and moving a Try conversation ("A preview conversation stays with its agent"). Rollback keeps the nullable legacy Build and creator columns; previews opened by the new release cannot be reopened by the old Build-keyed endpoint. After old workers drain, the legacy Build column and nullable creator compatibility can be contracted in a later release.
- Migration `0125_workspace_build_limits` adds two nullable `jsonb` columns, `allowed_tool_names` and `allowed_model_binding_ids`, to `collaboration_workspaces`. Run migrations before app and worker startup. Null adds no limit, so existing workspaces are unchanged. The previous release ignores the columns; rolling back leaves them in place and drops the limits' effect, and `builder` and `publisher` rows then grant nothing.
- Migration `0122_app_user_storage` creates private state with cascading App/account erasure. Run migrations before startup; an older database refuses startup with the missing migration name. Rollback leaves the new table unused; do not drop it unless losing stored personal state is intended. Personal state is capped at 64 KiB of UTF-8 JSON; the refusal is `App storage exceeds APP_USER_STORAGE_MAX_BYTES (65536 bytes). Use a Data Store for business records.`
- Decided or settled Inbox requests are deleted atomically with their Operation Run: with its conversation, or after `retention.auditDays` for calls without a conversation. Pending calls remain. Request history whose run was already deleted by an earlier release is not backfilled by this change. Migration `0123` adds an index on the request’s run reference, including confirmations handed to an approver. Rollback stops future request pruning and does not restore deleted history; the additive index remains compatible.
- **Data Stores:** Owned-store release 11 adds `catalyst.record_fields.content_sha256` with `IF NOT EXISTS`, preserving columns already created by earlier releases. Knowledge Base readiness checks every required owned-store release number, so a missing earlier release keeps the store preparing until the existing upgrade path repairs it. Core Drizzle migrations are unchanged. Rolling back the application restores the previous level-based readiness check; the additive column can remain.
- Migration `0115_user_locale.sql` adds nullable `product_users.locale` for the existing language choice. Run migrations before API or worker startup. Existing accounts without a choice use the instance default. Rollback leaves the additive column in place; an older runtime ignores the stored choice.
- Owned-store migration 9 (`source_superseded`), after REC-1a's migration 8 (`record_content_hash`), expands sync outcomes. The owned-store upgrade job applies it in order; no platform migration is needed. Source operations refuse a store awaiting upgrade with `CONFLICT` (409), reason `knowledge_store_not_ready`. Drain older source workers before starting this version: older binaries do not understand `superseded` outcomes. A rollback must retain migration 9 and use code that understands this outcome; do not roll back the schema.

## 0.8.0-rc.4 — 2026-10-17

### Added

- The agent page edits the agent's one draft (AD-4). The form starts from the pending draft when there is one, and Save draft writes it on the live revision and the draft revision the page holds. Save after save now works; before, the second save was refused with 412 and the page went on showing the live agent. The head names the draft as "Draft revision n"; the banner under it names the author and the time. Each changed field shows its published value under it.
- Publish sits in the agent page's head. A holder of `agent.publish` can use it; anybody else sees it disabled with the missing right named. Discard draft sits in the "…" menu behind a dialog. Before, both were only offered beside a Build conversation.
- When a save is refused because somebody else saved a newer draft, the page says who saved it and when. It keeps what the reader typed and offers to load the newer draft.
- Build > Agents marks an agent that has a draft, for holders of `agent.write`.
- `agents.draft.get` names the draft's author with `author.name`.
- Studio offers Publish only to holders of the kind's own publish right where the kind names one, as the instance does. Before, the write right on all assets was enough.
- `assets.get` names what the caller may do on the asset in `allowed` (`write`, `delete`, `publish`), decided by the instance with grants and denies on the asset itself. An asset's page in Studio follows it for Save, Publish, Discard and Delete. Before, Studio derived the rights itself and missed a grant or a deny on one asset: a holder of `agent.publish` on one agent saw Publish disabled although the instance would publish.
- **Workflows:** Run keys (EW-13k). `workflows.start`, `workflows.test` and `workflow.<id>.start` take a `key` beside the inputs (1 to 200 characters). Among a Workflow's open and `done` runs of one mode a key exists once: a start with it starts nothing and answers that run, also when two starts race. A run that ended `failed`, `cancelled` or `limit_reached` gives its key up, so a start with it is a new run on the published revision. A `workflow` step sets its child's key with `key`, literals and references joined with `/`; a step a key answered links to that run (`linkedRunId`), waits for it and does not own it, so cancelling the parent leaves it going. Runs carry `runKey`, the runs list filters by `key` or `keyPrefix`, and the run page and runs list show the key. No Workflow declares an input named `key`. Keys stay out of audit events.

### Changed

- `catalyst config push` writes a changed agent that exists as its draft and prints "draft revision n; live revision m is unchanged until it is published". Each agent names the draft revision its last pull or push saw (`expectedDraftRevision`). A push over a draft somebody changed since is refused as a whole and names who changed it and when, with the pull that records it.
- `catalyst config pull` writes each agent's live revision and lists every pending draft with its revision, author and time. `catalyst config diff` compares agents with their live revision, shows an agent the last push wrote as "pushed as a draft, not live", and names each pending draft.
- **Upgrade:** `.catalyst-state.json` records each agent's draft revision. A state file of an earlier CLI refuses a push that changes an agent until one `catalyst config pull`; commit or stash local edits first, as the pull overwrites the files.
- `catalyst config push --publish` publishes each draft the push wrote. An instance's own agent goes live without a terminal unless a guardrail on `agent.before_publish` asks for an approval, which prints the waiting Operation Run and exits 3. A workspace's agent asks first. A service principal's key, such as an operated instance's release key, writes drafts and publishes none, and the CLI says why; publish with a personal key that holds `config_assets:publish`, or on the agent page.
- `catalyst agent publish <name> --revision <n>` publishes an agent draft, `catalyst agent discard <name> --revision <n>` drops it, and `catalyst agent put` and `revert` take `--if-draft-revision <n|none>`. `agent list` shows a draft column and `agent show` the pending draft.
- API, additive: an agent draft's `author` carries `displayLabel` while the account exists; a `draft_changed` refusal names the agent's `kind` and `name`; and a release key (the release right with the scope `config_assets:release`) is given the pending draft summary in `assets.list` and `assets.get`, so its pull records the draft its push writes over.
- SRC-1b: sync operations, source inspection and retry commands for synced Knowledge Bases, using an owned ingestion principal.

- Source narrowing and removal remain refused with `not_supported_yet`: "Changing a source boundary or removing a source is not supported yet; the published source is kept."

- Change-feed sync remains refused with `not_supported_yet`: "Change-feed sync is not supported yet; request mode full." Use `catalyst knowledge-base sync <kb> --source <id> --full` for a full pass.

- Knowledge Base document retry now requires credential scope `config_assets:write` instead of `data_store_rows:write` shipped in 0.8.0-rc.3. Integrations issuing access tokens must request `config_assets:write`; CLI automation must use a personal API key that includes `knowledge_base.write`, also held by its owner. Existing service API credentials cannot carry the new write scope: replace them with such a personal key for retry automation. An old scope alone is refused with "Missing auth scope 'config_assets:write'". On rollback, use the previous credential scope again.
- **Knowledge Bases:** Synced Knowledge Base documents release their original bytes once indexing succeeds or fails. Their Managed File records and extracted text remain; re-indexing uses that text without fetching the original. Files added by hand retain their own copy, including files with the same content hash. Released originals remain at the source. No migration is required. Rolling back does not restore released bytes; recovering them requires a source retry.

- Retrying shared content uses an available document copy even when an earlier synced original was released. If extraction has neither retained text nor an available original, indexing fails with `knowledge_file_missing`; delayed extraction jobs requeue indexing without overwriting retained results.

### Fixed

- **Sandbox:** A command of the `local` sandbox no longer leaves running what it started in the background. When the command ends, by itself, at its time limit or at a cancel, every process still in its process group is killed, and the result no longer waits for a process that left the group and holds the command's output open: it waits one second at most. A process that left the group with a session of its own or a double fork is still out of reach of the `local` sandbox, which is for development only. In the `docker` sandbox the script of a code step is the first process of its container, and every process of the container ends with it, including one in a session of its own; the tests now check this against the runner image.

### Database

- Add `workflow_runs.run_key` and `workflow_step_runs.linked_run_id` (0107), then, concurrently, the partial unique index `workflow_runs_run_key_idx` on `(client_instance_id, workflow, mode, run_key)` for keyed runs that are not `failed`, `cancelled` or `limit_reached`, and `workflow_step_runs_linked_run_idx` (0108). Apply both before startup; existing runs have no key, and the previous release reads the expanded schema.
- Add generic asset ownership to service principals (0105/0106), and owned Knowledge Base store migration 4 for transactionally maintained source counts. Apply the migration before startup; the previous release can read the expanded schema. Source narrowing and removal remain refused with `not_supported_yet` ("Changing a source boundary or removing a source is not supported yet; the published source is kept."); rollback stops new source operations but keeps imported data and owned principals. The previous API lists those principals and does not enforce ownership, so do not administer their accounts on a rollback.

## 0.8.0-rc.3 — 2026-10-17

### Added

- The docs page "App or Workflow" holds one decision table (View, App, App action, `code` action, Workflow) with the ruled sentence on where an App ends and a Workflow begins, the Buchhaltungscheck as its worked row, the route for outside data and the order to build in; `platform-docs` carries it, and `show_view`, `workspace.open`, `app.save`, `platform.assets.put` and the `workflow-authoring` skill each point to it in one sentence.
- **A use level on personal API keys (CLI-PUBLISH-USE):** a personal key can carry
  `connection.use`, `data_store.insert`, `data_store.execute`, `knowledge_base.use` and
  `workflow.use`, with the same scope grammar as the other actions (`connection.use:kai-`). With
  them a person publishes from the CLI a Workflow whose Service Principal uses a resource: the
  no-escalation rule asks the person for each right the principal holds, within the key's
  scopes. A key without the level is refused with the missing right named, for example "The
  API key of this call does not cover 'connection.use' on the whole instance, and
  'workflow-runner' would act with it". The level never exceeds the owner's rights: a key is
  issued only with use rights the person holds somewhere, and a right taken from the person
  is gone from the key on its next call. The level adds no operation scope; it counts on the
  operations a key already reaches, so a key with `workflow.use` and a write scope also starts
  a Workflow its owner may start.
- **Settings > API keys** offers the level as **Use** / **Verwenden** beside the scopes, with
  the use rights the person holds (`useActions`, a new field of `platform.context.get`).
  `catalyst setup` opens the confirmation with `level=use`, which starts the key with the
  reading, writing and publishing rights the person holds and the level ticked (deleting is
  never ticked; `authoringActions`, a new field of `platform.context.get`); `catalyst login`
  and a code typed by hand start with nothing ticked.
- **Effect on an operated instance:** nothing changes for existing keys, which carry no use
  right. Rollback is a redeploy of the previous release; keys issued with the level then fail
  to parse those scopes and lose them, and are best revoked.
- A Data Store's page says where its rows come from and who reads them (DS-13a), right after its status. "Filled by" lists each published Workflow or App that adds rows to the store, with every Connection it calls and the account a Workflow runs as. "Read by" lists the published Apps with the workspace that opens them, the Knowledge Bases on the store, and who has direct access by a grant; instance admins always see everything, which the section says once. A caller who does not administer users is told how many hold a right and that a Workflow runs as a technical account, never who or which. What the caller may not see is counted in the section where it would stand. Everything is read from the published definitions at each look, so what was published before this release is shown the same way; no migration.
- An App says where its data comes from, one sentence per Workflow or App that fills a store it reads: "Shows data from “Clients”, which the Workflow “Nightly import” copies from CRM." Whoever uses the App reads it from a button beside the App's name; builders also find it first in the App's details. It never names an account.
- `GET /api/v1/app-data-sources?app=` (`data_stores.app_sources`) answers where the data of one published App comes from, to whoever may use or read the App.
- `GET /api/v1/data-stores/:store/used-by` (`data_stores.used_by`, `catalyst data-store used-by`) answers, for each App and Workflow, whether it reads or adds rows, the Connections its rows come from, an App's audience and a Workflow's account, and newly the Knowledge Bases on the store, the store's readers, `hidden.knowledgeBases`, `hidden.fills` and `hidden.reads`. The fields it answered before are unchanged.
- Configure Workflow step concurrency with `workflows.stepSlots` (default 4, integer 1–64). Workers and loop run views use the setting. Code sandbox concurrency is capped by both this setting and `workflows.codeSteps.slots`; the startup memory check counts that effective concurrency. Invalid values stop startup.
- Agents with platform tools can test the conversation's subject Workflow draft with `workflows.test`, whose release default policy is `allow`, and read progress and step targets and results with `workflows.get_run` and `workflows.list_step_runs`. Test runs act as the person, bounded by the Workflow's principal; changing steps remain Simulated. Testing another Workflow is refused with "An agent may test only the conversation's subject Workflow". These tools expose no "Run live once" switch and do not start published Workflows. The tools also work in standalone Agent Run workers.

- Successful Workflow run and step reads from the UI leave no Operation Run or audit rows; agent calls of the same operations remain recorded.
- **Apps:** Apps can load fonts from their own folder or inline data. App Kit 1.5.0 adds Inter,
  Lora, IBM Plex Mono and Bungee as local WOFF2 files with SIL OFL 1.1 licences and a
  single fonts.css stylesheet. React CSS can import the kit stylesheet and reference
  its font URLs directly. Agent guidance explains that fonts and libraries must
  come from the App folder or kit; outside font services and CDNs remain blocked.
- **Chat:** A message sent while a run goes waits in the conversation's queue instead of being refused. Send stays beside Stop while there is text, and the queued messages stand above the composer, oldest first. Their author may edit one, which puts its text back into the field, or remove it. Other members see the queue, with their messages marked "From another member". After a failed or stopped run the queue reads "Queue paused" and says it continues after the next message is answered; the author of the oldest message may send it now or discard their messages, and for anyone else the oldest row says only its author can send it now. While the queue is paused, every open page reads it again every ten seconds, so another member's change shows without a reload. The queue lives on the server, so a reload or a second tab shows it. "Wait for the current response to finish" is gone.
- **Chat:** A run that ended with an internal, aborted or unknown failure reads "The reply was interrupted. Please send your message again." in the person's language, no longer the worker's "Agent run failed". Only a cancelled run reads "The reply was stopped."
- **UI library:** `Button` has the variant `solid`, the one full fill in the text colour, and `ComposerFrame` frames a message composer and the tray above it.
- **Knowledge Bases:** `knowledge.<id>.add_files` (`POST /api/v1/knowledge-bases/:knowledgeBase/files`, right `knowledge_base.write`) adds files of Conversations the caller can read to a Knowledge Base without a `backend`, up to 20 per call. Each is copied into a Managed File the Knowledge Base owns, with an object of its own under `knowledge-bases/<asset id>/` in the store `infrastructure.objectStorage.files`, and gets a row in the Knowledge Base's store, `pending` until the index job of a later release reads it. The copy follows the Knowledge Base, not the Conversation: deleting or expiring the Conversation removes the Conversation's own file and leaves the copy, and the orphan sweep never removes a file an Asset owns. Every user of the published Knowledge Base will find an added file once it is indexed, without a publish. The audit event `knowledge_base.files_added` names the Knowledge Base, the file ids, the count and the bytes, never a file name.

- **Refusals:** A file the caller cannot open, or that does not exist, is refused alike with 404, reason `knowledge_file_not_available`. A file in another format than TXT, Markdown, PDF or DOCX is refused with `knowledge_file_format_unsupported`; PDF and DOCX on an instance without the module `documents` with `knowledge_file_format_unavailable`; a file over 25 MB (`KNOWLEDGE_FILE_MAX_BYTES`) with `knowledge_file_too_large`; a Knowledge Base that would then hold more than `knowledge.maxDocuments` documents with `knowledge_documents_limit`; a Knowledge Base whose store is not ready with `knowledge_store_not_ready`; an instance without `infrastructure.objectStorage.files` with `knowledge_files_unavailable`. A Knowledge Base on a Data Store has no `add_files`. A refused or failed call leaves no copy and no object behind: it removes what it copied, and the job `knowledge_base.clean_files`, which every call queues before it copies, removes what a process that ended in the middle of a call left. A removal marks copies deleted first, then waits for the lock that writing documents takes and deletes only the objects of copies no document names; a copy a document names is marked available again. A call still running when its copies were marked is refused with 409, reason `knowledge_files_released`, and writes no document. No document loses its bytes, however either side stalls. Each copy keeps an object of its own, so two documents of the same bytes keep two objects.

- **Release config:** `knowledge.maxDocuments`, the most documents one Knowledge Base holds, 10,000 by default.
- **Rights on Apps, Data Stores, Knowledge Bases and Workflows for one person (RIGHTS-1c):**
  the Access page and `permissions.grant` give `app.read|write|publish|delete` and
  `data_store.read|write|publish|delete` in one Shared Workspace, on one App or Data Store, or
  for the whole instance; `knowledge_base.delete` and `workflow.delete` on one item or for the
  instance. A new right is never written in a Namespace; rows that had one keep it until the
  Namespace retires.
- **The data of a Workflow's runs** (`workflow.read_run_data`) is given on one Workflow only,
  and giving it, or lifting a deny of it, asks every right of the Service Principal the
  Workflow's published and newest revision name, as a publish does: "This call does not hold
  'connection.use' on the whole instance, and 'workflow-runner' would act with it".
- **Instance scope in the grant operation** for every grantable right no legacy key carries
  (Connections, Apps, Data Stores, Knowledge Bases, Workflows, `guardrail.publish`). Such a row
  is listed on the Access page and revoked there; an instance row of a legacy key's action
  (agents, skills) is still changed on the Users page only.
- The member role gains no `workflow.publish`.
- **Effect on an operated instance:** nothing existing changes; admins can hand out more
  narrowly than the role. Rollback is a redeploy; instance rows written for the new rights
  then stay in the table, unlisted and still evaluated, and are best revoked first.

- New Namespace grant rows are refused for every action, while existing rows stay readable,
  listable and revocable. The New right dialog limits kinds, verbs, scopes and resource choices
  to the giver's effective rights, including denies; the server re-checks every submitted row.
- The local demo seed gives rights on existing assets, including Kai’s prepared drafts,
  without writing new Namespace rows.
- **Agents:** An agent's save of an agent that exists is now a pending change proposal of its Build conversation, not a refusal with `no_draft`. The live agent stays as it is; a read in that conversation answers the proposal, and each save advances it. `agents.proposal.get`, `agents.proposal.apply` and `agents.proposal.discard` let the conversation's creator read, apply or drop it. Apply needs the rights of a save of the agent, `agent.write` among them, and writes one live revision through the write rules, `asset.before_write` guardrails, revision and audit. Apply names the proposal revision the person read (`REVISION_CONFLICT`, reason `proposal_changed`, otherwise) and refuses a proposal whose base is no longer the live revision with `CONFLICT`, reason `stale_base`; the agent's next save bases it on the live revision again. A proposal's revisions count on across an Apply or a Discard, so a revision the person read names one proposal's content only. A proposal is checked as an agent definition and against the instance's editable agent fields when it is saved, and the agent is told which field it may not change. Deleting a conversation removes its proposals.

- **Editable agent fields:** A save of an agent stored without a field at its default, such as `skillNames`, no longer counts that field as changed, so a save of the instructions alone is allowed where only `instructions` is editable.

- **Database:** Migration `0091_agent_change_proposals` adds the tables `agent_change_proposals` and `agent_change_proposal_revisions`. Apply it before starting API and worker processes. It only creates tables, so the previous release keeps running on it; rolling back leaves pending proposals stored and unused. Proposals hold agent definitions, are kept only until Apply, Discard or the conversation's deletion, and never enter audit.
- An agent's page shows the change the agent in the dock proposes for it. Each section with a proposed change carries a "Proposed change" mark, and under each changed field the proposed value stands beside the live one: the text in each language, the instructions, the model settings, and the skills, tools, Knowledge Bases and starters it adds or removes. A person who may change the agent gets Apply and Discard. Apply sends the proposal revision they read and makes it the live agent, and the marks go. When the agent changed its proposal in the meantime, the page reads it again and says so. When the agent was saved since the proposal was made, the page says the proposal can no longer be applied and to ask the agent in the chat again, and offers no Apply; a newer proposal shows again as usual. Apply waits, and says so, while the person has unsaved changes of their own, and the fields stay locked while Apply or Discard is on its way. A person without the right to change the agent sees the marks, no Apply or Discard, and who can apply it.
- The UI library has `ProposedValue`, the proposed value of a field shown under it, and `Section` takes a `state` after its title.
- **Agents:** `agents.try.open` opens the Try conversation of an agent beside the caller's own Build conversation, and makes it where there is none: a second open answers the same one. The Build conversation is the caller's conversation about that agent; any other conversation is refused with `NOT_FOUND`, as a missing one is. It needs the write right on the agent, as Apply and Discard do. The Try conversation is private to its creator, shows in no conversation list, and answers `preview: true`. Every model usage event of a Try conversation carries `preview`. Applying or discarding the Build conversation's proposal for the agent deletes its Try conversation, and so does deleting the Build conversation; each deletion is audited as `conversation.deleted` with `requestedBy` `proposal_applied`, `proposal_discarded` or `build_conversation_deleted`, and the conversation's audit and usage events stay. A Try conversation cannot be the Build conversation of another one. When the cleanup after a deletion fails, the deleted Try conversation stays in reach of the retention job's retry, also after a new open made another in its place, until the retry has removed what it left, such as its Operation Runs. The preview run itself is not in this release: a turn in a Try conversation still runs the live agent with its tools.

- **Account deletion:** A conversation that went with another one during the deletion of an account, such as a Try conversation with its Build conversation, no longer stops the deletion.

- **Database:** Migration `0093_agent_try_conversations` adds the table `agent_try_conversations` and the column `model_usage_events.preview` (boolean, default false). Apply it before starting API and worker processes. It only adds a table and a column with a default, so the previous release keeps running on it; rolling back leaves Try conversations listed as ordinary private conversations of their creator, and usage events written meanwhile keep their mark.
- Knowledge Bases on the built-in backend index their TXT and Markdown documents for keyword search in German and English (KB-5c). The job `knowledge_base.index` cuts the text by page and Markdown heading into passages of about 512 tokens with a title, path and heading prefix, and replaces a content's passages on every run. It skips a content already indexed at the current chunking revision. A document is `pending`, `indexed` or `failed` with one of the failure codes in `KNOWLEDGE_DOCUMENT_FAILURE_CODES`.
- `knowledge.<id>.list_documents` (right `knowledge_base.use`, `GET /api/v1/knowledge-bases/:knowledgeBase/documents`) pages the documents of a Knowledge Base with their state and failure code. `knowledge.<id>.retry` (right `knowledge_base.write`, `POST /api/v1/knowledge-bases/:knowledgeBase/documents/retry`) indexes failed documents again.
- PDF and DOCX are indexed through a durable extraction handoff. The index job queues `knowledge_base.extract`, and the handler from `defineKnowledgeExtractHandler` stores its result at `knowledge-bases/<kbId>/extracted/<sha256>.json` in the files store, then queues the index job again. Without an extractor the document fails with `knowledge_file_format_unavailable`. `verifyKnowledgeExtractor` is the contract test for an extractor. A stored text is used again when the chunking revision changes. A stored failure or a result without text is deleted before its document is marked failed, and Retry deletes any left behind, so Retry always extracts afresh.
- The audit event `knowledge_base.content_indexed` records file id, chunk and page counts or the failure code, without names or text.
- One conversation builds what an App needs (BUILD-ALL-1). The agent may create a draft with `platform.assets.put` also while the conversation is about an asset: the draft stays beside the subject, nobody's page moves, and the conversation shows "Workflow-Entwurf „<Name>“ erstellt · Öffnen" ("Workflow draft “<name>” created · Open"), whose link opens the draft's page with the conversation in the dock. The agent keeps checking and saving the drafts its conversation created by naming their `kind` and `name` with `expectedRevision`, and `workflows.test` reaches a Workflow draft the conversation created. An asset that existed before the conversation still changes only as its subject, after an open; any other save is refused with the reason `asset_not_of_conversation`. The tool descriptions ask the agent to say what it creates first. The first create of a conversation about no asset keeps making it the subject and moving the person there.
- **Connections:** An `mcp` Connection can sign in to its server with OAuth 2.1 (CS-4b2). Set `authScheme: oauth` and, where the provider issued a client, `settings.oauth.clientId` (and `settings.oauth.scopes`). The new operation `connections.oauth_start` (`POST /api/v1/connections/:name/oauth/start`) reads the server's challenge and metadata, registers a client by Dynamic Client Registration where the provider offers it and no client id is set, and answers the address to open in the browser. The provider sends the browser back to `connections.oauth_complete` (`GET /api/v1/connections/:name/oauth/callback`), which checks the state, the person, their `connection.write`, the Connection's revision and address and the issuer, exchanges the code with PKCE (S256) and `resource`, stores the token set in the Secret Store and connects the shared sign-in. It always answers `303` to `/build/connections?signIn=<connected or reason>&connection=<name>` under `instance.publicUrl`, never with a code, a state or a token. Only a person signed in to the instance in a browser completes a sign-in; a personal API key may start one, a Service Principal may not.

- **Release config:** `instance.publicUrl`, the origin the instance is reached at in a browser. The redirect URI of a sign-in is `<publicUrl>/api/v1/connections/<name>/oauth/callback`; without `publicUrl` a sign-in is refused with `oauth_redirect_unconfigured`.

- **Connections:** `connections.test` answers `oauth_required` for a server that refuses with a Bearer challenge and describes its sign-in, by the challenge's `resource_metadata` or by Protected Resource Metadata at its well-known address, and for an `oauth` Connection nobody signed in for. A Bearer refusal that describes no sign-in stays `unauthorized`. Moving a Connection to another origin or setting another auth scheme than `oauth`, at runtime or in release config, sets its sign-in `revoked` and deletes the token set, so moving back needs a new sign-in. A sign-in is refused before the browser is sent to an authorization endpoint that is plain `http` off the local machine. `connections.get` names the shared sign-in (`binding`: state, scopes, since when) and how the client is registered (`oauth`: `dcr` or `preregistered`, the redirect URI, the provider's host). Neither holds a token.

- **Audit:** The events `connection.oauth_client_registered`, `connection.binding_connected` and `connection.oauth_refused` record a registration, a completed sign-in and a refused start or callback with its reason. None holds a code, a state, a verifier, a client secret or a token.

- **Demo:** The sample MCP server serves its tools again behind an OAuth authorization server at `/dcr/mcp` (Dynamic Client Registration) and `/registered/mcp` (a pre-registered client) when `SAMPLE_OAUTH_ISSUER_BASE` is set.

- **Deployment:** Apply migration `0099_oauth_setup_session_resource` before starting API and worker processes. It adds two nullable columns to `connection_setup_sessions`, and the previous release stays compatible. A setup session stored by the previous release ends as expired.
- A shared OAuth sign-in of a Connection now lives on after it was made (CS-4b3). Its access token is refreshed under the binding's lease, so many calls at once make one refresh and one new secret version. A reading call is made once more after a 401; a changing call never is. A `403 insufficient_scope` answers `connection_needs_reconnect` with the scopes the sign-in lacks and keeps the sign-in. A refused refresh sets the binding to needs reconnect, deletes the token set, never falls back to the Connection's own secret, records `connection.binding_needs_reconnect` and files one Inbox notice (approval kind `connection_reconnect`) for those who may connect the Connection again.
- `connections.disconnect` (`POST /api/v1/connections/:name/disconnect`) ends a Connection's sign-in: the token set is deleted, then the provider is asked to revoke the grant by RFC 7009. The answer says `confirmed`, `failed` or `not_offered`, and `connection.binding_revoked` records it. Deleting the Connection, moving it to another server or setting another auth scheme ends the sign-in the same way, inside the transaction of the config write. A revert restores no token, a call waiting for the lease stops once the Connection is deleted, and an approved call made before a new sign-in fails as stale.
- The job `connection_bindings.keep_alive` refreshes every 6 hours the shared sign-ins no call used for 7 days, so a monthly Workflow finds its Connection connected. Personal sign-ins are never touched.
- Each Connection's OAuth callback has its own path, `/api/v1/connections/:name/oauth/callback`, so a provider's redirect URI names the one Connection it serves. A Connection signed in before keeps its sign-in; a redirect URI registered at a provider for the old path must be changed there.
- A sign-in refuses metadata whose token, registration or revocation endpoint, or a challenge whose resource metadata URL, is on a host that is neither the Connection's nor the issuer's, with `oauth_discovery_failed`.
- **Studio:** The New connection dialog signs an MCP server in with OAuth where its test answers that it needs a sign-in: the step names the provider's host and the permissions it asks for, says that everyone who may use the connection acts through that account, opens the provider in a tab of its own and goes on to the tools once the Connection is signed in. A provider that registers no client asks for the client ID and secret it issued, with the redirect URI to copy. A declined, expired or refused sign-in says why at the step.
- **Studio:** The page a sign-in lands on (`/build/connections?signIn=…`) says whether it worked, takes the outcome out of the address, tells the tab that waits and closes itself after a sign-in.
- **Studio:** The Connection page has a section "Anmeldung" for a Connection that signs in with OAuth: state, provider, account, who signed in and since when, the permissions granted, for a client the provider issued its ID and the redirect URI, and Anmelden or Neu anmelden. Its recorded state says "Anmeldung nötig" where nobody is signed in.
- **Studio:** An agent's Tools mark the tools of a Connection nobody is signed in to with "Anmeldung nötig".
- **Studio:** Editing the settings of an OAuth Connection keeps its OAuth settings and its sign-in scheme.
- Knowledge Bases on the built-in backend whose published revision lists `semantic` embed their passages (KB-5d). The index job `knowledge_base.index` starts generation 1 with the instance's `knowledge.defaultEmbeddingBinding` when the Knowledge Base has none. It records the binding, the model and the dimensions in `catalyst_kb.index_generations` and keeps the vectors in `catalyst_kb.embeddings_1` as `halfvec(<dimensions>)`. Passages without a vector go through `gateway.embed`, each with its title, file name and heading prefix, in batches of up to 2,048 passages (`KNOWLEDGE_EMBEDDING_BATCH`) and up to 150,000 estimated tokens with the prefixes, half of Azure's 300,000 per request. A batch the provider still refuses as too large (`max_tokens_per_request`, or a 413) is split in two, so the same request is never sent twice; a single passage it refuses fails the document with `knowledge_index_failed`. A passage that has a vector makes no call, so a rerun and a second file with the same bytes cost nothing. A document stays `pending` until every passage has its vector.
- A Knowledge Base with only `keyword` makes no embedding call and keeps no vectors. A generation whose binding is gone from release config, or now names another model or another length, gets no new vectors: re-embedding with another model is KB-8's re-index.
- Embedding calls are usage events with the purpose `knowledge_embedding`. Each names the Operation Run of the `add_files` or `retry` call that queued the job, that run's person and the Knowledge Base's workspace. When a usage limit refuses a call, the document stays `pending` with `waitCode: knowledge_usage_limit_reached` in `knowledge.<id>.list_documents` (`KNOWLEDGE_DOCUMENT_WAIT_CODES`). The job looks again every 30 minutes and goes on once the limit resets or is raised. A provider's 429 that outlasts the gateway's own waits queues the job for its `Retry-After`. Neither wait uses up an attempt.
- `fileJobs` of `createKnowledgeBases` takes the process's `embed`, and `KnowledgeEmbedding` lists the approved embedding models (`models`) beside the default.
- **Knowledge Bases:** Withdraw removed documents immediately and purge their unshared chunks, vectors, extraction results and owned files with a retryable job. Deleting a Knowledge Base cleans its files before dropping its store. Removal requires `knowledge_base.write`; deletion counts are audited without document text or file names.
- A new Knowledge Base in Build is made for documents ("Dokumente") or for tables of a data store (KB-5f). A Knowledge Base of documents names no backend and searches by words (`methods: [keyword]`); the choice is fixed once it exists, and it has no SQL test query.
- The page of a published Knowledge Base of documents lists its documents, newest first, each with its state: being indexed, searchable, or failed with the reason in plain words. The list is read again every few seconds while a document is being indexed. Whoever may change the Knowledge Base retries a failed document, adds documents and removes one through `knowledge.<id>.remove_documents`, after a confirmation that names it; whoever may use it sees the list.
- The Add dialog adds files uploaded in the conversations of the reader's workspace through `knowledge.<id>.add_files`. It names the limits of one add and keeps to them: at most 20 files, none over 25 MiB, and only PDF, DOCX, TXT and Markdown. `KNOWLEDGE_ADD_FILES_MAX_COUNT` and `knowledgeDocumentFormatOf` move to `@work-shape/catalyst-core`, so the dialog and the operation apply the same rule.
- While the store of a Knowledge Base of documents is being made, its state is `preparing` ("Being set up", "Wird eingerichtet") and no longer `needs_attention`, and the page reads it again every few seconds until the store is ready. A check that finds the store being made keeps nothing; `knowledge_bases.get` looks at the store while no check is kept and keeps the first check that finds it ready, so the page shows it ready without a check. `add_files` refuses files until then, as before.
- `knowledge.<id>.search` (right `knowledge_base.use`, `POST /api/v1/knowledge-bases/:knowledgeBase/search`) answers the passages of a built-in Knowledge Base's documents that match a query best (KB-7a). One statement fuses up to three ranked lists by reciprocal rank (k = 60): German and English full text, the words of each document's title and file name, and exact cosine over the active generation of embeddings (`catalyst_kb.embeddings_<generation>`, `chunk_id` and `embedding halfvec(<dimensions>)`) where the Knowledge Base searches by meaning. Without an active generation the search answers by words and titles. Withdrawn documents are left out in the same statement. The answer names the lists it fused under `signals`.
- With search by meaning the query is embedded once per call as model usage with the purpose `knowledge_query`, tied to the call's Operation Run. Every search is recorded: its run keeps a hash of the input, and the audit event `knowledge_base.searched` records a SHA-256 of the query, the result count, the lists fused and the duration. No query text, passage or file name is logged.
- The agent tool `knowledge.search` searches every Knowledge Base with documents assigned to the agent, or the ones named under `knowledgeBases`, as one recorded call of `knowledge.<id>.search` per Knowledge Base. It merges the lists by rank, numbers the passages `K1`, `K2` and so on uniquely within an Agent Run, and names under `skipped` each Knowledge Base the person may not use or that failed. Naming a Knowledge Base not assigned to the agent is refused.
- The page of a Knowledge Base with documents has a test search.
- **The confirmation in the Inbox (OP-4b2):** A confirmation addressed to one person, from an Agent Run nobody watched or from `catalyst app publish --yes` and `catalyst workflow publish --yes`, now shows as its own item. It is headed "Confirm an action" or "Confirm publishing “…”", says who asks on the person's behalf (the agent, or their command line), shows the frozen call or the publish review, and says "The run waits until you decide" or "Nothing is published until you decide", and that nobody else can decide it. It offers **Allow** and **Deny** ("Erlauben", "Verweigern") with an optional comment, and no request for changes and no Always allow. Its state reads "Waits for you", "Allowed", "Denied", "Expired" or "Withdrawn", and the item says what became of the call. A person who is not the addressee gets the not-found state the server answers, as before.
- The conversation of a run whose confirmation waits in the Inbox shows that it waits there, with "Open in Inbox", instead of Allow and Deny.
- The contract of synced sources of a Knowledge Base, as types and SQL with no behaviour yet (SRC-0). A Connector type may declare `documentSource` (`DocumentSourceCapability`: `list`, `changes` answering `not_offered` or a feed, `fetch` streamed under a size cap) with the item shape `documentSourceItemSchema` and `DocumentSourceError` for `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `unavailable`, `cursor_expired` and `over_limit`. `verifyDocumentSource` in `@work-shape/catalyst-connections` is the contract test kit a type runs in its own tests; `createFixtureDocumentSource` is the in-process `fixture` source it is proven against.
- The job kinds `knowledge_base.sync` (one per source at a time) and `knowledge_base.fetch` with payloads of ids only, the handoff of a fetched item into the index job (`knowledgeIndexPayloadOfFetch`), the input and output of `knowledge.<id>.sync`, `.sources`, `.source_items`, `.locate` and the widened `.retry`, and the failure codes `KNOWLEDGE_SOURCE_FAILURE_CODES`.
- The store of a built-in Knowledge Base gets `catalyst_kb` migration 2 (`sources`): the tables `source_items`, `sync_runs` and `source_cursors`, and `documents.source_item_id`. A store an earlier release left at level 1 reaches level 2 with its rows unchanged at the next start, without a publish: the new job kind `data_store.upgrade_owned`, due at each start and once a day, queues the migration of every store a Knowledge Base owns whose level is behind the release.
- A Knowledge Base definition reads `sources` (`id`, `connection`, `folders`, `include`, `exclude`). A draft with a source is saved; publishing it is refused with `not_supported_yet` until SRC-1a syncs sources.
- A Knowledge Base definition with `schedule` is refused on push with the reason: the field is withdrawn, because a synced source is kept current by its daily Workflow and background updates.
- **Knowledge Bases:** Synced Knowledge Base sources import initial and full listings in resumable pages and fetch batches of 100, with per-item retries, size checks and content deduplication. TXT and Markdown extraction results remain available for later reindexing. Source operations and publishing remain gated until SRC-1b.

- Fetch batches record terminal item failures and end a failed run after executor exhaustion. Listing resumes remember queued items, fetches claim individual items, and failed handoffs clean unadopted Managed Files. Cross-store writes use the owned-store-before-platform lock order.
- Removing a synced document locally is refused with `knowledge_synced_document_remove_refused`: "Synced documents cannot be removed locally. Remove them in the source or change the published source boundary." Fixture paths are relative to the boundary folder.
- Owned Knowledge Base migration 3 (`source_fetch_claims`) adds queue and claim markers. Apply through the existing owned-store upgrade job before serving source imports; rollback leaves these additive columns in place and must drain source jobs first. No platform migration.

### Changed

- The release's fresh consumer gate now seeds its sign-in user through the deployments' `seed-auth` entry before starting the server, generates its database password in the job, names the failing step on the run's summary page and prints the server's log when a start or request fails.
- **Docs:** the Connections section of the modules page no longer says MCP is the only connector type. It names both built-in types, `mcp` for a remote MCP server and `http_api` for a REST interface read by GET, and says a client assembly can register more.
- Remove the unused legacy permission resolver and role-permission list from core. The user administration model derives its legacy display from canonical role actions, and equivalence tests retain the frozen pre-AP-4 resolver.
- **Approvals:** Stopping an agent run withdraws its unexecuted approval request in the same transaction, removes it from approvers’ open Inbox lists, and records the reason “run stopped”. Completed calls retain their approval history.
- **Apps:** Save as app asks for the name only. The ID field is gone: the id is made from the name exactly as `app.save` makes it, so German letters keep their sound ("Über uns" is `ueber-uns`, where the dialog made `uber-uns` before) and a name of no letter or digit is `app`. A name whose id an App already has is refused at the name ("This name is already taken."), with the offer to update that App where the reader may write it; the refusal goes once the name is changed. Apps that exist keep their ids. The name is filled in with the folder's `app.yaml` name, else the `<title>` of the HTML file it opens, else the folder's name; `workspace.open` answers that name as `title` beside the revision it shows. The preview card and the preview panel head read that same name, not the opened path, and name no revision number: the card reads the name alone, or "Saved to the draft of …", and a refused open says the preview still shows the last version. On a phone the panel head's "Show chat" keeps only its icon, so the name has the row.
- "Edit with the agent" on an App draft or a Workflow keeps the page and opens the dock beside it. The dock's head names the agent with its mark and says "Working on:" the asset, and the empty conversation offers starters for the kind: "Add a field" and "Change the look" for an App, "Add a step" and "Run a test" for a Workflow. At phone width the dock lies in front of the page, and "Show page" brings the page forward.
- An empty Apps, Workflows or Data Stores list offers a person who may build there "Build one with the agent" with two examples, each opening the agent in the dock with its start, as the New buttons do; on Data Stores this also stands under the scope picker. Everybody else reads one sentence on what the kind is, never that a builder could add one. The Data Stores list no longer names the CLI or the API.
- **Agent page:** the model section says in one sentence what reasoning effort changes, and a
  default model the reader may not change says "Set by your instance" ("Von deiner Instanz
  festgelegt"). The instance default no longer shows its provider id, and the section's hint
  no longer speaks of model bindings.
- **Agent mark:** an agent has one mark everywhere it is named. The UI library's agent `Avatar`
  draws the agent glyph by default, so Studio's agent list no longer shows the name's initials,
  and the agent chip of the conversation and the dock uses the same mark as the Agents page.
- **Instance > Users:** every full name keeps its room. Last active, then Access, then Status fold into the details under the name when the list runs out of room, so at phone width the name reads whole and the folded values stay in the row. Sign-in methods left the list; the person's detail lists them under "Sign-in methods". An active account nobody has signed in to yet reads "Invited", in the list, its filter, the count under the title and the detail. The selection boxes are the library's checkbox.
- **UI library:** a `TableHead` takes a `priority`. Once the table cannot show every column at its full width, the column with the highest number folds first into the cell marked `rowDetail`, under the head's label. The table measures its box and refits as it narrows or widens. A table without priorities is unchanged.
- Usage shows the configured monthly euro budget beside the tokens used.
- The API keys and Workspace Members pages open with the person's existing keys and members. The join-request list appears only when a request exists.
- Permission refusals on these pages name the active instance admin who signed in most recently, excluding accounts being deleted and accounts that never signed in. The signed-in response includes one admin display name without opening the user directory.
- A refusal to create a key stays visible beside the dialog's actions.
- Refusals remain beside the affected Members section and dialog controls; refused key creation can be retried after editing a field, and refused revocation offers Close.
- Usage presents one monthly cost-and-budget answer, with tokens underneath and the over-budget warning retained.
- Show one not-found state, an icon, one sentence and one next step, where a page cannot find its subject: an address the interface does not know keeps its address and offers "To chat" instead of opening the chat start, an unknown Workflow offers the way back to the Workflows instead of a title placeholder that never ends, and an unknown agent's address in Studio no longer shows its id as the page title and offers "Back to Agents" ("Zurück zu Agenten") in the middle of the page. The UI library adds `NotFound`.
- A failed Workflow run's page offers "Fix with the agent" as its main button to whoever may write the Workflow: it opens the conversation about the Workflow in the dock beside the Workflow's page, with the run, the failed step and its reason in the composer, unsent. "Run again" stands beside it for whoever may start the Workflow. Each failed row of the runs list says why the run failed on a line of its own, in the sentence the run's page uses.
- Phone fit (UXA-7a): a table in a chat reply or a Markdown preview stands in the library's `Table` box, so a table wider than the message scrolls sideways inside it with the edge fade and shade instead of losing columns, and a cell is as wide as its content up to 16rem and breaks between words only, so a short value stays on one line and the cut falls inside a column; its copy menu stays, its fullscreen button is gone.
- A page head keeps its actions on one line. Where they do not fit, the secondary actions move into the head's "…" menu and the primary action stays, so no label is cut. Beside the actions a detail head keeps room for its name (the whole name or 160 px), so beside a dock the actions fold before the name is cut. Breaking for `@work-shape/catalyst-ui`: `PageHeader`'s `secondaryActions` is now a list of `PageHeaderAction` data, and `overflow` became `menu`, the items of the "…" menu whose button the head draws itself.
- The agent picker and every other `Picker` open at their first option; the keyboard starts on the chosen option where it shows, otherwise on the first.
- The command palette names each Settings page with its group, such as "Instance › Users" ("Instanz › Benutzer").
- The solid band under the phone's sidebar button gives way where a pinned detail head stands outside a conversation: on a Studio page, an App or a Workflow it covered the head, its name and its actions. Over a conversation, a list or a Settings page it stays, so nothing scrolls under the button.
- An App's view keeps Edit in its head as the primary action, so on a phone only "Edit with the agent" folds into the "…" menu.
- A shipped skill or Connection keeps "Copy to edit" in its head as the leading action, so on a phone it no longer folds into "…" while the notice under the head says to copy it. The German notice addresses the reader with "du".
- The work history in chat says what happened in words (UXA-7b). A read of a Connection names the operation and the Connection with the rows it brought back ("Read top customers from Sample business · 5 rows"), a view says what it showed ("Showed a table"), any other step shows its title or, without one, its name turned into words, and a failed step says so. A group of several steps is counted as steps. The input and output stand behind "Technical details" / "Technische Details", closed by default for a failed step too, and are not in the page until it is opened. Nothing stored changes.
- The chat start shows one style of suggestion: the prompts an agent's author wrote stand as the same cards as its skills' starters, in one list before them, with a prompt icon on the same tile and the request under its title. They no longer show as pills of their own. The list holds four at most: the author's prompts first, the skills' starters fill the rest. Every starter of a `StarterList` now stands as high as the highest, so one without a hint looks like the others. The icon registry gains `prompt`.
- A member sees the composer's model control only where the agent's author offered a choice: more than one model, or a reasoning effort left open. Where the author set the effort, the efforts the model binding allows are no choice by themselves, so the instance offers that model with no other effort to a person who may not write the agent (`config.get` and `workspaces.agents.list`). Whoever may write the agent is offered what the binding allows, as before. A member's earlier effort pick for such a model no longer applies; the run uses the author's effort. Starting a run holds to the same rule: `conversations.runs.create` and `conversations.runs.start` refuse such a person another effort (`effort_not_offered`), and refuse a model the agent does not offer (`model_not_offered`).
- **Apps:** `workspace.open` replaces `page.save` and `app.save` replaces `page.save_as_app`. `workspace.open` shows an HTML file or an App's folder in the preview and keeps nothing; a single HTML file, or a folder with an `index.html` and no `app.yaml`, opens as plain HTML. `app.save` takes the opened path and a name, makes the App with an id derived from the name and asks nothing; each later `app.save` in that conversation writes the App's next draft revision, which an open no longer does. An App saved from a Page that the former `page.save` kept under a name other than its folder's (`page.save {name: 'Offers', directory: 'offers'}`) keeps that folder: in its conversation, `workspace.open` of the folder and `app.save` write the App's next draft revision, and the App is the Page of that path from then on. Every name under `app.` but `app.save` stays kept for App actions; a release tool or operation named `app.<anything else>` is refused. Only the new names are offered to a model. A release config or a stored agent that names a former name still starts and logs `The release config names the tool 'page.save', which is now 'workspace.open'. Rename it: a later release refuses 'page.save'.` (or `Agent '<name>' names the tool …`); an agent write that names one is accepted. Rename `page.save` to `workspace.open` in the release config's `tools:` and remove both former names from agents' `toolNames`: every conversation offers the two tools where `apps` is on. Stored conversations keep showing calls of the former names. Rolling back to an earlier release offers the former names again, and Apps saved with `app.save` stay as they are; a release config that already names `workspace.open` names an unknown tool there, which enables nothing.
- **Apps:** Members read "App", "Entwurf" and "Vorschau" for what an agent builds, never "Page" or "Seite"; the empty Apps list says a saved App is its builder's and publishing it decides who else sees it.
- Store identical retained App Kit files once by content hash in the server package, preserving every versioned URL, released byte and serving policy.
- **Known Studio behaviour (AD-1, before AD-4):** A save writes the agent’s draft while the page still shows the live version. A second save is refused with HTTP 412 until the draft is published from the Try panel. AD-4 is in build.

### Fixed

- Resume Agent Runs after their waiting confirmations expire; Stop settles waiting runs and denies their held calls immediately, without a worker. Allow changing tools that require confirmation or approval at startup; reading tools that require approval remain refused.
- **Chat:** Queued follow-ups in shared conversations now show the other member’s display name. Names are resolved from current workspace access when the queue or run events are read, and are never stored in run events. Messages from unavailable authors or former members keep the generic member label.
- **Operations:** Agent calls that require approval now pause their run and keep the conversation busy. Approval executes the frozen call once and resumes with its result; rejection and seven-day expiry resume without executing it.
- Reclaim browser instance-state locks immediately when their holder process has died, logging the previous holder. Give every connection-editor test a free sample MCP server port so an orphan cannot answer with an old key.
- Keep `catalyst app publish --json` machine-readable when the revision is already published, returning the draft and published revisions with `alreadyPublished: true`.
- **Agents:** Readers with a right on one asset or workspace can load model and tool references without a failed request. Other agents' configurations remain protected by their own read rights.
- Reasoning efforts read as the same words in the composer, the agent page's effort choice and an agent's proposal, in English and German, and the effort "none" reads "Off" ("Aus"); the stored values are unchanged.
- A conversation still titled with the server's placeholder "New conversation" reads "Neue Unterhaltung" in German in the rail, the search, the dock head and the move and delete dialogs. The stored title stays "New conversation" in every language, so the server still replaces it with a generated title.
- The agent page tells a person who may change the agent but not its models that changing them requires the same “Manage agent model settings” right named on the rights screens.
- A folded text whose third line ends with a full stop no longer shows "…" behind it; a cut inside a sentence still ends with one "…".
- Instance > Users: the head counts one person as "1 user", and the New user form folds Advanced rights under the library's disclosure.
- Instance > Usage: a cost not known yet is said once per card, with no extra badge or sentence; a reached budget reads "Budget reached" and "Budget erreicht"; the cost tiles wrap a long value inside their box.
- Workspace > Members: both descriptions limit editing and publishing rights to assets the workspace owns, with agents and apps as examples; the German text names the rights instead of the English role names.
- Inbox: the Decided tab shows no count, so German "Zu entscheiden" fits the tab row.
- Record `workflow_run.cancelled` once for each child run cancelled when its parent ends, with the parent run id in audit metadata.
- Restore per-value Connection and Workflow contract documentation and remove the outdated migration snapshot packaging comment.
- Attribute cascaded Workflow Run cancellations to the actor who cancelled the parent and correlate every descendant event with the cancellation request.
- `pnpm db:generate` runs again without moving a file aside: the packaging rule that keeps migration snapshots out of the postgres-store tarball moved from `migrations/meta/.npmignore`, which drizzle-kit read as a malformed snapshot, to `migrations/.npmignore`. The packed file list is unchanged.
- While an Agent Run waits for a decision, the conversation's activity row says it waits for a decision or an approval instead of a working phrase, in English and German.
- Instance > Operations shows a confirmed or approved agent call that waits for its run's worker as "Confirmed, waiting to run" or "Approved, waiting to run", not as still waiting for confirmation or approval.
- Answering a confirmation after its time ran out says the call expired and nothing ran, instead of "already decided". `operations.decide` names that case in its 409 with `details.reason: "decision_expired"`; any other 409 of a decision means the call was decided otherwise first.
- **Follow-up queue:** Changes no longer deadlock with streaming agent-run writes. Worker observations and messages lock the conversation before the run, matching queue acceptance and withdrawal; durable event sequences keep their existing shared allocation and public shape.
- The Knowledge Base test of a cleanup that waits behind a document write starts the call only once its own lock on the documents is held. Before, the call could take the lock first and the test waited in vain for it to queue.
- Restore outside-host source checks for protocol-relative and backslash URLs, mixed-case schemes, and bare CDN guidance. Asset header checks now reject names and ids interpolated into template literals.

- Scan every manifest-referenced shared App Kit file for customer names, including font documentation and licences.
- **App builds:** CSS kit imports and font URLs now require the App's own kit version. A mismatched reference fails the build with the reference and the App's kit version instead of failing when the App loads.
- **App Kit:** Refuse unreferenced shared files at startup and before a kit release, and scan manifest-named shared content for customer names despite its extensionless storage paths.
- `docker/vivd-client.Dockerfile` installs and builds every workspace package a client declares as a dependency, together with that package's own dependencies, also where the client pins a released Catalyst version that the local workspace root links to source through an override (`pnpm dev:links`). Since the deployments pin `0.8.0-rc.2`, their local images built none of the linked packages: the build printed `No projects matched the filters` and stopped on `ERR_MODULE_NOT_FOUND` for `@work-shape/catalyst-client-assembly/dist/index.js`. The release images are unchanged; they build from the deployment kit's `docker/deployment.Dockerfile`.
- The client image's ignore file has no `!` exceptions any more (`!.env.example`, `!**/.env.example`). An exception makes Docker walk every excluded folder for a file to keep; from the local workspace root, whose `.worktrees` hold hundreds of gigabytes, loading the build context took 16 minutes before each image of a local deployment. It now takes about a second. The file also leaves out `.worktrees`, `.agents`, `.claude` and `.codex` at any depth, `.data`, copies of `.venv`, and the workspace root's `data` and `outputs`: the context falls from 1.65 GB to about 0.1 GB. No image used an `.env.example`.
- Document the private Postgres package's per-repository Actions access, workflow token
  requirements and `manifest unknown` diagnosis. Clarify that capabilities CI and deployment
  Compose still use stock Postgres; deployments now check their versioned npm packages.
- Let deployments supply React and React DOM through the chat UI and shared UI packages' peer dependencies, while retaining the tested runtime for core development. Release consumers verify both packages use the host runtime.
- Cover a deployment pin bump whose existing SheetJS lock entry loses its integrity during pnpm resolution; the deployment kit restores the verified hash before accepting the lockfile.
- **Release:** Authenticate registry waits when NODE_AUTH_TOKEN is set, so restricted packages can become visible without weakening the anonymous privacy check.
- **Retention:** Retry failed conversation database cleanup even when no file store is configured, including deleted conversations whose only remaining data is Operation Runs and their outputs.
- Explain rights through workspace ownership, list the scopes supported since RIGHTS-1c, and keep Namespace grants in a short legacy section: new Namespace rows are refused for every right while existing rows retain their effect.
- Mark Workflow run-data access as reserved for dataset downloads, with no additional access today, in English and German. Use “Wissensbasen” in the German personal-key hint.
- Serialize Stop, approval decisions and run expiry/recovery with follow-up queue changes by locking conversations before agent runs, preventing deadlock errors.
- Patch the remaining dependency advisories: Mermaid 11.16.1 and DOMPurify 3.4.17 in the chat UI's diagram rendering, nanoid 5.1.16 under Univer (an override, since Univer 0.25 pins 5.1.11), gRPC 1.14.5 and protobufjs 7.6.6 under Univer's protocol types, and Vitest 4.1.12, PostCSS 8.5.30, nanoid 3.3.20, source-map-js 1.2.2 and brace-expansion 1.1.21 and 2.1.7 in development tooling.
- **Agent runs:** Log explicitly cancelled agent runs as cancelled at info level with their run id and no error stack. Other signal aborts, including idle stops, worker shutdown and lost leases, keep their error-level diagnostics and stacks.
- Fifteen store lists and lookups ordered by a timestamp now end in the row's id (or a membership's user), so two rows written in the same instant come back in one order: a member's, the discoverable and the shared workspaces; a workspace's memberships, also while it is being deleted, and its access requests; a conversation's draft and sent attachments and the attachment found by checksum or by file; a file's and a conversation's managed artifacts; a conversation's structured data; and a conversation's latest agent run. No index or migration changes.
- The asset write history test reads call order from the revision each audit row names, not from the order of the audit list.
- You > API keys and the personal keys on Instance > API access name what a key may do as the rights screens do, in English and German ("Edit agents in kai-", "Agenten bearbeiten in kai-"), never by its scope id, as one muted comma-separated line that breaks between words. The New key dialog and a CLI's connect code offer the same titles, one under the other at every width. A key's start ("Starts with cat.apic_1f0c2a9e…", the first eight letters of its id) shows only where its owner holds another key of the same name, and wraps at a phone's width. An active key's status is green and Revoke is an outlined button. Times show no seconds. Name, status and Revoke always stay in view: the other columns fold into the details under the name before the table scrolls sideways, at 1280 and at 390.
- A table's folded value wraps under its label where the room beside the label is too narrow, so at a phone's width it no longer spills over the next column.
- A tab row that does not fit its width, such as the Inbox's at 390 with counts, fades the edge that hides tabs and scrolls the selected tab into view when it first shows and whenever another tab is selected. The row's line stays whole under the fade. `TabsList` and `TabsNav` now wrap their scrolling row in a frame that takes `className`.
- The sign-in choices of the New user form (invitation, password sign-in) are the library's checkboxes.
- Keep pinned chat notices and the conversation head opaque, preserve the header hairline beside panels, and place the scroll-to-bottom button above notices, queued messages and the composer at phone width.
- Keep covering panel heads compact, reveal clipped titles in a tooltip, and shorten the Save as app update offer so it stays within the form.
- Retry transient Workflow reading operation failures up to three attempts with the step job backoff. Source rate limits respect Retry-After without spending an attempt or holding a worker slot. Exhausted reads keep the operation error code; changing calls retain their existing replay rules.
- Stop the agent form browser test's old page before replacing its login session, so its pending workspace requests cannot run as the next person.
- Read the composer's live state at the moment of the action in three more places. Choosing a starter no longer collapses a selection made in the composer before its focus frame, a queued send decides from the composer's current text and readiness, and Enter decides from whether the thread runs now rather than at the last render.
- Preserve the composer's selection during delayed focus recovery so replacing starter text cannot append to it instead.
- Submit the composer's current text and send readiness when Enter or Send arrives before React's next render. A fast send while switching conversations is retained, and replacing a builder starter sends the replacement rather than the starter.
- Keep env examples out of deployment image build contexts and remove ignore exceptions that make Docker walk excluded directories.
- A conversation's thread is read at one moment. A queued follow-up that started while a page read the thread could be in neither the queue nor the transcript of that read, so the page stopped following and a member's message never appeared until a reload.
- A queued follow-up whose start is refused stays queued, and the queue reads as paused, instead of being dropped. Only a follow-up whose author can no longer act in the conversation is withdrawn. Every refusal is logged at warn level with its code and the check that refused, without the message.
- **Knowledge Bases:** Deleting a large Knowledge Base finishes. The purge goes in pages of 100 documents, each committed on its own, so an attempt that fails keeps what it deleted and the next attempt continues where it stopped. A missing object counts as deleted, and an object that cannot be deleted keeps only the rows that lead to it while the rest is purged. Such a deletion ends failed with `knowledge_purge_incomplete` on the store and in the audit event, and its job can be retried; the store is dropped only after its objects are gone. Removed copies no longer leave a Managed File row with their file name and checksum behind.
- **Knowledge Bases:** The documents page no longer offers Remove for a document synced from a source, because source withdrawal removes it and the instance refuses a manual remove. Where a remove is still refused with `knowledge_synced_document_remove_refused`, the page says why in the reader's language instead of the instance's English sentence. `knowledge_bases.list_documents` names the source of a synced document in `sourceId`.

- **Tests:** The large-source sync test imports 1,250 items instead of 10,000. That still crosses 13 listing pages and 13 fetch batches, and the test no longer runs at its drain limit.
- **Browser tests:** The page-frame browser check allows the title row to recover its space once after the header actions wrap. CSS wrapping and the deferred back-text measurement can appear in separate samples; both rows still give up chips and back text before cutting the name.
- Make the Users browser resize check observe an additional folded column before reading the phone layout. Last active can already be folded at desktop width.

### Database

- An agent whose config lists the tool `run_agent` hands sub-tasks to subagents (CR-1). Each subagent is a Child Agent Run in a run thread of its own that acts as the parent run's person; the parent starts its subagents at once, waits in the new status `waiting_for_subagents` at the end of its step with no lease and no job, and reads each subagent's answer once the last one ended. The operation is `agents.run`; an agent's config names the other agents it may start under `subagentNames`.
- Migrations `0096_subagent_runs` (columns and checks, added `NOT VALID`, under a 5-second `lock_timeout`: if it times out, run the migration step again) and `0097_subagent_run_indexes` (built `CONCURRENTLY`): `conversations` gains `kind`, `parent_conversation_id` and `workflow_run_id`, and its workspace and creator columns become nullable for a Workflow step's thread; `agent_runs` gains `parent_run_id`, `root_run_id`, `depth`, `parent_operation_run_id`, `workflow_step_run_id` and `principal_id`, and `owner_user_id` becomes nullable; `agent_run_observations.owner_user_id` becomes nullable; `workflow_step_runs.agent_run_id` and `model_usage_events.workflow_run_id` are added. The active-run index now counts `waiting_for_subagents`.
- A subagent never waits for a decision: a call it makes that needs a confirmation or an approval is not run and answers the tool error `confirmation_required` with the operation's name, and the parent's model makes the call itself under its own card. A subagent is never offered `run_agent`; a step starts at most 4 subagents and a run 16 (`subagent_limit`), and an agent outside the parent's own and its `subagentNames` answers `agent_not_available`. `background` and `continueRunId` are refused by the input.
- The parent's stream gains the observation `subagent_started`, and the thread snapshot's tool part carries the subagent it started. The API client skips an observation whose type it does not know, keeps the stream open and reports its sequence through `onSkipped`.
- `GET /api/v1/conversations/:conversationId/subagents` (`conversations.subagents.list`) lists a conversation's subagents. A run thread is read through its root conversation: whoever may read the root reads its threads, and `runs.start`, rename, subject, move and delete on a thread answer `CONFLICT` with reason `run_thread`. Deleting a conversation cancels its runs and its subagents' runs first and removes its threads with it; moving it moves its threads; retention never expires a thread alone.
- In the chat, a `run_agent` call is a card with the subagent's description, agent, status and duration, Stop while it runs and Open. The Resources panel lists the subagents first, under Active and Done. Open shows the subagent's thread read-only at `/w/$ws/c/$conv/subagents/$thread`, live while it runs, with Stop and the way back to its card.
- **Connections:** Add the storage of shared OAuth sign-in (CS-4b1) with migration `0095_connection_bindings`. The new table `connection_bindings` holds one binding per Connection and credential subject: its state (`connected`, `needs_reconnect`, `revoked`), the origin it was signed in for, the granted scopes, a lease and a row version. Every change names the row version it read, and a stale one changes nothing. The new table `connection_setup_sessions` holds a sign-in that is under way: the state as a hash and the PKCE verifier sealed with the Secret Store's keyring. A session is consumed once and expires after its time to live. The hourly job `connection_setup_sessions.sweep` removes expired sessions. `connection_state` gains the nullable column `oauth_client`. No column outside `secrets` holds a token: a binding names its token set by Secret Store handle and version, under the subject `oauth:shared`. This release adds no route and no sign-in yet.

- **Refusals:** A Connection type that lists the `oauth` auth scheme reads its credential from the binding. A Connection without a connected binding for its current origin is refused with `connection_not_connected`, and the call says `…cannot be used because nobody has signed in to the outside system for it. Trying again will not help until an administrator signs in under Studio > Connections.` A binding the outside system ended is refused with `connection_needs_reconnect`. A binding signed in for another origin is never used. No connector type lists `oauth` in this release.

- **Fixed:** Seeding a release secret no longer replaces a secret that was set on the instance between the seed's read and its write (S3-37). The write of a secret's next version now requires the version it follows, and a release seed replaces only a secret the release seeded. Removing a seeded secret that the release no longer names removes only the release's own.

- **Deployment:** Apply migration `0095_connection_bindings` before starting API and worker processes. It adds two new tables and one nullable column, and the previous release stays compatible. Rolling back leaves bindings and setup sessions stored and unused; the previous release neither reads nor sweeps them.
- **Conversations:** Add the server follow-up queue with migrations `0089_follow_up_queue` and `0090_follow_up_attachment_index`: `conversations.runs.start` accepts `followUp: "queue"` and returns a queued follow-up when a conversation is busy. Pending messages retain the author's agent, model and effort, claim their attachments, appear in the thread snapshot and emit `follow_up_changed`. Successful completion dispatches one compatible pending turn with the author's current access; failure or Stop pauses the queue. Authors can withdraw pending messages or resume an idle queue through `conversations.follow_ups.dispatch`.

- **Compatibility:** Callers that omit `followUp` still receive `CONFLICT` with `Conversation already has an active agent run`. Withdrawing another author's message is refused with `Only the author may withdraw this follow-up`; Send now by another author is refused with `Only the author may send this follow-up now`. Withdrawing an item that already ran is refused with `Follow-up was already dispatched`. The two unaudited queue controls are explicitly named in the operation inventory; its legacy baseline is unchanged.

- **Deployment:** Apply both migrations before starting API and worker processes. The attachment column is nullable and the migration keeps the previous release compatible. Rollback leaves pending messages stored but undispatched; the previous release does not understand their attachment claims, so drain or withdraw the queue before rolling back. No queued text or attachment content enters audit; `message.created` records `delivery: "queued"` only at dispatch.

- **Authorization:** Queue rows retain the accepting run's principal, delegation and credential scopes as server-only metadata. Dispatch rechecks the author's current conversation and workspace access and preserves those scope bounds. This metadata contains no token material, follows conversation deletion/retention, never enters observations or audit, and introduces no provider or region route beyond the existing selected model gateway.

- **Merged turns:** Dispatch consecutive pending messages as one turn only when author, agent, model binding, reasoning effort and accepting authorization match. Stop at the first incompatible pending item. Each message keeps its own ordered transcript row, attachment manifest and `message.created` audit event; all consumed follow-ups point to the same run. The last message is the run input so the model also reads every earlier message in that turn. Existing queue tables and indexes suffice; no additional migration or deploy step.
- **Knowledge Bases:** A Knowledge Base without `backend` keeps its documents in a Data Store it owns. Its `methods` are `semantic` and `keyword`, both by default. Publishing it makes the store through Data Store provisioning, with the platform's `catalyst_kb` tables, versioned with the release. It makes pgvector only where the Knowledge Base searches with `semantic`. Deleting the Knowledge Base drops the store's database and roles with the new job `data_store.drop`, audited as `data_store.dropped`. The drop removes only the database and roles the store's id gives. It refuses, audited with reason `store_names_not_its_own` or `store_names_shared`, where the record names others or another store's record names them. Provisioning that a delete overtakes removes what it made. `data_stores.list` lists the store as `knowledge-base:<id>` with `ownedBy: { knowledgeBase }`. The store has no operations and answers no SQL. This release adds no documents and does no search.

- **Refusals:** On an instance whose release config names no `knowledge.defaultEmbeddingBinding`, a Knowledge Base that searches with `semantic` is refused when it is written. The refusal says `Search with 'methods: [keyword]', or ask the operator to approve an embedding model.` A definition with `tables` or `structured` and no `backend`, or with `backend` and a method other than `structured`, is refused. Publishing a revision that changes a published Knowledge Base's backend is refused with reason `knowledge_backend_changed`. Bringing a deleted Knowledge Base back is refused with `knowledge_store_dropping` until its old store is dropped. Knowledge Bases on a Data Store (`knowledge.query`) are unchanged.

- **Deployment:** Apply migration `0092_data_store_owner` before starting API and worker processes. It adds the nullable column `data_stores.owner_knowledge_base_id`, and the previous release stays compatible. Do not roll back while a Knowledge Base without `backend` is published. The previous release cannot read its definition and does not drop its store. Delete such a Knowledge Base first, and wait until its store is gone. The image must make pgvector, which it trusts as of KB-3, before a semantic Knowledge Base is published. The store's roles get no rights on `catalyst_kb`. Backups keep a dropped store until they rotate.
- **Deployment:** Apply migration `0094_managed_file_owner` before starting API and worker processes. It adds the nullable columns `managed_files.owner_kind` and `managed_files.owner_id`; every existing file keeps no owner, and the previous release stays compatible. Do not roll back once a file was added to a Knowledge Base: the previous release's orphan sweep does not know the owner columns and deletes the Knowledge Base's copies, whose rows no Conversation refers to. Delete those files first, or keep the release.
- Migration `0098_conversation_created_assets` adds the table `conversation_created_assets`: which assets the agent of a conversation created, by conversation and asset, with the revision of the create. Its rows go with the conversation's data and with the asset.
- Existing agents now save one shared draft through Studio, Build conversations, revert and sync, including release sync. Creating an agent still writes its first live revision. Draft saves do not change the runtime snapshot or agent history. Reads stay live; holders of `agent.write` also receive draft revision, base, last author and time.
- `expectedDraftRevision` is an additive fence beside the live `expectedRevision`. An old caller without it can save only when no draft is pending. A changed draft answers `REVISION_CONFLICT`: "The agent draft changed. Read it again before saving", with `reason: draft_changed`, its current revision, author and time.
- `agents.draft.get` and `agents.draft.discard` replace `agents.proposal.get` and `.discard`; `assets.publish {kind: agent, revision}` replaces `agents.proposal.apply`. Publish needs `agent.publish` (admin by default; grantable on an asset or workspace). Personal keys use `config_assets:publish`; service principals cannot publish. A changed draft answers "The agent draft changed. Read it again before publishing" (`draft_changed`); a stale live base answers "The live agent changed since the draft was written" (`stale_base`). Release-written drafts retain release field rules at publish, including publication by a person when interactive asset editing is disabled. Approved skill attachments and their undo also move a pending draft and its base.
- Migrations 0103/0104 collapse proposals to one draft per agent: the newest pending head by update time, then id, wins; its revision rises to the highest counter for that agent. Attribution is backfilled before the source indexes are replaced by one unique agent index. Drafts survive conversation and account deletion. Publish and Discard delete every Try conversation of the agent, retaining audit and usage.
- **Deploy/rollback:** run both migrations before the new application. Supported stable releases do not use the proposal tables. rc.3 does: after this collapse a rollback to rc.3 can read the retained proposal but saving from a second Build conversation fails on the new unique index. Collapsed content cannot be recovered without a pre-migration backup. Source columns remain for that transition and need a later contract migration.
- **Workflows:** An `operation` step can wait on an operation whose work ends after the call (EW-ASYNC, engine half), with migration `0100_workflow_step_operation_wait`. An operation declares `completion: { mode: "async", stillRunning, example }`. Its call answers `running` with the run's id, and the Operation Run stays `running` until its owner ends it with `finish`. The step goes `waiting` on that run and holds no step slot. The transaction that ends the run (`finish`, or an interrupted run) queues the job of every step that waits for it, so the end of the run is never lost to a restart. The step then ends with the operation's result when it fits the output schema (`output_invalid` otherwise), or failed with the run's code.

- **Timeout:** An operation step takes `timeout` in minutes or hours (`30m`, `6h`). The default is `6h`, and the most is `12h`, the time a run may take. At the timeout the step fails with `operation_still_running` and the operation's `stillRunning` sentence, and the work goes on. The run page shows that sentence. Cancelling a run ends a waiting step `cancelled` and leaves the work running. A step job that is retried after its worker died finds the first call by the step run's idempotency key and starts no second call. A test run simulates such a changing operation and gives its `example` as the step's output.

- **Compatibility:** An operation with `completion` must be `changing`. A call through an agent tool answers `{ status: "running", operationRunId }`, and the HTTP face answers `202` with the run's `Location`. An App action that calls such an operation is refused. No operation of this release declares `completion`; the Knowledge Base sync that uses it comes with SRC-1b.

- **Deployment:** Apply migration `0100_workflow_step_operation_wait` before starting API and worker processes. It adds one partial index on `workflow_step_runs (operation_run_id)` for waiting steps. The previous release stays compatible, and rolling back leaves the index unused.
- **Confirmation in the Inbox (OP-4b1):** A call at `confirm` that acts for a person who is not there waits in that person's Inbox, and in nobody else's. The policy now says where a confirmation goes: the conversation, or the Inbox for an Agent Run marked unattended (set by scheduled starts once EW-8 builds them) and for a CLI call sent with the new header `Catalyst-Unattended: 1`. The header is read only from an API credential and only makes a call stricter: the call stays origin `cli` and is no longer its caller's own confirmation. A subagent is never unattended, and a Workflow's `confirm` still becomes an approval.
- The item is an `operation_call` Approval Request with payload `mode: "confirmation"`, addressed to its person through the new column `approval_requests.addressee_user_id`. Only the addressee sees, counts and decides it: `approval_requests.list` and `.count_pending` leave it out for everyone else, an instance admin and a holder of `operations.approve` included, and `.get` and `.decide` answer `NOT_FOUND`. A person who reviews no kind may now list the items addressed to them. Allow and Deny decide it; `request_changes` and withdrawing are refused. It expires after 7 days, and Stop on its Agent Run withdraws it. The request view gains `addresseeUserId`.
- The Operation Run stays `pending_confirmation` and names the item in `approvalRequestId`; the call's `202` answers that run. Allow records the decision mode `confirmed` and runs the frozen call once. `operations.decide` on such a call answers `CONFLICT` and names the item.
- **`catalyst app publish --yes` and `catalyst workflow publish --yes`** now send the publish unattended instead of refusing: nothing goes live, the command ends with exit code 3, the request id and "Waits in your Inbox". `assets.publish` is at least `confirm` for every call that is not its caller's own confirmation, whatever a central setting says. The person's Allow counts as their click on Publish: an instance approver's makes it live at once, and anyone else's files the `app_publish` or `workflow_publish` item, which ends the confirmation with the new execution value `held`. A run with no terminal and without `--yes` still publishes nothing.
- **Deployment:** Apply migrations `0101_approval_request_addressee` (adds the nullable column `approval_requests.addressee_user_id`, no backfill) and `0102_approval_request_addressee_index` (builds `approval_requests_client_addressee_idx` `CONCURRENTLY`) before starting API and worker processes. Rolled back, an older release lists such a request to holders of `operations.approve`; until EW-8 the only such rows are `--yes` publishes, so count them before rolling back.

## 0.8.0-rc.2 — 2026-10-16

### Changed

- Operated deployments use one exact published Catalyst version and their own frozen lockfile. The deployment kit removes source-pin updates and workspace preparation; use `catalyst-deploy bump <version>` and commit the manifest and lockfile together. Merge this cleanup only after VP-6 and VP-7 switch Musterbau and Catalyst. Earlier digest manifests remain readable for rollback; pre-switch releases use the kit and recovery procedure committed with their tag.
- **Test audit:** Test inventories now use per-rule lint fixtures and reviewed event and role-right snapshots. Plain-operation rights decisions remain checked against the catalog, and exact module inventories and operation counts are checked at the API seam.
- Trim duplicate discovery-tool integration checks and enforce asset-header and workspace-handle boundaries through lint rules with violation fixtures.
- **Migration tests:** Migration guards identify their named migration without depending on the latest journal entry, while preserving exact rollback replay and legacy-data checks.
- Route chat UI tests through one private test seam so folder moves do not rewrite their imports. Reject private chat UI imports outside that seam with lint; all existing assertions remain in place.
- **Test guards:** Make rights wording guards follow marked screens and translations across folder moves, verify Connect page API side effects by rendering, and carry the UI guard's unchanged counts in the shared quality baseline.

### Fixed

- **Release checks:** The deployment-kit version mismatch fixture stays different from the kit version after a release cut.
- **Release:** Publication now waits for a hosted scratch consumer to install the release tarballs without core's lockfile or third-party overrides and build the server and UI, catching incompatible third-party range drift before publishing. The same gate can be dispatched on a branch without publishing.
- **Deployment kit:** Document the buildx bake filesystem permission required for the CI npm secret outside the work tree.
- **Release safety:** Bound published auth, ORM, database, validation, React and server dependency ranges (including UI peers) to core-tested versions or minor lines. Fresh consumer release validation now migrates test Postgres, starts the installed assembly and requires a real sign-in plus an authenticated API request. Manual gate runs also prove the better-auth 1.7.10 / zod 4.4.3 regression is rejected at sign-in.
- **Release:** Retry transient npm registry failures while waiting for public packages, retaining the last HTTP status within the existing 20-minute deadline. Bound GitHub release notes and link to the full tagged changelog when truncated.

## 0.8.0-rc.1 — 2026-10-16

### Added

- **Connections made on the instance (CS-4, first slice):** Build > Connections has "New
  connection" for a remote MCP server: name, address and authentication (`none`, `bearer`, or a
  key in a named header). The asset operations now create, change, revert and delete a
  Connection of origin `runtime`; the server writes its origin, its owner (the writer) and its
  secret handle, whatever the caller sent. A Connection of release config stays read-only
  (`read_only_origin`), and a batch of `assets.sync` holding a Connection is refused with
  `connection_batch_unavailable`. A save whose address the operator's `egress.allow` does not
  name is refused with `egress_denied` before anything is stored; the list is asked without a
  DNS lookup. `connections.set_secret` (`PUT /api/v1/connections/:name/secret`) takes the key
  once, as the next version after the `expectedVersion` the writer read (`secret_write_conflict`
  otherwise), answers only the state and the version, and keeps a mark instead of the value in
  its Operation Run. `connections.discover` (`POST /api/v1/connections/:name/discover`) queues a
  discovery; every save and every new key queue one too. `connections.get` answers the tools
  the last discovery read that the Connection does not accept (`discovered`), and the page
  accepts one with its effect, for agents or not, pinned to the fingerprint it showed. A delete
  is refused with `409 connection_in_use` while an agent carries a tool of the Connection or an
  App names it, in its draft or in its published revision, and removes its key and its runtime
  state. Both operations need `connection.write`. A key is bound to the origin of the
  Connection's target (protocol, host and port) it was entered for: a save that moves the
  target to another origin removes it, a new path on the same origin or another Connector type
  with the same target keeps it, and a key is never handed to a test, discovery or call of
  another origin (`connection_not_configured`), also where its removal failed. Migration
  `0078_secret_origin` adds `secrets.origin`. **Upgrade:** an instance whose release config
  names `secretStore.keys` now needs the first key at start even where release config defines
  no Connection, and stops naming its variable without it. A secret of release config is bound
  to its origin by the seed at the next start. Shared OAuth, the CLI and the platform MCP tools for Connections are not
  part of this slice.
- **Personal API keys and `catalyst login`:** the module `personalApiKeys` (off by default)
  lets a person issue keys that act as themself, in Settings, API keys, or by confirming the
  code `catalyst login` prints; the CLI collects the key itself and saves it in
  `~/.config/catalyst/credentials.json` with mode 600. A key has a name, scopes
  (`agent.write` or `agent.write:kai-`; reading, writing, deleting and publishing actions
  only), and an expiry of at most a year. Every call acts as the key's owner with the owner's
  rights of that moment, intersected with the key's scopes, so a removed grant or a disabled
  owner narrows or stops the key at once; a refusal by the key reads `FORBIDDEN` with the
  reason `outside_key_scope`. Audit names the owner and the key (`credentialId`,
  `delegatedActor.kind: "api_key"`). Whoever holds `api_access.manage` lists and revokes
  every person's keys. A key cannot issue keys or confirm codes. A working copy may name its
  Namespace in `catalyst.yaml` (`namespace: kai-`); its push names it, and its pull, diff
  and list read only the assets the key may read, without the instance overview. Operations:
  `me.api_keys.list|create|revoke`, `me.connect_codes.get|confirm`,
  `connect_codes.start|redeem` (public), `personal_api_keys.list|revoke`. **Operators:**
  migrations `0075_personal_api_keys` (expand: `api_credentials.owner_user_id`, the owner
  check and foreign key `NOT VALID`, table `api_connect_codes`),
  `0076_personal_api_keys_validate` and `0077_personal_api_keys_indexes` (concurrent) run
  before the new release; the previous release runs on them unchanged, as it writes only
  service principal keys. Rolling back the release leaves personal keys stored and unusable.
  Turn the module on with `modules.personalApiKeys.enabled: true`.
- **Calls made by a draft (ADR-0031):** a call that carries a draft context (`OperationCall.draft`:
  the App or Workflow, the draft revision and the action or step) is decided in
  `runOperation()`. A reading call reads live with the caller's rights; a changing call answers
  `dry_run` with the input it would have been made with and whether the live call would have
  waited for a confirmation or an approval, changes nothing and holds no idempotency key. Every
  Operation Run records `target` (`live`, `test` or `dry_run`) and the run resource returns it.
  `assets.run_live_once` (`POST /api/v1/assets/:kind/:name/run-live-once`), for a holder of the
  kind's write right, switches one action or step of the current draft revision live for its
  next call; the switch is audited when set, used and cleared, and a switch whose draft changed
  since is cleared and never applies. A call of a Workflow test run (`draft.boundBy`) is made
  as the person testing and allowed only where the Workflow's service principal holds the right
  too; a refusal on the principal's side names it, and such a call cannot wait for an approval.
  Migrations `0073_draft_call_targets` (adds `operation_runs.target`, default `live`, and the
  table `live_once_switches`) and `0074_draft_call_targets_validate` (validates the check of
  `target`) are expand-only. **Rollback:** the previous release ignores the column and the
  table; runs it writes during a rollback get `live`, and switches set before it stay unused
  until a release that reads them, where a changed draft clears them.
- **Apps, an action that starts a Workflow (App Kit 1.3.0):** an action file
  `actions/<name>.action.yaml` with `workflow: <id>` and `input.schema`/`input.mapping` starts
  the published Workflow as the viewer, who needs `workflow.use` on it; without it the call is
  refused with the right named. Its effect is always `changing`. The call answers
  `{ runId, status, result }` with the Workflow Run in `result`; the Page follows it with the
  kit's `useWorkflowRun(result.id)` or `workflowRuns.get(result.id)`, through the new operation
  `apps.sessions.get_workflow_run`
  (`POST /api/v1/app-content-sessions/:pageSessionId/workflow-runs/:runId`), which reads only
  runs of the Workflows the App's actions start and only for the viewer who started them. In a
  draft the call starts nothing and answers `status: "dry_run"` with "Would have started the
  Workflow '<id>' with <input>". The build refuses a Workflow action in an App on a kit before
  1.3.0. `page.save` documents the kind. The kit's `page.css` for a plain Page leaves out the
  flow canvas rules the library's stylesheet brings. **Operators:** the chat-server tarball
  limit rises to 2.1 MB for the fourth kit version.
- **Cards open as a whole:** the UI library's `CardTarget` marks a card's one link or button to
  what the card stands for and stretches its clickable area over the card. Every other control
  in the card keeps its own action, the keyboard meets the target once under the name of its
  action and the card's title ("Open Trip planner"), a press dragged across the card opens
  nothing, and the card shows the hover state and its target's focus on its edge. Text under
  the area cannot be selected; `CardReachable` keeps content such as a time with its full date
  as a tooltip, or an id to copy, above it. Agent cards start a chat, App cards open the App (a
  builder's draft-only App opens its draft) and Workflow cards open the Workflow, from a click
  anywhere on the card. A card whose reader has nowhere to go opens nothing.
- **Guardrails replace approval checks, and Build lists them:** release config takes
  `guardrails`, keyed by name, each with `on: approval_request.before_create`, an optional
  `filter.kind`, a `check` of kind `model_judge` (`modelBindingId`, `instruction`) and
  `outcome: warn | block`. They run where approval checks ran, with the same judge, timeout and
  usage purpose `guardrail_judge`. The API seeds them as read-only assets of the kind
  `guardrail` when it starts; Build > Guardrails lists them with their newest 50 hits for
  holders of the new right `guardrail.read` (administrators), read through
  `guardrails.list_hits` (`GET /api/v1/guardrails/:name/hits`), with counts for the last 7 and
  30 days. A hit keeps the guardrail, the outcome, its reason and the kind of request, never the
  checked content and never the person: hits are counted by rule and period, not listed by
  person (works-council co-determination). Hits are deleted with the audit events (migration
  `0071_guardrail_hits`). Every write of a guardrail
  through the asset operations is refused with the reason `guardrail_release_config_only`.
  **Operators:** `approvalChecks` still loads for this release, each check as the guardrail it
  became (`id` the name, `appliesTo` the `filter.kind`, `onFail` the `outcome`). A config with
  both keys stops startup with "'approvalChecks' was replaced by 'guardrails', and the config
  sets both. Move each approval check into 'guardrails' and remove 'approvalChecks'." The next
  release refuses `approvalChecks`; move the checks now. **Rollback:** an earlier release
  ignores the table `guardrail_hits` and the stored guardrails, and it does not read
  `guardrails`: roll back with the config that still has `approvalChecks`, or the instance runs
  no checks.
- **Guardrails answer at every before-event:** a guardrail of release config binds to
  `asset.before_write` (each asset `assets.put` and `assets.sync` save, an agent's save of its
  conversation's subject, and the skill a `propose_skill_change` would write), `operation.before_call` (every call, and the operation an App's or a Page's action calls,
  such as a Data Store's insert, with that operation's name), `app.before_publish`,
  `workflow.before_publish` or `approval_request.before_create`. The before-events of a call go
  through the event emitter, which runs the guardrails bound to them. A `filter` narrows by
  what its event knows: `kind` (an asset's or a request's), `operation` (a name or a prefix
  ending in `.*`), `origin` (`agent`, `user`, `cli`, `mcp`, `app`, `workflow`, `schedule`) and
  `agent`. A new check kind `pattern` matches an RE2 expression (no backreferences, no
  lookaround, linear time; `re2js`) over the fields the event declares checkable: `name` and
  `content` of an asset, `input` of a call, `summary` and `newContent` of a request; a check may
  name `fields`, and a pattern a `reason` it is shown with. A new outcome `require_approval`
  holds a changing call for an approval in the Inbox and refuses a read; an outcome `allow`
  lets the action go on and never overrides another answer. Patterns run first, and a block
  among them skips the judges. Every guardrail that applies runs and the strictest answer wins.
  A refusal names the guardrail, the asset and the reason, as `GUARDRAIL_BLOCKED` with
  `details.guardrailId`, and `catalyst config push` prints it. Content longer than 2 Mi
  characters is not read in part: a guardrail that blocks or holds answers as on a match. A
  pattern reads less the larger its compiled program is (40 million steps a field, about half a
  second at most on the server's one thread), so no pattern holds the server. A hit
  now names its subject (the asset's kind, id and name, or the operation's name, never the run
  and never a person), and Build > Guardrails links an asset's hit to its page (migration
  `0072_guardrail_hit_subject`). A call that waited for an approval is asked again before it is
  executed without keeping a second hit. **Operators:** release config refuses at start a
  pattern RE2 does not compile, one longer than 2,000 characters, one whose program is too large
  to read 64 Ki characters (such as `[a-z]{1000}`), a filter key or a field its
  event does not have, and `require_approval` on `approval_request.before_create`.
  **Rollback:** an earlier release ignores the two new columns, and refuses a config with a
  guardrail it does not know: remove guardrails on the new events, of kind `pattern` or with
  the new outcomes before rolling back.
- **Guardrails read every way content reaches an asset or goes live:** `asset.before_write` now
  also answers `apps.create_from_page` and `apps.update_from_page` (the App's definition and
  the Page revision the write copies: the write copies the revision the guardrails read; a call
  held for an approval, by a guardrail or by a policy, keeps the revision there was beside its
  input (`heldInput` of the request, only in the fields the operation declares), so the call
  the approval answers is checked again and writes exactly that revision; the new optional `fileSetId` names a revision to copy, and a
  revision that is gone is refused with `CONFLICT`), the agent's `page.save_as_app` (held for an approval, it too keeps the revision its guardrails
  read) and the App draft a `page.save` writes (the revision the save stored; a block or a hold
  leaves the draft unwritten and says why, as the Page is saved already), `assets.revert` (the
  earlier revision it writes again, also one written before the
  guardrail existed), an approved skill change before it is applied (the skill as the approval
  writes it) and the undo of an approved skill change (`approval_requests.revert`, the revision
  it writes back). A block at the approval leaves the skill unchanged and ends the request as
  not applied (`superseded`, `applyResult.execution` `refused`, `GUARDRAIL_BLOCKED` with the
  reason), which the Inbox item shows; a block at the undo refuses it and the request stays
  approved. A new before-event `data_store.before_publish` answers the publish of a Data
  Store, with the revision's definition and migration files. A UTF-16 text file, with its byte
  order mark or with a NUL in every other byte of its start, is read as text. Any other file that is no UTF-8 text is no longer skipped: a
  `pattern` reads its printable runs (line ends included) of at least 4 characters, so a photo
  passes whatever its size, and only text counts toward the limit of what a check reads and text hidden beside a NUL byte is found; a `model_judge` reads the printable runs of
  at least 16 characters of an image or a font and answers any other such file as unread. A refusal for content that is
  too large or cannot be judged no longer says to try again. A block found when a held call
  or an approved change is asked again is kept as a hit. A revert and a publish read no
  revision of an asset of another scope than the call's: the call is refused as before, with
  no guardrail asked. **Access:** `apps.create_from_page` and `apps.update_from_page` ask
  whether the caller reads the Page before the guardrails read it, so a Page the caller
  cannot read answers 404 before any check; `assets.revert` now needs the read right on the
  asset beside the write right, as a revert restores content its guardrails would answer
  about. **Operators:** a rule that should keep content out of live Apps needs an entry on
  `app.before_publish` beside the one on `asset.before_write`; the demo's IBAN rule has both.
  **Rollback:** an earlier release refuses a guardrail on `data_store.before_publish`: remove
  it before rolling back.
- **Embedding models:** a model binding of `kind: embedding` with `dimensions` turns text into
  vectors for Knowledge Bases, and `knowledge.defaultEmbeddingBinding` names the default. The
  gateway's `embed` is the one path for an embedding call, admitted, retried and settled like a
  chat call, with the usage purpose `knowledge_embedding` or `knowledge_query` and no output
  tokens. `openai-compatible` posts to `<baseUrl>/embeddings` (Azure OpenAI's v1 endpoint
  included) and `deterministic` returns vectors from a hash of the text. Startup stops on an
  embedding binding whose entry has a region other than `eu`, one without `dimensions` or with
  `agentSelectable: true`, one on a provider that does not embed, a default that names no
  embedding binding, and a guardrail or conversation title generation that names one.
  Nothing calls `embed` yet; Knowledge Base ingestion and search follow. Existing config is
  unchanged: a binding without `kind` is a chat binding.
- **Skills that ship with the platform:** the guide to the platform (`platform-guide`) and, with
  Workflows on, `workflow-authoring` are stored skills of origin `release`. The API process
  writes them at start: a changed one gets a revision in History, one a release no longer ships
  is deleted, and the same release writes nothing. They are read-only: a write, delete or revert
  of one is refused with `403` and the reason `shipped_skill`, and a skill that names `origin`
  or `icon` is refused with `422`. A skill of the instance's own under the name of either is
  refused with `422` whether Workflows is on or not: "The platform ships a skill named '<name>',
  also where its module is off: choose a name of your own". Studio lists them with the label "Platform" and offers "Copy
  to edit", which creates an ordinary skill. The config CLI neither pulls, diffs nor prunes
  them. **Upgrade:** an instance that holds a skill of its own named `platform-guide` or
  `workflow-authoring` stops at start with "The platform ships the skill '<name>', and a skill
  of that name was created on the instance"; rename that skill before the upgrade. A rollback
  leaves the stored shipped skills in place until the next start of a release that ships them.
- **Data Stores, the reads of a store's page:** `data_stores.list` (`GET /api/v1/data-stores`)
  lists the stores a caller may read with the size, the number of tables and the estimate of
  rows of the last measurement (migration `0069_data_store_table_counts` adds the two columns;
  absent until measured). `data_stores.rows` pages through one table by keyset on its primary
  key, at most 50 rows a page, values cut at 1,000 characters, and `data_stores.value` reads
  one value whole; a table without a key is paged in physical order and the answer says so.
  `data_stores.used_by` names the published Apps and Workflows that use a store, as far as the
  caller is shown them, and counts the others. `preview_rows` is unchanged. On a store's page
  in Studio a Workflow under "Used by" is a link to its page, as an App is, for a reader the
  Workflows area is open to.
- **YAML anchors with aliases are refused** in the frontmatter of a `SKILL.md`, in `store.yaml`,
  `workflow.yaml`, `app.yaml` and an App's action files: nested aliases in a file of a few
  hundred bytes made a value of any size for whatever read it. A file that uses one is refused
  with a sentence that says so; write the value out where it is used.
- **Skills as folders of files, in the public skill convention:** a skill may carry real files
  beside `SKILL.md` and its text resources, at any path, and a folder taken from a public skill
  library round-trips byte for byte. `title` is optional in the frontmatter and derived from
  the content or the name; further frontmatter keys are kept as `frontmatter`; a skill name may
  start with a digit; a name or description outside the convention is answered with a warning. `assets.put` takes the whole folder
  as `files` and `assets.get` with `files=true` answers it byte for byte. The config of a skill
  is unchanged for a skill that is text alone; other files are kept in the file set of the
  revision and named in the config's `files` index (path, hash, size, media type). A write of
  the config alone leaves them in place, and a revert brings a revision's files back. Compiled
  programs, Git LFS pointers, files below `scripts/` and text files that are no UTF-8, a `SKILL.md` below the
  root and files or folders over the limits (2 MiB a file, 500 files, 8 MiB a skill) are refused
  with their path and a reason. No database migration: a revision from before reads from its
  config. An agent's proposal no longer creates or changes a resource below `scripts/`.
- **Claude on Amazon Bedrock:** a model provider `aws-bedrock` beside `openai-compatible` and
  `google-vertex`. It calls Claude through the Bedrock runtime in Frankfurt
  (`eu-central-1`) with a Bedrock API key named by `credentialSecret` (default
  `AWS_BEARER_TOKEN_BEDROCK`). The entry must state `region: eu` and `accountId`, and `model`
  must be the ARN of an application inference profile of that account in `eu-central-1`: a model
  id, a shared `eu.anthropic.…` profile, another region or another account stops startup. It
  carries text, images, tool calls and streaming, and a binding on it can be chosen for agents.
  An answer has at most 16,000 output tokens, thinking included. The reasoning efforts `low`,
  `medium` and `high` ask for adaptive thinking, and the thinking of a turn that calls a tool
  goes back to Bedrock unchanged with the tool's result. A PDF is sent as a document; one above
  4.5 MB, or more than 100 pages in one request, is refused with the reason `document_too_large`
  or `document_too_many_pages`. A JSON answer format is sent as the Messages format's structured
  output. It does not carry web search. It is checked against Claude Sonnet 4.6 only, on
  recorded exchanges: keep a Claude 5.5 profile out of the config until the adapter has run
  against one. **Operators:** the API and the agent
  run worker need the secret. Startup stops unless `usage.costs.customer.models` holds a row
  with a price above zero for the entry's model and for the model of every binding on it. The
  adapter fixes the endpoint; the profile, the key's IAM policy, Bedrock's data retention and
  invocation logging decide the rest and are the operator's to set, see the configuration docs.
- **Workflows, editing with the agent from the page:** the page of a Workflow offers "Edit with
  the agent" to a person who holds `workflow.write` and is shown the draft. It starts a
  conversation of the open workspace about that Workflow and opens it. Where the draft is not
  the published revision, a bar on the page says so, and says of a draft that was never
  published that it is not published. The bar offers Publish to a holder of `workflow.publish`
  and Discard to a holder of `workflow.write`, each after one question; a refusal of the
  instance is answered in the question. The page reads the Workflow again each time it is
  opened, so a draft the agent saved shows on the way back from the conversation.
- **Step files of a Workflow:** the config of a Workflow asset takes `files` beside `name` and
  `manifest`: the scripts of its `code` steps, each `{ path, content }` with a path such as
  `steps/check.py`. One `assets.put` saves them with the manifest as one revision, `assets.get`
  answers them with the config to whoever may read the definition, and a run reads the script
  of the revision it was started on, whatever is published after. A script is at most 256 KiB
  and the files of one revision 2 MiB together. A save and a publish are refused with the
  reason `code_file_missing` for a script the manifest names and the save does not bring,
  `code_file_unused` for a file no step names, `code_file_invalid` for a path outside `steps/`,
  one with `..`, one given twice or one that is no `.py`, `.js` or `.mjs`, and
  `code_file_too_large` or `code_files_too_large` for the sizes. `workflows.list` shows a
  published Workflow without its script as not runnable with `code_file_missing`. A Workflow
  with a code step that was published before has no script: save it again with its files.
- **Workflow code steps:** a step of the type `code` runs one script of the Workflow's
  `steps/` folder on the step's input. The script is Python (`.py`) or JavaScript (`.js`,
  `.mjs`), at most 256 KiB, and runs in a fresh container of the runner image, started by the
  workspace command worker: no network, a read-only root, no variable of the platform's
  environment, and one directory that holds the script and `input.json` and nothing else. The
  input is also the script's input stream. That directory is memory of a stated size and no
  disk: the worker's copy of the two files is handed in read-only, so nothing a script writes
  reaches the worker's disk, and a script that fills the directory reads "No space left on
  device" and fails as `code_failed`. The result is what the script writes to
  `output.json`, or what it prints where it writes no file: JSON of at most 256 KiB that fits
  the step's `outputSchema`. The result is read inside the container, within the script's
  time limit, and only from a regular file: a pipe, a socket, a link, a directory or a file
  without end in its place is no result, and the worker never opens it. What the script prints beside it is kept on the step run as
  `log`, 16 KiB of each stream, shown with the step run and never audited. A script that
  ends with an exit code fails its step as `code_failed`, one stopped at its time limit as
  `code_timeout`, one whose container the engine ended for its memory as `code_out_of_memory`
  (Docker's own record of it; a script that exits with 137 or kills itself is `code_failed`); a
  result fails as `code_output_missing`, `code_output_not_json`, `code_output_too_large` or
  `code_output_invalid`, an input as `code_input_invalid`. None of these is run again. A
  container that could not be started is tried three times and then fails the step as
  `code_runner_unavailable`, as does an instance without Execution Workspaces. A code step
  changes nothing outside its container, so a worker that stops in one runs it again, and a
  cancel of the run stops the container within a second. What a killed worker left, a
  container no process ends and its directory, is removed when a command worker starts and
  every ten minutes after, once it is older than twice the time limit and a minute. A
  definition whose script is missing
  from its revision is refused when a run is started (`code_file_missing`,
  `code_file_too_large`), and one that names a dataset in a code step's schema is refused as
  `not_supported_yet`. **Release config** gains `workflows.codeSteps`: `memoryBytes` (512 MiB),
  `cpuCount` (0.5), `pidsLimit` (64), `timeoutSeconds` (60), `slots` (4 at once per command
  worker) and `scratchBytes` (64 MiB, the working directory; it is part of `memoryBytes` and
  at most half of it), apart from the limits of an agent's command under
  `infrastructure.sandbox`.
  **Operators:** the workspace command worker now refuses to start where the sandboxes that
  can run at once need more memory than its host has: its command slots and its Page build
  slots times `infrastructure.sandbox.memoryBytes` (4 GiB unless set), plus the code step slots
  times their memory. The refusal has the reason `sandbox_memory_exceeds_host` and names each
  term with its two settings. A host of 16 GB with three command slots of 4 GiB, Pages and
  Workflows on needs 22 GiB and is refused until a slot count or a memory limit is lowered.
  Where the sandbox is a Docker engine on another host the worker warns and starts.
  **Migration `0063_workflow_code_steps`** adds three columns to `workflow_step_runs`; the
  previous release runs on the migrated database.
- **Workflow schedules:** a published Workflow with a `schedule` trigger starts its runs by
  itself. The trigger names a cron expression of five fields (minute, hour, day of month,
  month, day of week; numbers, ranges, steps and lists), read on the clock of the instance's
  time zone: release config `clientInstance.timeZone`, an IANA name such as `Europe/Berlin`,
  UTC when left out, refused when it is no time zone. On the day the clock is set forward, a
  time that day skips runs once at the first minute after the gap; on the day it is set back,
  a time shown twice runs once, the first time. One job per Workflow
  waits for the next due time on the job executor and starts the run of that time; a due time
  starts one run, whichever worker fires it and however often. Times that came due while the
  instance was down start one run, for the latest of them. A job that was claimed is due
  whatever the clock of its process says, and the job of the next due time exists when it
  ends, also when all its attempts failed. A due time that meets the open run
  of an earlier one starts nothing and is audited as `workflow_run.tick_skipped` with the
  reason `overlap`, as is one whose Workflow cannot be started (`principal_inactive`,
  `input_invalid`, `operation_secret`). A scheduled run gets no input, has the trigger
  `schedule` and its due time as `scheduledFor`, and names the Workflow's own service
  principal as its starter. `manual` and `schedule` may stand together. `missed: skip`,
  `missed: all` and `overlap: queue` are refused as `not_supported_yet`. A process plans the
  schedules of what is published when it starts. **Migrations `0063_workflow_run_schedule` and `0064_workflow_run_schedule_index`**
  add the column `workflow_runs.scheduled_for` and a unique index on it per Workflow; the
  previous release runs on the migrated database.
- **Workflow loops, several items at once:** a loop with `concurrency` from 2 to 8 runs that
  many of its items at the same time, each as its own jobs on the job executor, and starts the
  next item in the order of the list whenever one ends. One process runs four step jobs at
  once, so more than four items go at once only with more than one worker. `onItemFailure`
  holds as before: a loop that continues counts its failed items and ends `done`; a loop that
  stops fails at the first failed item, starts no item after that failure is written, and
  cancels what it had started and not yet run. That holds inside a loop that continues: the
  stopped loop's items in flight end and start nothing, no step after it runs for that item,
  and the outer loop counts the item as failed and goes on. A cancel starts no further item. The run's
  limit of step runs binds as before: the loop starts no item past it. A refusal by the
  instance's policy (`POLICY_DENIED`) stops a loop that continues, as a refusal of the
  principal does: the run fails with that reason and is not audited as a success. A refused
  right reads "The service principal '…', which the Workflow runs as, does not hold the right
  '…' to call '…'". A step whose worker was gone when its run ran out of its time says what
  its call did, as it does after a cancel.
- **Workflow Runs, the outline of a run:** `GET /api/v1/workflow-runs/{runId}/steps?topLevel=true`
  answers the step runs that stand in no block: the steps of the definition's own list, with a
  loop's own step run and its counts and none of its items. It goes with `status` and pages
  like the list, and is refused together with `containerStepRunId`. The reads there were
  answer as before.
- **Access:** `workflow.read`, `workflow.use`, `workflow.write` and `workflow.publish` can be
  granted to a person in a Namespace, which covers the Workflows whose names start with its
  prefix, or on one Workflow, through `POST /api/v1/instance/access/grants`. Before, the call
  answered `action_not_grantable` and a member reached a Workflow only as an administrator. A
  grant for the instance or a workspace is refused with `invalid_scope`; `workflow.delete` and
  `workflow.read_run_data` stay with the administrator role. The Access page lists such a row
  under the action's name and does not offer the kind in its form yet. A run a caller may not
  read on its Workflow is answered like a run that does not exist, also under a deny on one
  Workflow.
- **Workflows, the pages on the canvas:** a Workflow opens as a drawing of its steps, left to
  right on a wide page and top to bottom on a phone, fitted to the page when it opens. A loop
  and a parallel part are frames around their steps, a condition is a step with one exit per
  path, and a step that starts another Workflow opens that Workflow at an address of its own
  (`/w/<workspace>/workflows/<workflow>/open/<child>`): the browser's way back leads one level
  up, a trail names the way, and the head, the start and the runs are those of the Workflow
  shown. A press on a step opens one panel beside the drawing (a sheet on a phone) that says
  what the step does. The page of a run draws the same graph with how far each step is: a loop
  shows its counts and its bar however many entries it has, with the failed in the failure
  colour; a failed step says why and its panel opens by itself, and what an ended run did not
  reach is dimmed. A step's panel shows what the step returned: a list of records as a table of
  its first rows, anything else as text. The entries of a loop are listed in the loop's panel,
  failed ones first, a page at a time, under a filter that stays in view. The run page draws the
  published definition and says so when the run started on an earlier one. A Workflow has two
  tabs, "Workflow" and "Runs". The drawing can be read with the keyboard and cannot be
  rearranged. The pages read and write through the operations of the module `workflows`: the list with
  each Workflow's latest run, the runs, a run and its step runs, the start and the cancel; the
  drawing is the manifest of the Workflow's asset. A Workflow the instance accepts no start of
  is listed as "Cannot start" and opens with the reasons its list entry names, in the
  instance's words, over a start that is switched off. The start is offered where the Workflow's
  entry of the list names `workflow.use` for the reader; one who only reads sees the Workflow
  and its runs without it. A failed step
  names the right the account of the Workflow lacks, a run interrupted while a step changed
  data says that the change may or may not have happened and was not repeated, and a run that
  was asked to stop says that it ends when the call that is going has. The sample Workflows
  and runs stay at `/ui-library/workflows`, behind the right that opens the UI library. **Not
  in this release:** a start with input, for which there is no form.
  The step runs outside the items of a loop have no read of their own: the page
  picks them out of at most 2,000 step runs of a run and says so where a run has more.
  `condition` and `parallel` are drawn and run by no engine. A step run carries the start of its output and no
  count, so a table of a long output names no total.
- **UI library:** `Breadcrumb`, the way into a nested place with the current one marked, and
  `IconTile`, the square an icon stands in on a node of a graph and in the head of its panel.
  On the flow canvas a group names its failed share in the failure colour (`failedLabel`),
  folding a group leaves it where it stood, a graph that runs top to bottom and is wide enough
  to be small either way opens whole, and on a narrow canvas the canvas library's mark stands
  in the corner on the canvas' ground. `ListRow` takes `descriptionWraps="always"` for a list in
  a narrow column. A panel that opens beside the canvas is given room: until the reader moves
  the view, the graph is fitted again into what the panel leaves free, and again when it
  closes, at the pace of the library's `--duration-open`.
- **Workflow Runs:** with the module `workflows` on, a Workflow is started by hand and runs to
  its end on the job executor. `POST /api/v1/workflows/{workflow}/runs` starts a run
  (`workflow.use`), `GET` on the same path lists the runs of a Workflow, `GET /api/v1/workflows`
  lists the published Workflows the caller may read, each with its latest run as `lastRun`, and
  `GET /api/v1/workflow-runs/{runId}` and `.../steps` read a run and its step runs
  (`workflow.read`): status, times, error and a preview of at most 2,000 characters of a
  result, never an input. `POST /api/v1/workflow-runs/{runId}/cancel` ends a run for whoever
  started it or holds `workflow.write`; no further step and no further item of a loop starts,
  and the run says who cancelled it and when (`cancelledBy`, `cancelledAt`). A run acts as the
  service principal its definition names under `runAs` by the principal's `name`, with that
  principal's grants and never the starter's. `workflow.yaml` is an ordered list of steps with
  nested blocks: a file with `wiring`, edges or positions is refused. This release executes
  the step types `trigger` (manual), `operation`, `loop`, `code` and `output`. A definition is checked
  with the contract's block check, and refused with the reason `block_depth` (more than 16
  nested blocks), `reference_out_of_scope`, `duplicate_step_id` or `not_supported_yet`: the
  last for the reserved blocks `condition` and `parallel` and for every field the file form
  holds and this engine does not run (`dataset`, `paginate`, `collect`, the step types
  `agent`, `notify` and `workflow`, the trigger `parent`,
  `labels`, `onFailure`, `retention`, `types`). A loop returns how many of its items ended how
  (`total`, `done`, `failed`) and never what an item returned. With `onItemFailure: continue`
  the loop goes on past a failed item and ends as `done`, and so does its run; without it the
  loop and the run fail at the first failed item. A run keeps the definition it started on
  and the id of that revision (`definitionRevisionId`): what is published after its start
  changes nothing of it. A step run says where it stands in the tree of its run
  (`containerStepRunId`, `iteration`), an operation step what it called (`effect`, `source`),
  and the step run of a loop how the step runs of each step directly inside it stand
  (`bodyCounts`); `.../steps` filters by `containerStepRunId`, `status` and `iteration`. An
  operation step calls through the operation layer from the origin `workflow`, and a changing
  call carries the id of its step run as its idempotency key, so a step a worker runs again
  changes nothing twice. A worker that stops fails no run: a reading call is cut and made
  again by the next worker, and a changing call is left to end and is answered again from its
  Operation Run. A changing call whose process died before it had an outcome is never made a
  second time: the step waits for the outcome, at most ten minutes from the start of the
  call, and then ends with its run as `operation_interrupted`. An operation marked secret is
  no step (`operation_secret` when the run is started), and a step whose input holds a secret
  fails as `secret_input`. A refusal of the run's principal itself, disabled or without the
  right, stops a loop that continues past failed items and fails the run with that reason and
  the right in `error.action`. The trigger step shows no preview: its output is the run's
  input. `iteration` filters the step runs of one loop and is refused without
  `containerStepRunId`. A run ends as `limit_reached` after 20,000 step runs or twelve hours;
  the step runs bound a loop before its 10,000 items do, unless it has one step.
  The start, the cancel and the end are audited as `workflow_run.started`,
  `workflow_run.cancelled` and `workflow_run.ended`, without a value of the run. An assembled
  instance knows no Workflow yet: definitions are stored with the asset kind that follows.
  **Migration `0060_workflow_runs`** adds the tables `workflow_runs` and `workflow_step_runs`
  and changes no existing table, so the previous release runs on the migrated database. A
  changing call from the origin `schedule` now needs an idempotency key, as one from `app` and
  `workflow` does; nothing in the platform makes such a call yet.
- **Runner image:** the platform's runner image (`workspace-command-runner`) carries git and the
  fixed command `catalyst-asset-repo`, which commits a folder of plain files into a repository
  kept as git bundles and makes a repository from bundles. It is the first part of keeping the
  source of an App as a git repository (ADR-0029); no operation calls it yet. Git runs in this
  image alone: the API image and the worker images carry none, and `pnpm check:images` fails
  when one does. **Operators:** the image grows by git, about 95 MB unpacked. The runner image of
  the capabilities repository carries both from the build that follows this release.
- **Database:** migration `0061_asset_repositories` adds the tables `asset_repo_bundles` and
  `asset_checkouts` and the columns `commit` and `tree` on `config_asset_revisions`. They are
  empty for every asset that exists. The migration waits five seconds for its locks at most; one
  that gives up is run again. **Rollback:** an earlier release ignores them.
- **Data Stores:** with `modules.dataStores.enabled` an instance has the asset kind
  `data_store`: a folder with `store.yaml` (`id`, `name`, `description`, `scope`, `sizeLimit`;
  an unknown key is refused) and SQL files under `migrations/` (`NNNN_name.sql`, numbered from
  0001 without a gap), with a draft and a published revision. Publishing a revision creates a
  Postgres database of its own for the store on the platform's server, with an app role (reads
  and writes rows, 15 seconds per statement, 10 connections) and a migration role (changes the
  schema, 10 minutes, 2 connections), or applies the migrations that database lacks, each in
  its own transaction. The jobs are `data_store.provision`, `data_store.migrate` and the daily
  `data_store.measure_size`. The rows are reached through `data_store.<id>.<verb>`, which a
  Workflow step and an agent call, and which the routes `data_stores.<verb>` under
  `/api/v1/data-stores/:store/` run under that same name (a key needs `data_store_rows:read`
  or `data_store_rows:write`, and `config_assets:read` for `describe`): `query` (one read-only statement with bound parameters, at
  most 1,000 rows and 2 MiB), `describe` (tables, columns and types) and `preview_rows` (at
  most 50 rows of one table) need `data_store.read` and record every call; `insert` (at most
  1,000 rows and 1 MiB per call, `onConflict: fail | skip`, answers `inserted` and `skipped`)
  needs `data_store.insert`. `load` takes a dataset of a Workflow Run into one table in one
  transaction (at most 100,000 rows and 64 MiB per call; `key` with `onConflict: fail | skip |
update`; `replace.by` deletes the rows of the dataset's values and adds the dataset, so a
  reader never sees the table half replaced); it needs `data_store.insert`, and
  `data_store.execute` as well for `update` and `replace`. Until the datasets of Workflow Runs
  exist it answers `not_supported_yet`. `data_stores.get` (`GET /api/v1/data-stores/:store`,
  `data_store.read`, scope `config_assets:read`) answers the state of a store in one read: its
  migration level and the published one, its size against its limit, each thing the server
  leaves open with what an operator does about it, and how its last migration ended. No verb
  of a store names a policy of its own. A step of a Workflow Run calls `insert` and `load` as
  its service principal, by that principal's grants; it has nobody to ask, so the instance
  default `confirm` is an approval for it, which no call of a service principal can wait for
  yet: such a call is refused as `POLICY_DENIED` with `details.reason: approval_unavailable`,
  and runs where `policy.defaults.changing` is `allow`. A changing call of a store that failed
  and rolled back whole is run again under its idempotency key, so a step that is tried again
  recovers once the cause is gone; an operation says so with `AppError.changedNothing`. A changing
  call of a store that carries an idempotency key records the key in the store's database with
  its rows (`catalyst.calls`: hashes of key and input, the operation and the counts it
  answered; kept 30 days; the app role reaches it through two functions and holds nothing
  on the table, so a query or an `sql` action of an App reads no record): the same key with the same input changes nothing and is answered
  again, with another input it is refused as `data_store_key_reused`. `insert` and `load`
  declare `repeatsUnderKey`, so a step whose worker died is made again under its key and its
  run ends `done` with each row once. Release
  config `dataStores.sizeLimit` (default `5GB`) is the most one store may hold and
  `dataStores.poolMaxConnections` (default 5) the connections one process holds to one store.
  Migration `0062_data_stores` adds the table `data_stores`, the platform's record of each
  store; a store's own database is made at runtime and is no platform migration. With the
  module off nothing of it exists.
  - **New privileges of the platform's database role:** `CREATEDB` and `CREATEROLE`, and
    ownership of the platform database. On an instance that exists an operator runs
    `ALTER ROLE <platform role> CREATEDB CREATEROLE;` once before turning the module on.
    Provisioning takes `CONNECT` on the platform database from `PUBLIC`, so that no store role
    reaches it: a role of the operator's own that connected through `PUBLIC` needs
    `GRANT CONNECT` of its own. The module needs `secretStore.keys`, where the passwords of the
    store roles are kept; without a key startup stops and names the setting.
  - **Migrations are held to their transaction and their role:** a migration whose text holds
    transaction control (`begin`, `commit`, `rollback`, `savepoint`) or a role statement
    (`alter role`, `create role`, `set role`, `set session authorization`) is refused when it
    is written. One that tries either out of sight fails as `migration_failed` or
    `migration_changed_role` and leaves nothing behind. After every migration both roles of the
    store get their password and settings again. The platform's record of a store says what
    is applied: where the key of the store's own record cannot be read (`ledger_key_lost`) or
    that record falls short of the platform's (`ledger_mismatch`), no migration is run. On a
    server whose platform role is a superuser, provisioning also takes `pg_stat_activity`,
    `pg_terminate_backend` and `pg_cancel_backend` from the store's roles. Before every job
    and call that connects as a role of a store, both roles are looked at and set again where
    they differ. **Keep the Postgres port closed to tenants: a role may change its own
    password between two checks.** What provisioning finds open and leaves to an operator is
    named on the store's record and asked anew at every job: `server_databases_open` (a
    store role can connect to another database of the server; revoke `CONNECT` from `PUBLIC`
    there, or add `host postgres,template1 /^catalyst_ds_ all reject` to `pg_hba.conf`),
    `sessions_open` and `temp_files_unbounded` (the platform's role is no superuser, so it
    can neither take the session functions from a store nor set `temp_file_limit` on its
    roles). The roles of a store carry `work_mem` and, set by a superuser, `temp_file_limit`.
  - **Size limit:** a store is measured when it is provisioned and after every migration.
    Every insert reads the size of the store's database before it writes and after, on a
    connection of the platform's own, and is rolled back where it passed the limit, so no row
    that is kept lies beyond it; what it wrote is given back with a `VACUUM`. A migration that
    would leave the store over its limit is refused the same way. `insert` with
    `onConflict: skip` goes by a unique key of all rows that is not deferrable and whose
    columns the call gives: a call without one is refused (`skip_without_key`,
    `skip_deferrable_key`), and so is a row whose key is empty (`nullable_key`).
  - **Refusals:** a migration that names the schema `catalyst`, which the platform keeps for
    itself in every store, is refused when it is written. A publish whose `scope` is not the
    owner of the store answers `scope_mismatch`. A publish that changes or removes an applied
    migration answers `400` with `details.reason: "applied_migration_changed"` and names the
    file; one whose id a retired
    store holds answers `409` with `data_store_id_held`. An insert at the size limit answers
    `409` with `data_store_size_limit` and names the limit; a call of a store without a
    database answers `409` with `data_store_not_ready`. A failure of the database is answered
    with a fixed sentence and its SQLSTATE, never with the database's own message.
  - **Deleting** a store's asset retires the store: its operations are gone, its database,
    roles and rows stay, and its id is not free. Nothing drops a database yet.
  - **Rollback:** the previous release ignores the table `data_stores` and the store
    databases, so rolling back loses nothing and leaves them in place. The `CONNECT` taken from
    `PUBLIC` on the platform database stays taken. The backup holds the store databases, see
    "Backups of the whole database server" under Fixed.
- **Asset kinds that read their own files:** a kind may bring `manifestOfFiles`, which reads the
  source files of a write into the manifest of their file set without the build of Pages, and
  `onPublish` and `onRemove`, which run in the transaction of a publish and of a delete.
- **`@vivd-catalyst/postgres-connector`:** `PostgresExecutor.change` runs statements in one
  transaction that commits, or outside of one, for a database the platform manages itself. A
  change takes at most `POSTGRES_CHANGE_MAX_TIMEOUT_MS` (10 minutes). `createPostgresExecutor`
  takes `poolMaxConnections` for an executor whose databases the platform sizes itself.
- **Workspace command worker:** with the module `apps` on, the worker serves two more job
  kinds. `asset_repo.commit` makes the commit of a save in the sandbox, with the command and
  the git of the runner image: it reads the bundles the ledger names, each checked against the
  size and the SHA-256 the ledger recorded before the command sees it
  (`bundle_hash_mismatch` otherwise), names the new bundle on the save's pending row and then
  puts its object into the `files` store. `asset_repo.sweep` runs every hour and gives up the
  saves that are still pending after a day, with their objects. A kind of asset says with
  `content: repository` that its files are a repository; the kind `app` does. **Operators:** a worker of this release needs a runner image that has
  `catalyst-asset-repo`: the image of this release, or the capabilities runner image built
  from it. On a `local` sandbox the command runs the git of the machine, 2.47 or later. A
  worker of an earlier release beside this one is refused at its start, as for `page.bundle`.
- **Apps:** `apps.create_from_page` gives the App a git repository. The source files of the
  Page are its first commit, revision 1 names the commit and its tree beside its file set, and
  the audit event `app.created` names the asset, the revision and the commit. A write of such
  an App with `assets.put` adds a commit on the draft's; an App that was first written with
  `assets.put` has no repository yet. A call that is refused or fails writes nothing a reader
  can see. **Operators:** naming a Page as an App now needs the workspace command worker and a
  runner image of this release. On an older runner image the call is refused with `409`
  (`details.reason` `runner_image_outdated`) and a message that says the image must be rolled
  out; without a worker with `commit_unavailable`. Seeded Apps and Apps that exist are not
  changed, and `assets.discard_draft` moves the draft back as before. A commit works on the
  disk of the worker, not in the 64 MiB `/tmp` of the sandbox: it needs 550 MiB free
  (`ASSET_REPO_COMMIT_DISK_BYTES`) below the worker's temporary directory and is refused with
  `409` `no_space` otherwise. The bundles of one repository may have 100 MiB together; a save
  that would leave more is refused with `history_too_large`.
- **Database:** migration `0065_asset_repo_commit_request` adds the columns `request` and
  `result` to `asset_repo_bundles`: what a pending save commits, without bytes, and how its
  commit ended. **Rollback:** an earlier release ignores them.
- **Published Apps in the rail:** under the "Apps" row the main rail lists the published Apps
  of the open workspace that the person may open, at most five. The App this person opened last
  in this browser stands first; Apps never opened follow by their latest change. A row opens
  the App, and the "Apps" row opens the page with every App as before. The collapsed rail shows
  nothing more, and there is no block without the Apps module or for a person without a
  published App. The rail reads the first page of the Apps list, so in a workspace with more
  than fifty Apps it chooses among those fifty.
- **No empty Apps or Workflows row for members:** the rows "Apps" and "Workflows" of the main
  rail, open and collapsed, show only while their module is on and the person is shown at least
  one App of the open workspace or one Workflow, or may write one (`app.write` on the instance,
  in that workspace or on one of its Apps; `workflow.write` on the instance, in a Namespace or on
  one Workflow). A builder keeps the empty row to make the first one. The server decides both:
  `workspaces.agents.list` answers `visibleSections` with `apps` where that row is there for the
  caller in the workspace, by the check of `assets.list`, and `platform.context.get` with
  `workflows`, by the check of `workflows.list`; the rail follows the two flags alone. Whoever
  the flag names the Workflows row also reaches the Workflows page, such as a member who may
  only start Workflows; the Apps page and its addresses are unchanged.
- **No Agents row for one agent:** the row "Agents" of the main rail, open and collapsed, shows
  only while the open workspace offers the person two agents or more, or the person may write
  one (`agent.write` on the instance, in a Namespace or on one agent). With one agent New chat
  starts it, and the composer's agent picker stays as it is. The page and its address are
  unchanged. `workspaces.agents.list` answers `visibleSections`, which names `agents` where the
  row is there for the caller in that workspace, counted over every page of the list.
- **New chat from the Recent heading:** the "Recent" heading of the main rail has a small plus
  at its right end that starts a new chat as the "New chat" row does. It shows while the pointer
  is over the Recent section or the keyboard is on it, and always on a screen without hover.
  `NavGroup` of `@vivd-catalyst/ui` has the slot for it, `labelAction`.
- **Agents page:** the main rail has a row "Agents" directly under New chat, for everyone in a
  session with workspaces. It opens `/w/<workspace>/agents`, a page with one card per agent the
  person may use in that workspace: the name, the description, the first three starter prompts
  and "Start chat". Start chat opens a new conversation with that agent selected; a starter
  prompt opens one with its text in the composer. The workspace's default agent is marked. The
  card shows the description whatever `ui.showAgentDescriptions` says. Nothing is edited there:
  a person who may read agents in Studio gets "Edit in Studio" on each card. The page reads the
  list the agent picker already reads and adds no call. `@vivd-catalyst/ui` gains `CardFooter`.
  A person who may create an agent (`allowAgentCreation` and the right to write one) finds
  "New agent" in the page head: it opens the list of agents in Studio with the dialog that
  starts one.
- **Workflows, the pages on the canvas:** a Workflow opens as a drawing of its steps, left to
  right on a wide page and top to bottom on a phone, fitted to the page when it opens. A loop
  and a parallel part are frames around their steps, a condition is a step with one exit per
  path, and a step that starts another Workflow opens that Workflow at an address of its own
  (`/w/<workspace>/workflows/<workflow>/open/<child>`): the browser's way back leads one level
  up, a trail names the way, and the head, the start and the runs are those of the Workflow
  shown. A press on a step opens one panel beside the drawing (a sheet on a phone) that says
  what the step does. The page of a run draws the same graph with how far each step is: a loop
  shows its counts and its bar however many entries it has, with the failed in the failure
  colour; a failed step says why and its panel opens by itself, and what an ended run did not
  reach is dimmed. A step's panel shows what the step returned: a list of records as a table of
  its first rows, anything else as text. The entries of a loop are listed in the loop's panel,
  failed ones first, a page at a time, under a filter that stays in view. The run page draws the
  published definition and says so when the run started on an earlier one. A Workflow has two
  tabs, "Workflow" and "Runs". The drawing can be read with the keyboard and cannot be
  rearranged. **Not in this release:** the instance runs no Workflow yet, so on an instance the
  list of runs says so and no start is offered; the pages are shown over sample Workflows and
  runs at `/ui-library/workflows`, behind the right that opens the UI library. `condition` and
  `parallel` are drawn and run by no engine. A step run carries the start of its output and no
  count, so a table of a long output names no total; and an instance cannot yet tell an earlier
  definition, because the read of a Workflow answers its revision's number and a run names the
  revision's id.
- **UI library:** `Breadcrumb`, the way into a nested place with the current one marked, and
  `IconTile`, the square an icon stands in on a node of a graph and in the head of its panel.
  On the flow canvas a group names its failed share in the failure colour (`failedLabel`),
  folding a group leaves it where it stood, a graph that runs top to bottom and is wide enough
  to be small either way opens whole, and on a narrow canvas the canvas library's mark stands
  in the corner on the canvas' ground. `ListRow` takes `descriptionWraps="always"` for a list in
  a narrow column.
- **Pages, plain HTML:** App Kit version `1.2.0`, with two new files, `page.css` and `theme.js`.
  A plain HTML Page that names it comes out with the look of the platform: the build links
  `page.css` and `theme.js` first into every HTML file of a Page with an `entry`, also one whose
  script imports the kit to call an action. `page.css` holds the library's tokens and reset and
  base rules for plain elements (room around the body, font, type sizes, and plain headings,
  links, lists, tables, buttons and fields) and no utility class, so a class name of the Page
  such as `table` or `hidden` means only what the Page's own rule says. An HTML file whose
  script mounts components (it imports `react`, `react-dom`, the kit's `ui` or a router) gets
  `ui.css` in place of `page.css`, as a React Page does, and none of the base rules; one that
  imports only the kit itself or its `charts` stays a plain Page. `theme.js` asks the
  interface for its theme and mode and keeps the tokens on `<html>`, so the Page follows light
  and dark. Every base rule has no specificity and sits in the layer `components`, so a rule of
  the Page's own wins when it stands outside any layer or in a layer of the Page's own; one the
  Page writes into `@layer base` loses. A React Page and a Page that names `1.0.0` or `1.1.0`
  build to the files they built to before. **Operators:** the build runs in the runner image, so
  a runner image of an earlier release refuses `kit: 1.2.0` with "an exact released kit version:
  1.0.0, 1.1.0"; roll out the runner image with the instance. **Rollback:** an earlier release
  does not serve `/app-runtime/kit/1.2.0/`, so a Page saved with `1.2.0` shows nothing there
  until it is saved again with `kit: 1.1.0`.
- **Inbox, counts on the tabs:** the tab **Decided** shows how many requests it holds, so a
  reviewer sees without opening it whether anything is in there. **To decide** shows its count
  in the emphasis of the sidebar, **My requests** keeps counting what is still open, and a tab
  that counts nothing shows no number. A screen reader reads a count with its noun, "Decided,
  3 items". `approval_requests.count_pending` also answers `decided`: the length of the list
  with `scope=decided` for the caller, the same kinds and the same 30 days, and 0 for a caller
  who may decide nothing. No migration. In the library, `TabsTrigger` and `TabsLink` take
  `countTone`, and `UiLabels` has `countOne` and `countMany`; an assembly that passes labels of
  its own adds both.
- **Model names:** a model binding in release config takes `label`, the name people read for
  the model. The model picker, the agent editor and the Access page show it in place of the
  model id; without it they show the id tidied up, as before. An instance whose `model` is a
  deployment name of its own, as on Azure, sets `label` and `vendor` to get the model's name
  and logo. `GET /config` carries it as `label` on a selectable model, and the config asset
  references carry it on a model binding.
- **Update app:** an App remembers the Page it is updated from, and the header of that Page
  offers "Update app" in place of "Save as app" to whoever may write the App. The update writes
  the Page's newest revision as the next draft revision; nothing is published, and the App
  keeps its title. For an App with a repository the update is its next commit, on the commit
  of the draft it replaces. New operations: `apps.update_from_page`
  (`POST /api/v1/apps/{app}/update-from-page`, `app.write` on the App and read access to the
  Page, `expectedRevision` required, `412 REVISION_CONFLICT` for a draft that moved, `409` with
  `details.reason: "app_not_from_page"` for an App of another Page or of none unless the call
  says `"link": true`) and `apps.get_from_page`
  (`GET /api/v1/conversations/{conversationId}/pages/{pageId}/app`, with `?app=<id>` also the
  App of that id where the caller may write it). The link is the `origin` of an App revision,
  which gains the kind `page`: an App's Page is the one its newest revision with such an
  origin names. No migration. **An App saved before this release has no link:** saving its
  Page under the App's id now offers "Update <App> from this page", which replaces the App's
  draft with the Page and links the two. After a rollback the previous release logs a
  response-schema error when it lists the revisions of an App that carries the new origin;
  the answer is still sent.
- **Documentation links:** release config `ui.docsUrl` names where an instance's documentation
  is read. With it the account menu has a "Documentation" item in a group of its own above
  Sign out, and the Access page, the New right dialog, the rights check and the read-only
  notice of a Build page end with a link into the page How rights work. All of them open a new
  tab. The key has no default: an instance that leaves it out shows none of them. `null` clears
  an inherited address, and anything but an `http` or `https` address stops the start. The
  address reaches the interface as `docsUrl` in the branding and in `ui` of `GET /config`.
  `@vivd-catalyst/ui` gains `DocsLink`, `DocsAddressProvider` and `useDocsLinkShown`, and
  `DropdownMenuItem` takes `href` and `accessibleName` for an item that is a link.
- **Connections, secrets and egress:** release config `connections` names the Connections of an
  instance, and the API process writes them into the store when it starts, in one transaction
  under one lock. Such a Connection has `origin: release` and is read-only on the instance:
  `assets.put`, `assets.revert` and `assets.delete` answer `403` with
  `details.reason: "read_only_origin"`. An entry that is gone removes its Connection. The
  credential an entry names under `secret` is stored encrypted in the new table `secrets`
  (AES-256-GCM, a random 12-byte nonce per encryption, bound to instance, Connection, subject
  and version); a changed value becomes the next version. **An instance whose release config
  names a Connection needs `secretStore.keys`**: the first key is 32 random bytes in base64, and
  startup stops with the name of its variable when it is not set. Nothing returns a stored
  secret. `egress.allow` lists the targets a Connection may reach as protocol, host and port;
  it is empty by default and then refuses every target. The check resolves the host, refuses a
  loopback, link-local, metadata or private address unless the entry says `network: private`
  and names the range, pins the checked address and refuses the instance's own database.
  Migration `0055_connection_secrets` adds `secrets` and `connection_state`. The connector type
  `mcp`, below, is the first one that ships.
- **Connections, the `mcp` connector type:** a Connection with `connectorType: mcp` reaches a
  remote MCP server over Streamable HTTP. Its `authScheme` is `none`, `bearer` or `header`; with
  `header` the setting `headerName` names the header that carries the secret. OAuth is not
  supported yet, and neither is a local stdio server. A call takes at most 30 seconds and a
  result at most 2 MiB, 8 calls of one Connection run side by side in one process, a further
  call waits up to 10 seconds for a slot and is then refused with `connection_busy`. A refused
  or failed call names one of fifteen reasons in `details.reason`, such as `egress_denied`,
  `upstream_unauthorized` or `output_invalid`. A result that holds the Connection's credential
  is discarded with `output_rejected`.
- **Connections, operations as agent tools:** each operation a Connection lists under
  `operations` is an Operation named `connection.<name>.<tool>`, with its required `effect`
  (`reading` or `changing`), its `exposure` and an optional stricter `policy`. An agent carries
  it as a tool by that name when the operation is exposed to `agent`, and the person the agent
  acts for needs `connection.use` on the Connection. Every call runs on the one operations path
  and leaves an Operation Run, a reading call included. A tool the remote server lists and the
  Connection does not accept cannot be called.
- **Connections, discovery:** the API process queues a job of kind `connection.discover` for
  every enabled Connection after it seeded them at start. The job reads the server's tools into
  the Connection's catalog. An accepted operation is callable once a discovery has seen it and
  pinned the fingerprint of its descriptor; until then its status is `awaiting_discovery`. A
  descriptor that changes later stops that one operation with `operation_needs_review`. A
  discovery takes at most 60 seconds, 500 operations and 4 MiB, and a failed one leaves the
  stored catalog and everything accepted as it was. A tool whose name, description or schema
  holds the Connection's credential is left out.
- **Connections, the Connection page:** Build > Connections opens a read-only page for each
  Connection: health with the time of the last test, the state of the credential (never its
  value), the settings, the accepted operations with effect, who may call them and their
  status, and the agents that carry one of its tools. "Test connection" runs the type's bounded
  test and needs `connection.write`. The operations behind it are `connections.get`
  (`GET /api/v1/connections/{name}`), `connections.test` (`POST /api/v1/connections/{name}/test`)
  and `connections.list_tools` (`GET /api/v1/connection-tools`).
- **Demo client:** `pnpm demo:seed` fills a local demo instance with a test company: people,
  three Namespaces, agents, skills, grants and one approval waiting in the Inbox. It works only
  through the API and the config CLI, talks to this machine only and can run any number of
  times. `clients/demo/sample-mcp` is a sample MCP server that the demo's Compose file runs as
  the service `sample-mcp`. The seed brings no Connection yet.
- **Demo client, accounting sample:** the sample MCP server answers at a second address,
  `/accounting/mcp`, with the same key: the books of 600 invented clients of one tax
  consultancy, served as the Exampledata interface over DATEV data serves them. Its four reading
  tools are `list_accounting_clients`, `list_fiscal_years`, `list_postings` and `list_accounts`.
  The demo's release config brings the Connection `sample-accounting` for it, open to a Workflow
  only. Each client has a legal form and an industry that decide the size and the content of
  its ledger, its own customers and suppliers with personal accounts, and months with planted
  bookings that break one of seven rules, in a known number. Everything follows from a fixed
  seed, so a month answers the same forever. The books run from 2024-01 to 2026-09, a fixed
  month and not the clock, and a later month is refused; `SAMPLE_ACCOUNTING_LAST_MONTH` moves
  the end. A month has the noise of real books: cash discounts with their tax correction, part
  payments, payments out of the order of the invoices, invoice numbers out of the order of
  the days, till reports in one booking per tax rate with a restaurant's best days at the
  weekend, and no booking on a nationwide public holiday. A planted booking has the text and
  the accounts of clean ones and a document number that fits its day as theirs do, and no kind
  of booking is mostly planted, so only its rule tells it apart. See "The sample accounting
  system and its Connection" in `clients/demo/README.md`.
- **Web access:** the public web fetcher refuses an IPv6 address that carries a blocked IPv4
  address in any form: IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16` and Teredo
  `2001:0::/32`, as it did IPv4-mapped ones.
- **Access:** `connection.read` and `connection.use` can be granted in a Namespace, which covers
  the Connections whose names start with its prefix.
- **Pages:** a conversation can hold Pages, each with numbered revisions. A revision is a file
  set that is stored once and never changed. The module `apps` owns them and is off by default;
  with it on, startup stops with the missing piece named unless `infrastructure.objectStorage.files`
  is configured and `CHAT_SESSION_TOKEN_SECRET` or `BETTER_AUTH_SECRET` is set with at least 32
  characters. `GET /api/v1/conversations/{conversationId}/pages`, `.../pages/{pageId}` and
  `.../pages/{pageId}/file-sets/{fileSetId}/source-file` read them, and `POST .../pages/{pageId}/preview`
  answers the address a frame loads a revision from. The tool `page.save`, below, stores them. A file set
  holds at most 500 files, 2 MiB per file and 25 MiB in all, a Page at most 1,000 revisions, a
  conversation at most 200 Pages. Deleting a conversation, a workspace or a user removes their
  Pages, rows and files, whether the module is on or off.
- **Pages, serving:** the files of a revision are served at
  `/app-content/<file set>/<token>/<file>`. **A reverse proxy must route `/app-content/*` to the
  API**, as it does `/app-runtime/*`, and must not write these addresses to an access log:
  the token is a bearer capability, minted after the check that the person may read the Page
  and valid for one hour for whoever holds the address. `docker/Caddyfile` and
  `docker/nginx-spa.conf` are changed accordingly. An HTML file is never answered as stored: the
  answer is a shell that holds it in a frame with `sandbox="allow-scripts"`, under the header
  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'
'sha256-<the platform's script>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none';
frame-ancestors 'self' <allowed origins>`. A Page therefore has no origin, sends no form,
  opens no window, reaches no other host and cannot move its frame. The platform's script is the
  only content of the frame's document and writes the stored HTML into it as its last step, so
  there is no Page where that script did not run. In a Page a link has no address, there are no
  frames, `document.write` is refused and the WebRTC constructors are removed by name; this
  part runs in the Page's own realm and is hardening, not a boundary. WebRTC from a scripted
  frame stays a known open exit. Tested in Chromium only.
- **Database:** migration `0050_pages` adds the tables `pages` and `file_sets`.
- **Pages, saving:** the tool `page.save({ name, directory })` stores a folder of the
  conversation's Execution Workspace as the next revision of a Page. It answers
  `{ pageId, number, fileSetId }`, or `{ errors: [{ file, line?, column?, message }] }` when the
  files do not build; a failed build stores nothing and uses up no number. The tool exists with
  the module `apps` on and Execution Workspaces enabled, and like every tool it must be listed in
  `tools` and on an agent. The folder needs a manifest `app.yaml` (`id`, `name`, `kit`, optional
  `description`, `icon`, `entry`, `connections`, `actions`, `externalHosts`; unknown keys are
  refused). The build is the job kind `page.bundle`. **It runs in the sandbox of Execution
  Workspaces, as the fixed command `catalyst-page-build` of the runner image, and the workspace
  command worker serves it.** With the Docker sandbox that is a container without network, with
  a read-only root file system, no capabilities and the sandbox's CPU, memory and process
  limits; it sees one directory holding a copy of the Page's files and nothing else. The worker
  reads what the command left behind as untrusted data. No file of a Page is parsed or run in
  the API process or in a worker process. Kit imports are rewritten to
  `/app-runtime/kit/<kit version>/<file>`, and inline scripts and styles of an HTML Page are
  moved to files. An inline event handler such as `onclick` fails the save with the file,
  element and attribute; a file whose name ends in `__virtual.js` (or `.ts`, `.mjs`, `.cjs`,
  `.mts`, `.cts`) is refused, because the route generator would execute it. A build is stopped
  after 60 seconds (`PAGE_BUILD_TIMEOUT_MS`) or when it leaves more than 50 MiB or 500 files; a
  worker process runs 2 builds at once (`PAGE_BUILD_CONCURRENCY`). **Operators:**
  `modules.apps.enabled: true` now requires `executionWorkspaces.enabled: true`, a running
  workspace command worker that can reach the `files` object store, and a runner image of this
  release; outside development the sandbox must be `docker`. An instance that lacks one of
  these does not start and names it, and a runner image without the command fails each save
  with a message that says so. Both runner images carry the command, the platform's
  `workspace-command-runner` target and the capabilities runner image, and each builds a small
  Page with it when the image is built. A save fails after 30 seconds, with the reason, when no
  worker takes builds: none is running and none was claimed or ended in that time. A revision is published in one transaction with the result of its build,
  so a job delivered twice or a save that gave up leaves no second or unwanted revision. A
  worker removes the directories and containers a killed worker left of its builds. The kit
  files themselves are not served yet, so a saved React Page does not render until they are.
- **Database:** migration `0053_page_builds` adds the table `page_builds`, the row a save and
  its build meet on. A row lives for the length of one save.

- **Infrastructure:** the page **Instance > Infrastructure** in the settings and
  `GET /api/v1/instance/infrastructure` list what the instance runs on: every entry of the
  `infrastructure` section and the database, each with its provider, region, endpoint host or
  bucket, its secrets with "set" or "missing", and the result of its last check. Both need
  `users.manage` and change nothing. No secret value, connection string, key or host path is
  returned. A secret is shown by its name while it is set; one that is missing is shown by the
  config key that names it. A host or a bucket that does not read as one is shown as "not shown"
  and named in a warning of the server log by provider and field. Every provider now has a
  check, the cheapest authenticated read it has, which ends after five seconds together with the
  creation of the provider. An S3 store is asked with one `HEAD` of its bucket; a missing bucket
  is the class `bucket_missing` and is not created. The new job kind `infrastructure.check` runs
  the checks of the API every five minutes, the workspace command worker checks the sandbox
  with the kind `infrastructure.check_sandbox`, and
  `POST /api/v1/instance/infrastructure/check` runs the API's checks once more, at most once a
  minute for the instance. A failed check carries a class from a closed list and never the
  provider's own error text. A provider that fails does not change `/ready`.
  `defineProvider` requires `check`: a capability that registers a provider must add one.
- **Database:** migration `0046_infrastructure_check_state` adds the table
  `infrastructure_check_state`, one row per instance with the last check outcome of each
  provider and the time of the last manual check. Every API process reads it, so the page shows
  the same health whichever process answers.
- **Models:** a second model adapter, `google-vertex`, calls Gemini on Vertex AI through
  `generateContent`: text, tools, images, PDF documents, answers in a JSON format, streaming and
  abort. An entry under `infrastructure.models` takes `projectId` and `credentialSecret` (default
  `GOOGLE_VERTEX_CREDENTIALS`, the JSON key of a service account), and its `region` decides the
  endpoint and location: `eu` stays on `aiplatform.eu.rep.googleapis.com`. Web search, reasoning
  efforts, the fast tier, server-side compaction and tool calls are not declared, so a call that
  asks for one is refused before it is sent. Tool calls wait until the adapter carries Gemini's
  thought signatures: a call with tools or with a tool call in its history is refused with
  `VALIDATION_FAILED`, and a binding on such a provider must state `agentSelectable: false`, or
  startup stops with: `Model binding '<id>' can be chosen for agents, but provider '<id>' does
not support tool calls, which every agent run needs: set 'agentSelectable: false' on the
binding`. The check on **Instance > Infrastructure** asks Google for a token with the key; it
  does not call Vertex. A model message can carry a PDF document; the
  gateway refuses such a call for a model that does not read documents, and fails a call that
  asked for a JSON format with `invalid_response` when the answer is not JSON, after settling
  what the call used. An answer the provider counted and then blocked or could not form is
  settled with the usage it reported. A conformance suite runs the same recorded cases against
  both adapters.
- **Capability SDK:** the capability context has `models`, the instance's model gateway for a
  capability's own calls. `models.complete` takes a model binding, a purpose, text and PDF
  content and an optional JSON format, and `models.describeBinding` says what the binding's
  model can do. The call is admitted and recorded like every model call. A worker process of a
  capability gets the same from `createWorkerCapabilityModels` of
  `@vivd-catalyst/client-assembly`, which creates only the providers behind the bindings it is
  given.
- **Assets:** agents and skills are read and written at `/api/v1/assets/{kind}/...` through nine
  operations: `assets.list`, `assets.get`, `assets.put`, `assets.delete`, `assets.revisions.list`,
  `assets.revert`, `assets.validate`, `assets.sync` and `platform.context.get`. Each call is one
  Operation Run and is decided by the right on the one asset (`<kind>.read`, `.write`, `.delete`),
  so a holder of rights in a Namespace lists, reads and writes the assets of that Namespace.
  `assets.list` answers summaries in pages, filtered by name prefix and text.
  `assets.revisions.list` answers the revisions of one asset in pages, newest first. A write names the
  revision it was made against in `expectedRevision` and answers `409 CONFLICT` with
  `details.currentRevision` when the asset stands at another one; a put without it creates the
  asset and is refused when the name is taken. `assets.sync` applies up to 200 puts and deletes
  for one Namespace completely or not at all, reports each item and reaches no asset outside the
  prefix. The right on every item is decided before the policy is asked, and a policy setting
  narrowed to a kind or a Namespace applies to every asset call that names one of that kind or in
  that Namespace. A reference to an asset the caller may not read is answered like a reference to
  an asset that does not exist, on a put and on a revert, also for an asset in the same Namespace;
  a reference the stored asset already holds may stay. `assets.get` names of an agent's
  availability only the workspaces the caller is a member of, and all of them to a holder of the
  instance-wide write right. `platform.context.get` now also answers a service principal and names only the actions
  the credential's scopes allow. **Breaking:** the five old asset addresses are gone. Scripts that
  called them use `/api/v1/assets/...`; the CLI is unaffected. The operations
  `config_assets.get`, `put`, `delete`, `revert` and `revisions.list` under
  `/api/v1/instance/config/assets/{kind}/{name}` answer `404`, and the instance-wide `baseVersion`
  of these writes is replaced by the asset's `expectedRevision`. Three migrations (0047 to 0049)
  tie an asset a workspace owns to that workspace: deleting the workspace deletes its assets and
  the grants on them.
- **Operations:** an agent's tool call is a call of an operation. Every tool call leaves an
  Operation Run with the person as actor and the agent, conversation and tool as origin, and a
  tool is handed its run as `context.operationRun`. A capability's model call that passes it on
  (`workspaceId` and `operationRunId` of `models.complete`) is a usage row of that person,
  workspace and run. A call the policy
  sends to another person is held: the answer over HTTP is `202` with the run, an approval
  request of the kind `operation_call` appears in the **Inbox** of everyone who holds the new
  right `operations.approve` (admins hold it by default, and the legacy permission
  `agent_skills.approve` includes it), and the agent is told that its call has not run. The
  request shows the operation, who called it, through which agent, and the input: the first 50
  fields of 2,000 characters each as rows, a sentence that counts what the rows leave out, and
  the whole input in a full view. Approving records the decision and answers at once; the call
  then runs once in a job (`operation_call.execute`, four at a time, on the API's job worker),
  as the person who made it and with their rights of that moment, and ends after its
  operation's timeout at the latest. The caller may approve their own call when they hold the
  right. A second or late decision is refused with `409`, and so is a decision of a request
  that somebody else is deciding at that moment. Declining or withdrawing ends the run as
  `denied` with the reason `DECLINED`. When the job runs the call it asks again: the caller's
  account is open, they are still a member of the workspace, they still hold the right, the
  agent is still available in the workspace and still lists the tool, and the policy and the
  guardrails still let the call through. Otherwise the call does not run and its request ends
  as superseded with the reason, shown as "Not executed". The run is marked as started
  immediately before the operation is called. A worker that is told to stop before that calls
  nothing: the call stays queued and the next worker executes it. Only a call that was being
  executed when the worker stopped is recorded as interrupted, and is not run again. A request says what became of its call: approved and executed, approved
  and failed (also when the target changed while it waited, for example an asset write whose
  expected revision no longer matches), approved and interrupted, not executed, or expired;
  the thread is told the same and reads "active" only for a call that succeeded. A held call
  expires after seven days, and a decision that comes after that is recorded as expired, with
  nobody named as having decided it. One person may have 25 calls waiting and an instance
  2,000, counted and filed under one lock; a held input may be 256 KiB; one more is refused and
  says so. The input of a held call is removed from its request when the request ends: after
  the call ran, on a rejection, a withdrawal or an expiry, and when the conversation or the
  account of the caller is deleted. The request keeps which run, operation, actor and origin it
  was. The job `operation_call.remove_ended_input` (every six hours and at start, 2,500
  requests a tick) removes the input from requests that ended before this release. It also
  ends, as not executed, a request that still keeps its call when that call can never run:
  its run no longer exists, or the account of the caller is being deleted. This reaches a
  request whose conversation or account was deleted while a decision on it failed.
  The page **Instance > Operations** in the settings lists the runs with filters for operation,
  status, origin and workspace and shows one run with its decision and correlation id, without
  input or output; it needs `audit.view`. Two scheduled job kinds keep runs from staying open:
  `operation_runs.expire` every five minutes and `operation_runs.recover` every minute, which
  fails a run whose process is gone as `interrupted`. Deleting a conversation deletes the runs
  its agents caused, and the audit retention also removes ended runs no conversation caused.
  Migration `0052_operation_run_list_indexes` adds five indexes, created concurrently.

- **Modules:** a module that is off is off everywhere. Each of its operations answers
  `404 NOT_FOUND` with `details.reason: "module_off"` and the module in `details.module`, to a
  caller who is authenticated; a call without a credential gets `401` as on any route. Its agent tools are not offered to the model and cannot be called,
  and a write that adds or changes an agent that names one is refused with a message that names
  the module; an agent stored earlier keeps its entry, runs without the tool and holds up no
  other write, and the agent editor shows the entry as not available and removable. Its job kinds
  are not claimed, and their queued jobs stay queued and say under **Instance > Jobs** which
  module they wait for. The operations of `assetManagement` answered `403 FORBIDDEN`
  while the module was off and answer this `404` now. The page **Instance > Modules** in the
  settings and `GET /api/v1/instance/modules` list every module with its state, what it adds and
  its config key; both need `audit.view` and change nothing, because the switch is release config.
- **Access:** an instance administrator can give one user read, write or delete on agents or
  skills inside a Namespace or on one asset, and can deny it. A Namespace is a registered name
  prefix such as `kai-`; it can carry a list of allowed tools and a list of allowed model
  bindings, which bind every writer of an agent in it, an administrator and the release sync
  included. Eight operations under `/api/v1/instance/access` write and read grants and Namespaces;
  they need `users.manage`. A deny wins over every grant and role that would allow the same action
  on that asset. It does not wall the asset off from holders of instance rights: export and
  setting the default agent are decided at the instance and still reach it. A holder who is denied
  anything on an asset cannot delete it. Deleting an asset removes the allow rows on it and keeps
  the deny rows: a deny on a name stays until it is revoked, also across delete and recreate, and
  the grant list keeps showing it. In a Namespace with a list of model bindings, a user who may
  write agents there sets `modelBindingId` to a binding on the list without holding
  `agent_models.manage`; a binding off the list is refused for everyone, and an agent that names a
  provider or no model is refused unless the writer holds `agent_models.manage`. A grant's
  `grantedBy` and a Namespace's `createdBy` are left out for a caller who is not shown that user.
  Deleting a user deletes the user's grant rows. The page **Instance > Access** in the settings
  writes and shows all of this in three tabs, Namespaces, Grants and Check, and is shown to holders
  of `users.manage`; a grant row of asset scope answers with `scopeAsset`, the kind and name of
  its asset and whether it still exists. `scopeAsset.name` is left out for a caller who may not
  read that kind of asset; the row still carries `scopeId`. A migration adds
  the tables `permission_grants` and `namespaces` and changes no other table; no user, service
  principal or API key gains or loses a right. `node --experimental-strip-types
scripts/verify-permissions.ts` with `DATABASE_URL` set compares every holder's rights with what
  the legacy columns answered and exits non-zero on a difference. Before rolling back to an
  earlier release, list the deny rows (`select * from permission_grants where effect = 'deny'`):
  an earlier release reads neither table, so every grant stops applying and every deny stops
  refusing. An earlier release that deletes an agent or skill leaves the grant rows on it, and
  they apply again if the same name is created after rolling forward. Remove them first: `delete
from permission_grants where scope_kind = 'asset' and effect = 'allow' and scope_id in (select
id from config_assets where status = 'deleted')`.
- **Operations:** an operation can be registered once in the operation registry and is then
  reached through one call path, `runOperation`, that checks the actor's right, resolves the
  policy, asks the guardrails, executes and records the call as an Operation Run. Over HTTP
  the status says how the run went: `200` with the output, `202` with the run and a
  `Location` header while it waits for an approval, `403` for a refusal (`FORBIDDEN`,
  `POLICY_DENIED`, `GUARDRAIL_BLOCKED`, `DECLINED`), the operation's own error for a failure.
  Every answer of such a call names its run in the header `Operation-Run-Id`. A changing
  operation takes an `Idempotency-Key`, scoped to its caller: the same call again is answered
  from the run with `Idempotent-Replayed: true`, and `409` tells a key used for another call
  (`IDEMPOTENCY_KEY_REUSED`), a first call still running (`OPERATION_IN_PROGRESS`), an
  expired one (`OPERATION_EXPIRED`) or an answer too large to keep (`OUTPUT_NOT_RETAINED`).
  A changing call that failed is never run again under its key, since it may have changed
  something before it failed: the key answers the recorded failure again, with the same
  status and code and `Idempotent-Replayed: true`, and another attempt takes a new key. Only
  a call that failed before its operation was reached runs again under its key. A changing
  call that was interrupted answers `409 OPERATION_IN_PROGRESS` with
  `details.interrupted: true`, because nobody knows how far it got. A replay answers the
  actor that holds the key without asking for the right again: the actor had it when the
  call ran, and a refusal would hide an outcome that happened. The origin of a run over HTTP
  follows how the call was authenticated: a browser session is `user`, a key or token in the
  request is `cli`, also for a person's token. An operation that requires no right must be
  registered with an `authorize` function, which is asked where a named right is: after the
  scope and before the policy, the guardrails and an approval. Without one the server does
  not start.
  No operation of the release is registered this way yet. A run stores a hash of the input,
  never the input, and for a failure a code and a safe message.
- **Operations:** `GET /api/v1/operations/runs/{runId}` reads one Operation Run and
  `GET /api/v1/operations/runs` lists them, filtered by operation, status, actor, origin,
  workspace and time. A caller reads its own run; any other run and the list take the right
  to view the audit log. Both take the scope `governance:read`.
- **Release config:** `policy.defaults` sets the policy value of operations that nothing else
  names one for: `reading` is `allow` or `deny` (default `allow`), `changing` is `allow`,
  `confirm`, `approval` or `deny` (default `confirm`). An instance without the section gets
  the defaults.
- **Database:** migration `0033_operation_runs` adds the table `operation_runs` and the
  nullable columns `user_id`, `collaboration_workspace_id` and `operation_run_id` on
  `model_usage_events`. Nothing writes the three columns yet. The previous release runs
  against the migrated database.
- **API client:** a method of an operation that can wait for an approval answers an
  `OperationOutcome`: `done` with the output or `pending_approval` with the run. The client
  sends a new `Idempotency-Key` with every such call unless the caller passes
  `idempotencyKey`. `createApiClientFor(operations, options)` builds the same client for
  operations outside the release's catalog. Cross-origin browsers may send `Idempotency-Key`
  and read `Operation-Run-Id`, `Idempotent-Replayed` and `Location`.
- **API contract:** `defineRegisteredOperation` defines an operation of the registry.
  `defineOperation` takes an optional second success answer (`accepted`) and declared
  `headers`, which the OpenAPI document states. Error codes that share a status share one
  answer in the document, named after all of them.

- **API:** `GET /api/v1/conversations` takes an optional `query`. It keeps the conversations
  whose title contains the text, without regard to case, with the paging and the access
  filter of the list.
- **API reference:** an instance serves the OpenAPI document of the operations it runs at
  `GET /api/v1/openapi.json` and the same document as a page at `GET /api/v1/docs`. Both
  answer any signed-in person and any access token, whatever its scopes, and refuse a caller
  without a credential. The page holds no script and loads nothing from another host. The
  docs site has an "API Reference" section written from the release's document at build time.
- **API contract:** `openapi.json` is an OpenAPI 3.1 document with the release version, named
  schemas, the credentials each operation accepts with the scope it needs, an answer for every
  error code, `text/event-stream` and 204 for a stream, and the effect, rights and rate class
  of each operation as `x-catalyst-*` fields. It ships in `@vivd-catalyst/api-contract` as
  `@vivd-catalyst/api-contract/openapi.json`. `pnpm generate:openapi` writes it;
  `pnpm check:openapi` fails when it is stale or has a lint finding; `pnpm check:contract`
  fails on a change that breaks a caller of the newest release whose document has `/api/v1`
  paths, and passes with a notice while no such release exists. Both run in `pnpm check`.
  The package also exports `findBreakingChanges`, `describeApiReference` and
  `renderApiReferencePage`.

- **Chat:** the composer's model selector is a model picker. It opens as a short menu with the
  model and its reasoning effort; the model list shows each model's provider logo and an EU
  mark for providers with `region: eu`, and a model under the pointer brings up a
  card with its description and usage consumption. A model binding can carry `description`,
  `vendor` and `usageTier` for it. The usage tier comes from the Customer Rate Card unless the
  binding sets one.
- **Chat:** users can pick the reasoning effort of a model: `low`, `medium`, `high`, `xhigh`
  or `max` unless the binding's `userSelectableReasoningEfforts` lists others, and an empty
  list turns the choice off. `max` is a new reasoning effort, also available in agent model
  settings. The agent's configured effort stays the default. The run
  API accepts `reasoningEffort` and rejects an effort the model that runs does not offer. A
  migration adds `agent_runs.reasoning_effort`.
- **Chat:** a model or reasoning effort the user picks becomes their default for new
  conversations, on every device. A conversation that already ran stays on what its latest run
  used, and a user who never picked anything follows the configured defaults. The pick is
  stored per user (`/api/v1/me/model-preference`); a migration adds `product_users.model_preference`.
- **Workspaces:** a superadmin is Owner of every Shared Workspace without being a member. The
  workspace selector lists them under "Other workspaces"; the superadmin can open their
  settings, manage members and access requests, and read and start conversations there.
  Private conversations stay with their author and Personal Workspaces with their user. A
  workspace in the API carries `membershipRole` (`null` without a membership) next to `role`,
  which is what the caller may do.
- **Interface, Settings:** Instance > Jobs shows what the instance works on in the background.
  A table counts the queued, running, failed and dead jobs of each kind, kinds with failures
  first, and names how long the oldest due job has waited. Below it the jobs are listed under
  Failed and dead, Running and Queued, newest first; a kind in the table narrows the list to
  itself. A job shows its kind, status, attempts, when it was created and ended, the class of
  its last error and the id of the record it works on. It never shows the job's payload or an
  error message. The page asks again every ten seconds while its tab is visible. It needs
  `audit.view`.
- **Jobs:** a superadmin can retry a failed or dead job from that page. The job is queued
  again with its attempts reset and, in the same transaction, the record it works on is put
  back into the state the job starts from: a failed preview is pending again, a failed draft
  attachment is queued again. A job is not retried when a newer job already does its work,
  when its record can no longer be worked on, or when its kind is not retried by hand; a
  schedule tick is such a kind, because the next tick is its retry. The audit log records
  `job.retried` with the job and its kind.
- **API:** `GET /api/v1/instance/jobs/summary` and `GET /api/v1/instance/jobs` (filters `kind`
  and `status`, 50 per page) need `audit.view` and the scope `governance:read`.
  `POST /api/v1/instance/jobs/{jobId}/retry` is an operation of the registry that only a
  superadmin may call; it answers `409 CONFLICT` with `details.status`, or with
  `details.reason` `superseded`, `kind_not_retried` or `subject_not_restorable`.
- **Extension API:** a job kind can declare `manualRetry: false`. A capability hands the API
  `jobRetries` in its contribution: one entry per kind whose ended jobs may be retried by
  hand, with an optional `restoreSubject` that runs in the retry's transaction. The API
  retries no job of a kind it was given no entry for. `ChatServerOptions.jobRetries` carries
  them to the server. `PlatformFileStore` gains `restoreFailedArtifactPreviewJob`.
- **Inbox:** Approval Requests are found in the Inbox, a section of the sidebar below Chat at
  `/inbox`, with one address per item (`/inbox/<id>`). A person who may decide gets the lists To
  decide, My requests and Decided (the last 30 days); everyone else gets their own requests as
  one list, with the state, who decided and the comment. The new operation
  `approval_requests.list_mine` (`GET /api/v1/approval-requests/mine`, scope `conversation:read`)
  returns the caller's own requests. `approval_requests.list` takes `scope=decided`, and
  `approval_requests.count_pending` also answers `mine: { pending, total }`. A migration adds the
  index `approval_requests_client_requester_idx` to `approval_requests` and changes no data.

- **Deployment kit, upload check:** a deploy now ends by putting a file through the instance.
  `host/check-upload.mjs` runs in the `api` container, creates a conversation as the user
  `catalyst-deploy-check` ("Deploy check (synthetic)"), uploads one small text file, waits up
  to 60 s until it is `ready` and deletes both again. A file that is not processed fails the
  deploy with its state and the job behind it, for example
  `conversation_attachment.preprocess is queued, attempt 0 of 3`. **Operators:** the check signs
  in with `CHAT_SERVER_CREDENTIAL`, which the `api` service already holds, through
  `POST /api/v1/instance/session-tokens`; an instance without `auth.sessionToken` fails the
  check with that reason. Nothing is to be provisioned. The user `catalyst-deploy-check`
  appears among the instance's users after the first deploy and each run leaves two audit
  events. An instance with `retention.allowUserDelete: false` cannot remove the check's
  conversation and fails the check, naming the conversation.
- Add `pnpm check:affected` for builders to check changed packages and their dependents before review, with package quality baselines and affected tests.
- Fall back to all scopes for shared quality tooling changes, type-check root tests for every selected package, keep root-test-only checks narrow, and include Git diagnostics for missing bases.
- **A guide to building an App:** the docs page `apps/build` shows an App's folder, its
  manifest and each kind of named action (`connection`, `sql`, `workflow`) with a complete
  example, what a Page and a draft do with a changing action, how the App's code calls an action
  through the kit and who publishes. The shipped skill `platform-docs` carries it, and a test
  builds every example on the page. `page.save` now describes `sql` actions, and `page.save`,
  `page.save_as_app` and the platform orientation point the agent at the page before it writes
  actions.
- **Build errors that name the fix:** a YAML file in `actions/` without the ending
  `.action.yaml` is refused with the name it needs (it was passed over, and the action was
  missing at the first call); an action file without `connection`, `operation` or `effect` says
  what the key holds; an unknown key on a line under `actions` in `app.yaml` says which keys a
  line holds and that an action file needs none.
- **Task pages for people who use the product (D-2):** "Connect a system" (create a Connection,
  enter its key, accept operations, test, give an agent the tools, let people use it),
  "Workflows" (find, change with the agent, test run, Run live once, publish, start), "Guardrails"
  (when one runs, what a hit does, reading them in Studio, writing, testing and publishing one)
  and "Apps for people" (ask in a chat, Save as app, the draft's simulated actions, Run live once,
  publish). Each says what to click, with the German screen labels beside the English. The
  sidebar gains the groups Automate and Connect, and the shipped skill `platform-docs` carries
  the pages.
- **Docs:** A "How it works" page, Rights at a glance, explains in three pictures who may do what, where an App's data comes from and what a workspace gives its members, with the text beside each picture. The docs theme gains the diagram classes these pictures use.
- **Draft safe mode for Apps (ADR-0031):** a changing action called from the draft of an App is
  simulated: it answers `dry_run` with what it would have done and the input, changes nothing,
  and leaves an Operation Run with the target `dry_run` (named in `Operation-Run-Id`). A reading
  action reads live. "Run live once" on the Actions side of the draft carries out the next call
  of one changing action, for a person who writes the App. The switch is its owner's, on the
  key of action and person that Workflow test runs brought, so one member's switch neither
  replaces nor uses another's; the call goes through central policy (a call that needs another
  person's approval is refused with `approval_unavailable`, since a draft cannot wait). A save
  or a discard of the draft clears an unused switch at that moment and audits
  `live_once.cleared` in the name of who saved or discarded. `apps.actions.list` gives each
  action of a draft the `target` the reader's next call goes to. The test dialog says what the
  call would have done in the interface's language, and focus moves to the status line of
  "Run live once" once it is set. The UI library adds `TargetBadge` (Live, Test, Simulated),
  which now also marks the steps of a Workflow run, and `RunLiveOnce`. No migration of its
  own. Only a Page of a conversation still refuses a changing call with `draft_safe_mode`; a
  draft has no direct Connection call since `connections.call` was removed. **Upgrade:** an App's draft that called a changing
  action got `409 draft_safe_mode` and now gets a `dry_run` answer; the call needs an
  `Idempotency-Key` as in a published App. **Rollback:** the previous release refuses such a
  call again; switches stay in `live_once_switches` and are cleared by the next save or call.
- Show when a conversation started and where each new day begins: a small, centred time above the first message and above the first message of each later day, in the reader's time zone ("Today 10:47 AM", "Yesterday …", the weekday within the last week, the full date beyond it). It shows in the full chat, the side chat and while an answer streams. The UI library gains `TimeMarker` for it.
- Pull, push and inspect an App as a local folder with `catalyst app pull|push|status`. Files round-trip byte for byte, local edits are protected, and build refusals name the file, line and column. `catalyst app publish` shows the review and keeps the terminal question: `--yes` publishes nothing, and a required approval waits in the Inbox.
- Added `catalyst call <operation>` with file or stdin JSON input, JSON output and the existing API authorization and exit codes, plus write-only Connection secret entry and Connection test, discovery and tool-list commands.
- Fixed hidden secret prompts keeping the CLI process alive after Enter or Ctrl-C, reused the write's idempotency key for retries, and documented stdin for multi-line secrets.
- Recover a completed Connection secret write after a lost reply by reading its secret state on `OUTPUT_NOT_RETAINED` and exiting successfully; other conflicts remain refusals.
- Added named CLI commands for Workflow tests and runs, Guardrail hits, Knowledge Base checks, Data Store schemas and dependencies, App actions, own keys and Shared Workspaces, using the existing API client operations with readable output and `--json`.
- `instance workspaces` lists Shared Workspaces for agent availability; `workspace list` is reserved for personal memberships. Workflow test input file errors retain the file problem and exit 1.
- Personal API keys can follow their owner's Operation Runs and list and count their own approval requests with `me:read`; withdrawing an own request requires `config_assets:write`. Other callers retain their existing scopes and rights.
- `catalyst operation show <run-id>` follows a held call to its decision, and `catalyst requests [--withdraw <id>]` lists or withdraws the caller's own requests.
- Contract compatibility checks compare all scope alternatives per credential, and the API reference lists each credential once with its alternative scopes.
- A personal key refused a request withdrawal is told it needs `config_assets:write`; other caller kinds keep their existing scope refusals.
- **Connect a local agent:** Settings > "Connect a local agent" ("Lokalen Agenten verbinden"),
  at `/settings/you/connect` while personal API keys are on, gives one command for Claude Code,
  Codex or another tool: `npm install --global @work-shape/catalyst-cli@<version> && catalyst
setup <tool> --instance <url>`, with the instance's address and the CLI version
  `PUBLISHED_CLI_VERSION` names filled in. The page issues nothing; no key and no connect code
  exists until the command runs. `platform.context.get` answers that version as
  `release.cliVersion`. It is unset in this release, because no published CLI has `setup` yet:
  the page says the command is not available and shows none. Deploy order for the release that
  offers it: bump the shared version, run `Publish public CLI` on that commit, set
  `PUBLISHED_CLI_VERSION` and commit it, deploy, and only then switch on `personalApiKeys`.
  `Publish public CLI` now refuses a commit whose version is on npm already, with
  "@work-shape/catalyst-cli@<version> is on npm already. Bump the version all packages share and
  publish from that commit."
- **`catalyst setup <claude-code|codex|other> --instance <url>`** logs in by a connect code
  labelled "<Tool> on <host>" where no working key is saved, opens the confirmation address in
  the browser, and writes the Catalyst skill the package ships to
  `~/.claude/skills/catalyst/SKILL.md` (below `$CLAUDE_CONFIG_DIR` where that is set) or
  `~/.agents/skills/catalyst/SKILL.md`. A different file there is kept unless `--force` is
  given, which moves it to the first free name of `SKILL.md.bak`, `SKILL.md.bak.1` and so on; a
  link at that path is never written through. A run again keeps a working key and updates the
  skill; only a key the instance refuses (401 or 403) is replaced by a new login. It never prints
  the key. A test fails when the skill names a command or option `catalyst --help` does not list.
- **CLI:** outside a working copy, a command without `--instance` works on the one instance a
  key is saved for, unless `CATALYST_API_KEY` is set. With none or several saved it is refused,
  and the message names the saved ones. In a working copy nothing changes: one whose
  `catalyst.yaml` names no `defaultInstance` is refused, and the message names its instances. `catalyst --version` prints the version.
  `login`, `logout` and `setup` name the address of API keys, `<url>/settings/you/api-keys`.
- **`CommandLine`** in the UI library: one command with a copy button.
- **The docs page "Connect a local agent"**, carried into `platform-docs`.
- **New connection dialog (CS-5a 2/2):** "New connection" asks for an MCP server or a REST API, then for the name, the address and the key, with the id, how the key is sent, fixed headers and a test path under "Technical details". "Connect" writes the definition without operations, stores the key, tests the connection and, for an MCP server, reads its tools; a wrong address or a refused key is told at its field, a refused key empties the field, and a changed host sends the key again. Cancel after a failed connect asks, then deletes the Connection. The tools an MCP server names are approved in one list, the reading ones ticked, for agents, the bridge and workflows at once; the same list replaces "Accept" per tool on the Connection page. The tools of a REST API are pasted as YAML into that list, or "Draft with Workshaper" opens the chat beside the page with the request typed. Each operation on the page has four boxes: agents, the bridge, workflows and outside.
- **REST connections on the server (CS-5a 1/2):** the connector type `http_api` reads a REST interface by declared GET operations (CS-5a 1/2). Settings `baseUrl`, fixed non-secret `headers`, an optional `testPath` and `headerName`; a header that can carry a credential is refused as `credential_in_settings`. Auth `none`, `bearer` or `header`. Each operation declares `method: GET`, `effect: reading`, a `path` template with `pathParams` and `query`, and a `description`; caller input fills only the declared parameters, a path segment that is `.` or `..`, also written as `%2e` in any case, is refused in a declared path and a `testPath` at save and in a filled path at call time as `input_invalid`, as is a path parameter holding `/`, and no redirect is followed. The answer is JSON under 2 MiB and a list comes back as `{ items }`. Without `testPath` a test answered 401 or 403 is "key refused" and any other answer reachable. Changing the host of `baseUrl` clears the stored key. The key `scope` on an operation is reserved for SCOPE-2 and refused at save.
- **The agent drafts a REST API's tools as a card (CS-5c):** the platform tool `platform.connections.draft_tools` checks the operations an agent declares for an `http_api` Connection as a save would (GET only, the effect `reading`, no header or query or path parameter that can carry a credential, no `.` or `..` path segment in any spelling, no `default`, `const`, `examples`, `example` or singleton `enum` at any depth in a parameter's schema) and answers every issue, or the draft. A parameter is refused by credential substrings after case-folding and removing separators and digits, with only an exact allowlist of known harmless names; the credential words share the core list fixed headers are refused by: `refresh_token`, `subscription-key`, `authkey`, `jwt` and `pwd` are refused, `pageToken`, `nextToken` and `secretary` are not. The conversation shows the draft as a card with the tools' names, and an existing Connection by its own title; its button "Review and approve" opens the approval list on the Connection's page, which now shows each declared tool's description under its request, folded to three lines with "Show more" (`FoldedText` in the UI library), and each parameter's allowed enum values for drafted and pasted declarations, or, for an id no Connection has, the New connection dialog filled with the name, address and header names, whose drafted tools wait in the list after "Connect". The card never carries a key, and nothing is saved before the person approves. An agent holds the tool where its definition lists it; "Draft with Workshaper" now asks for the card instead of YAML to paste.
- **The chat dock beside every page (DOCK-1):** a conversation opened from a page's link
  stands in a dock at the left of that page and of every page after it, as
  `?chat=<conversation>` in the address; a reload or a new tab brings it back, and a
  conversation the person may not read leaves the dock empty without an error. A change of
  route never mounts the conversation anew, so its running answer, the composer's text and its
  scroll position stay. The dock opens at 420 px, keeps 380 px for itself and the page, and
  remembers a dragged width; below a main area of 760 px it lies over the page with "Show page"
  and "Show chat". Close hides it, and "Chat" in the page head brings it back with a dot while
  its answer runs. Going into or out of the dock plays a 250 ms view transition
  (`--duration-dock`), at once under reduced motion. The UI library gains `SplitHandle`,
  `SurfaceHeader` and `PageHeaderShellAction`.
- The docs build writes `catalyst/commit.json`, `{"commit": "<platform sha>"}`, so the published site names the commit it was built from. The hand-over check compares it with main. The commit is `CATALYST_PLATFORM_COMMIT` when set (a build without Git metadata), else the HEAD of the platform checkout; a build in neither case skips the file with a warning.
- When an agent's call waits for the person's confirmation, the conversation shows a card on that call: what it is, its input as it will run, when it expires, Allow, and Deny with an optional reason for the agent. The card says what became of the call, the same assistant message goes on once the run resumes, and every open tab closes the card when one decides. A call that waits for somebody else's approval shows its approval card under the line that the agent waits for it.
- **Workflows:** Test run of a Workflow's draft, from Test run in the canvas's draft bar or
  `workflows.test` (`POST /api/v1/workflows/:workflow/test-runs`). It needs `workflow.write`, not
  `api_access.manage`, and only a person starts one. A test run acts as the person who starts it,
  bounded by the Workflow's service principal: a step runs only where both hold its right, and a
  refusal names the side that lacks it ("The principal '…' does not hold … publishing would fail
  at this step", or `tester_missing_right`, "You do not hold …"). Reading steps read live; a
  changing step is simulated and says in sentences what it would have done. Every step run shows
  where its call went: Live, Test or Simulated. A disabled principal is refused with
  `run_as_disabled`.
- **Workflows:** "Run live once" on a changing step belongs to the person who sets it and makes
  that step live for the whole of their next test run: every item of a loop, every retry. Another
  tester's run stays simulated. `assets.list_live_once` (`GET /api/v1/assets/:kind/:name/run-live-once`)
  answers the caller's own switches and the test run that used each, so the run page shows them
  after a reload. The audit events `live_once.switched_on` and `live_once.used` name the switch's
  owner.
- **Workflows:** A step whose `confirm` the tester's own start satisfied says "A published run asks
  for approval here", because a published run has nobody present to confirm. A changing step that
  the policy holds for an approval is refused in a test run, which cannot wait for one yet.
- **Guardrails written as assets (EW-6a):** the kind `guardrail` is written as a draft and made
  to enforce by a publish, on the `draft_published` lifecycle, through `assets.put`, the CLI and
  the agent's asset tools. A guardrail belongs to the instance or to one Collaboration
  Workspace. Published guardrails run beside the floor of release config, which the release
  seed now stores published and which stays read-only; every guardrail that applies runs and
  the strictest answer wins. A workspace guardrail answers its workspace's events only, and a
  filter that reaches outside it (another workspace, an agent the workspace does not offer, an
  operation of another workspace's asset) is refused at save and at publish. Filters take a new
  key `workspace`. Guardrail assets never run on writes, publishes, deletes or tests of
  guardrails; only the floor does.
- **`guardrail.publish`:** a right of its own, held by administrators at instance scope and
  grantable at one Shared Workspace through `permissions.grant`. No bundle carries it.
- **`guardrails.test`, `guardrails.dry_run` and `guardrails.unpublish`:** a test checks a
  revision, the draft unless named, on sample content or on an asset, and keeps no hit. A dry
  run counts what it would have blocked, asked an approval for or warned on in the last 14 days,
  by actions and people and without names: writes and publishes of assets are checked again, a
  judge on at most the newest 200; calls of operations and approval requests are counted only.
  Unpublish stops a guardrail and keeps its draft. Publish and unpublish are audited as
  `guardrail.published` and `guardrail.unpublished` with revision, scope and actor, and a judge's
  usage counts for the guardrail's scope.
- **CLI:** `catalyst guardrail test`, `dry-run` and `unpublish`; `catalyst guardrail publish`
  shows the dry run first and asks `--confirm <n>` on a first publish that would block. `catalyst
  config pull|push` carries `guardrails/<name>/guardrail.yaml` with `check.md` for a judge's
  instruction.
- **Studio > Guardrails says when each guardrail runs:** every row of the list and the page of
  a guardrail show one line built from its event, filter, check, outcome and scope, in English
  and German, such as "Runs before an agent saves a skill, in workspace Kai Spezis. Checks the
  content for a text pattern. Blocks if the check fails." A guardrail of release config reads
  "set by the operator", and no event id is shown. A workspace guardrail's page names its
  workspace in place of "Instance".
- **Which calls skip the published guardrails** is decided by the operation: `guardrails.*`, the
  asset operations on the kind `guardrail`, a sync of guardrails alone and the agent's save of
  the guardrail its conversation is about. An input that names `kind: guardrail` no longer
  does. The dry run answers the guardrail's `outcome`, and `catalyst guardrail publish` asks
  `--confirm` also for the actions a first blocking publish could not check.
- **Guardrails (GR-PUB-1): publishing needs an instance admin's approval.** Every instance
  carries the shipped guardrail "Publishing needs an instance admin's approval"
  (`publishing-needs-approval`) on `app.before_publish` and `workflow.before_publish`, with no
  check and the outcome `require_approval`, on by default, existing instances included. It is
  not part of the release floor: a holder of `guardrail.publish` at instance scope switches it
  off and on again on Build > Guardrails (`guardrails.list_shipped`,
  `guardrails.switch_shipped`); each switch is the audit event `guardrail.shipped_switched`,
  and a release never switches it back on.
- **New rights `app.approve` and `workflow.approve`,** held by the `admin` role. A holder's own
  Publish of an App or a Workflow in the app satisfies a guardrail's `require_approval` on its
  publish only when the holder has the approve right at instance scope:
  the revision is live at once, and its Operation Run records the caller as publisher and
  approver with the decision reason `approved_by_caller` ("Approved by the caller's own
  click"); `operation.completed` carries `decisionReason: "approved_by_caller"`.
- **Everyone else's publish waits** as an Approval Request of the kind `app_publish` or
  `workflow_publish`, answered `202 pending_approval`. Only holders of `app.approve` or
  `workflow.approve` at instance scope see and decide it; the Inbox item shows the version,
  the live version it replaces, the files that differ, the changing actions or steps that are new or changed, the
  outside hosts it adds, the Connections, the Data Stores with their level and the account a
  Workflow runs as. A publish is checked against its caller's rights (RIGHTS-1a's rule over
  the principal a Workflow runs as) when it is filed, so a request that could never apply is
  not filed, and again when the approval applies it. Approving publishes exactly the frozen
  revision, as the requester. A
  request whose draft or live revision moved can no longer be approved: it ends `superseded`
  and its run is refused with `POLICY_DENIED`, `details.reason: approval_stale`. A newer
  request for the same asset replaces the open one.
- **`catalyst app publish` and `catalyst workflow publish` ask first** in the terminal; an
  answer other than yes publishes nothing. `--yes`, and a run without a terminal to ask, are
  refused with the reason ("needs your answer here or your click in the interface") until a
  publish can wait as a confirmation in the person's Inbox (OP-4). A held publish ends with
  exit code 3 and names the request id, even for an admin's key. A CLI answer never supplies
  approval; an instance approver can approve the request in the Inbox.
- **A publish of an App or a Workflow from an agent or an MCP client is refused** with the
  reason (`FORBIDDEN`, `reason: user_only`), until OP-3 and OP-4 let it wait for its person.
- `platform.context.get` names the `approve` right of a kind that has one.
- **Knowledge Bases on a Data Store (module `knowledge`, off by default, needs `dataStores`):**
  the asset kind `knowledge_base` with a draft and a published revision. Its definition names
  a Data Store under `backend: { dataStore: <id> }` and describes at least one of its tables
  with a sentence; it answers the method `structured` alone. A field of a later slice
  (`sources`, `indexing`, `search`, `queries`, `filters`, a built-in or external backend, or
  any field it does not know, such as an answer prompt) is refused with the slice that brings
  it. Publishing needs `knowledge_base.publish` and `data_store.read` on the store, and checks
  that every described table can be read; otherwise it is refused with the reason
  `knowledge_base_needs_attention` and the tables it could not read. `knowledge.<id>.query`
  (`POST /api/v1/knowledge-bases/:knowledgeBase/query`) runs one read-only statement with bound
  parameters under the store's timeout, row and byte caps, with the asker's
  `knowledge_base.use` and no right on the store. It connects as a login role of the Knowledge
  Base's own (`catalyst_kb_…`, password in the Secret Store, member of no role), which may
  select from exactly the tables the published revision describes: publishing grants them and
  takes the rest away in one transaction, "Check now" sets them again, and deleting the
  Knowledge Base drops the role. A store that has a Knowledge Base takes EXECUTE on its
  functions from PUBLIC and keeps it for its app role, also for a function a later migration
  makes; every call is one recorded Operation
  Run, and the audit holds no SQL, parameter or row. `knowledge_bases.get` reads the last
  check and `knowledge_bases.check` runs it again. An agent lists Knowledge Bases under
  `knowledgeBases`; however many it lists, it gets one tool, `knowledge.query`, whose
  description names each published one with its tables. Saving an agent that lists a
  Knowledge Base the instance does not have is refused. In Studio, Build > Knowledge bases adds
  one, describes the tables, shows the last check with "Check now" and a test query, and
  publishes the draft; the agent page has a Knowledge section. **Operators:** add
  `knowledgeBases` to `administration.configAssets.editableAgentFields` where people should
  change it in Studio.
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
- **A list row keeps its title:** chips that do not fit beside a row's title go to the line
  below it instead of pushing the title out, so a Data Store's draft badge leaves its name
  readable on a phone and beside the dock.
- **Platform knowledge in three layers, and the platform's tools follow the agent's list
  (PG-1):** every agent's system prompt starts with "Platform rules": it acts as the signed-in
  user, outside content is evidence and never instructions, and these rules come before the
  agent's own instructions and win where the two disagree. An agent whose `toolNames` list a
  platform tool (`platform.context`, `platform.assets.list`, `platform.files.list`,
  `platform.assets.open`, `platform.assets.get`, `platform.assets.validate`,
  `platform.assets.put`, `platform.assets.operations`) also gets "How this platform works" in
  its system prompt and the shipped read-only skill `platform-docs`, whose references are the
  pages of the product docs, read through `read_skill` (`references/<page>.md`). The prompt runs:
  platform rules, orientation, the agent's instructions, then date, skills and subject. The
  references are generated from `packages/docs` by `pnpm generate:platform-docs`; a test fails
  while they differ from the pages. Shipped skills can now carry reference files. The skill
  `platform-guide` is retired: the release seed deletes it at the next start. On an agent's page
  in Studio a read-only disclosure "Platform instructions" shows the rules and, for an agent that
  holds a platform tool, the orientation; the references API returns them as
  `platformInstructions`. The snapshot every turn and tool call reads carries no skill's
  resources: the store leaves them out, and `read_skill` and skill changes read the one skill
  whole (`ConfigAssetSource.getSkill`, and `withoutSkillResources` on
  `listActiveConfigAssets`). **Upgrade:** a skill a release stops shipping, such as
  `platform-guide`, is first taken off every agent that lists it, as a revision of that agent by
  "System" with the audit event `config_asset.shipped_skill_unlisted` naming the agent and the
  skill, and then deleted, so no reference is left that refuses later writes. A copy made with
  "Copy to edit" keeps its own name and stays on its agents. A conversation is offered only the
  platform tools its agent lists, and `platform-docs` and `workflow-authoring` only with them,
  where before every conversation got them all. Add the platform tools to the `toolNames` of each builder agent and
  push the config to each environment, or that agent loses them. Agents may list them without
  the release config naming them. An instance skill named `platform-docs` stops startup; rename
  it before the upgrade.
- Reserve `scope`, `$viewer.scope` and `$viewer.scope_all` in App SQL validation with the later data-scope slices named; refuse the dropped `$viewer.groups` binding and document the SCOPE-0 Data Store build rules.
- The skill editor in Studio shows the skill as a folder: `SKILL.md`, and the files below `references/`, `scripts/` and `assets/`. Text files are edited in place; any file can be uploaded, replaced, downloaded and deleted. A file is added to one of the three folders, and its type is read from its name. A save writes the whole folder where a file beside the instructions changed, and the instance's refusals, such as a file over 2 MiB, a compiled program or a script that is not UTF-8 text, are shown with the path of the file.
- A write of a skill's config is checked as a write of its folder is: the text resources it holds, beside the files it keeps, are refused for their size, the number and total size of the files, a Git LFS pointer, an invalid path, and a path that is a file and a folder at once. Before, a config write took such resources unchecked.
- The UI library has `FilePicker`: a labelled library control, such as a button or a menu item, opens the system file dialog, and the library owns the hidden file input.
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
- Config validation and push report unavailable agent tools with their `toolNames` index or instructions line. Dotted tool names in instructions are checked with or without backticks in the full registry’s tool groups, including tools disabled on the instance; skills are not scanned. Connection operations must exist in stored assets and be exposed to agents. App actions resolve against stored assets plus the push batch. Tools that exist and are exposed but are not callable now produce warnings. Failed validation writes nothing.
- The demo agent's instructions no longer name an unavailable App-saving tool, so demo seeding passes tool-reference validation.
- The Connection tools browser fixture saves valid references before removing a Connection, then verifies its retained tool is marked unavailable after a reload.
- **Tools people can read on the agent page:** the Tools section works like the Skills section
  above it. Each package ("Paket") the agent uses is a chip with its icon and name: Documents,
  Web, Files and code, Results, Skills or Platform. So is each of this instance's own tools and
  each Connection. A chip shows "1/3" while only some of its tools are on and has a remove ×.
  Clicking it opens a panel with its sentence and its tools, each with title and summary, plus
  "Remove package" and "All on". "Add packages" is a picker that lists what is not in use, with
  its sentence and number of tools, and adds it with all its tools on. A tool without a title
  shows its id. `read_skill` shows as included while the agent has a skill and is saved with it,
  so the warning to tick it is gone. The ids, effects and packages stand under "Technical
  details". The Connection groups are gone; each Connection is a chip.
- **What a tool tells people:** a tool definition takes optional `title` and `summary` in
  English and German, a `group` and an `icon` of the UI library's registry. Every platform tool
  carries them; a deployment's tool carries its own. `platform.references.get` answers them as
  `tools` beside `enabledToolNames`, with the module whose switch governs each tool.
- **`Chip` takes a count and a panel:** `trailing` shows small muted text after the label, and
  `popover` makes the chip open a panel under it.
- **`SkeletonChips`:** the loading layout of a row of chips with the picker below. The agent
  page's Tools section shows it while the instance's references load, so no tool stands by its
  id before its package is known.
- Publish the built documentation site as the restricted `@work-shape/catalyst-docs` package in each lockstep release, including its version and core commit so deployments can publish docs from their pinned registry package.
- **Releases:** `pnpm release:cut <version> --root ../capabilities` cuts one lockstep version, folds change files, refreshes OpenAPI and checks tarballs before creating a local release commit in each repository. Requires matching current versions in both repositories and reports repository state and undo commands when preparation fails, plus finish commands when a release commit fails. All manifests, including private tooling and repository roots, share the current version. Workspace dependencies stay linked; tags and publishing remain separate.
- **Release validation:** Core CI audits its own manifest versions and tests paired version drift with fixtures, so core and capabilities changes can land in that order. The cut preflight still refuses mismatched real repository versions before writing either tree.
- The deployment kit ships `docker/deployment.Dockerfile`: a deployment builds its six release
  images (api, ui, workspace-command-worker, artifact-preview-worker, doc-worker, runner) from
  its own folder, installing the catalyst packages its lockfile pins with an `npmrc` build
  secret. The runner and document worker images carry only their packages and what those
  depend on. The images keep `/app/deployment.<instance>`, so Compose files are unchanged. The
  kit README holds the bake file a deployment points at it.
- `catalyst-deploy bump VERSION` pins every `@work-shape/catalyst-*` dependency at a version
  npm has, rewrites the deployment's own `pnpm-lock.yaml` (`--ignore-workspace`) and prints the
  release notes in between. `catalyst-deploy pack-local` builds the same images from the
  workspace's platform and capabilities packages packed into `.local-packages/`, for changes not
  yet released.
- For a deployment without `deploy/release.refs`, `catalyst-deploy check` refuses a catalyst
  dependency that is not one exact release (`workspace:`, `file:`, `link:`, ranges, two versions,
  overrides), then gates on the installed release: it refuses `node_modules` that links local
  source. Refusal texts start with `catalyst-deploy:`, for example
  `dependencies.@work-shape/catalyst-ui is workspace:*: a local package never reaches a release`.
  `check --static` runs only the checks that read files; `publish staging` runs it.
- Release manifests of such deployments are schema 2 with `catalystVersion` instead of the
  platform and capabilities commits. `manifest check` still accepts schema 1, so rolling back to
  an earlier release keeps working; `deploy` refuses a schema 2 manifest whose
  `catalystVersion` is not the kit's own version.
- Deployments with `deploy/release.refs` keep `update-refs`, `prepare-workspace` and the
  stitched gate unchanged until they switch (VP-6, VP-7); `bump` and `pack-local` refuse them.
- pnpm drops the integrity of the SheetJS URL tarball whenever it rewrites a lockfile. The kit
  puts back the integrity core's lockfile records after every lockfile it writes (`update-refs`,
  `bump`, `pack-local`). It refuses a lockfile that still resolves a URL tarball without an
  integrity, or with a different one, before anything is compared or written. `check` refuses
  a deployment lockfile an install left without it; `bump` to the pinned version puts it back.
- **A workspace owns agents and skills (WS-OWN-1a):** an agent or skill made in a Shared
  Workspace's Studio scope, or pushed from a working copy bound with
  `catalyst config pull --workspace <id>`, belongs to that workspace (and so does a guardrail
  such a root pushes); one made with the scope
  Instance, or from an unbound working copy, belongs to the instance. `assets.put`,
  `assets.sync` and the reads take the owner as `workspaceId`; a batch names a Namespace or a
  workspace, never both, and a workspace batch is never a release. Only an asset of the same
  workspace may name a workspace's skill: an instance agent or another workspace's agent that
  names it is refused with `invalid_scope`, and a workspace agent names an instance skill only
  where its writer holds `skill.read` on it. A name that is taken is refused without saying
  where. A new workspace agent is offered in the workspace it was made in when its maker is a
  member there, and starts hidden after a push; offering it in another workspace is an
  instance admin's step. A workspace's agent is never the instance default: `assets.set_default`
  and a release naming one are refused with `default_owned_by_workspace`, and so is a
  workspace's agent as the first agent of an instance. A workspace's builder starts a Build
  conversation about its agents, and the agent's asset tools read them by name. Agent and skill rights can be granted "In
  workspace X" on Instance > Access. Studio has a scope filter, shows a workspace chip on a
  workspace's assets and writes into the scope chosen. `platform.context` names, per workspace,
  the actions the caller holds on what it owns (`workspaces`), and each kind's `owners`. What a
  workspace owns is deleted with it. The demo seed gives the workspace `Nordlicht Beratung` the
  skill `nordlicht-house-style` and the agent `nordlicht-front-desk`.
- **`egress.allowPublicHttps`:** an operator opt-in in release config, off unless set. With it
  on, a Connection may reach a host that no `egress.allow` entry names over `https` on port
  443. Such a target is judged as a `public` entry: every address it resolves to must be public,
  so loopback, link-local, cloud metadata, private ranges and their IPv4-mapped forms stay
  refused. The instance's database host is refused on every port, by name and by address.
  Redirects and download addresses are checked again, and the credential goes only to the
  origin it was configured for. Another port, plain `http` and `postgres` still need an entry. A
  start with the setting on logs a warning. An `egress_denied` refusal now ends with the setting
  that would let the target through, or says that none would.

### Changed

- **New agents start in the workspace they were made in:** an agent created in a Shared
  Workspace, in Studio or by the Build Agent in a conversation there, is available in that
  workspace only. One created in a Personal Workspace, by `catalyst config push` without the
  release right, or by `assets.put` without a workspace starts hidden; `assets.put` answers the
  warning `agent_hidden` and `assets.sync` names the agents in `hiddenAgentNames`. Before, every
  new agent was available in all workspaces. `assets.put` takes `availableIn` (`"all"` with the
  right to write agents on the whole instance, or `{ "workspaceId" }`), and the create dialog in
  Studio offers "All workspaces" to that holder. A release push and the first agent of an
  instance start in all workspaces as before. **Operators:** a script that creates agents
  through the API and expects them in every workspace passes `availableIn: "all"` or sets the
  availability after the write.

- **Skill icons:** a skill's line icon sits on one neutral tile in lists and on starters (32 px
  tile, 18 px icon; 24 px in the picker rows), in ink for a skill that ships with the platform
  and muted for the generic book. Inline, as in a chip, it stands bare at 16 px. The tile is
  never tinted: colour means a file type, and the file-type pages stay as drawn.
- **Kind icons:** each kind has one icon, read from the icon registry in Studio, on the rail,
  over the composer and on the canvas: Agent a bot, Skill a book, Connection a plug (in place
  of the cable), Workflow, App a grid, Data store a database and Guardrail a shield. The
  registry's `agent` key draws the bot in place of the sparkles and gains `app`, `datastore`,
  `guardrail` and `inbox`.
- **Agents page:** a card shows the agent mark in place of the initials, the name, the default
  badge, what the agent does in two lines at most, and Start chat. Its starter prompts are no
  longer on the card; they wait in the empty chat with that agent. New agent opens its dialog
  on the page: Cancel stays there, and Continue leads to the new agent's page in Studio.
- **Studio:** the list of agents names each agent in the reader's language and shows what it
  does under its name, in place of its id. `assets.list` takes an optional `locale`; an agent's
  title and description answer in it where the agent holds that language, and in the
  instance's default otherwise.
- **Chat:** the agent list shows each agent's description under its name by default:
  `ui.showAgentDescriptions` is now `true` unless release config sets it. An instance that
  wants the names alone sets `ui.showAgentDescriptions: false`.
- **Chat:** the usage consumption on a model card has six steps in place of four: `very_low`,
  `low`, `moderate`, `elevated`, `high` and `very_high`, and its filled steps take a colour that
  goes from cool to warm with the level. The tier still comes from the model's Customer Rate
  Card entry (three parts uncached input to one part output per million tokens), on bounds
  that double: below 1.25 `very_low`, below 2.5 `low`, below 5 `moderate`, below 10 `elevated`,
  below 20 `high`, from 20 `very_high`. **Operators:** the tier shown for a model can change
  with this release, for example from `low` to `very_low`; the four earlier values of a
  binding's `usageTier` stay valid and keep their words. The UI library has `LevelMeter` and
  the tokens `--level-1` to `--level-6` for it.
- **Model names in logs and the audit:** where a model call names a binding, the log lines
  `model_provider.error` and `model_usage.record_failed` carry `bindingId` in place of `model`,
  the refusal of something a model does not support reads "Model binding '…' of provider '…'
  does not support", and the audit events of a generated conversation title carry
  `modelBindingId` in place of `model`. A call without a binding names the model as before. The
  usage ledger keeps the model id. **Operators:** a log query or alert on the `model` field of
  these lines needs `bindingId` as well.
- **A Personal Workspace is named after its owner:** the interface shows "Felix's workspace"
  (German "Felix' Arbeitsbereich", "Annas Arbeitsbereich") in the workspace selector, the move
  dialog, the command palette, the workspace filter and column of Instance > Operations, and
  the workspace name an App or a Page is given. The first name comes from the display label;
  an account whose label is an e-mail address keeps "Personal workspace". The name stored on
  the row is unchanged and still not shown.
- **Studio:** the area that was named "Build" ("Bauen" in German) is named "Studio" in both
  languages: its row in the main rail, the head of its column, the palette's "Go to" entry, the
  sentences that name it and the documentation. The sentence of a failed Connection call now
  ends with "Studio > Connections". Its addresses stay `/build/...`, and it shows to the same
  people as before.
- **Apps page:** the Apps of a workspace are cards in a grid, as the agents are, where they were
  rows of a list. A card shows the name, the description where the App has one, the state, and
  when the App last changed. Its main action is "Open"; an App with a draft alone has "Edit" in
  that place for whoever may write it. A writer gets "Edit" as a quiet link beside Open. The
  menu of a card keeps Details, Copy link and Delete, and no longer repeats Open and Edit. The
  App's id shows to builders on every card, and to nobody else.
- **Page frame:** every page of Build, Settings, the Inbox and Apps starts its title line 56 px
  under the top edge, where it started 24 px under it. A page whose head is pinned, such as an
  asset page in Build, is unchanged: its head is the top band from the start. The column of
  pages in Build and in Settings is headed by the area's name, "Build" or "Settings", level
  with the open page's name. In a window too narrow for the column the name stands over the
  select of the area's pages; under 768 px it stands beside the button that opens the sidebar.
  `@vivd-catalyst/ui`: the room is the new token `--layout-page-top`, which `Page` applies in
  every layout without a pinned head, and `SubRail` in `routes` mode takes the area's name as
  `title`. A screen built on `Page` gets the room without a change; one that set a top padding
  of its own to make up for it now has both.
- **Asset pages, head:** the head of an agent, skill, Connection or App page is one row: the
  way back, the name, its chips and the actions. From 768 px up it never wraps, and a name
  that does not fit is cut and shown whole in a tooltip. In a narrower window the actions move
  to a second row only when they do not fit. The kind and the technical id are gone from the
  head: the id stands at the top of the page's first section, read-only with a copy button. On
  an App draft the sentence that names the missing publish right is a line under the head.
  `@vivd-catalyst/ui`: a `detail` `PageHeader` shows no line under the name.
- **Detail heads, one row everywhere:** every `detail` `PageHeader` is one row. A `description`
  stands after the name and its chips in the muted style, cut with an ellipsis and read in full
  in a tooltip; the Workflow and run pages use it, and `descriptionPlacement` is gone. The name
  wins a narrow row: the description goes first, then the state and the scope chip, then the
  text of the way back, and only then is the name cut. New `PageHeaderBack` is that way back:
  an arrow with where it leads, the arrow alone where the name needs the room. Under 768 px the
  actions go to a second row when they do not fit beside the whole name.
- **Build, the sections of a page:** the page of an agent, a skill and a Connection no longer
  lists its sections in a column on the left that looked like the list of pages in Build and
  Settings. The sections are an outline on the right of the content, under "On this page": a
  thin line marks the section in view and follows the scrolling, a count stands after the name,
  and a section a refused save names is marked. A link scrolls to its section and hands the
  focus to the section's heading. The content starts at the page's left edge, is at most 44rem
  wide, and each section's title stands above its fields. In a narrow window and on a phone the
  outline is one line above the content, "On this page: Overview", that names the section in
  view and offers the others, with a mark while a section has a refused field. A section rests
  under the page's head as tall as the head is on that screen, "Overview" scrolls to the top of
  the page, and the sections at the end of a page are marked in their turn while it scrolls to
  its end. Build's list of kinds and the Settings pages are otherwise unchanged.
- **Section titles above their fields are larger:** a `Section` with `layout="stacked"` shows
  its title at 16 px instead of 14 px, so it is not taken for a field's label. This also
  applies to the Settings pages that stack their sections.
- **UI library (breaking for a client assembly and for a Page on the next App Kit version):**
  new `PageOutline`, which `Page` takes as `outline`, with the labels `onThisPage` and
  `sectionHasError` in `UiLabels`. `SubRail` only opens pages: `mode` is gone, `value` and
  `onValueChange` are required, and `SubRailRoutesProps` and `SubRailAnchorsProps` are removed
  in favour of `SubRailProps`. Code that passed `mode="routes"` drops the prop; code that
  passed `mode="anchors"` hands its sections to `<Page outline={<PageOutline items={…} />}>`.
  A `Page` takes `subRail` or `outline`, not both; `outline={null}` leaves the column empty and
  the content where it is. A released App Kit version keeps the `SubRail` it was built with.

- **Every process of an instance is assembled from one build (breaking for a client
  assembly):** `defineClientInstance` gains `runWorkspaceCommandWorker()` and
  `runArtifactPreviewWorker()`, which hand the worker the capabilities of the build as
  `listen()` and `runAgentRunWorker()` do. `capabilities` is now required on
  `resolveInstanceModules`, `createClientInstanceApp`, `createClientInstanceAgentRunWorker`,
  `createClientInstanceWorkspaceCommandWorker`, `createClientInstanceArtifactPreviewWorker` and
  the `runClientInstance…` functions of the two workers, so an entry point that leaves them out
  no longer compiles. **A deployment changes `src/workspace-command-worker.ts` and
  `src/artifact-preview-worker.ts` to `client.runWorkspaceCommandWorker()` and
  `client.runArtifactPreviewWorker()` in the commit that pins this release.** The artifact
  preview worker now resolves the modules too, so it stops like every other process with
  `Module '<name>' is enabled but this build ships no code for it` when the config turns on a
  module its build lacks. Until now the workspace command worker was assembled without
  capabilities and stopped with that message on every instance with a capability module on.
  No migration and no data change: rolling back is rolling back the image.
- **Release gate:** `catalyst-deploy check` starts every built process entry point once per
  release config with the argument `--resolve-only`. The process loads the config, resolves its
  modules, makes the checks that need only the config and the build, prints
  `resolve-only: this process starts with this config` and ends with code 0 before it opens a
  store. This replaces the schema validation of the configs, which the run of `dist/server.js`
  includes, and fails the gate for a process that would stop on the host on one of those
  checks. **A deployment that builds `dist/workspace-command-worker.js` now fails the gate for
  a release config with `executionWorkspaces.enabled: false`.** Nothing but the gate passes the
  argument: a process started with it does no work.

- **Asset writes name the revision of each asset (breaking):** `expectedRevision` is required
  on `assets.put`, `assets.delete`, `assets.revert` and on every item of `assets.sync` and
  `assets.sync_check`: a number for an asset that exists, `null` on a put for one that never
  did. A write that leaves it out is answered `428 PRECONDITION_REQUIRED` with
  `details.assets` and writes nothing. A write against another revision is answered
  `412 REVISION_CONFLICT`, where it was `409 CONFLICT`, with `details.conflicts`: `kind` and
  `name` for everyone, and `currentRevision`, `deleted`, `changedBy` and `changedAt` for a
  caller who may read the asset's history. A deleted asset is created again only against the
  revision of its delete. The store no longer takes a version of the whole asset set, so a
  save of one asset is never refused for a change of another. `assets.sync` and
  `assets.sync_check` take a body of up to 20 MiB (`ASSET_SYNC_BODY_MAX_BYTES`). No migration.
  **`catalyst config push --force` no longer exists** and is refused with the conflict
  procedure: pull the assets the conflict names, re-apply the edits, push. A working copy that
  never pulled pushes every asset as a creation; `pull` records the delete of an asset it sees
  gone, and the next push may create it again. A pulled asset is recorded with the id of the asset on the instance, a push names it
  (`expectedAssetId`), and a working copy that belongs to another database or to an asset that
  was replaced is refused for that asset with `409` `asset_replaced` and the pull that repairs
  it; a `.catalyst-state.json` of an earlier CLI needs one `catalyst config pull` first. One
  put item of a batch holds at most 2 MiB (`ASSET_SYNC_ITEM_MAX_BYTES`), and each applied item
  answers its `id`. A write is refused for a missing right first, then for the missing
  revision, then for the stale one; a caller who may not read an asset is told its name alone
  for a delete, for a name another owner holds and for a read-only asset at another revision.
  A missing `agent_models.manage` is answered as every missing right, `Missing the right
'agent_models.manage'`, without the names of the settings. `assets.discard_draft` without a
  revision answers `428`. A committed write is answered as made when its audit row cannot be
  written, and the failure is logged. In Build
  the conflict notice names who saved first and when, says that loading the newer version
  replaces the text, and offers the history; on a phone it rests at the end of the page; the demo's
  `pnpm config:push` pushes without `--force`. **Upgrade CLI and server together.**
- **Access wording:** in English a row of the Access page is a "right", as it already is in
  German: "New right", "Create right" and the tab "Rights". The column of the place is "Where"
  ("Wo"), as the dialog's field. The descriptions of the New right dialog, of Deny, of the
  places and the read-only notice of an asset outside every Namespace say what they do in
  plain words; the notice no longer names a "Builder".
- **Theme:** the dark page of the base theme is a little darker: the dark `surfaceColor`
  default is `#181614` (it was `#1c1a17`). Cards and the chosen row of the sidebar follow, and
  the raised surface of menus becomes `#252320`. The sidebar, borders and text are unchanged.
  An instance that sets its own `darkTheme.surfaceColor` keeps it.
- **Default agent and availability (breaking):** `PUT /api/v1/instance/config/default-agent`
  (`config_agents.set_default`) and `PUT /api/v1/instance/config/agents/{name}/availability`
  (`config_agents.set_availability`) are gone. `POST /api/v1/assets/{kind}/default`
  (`assets.set_default`, body `{ "name": "…" | null }`) and
  `PUT /api/v1/assets/{kind}/{name}/availability` (`assets.set_availability`, the same body as
  before) replace them, for a kind that keeps a default or is offered per workspace. Both are
  Operation Runs: they answer the header `Operation-Run-Id`, take an `Idempotency-Key`, pass the
  policy of the instance, and the typed client answers them as an operation outcome. The right
  is unchanged, the right to write the kind on the whole instance, and a deny on the named asset
  now refuses too. `baseVersion` of the default-agent call is gone with the old address. Both
  calls take an optional `expectedAssetId`, and the availability an optional
  `expectedAvailability` (the availability as it was read, or `null`): where the instance holds
  another asset of the name or another availability by then, the call answers `409` and writes
  nothing. The interface sends them, so a change that waited for an approval does not overwrite
  a later one. A
  changed availability now moves the version of the asset set, so the overview's `version` rises
  by one with it. `routes/config-asset-routes.ts` is deleted; the two reads that stay,
  `config_assets.get_overview` and `instance.workspaces.list`, keep their addresses.
- **Inbox, held operation calls:** the item of a held call leads with a sentence that says who
  wants what and what approving and declining do, and names the rule that holds the call
  where one can be named. A held
  `assets.put` of a skill shows as the skill: all of a new one, before and after of a changed
  one, under "New skill" or "Skill change", with the Namespace in the row. The preview of such
  a request carries an `asset` block (`kind`, `name`, `title`, `namespace`, `isNew`, and for a
  skill its text). What is stored, its text and whether it exists, is shown only to a reader
  who holds the kind's read right on the asset; every other reader is shown what the call
  itself says. A list reads no asset. A new request records what held it as `heldBy`. Every other
  call is "Action to approve" and shows each input value in a block, a definition one row per
  field. Origin, expiry and the whole input are under "Technical details"; the dialog "Full
  input" is gone. `pnpm demo:seed` leaves two requests in the Inbox, a new skill and a change.

- **Workspaces and members (breaking for callers of the typed client):** `workspaces.create`,
  `workspaces.update`, `workspaces.delete`, `workspaces.members.add`,
  `workspaces.members.update_role`, `workspaces.members.remove`, `workspaces.members.leave`,
  `workspaces.access_requests.create`, `workspaces.access_requests.approve` and
  `workspaces.access_requests.decline` are Operation Runs. They answer the header
  `Operation-Run-Id`, take an `Idempotency-Key` and follow the instance's policy, so a call can
  answer `202` with the run while it waits for an approval. The run names the workspace; a
  creation names none. The typed client answers the ten calls as an operation outcome;
  `completedOutput(outcome)` hands a caller the output. `DELETE
/api/v1/workspaces/{collaborationWorkspaceId}` answers `200` with `{ "state": "deleted" |
"deleting" }` in place of the counts or an empty `202`; what a deletion removed is counted
  in its audit row `collaboration_workspace.deleted`. The caller's role in the workspace is
  asked before the policy: a refusal answers `403 FORBIDDEN` with `details.action` naming the
  operation, and a workspace the caller cannot reach answers `404` as before.
  `workspaces.ensure_personal` stays a plain call, since the interface makes it on every load.
  A call that waited for an approval is asked again by the same rule before it runs: an
  approved request to join runs for a person outside the workspace, and a change of somebody
  who left meanwhile ends unexecuted. The membership of the run's workspace is still asked
  first for an agent's call and for an operation whose right is a named action.
- **User administration (breaking for callers of the typed client):** `users.create`,
  `users.update`, `users.delete`, `users.identities.upsert`, `users.identities.delete`,
  `users.password.reset` and `users.invitation.send` are Operation Runs. They answer the
  header `Operation-Run-Id` and take an `Idempotency-Key`. The typed client answers the six
  calls other than password reset as an operation outcome; `completedOutput(outcome)` hands
  a caller the output. `DELETE /api/v1/instance/users/{userId}` answers `200` with
  `{ "state": "deleted" | "deleting" }` in place of the user or an empty `202`. A refusal by
  a superadmin rule answers `403 FORBIDDEN` with the rule as its message, such as
  `Only a superadmin may change a superadmin`, and `details.action` naming the operation. Each
  operation's summary names the right `users.manage`. A repeated call that sent a password
  answers `409 OUTPUT_NOT_RETAINED` saying that the call was carried out and that a repeat
  needs a new `Idempotency-Key`.
  The rows `governance.user_*_authorized` are no longer written; the run's
  `operation.authorization_checked` row records the same check. The change's own audit rows
  stay and name the run. `users.password.reset`, and `users.create` with `passwordSignIn`,
  keep no answer: a repeat with the same key answers `409 OUTPUT_NOT_RETAINED` and sets
  nothing. These calls never wait for an approval, and the hash their run keeps of the input
  is taken with the password left out, so no password and no fast hash of one rests in a run.
  An operation whose input can hold a secret says so with `inputWithoutSecrets` on its
  registration.
- **API access (breaking for callers of the typed client):** creating and changing a service
  principal and issuing and revoking an API key are Operation Runs. `service_principals.create`,
  `service_principals.update`, `api_credentials.create` and `api_credentials.revoke` keep their
  addresses, inputs and `200` answers, answer the header `Operation-Run-Id` and take an
  `Idempotency-Key`. The typed client answers the first, the second and the fourth as an
  operation outcome (`{ status: "done", output }`) and the new key plain;
  `completedOutput(outcome)` from `@vivd-catalyst/api-client` hands a caller the output. The rule for who may call is unchanged, a superadmin who holds
  `api_access.manage`, and is now the operations' own check: the descriptors list no `requires`,
  a refusal is recorded on the run, and a refusal for the missing role reads
  `Missing the right '<operation id>'` in place of `... requires a superadmin role`. The audit
  rows `api_access.*_authorized` of these four are no longer written; the run's
  `operation.authorization_checked` row records the same fact. The rows
  `api_access.service_principal_created`, `..._updated`, `api_access.credential_created` and
  `..._revoked` stay and name the run.
- **Operations:** an operation of the registry may declare `secret: true` on its descriptor when
  its answer holds a secret that is shown once. Its run keeps no output, and a repeated call
  with the same `Idempotency-Key` answers `409 OUTPUT_NOT_RETAINED` and never the secret. The
  call is never held for an approval, so its descriptor declares no `202` answer and the typed
  client answers its output plain. An instance default of `approval` for changing operations
  does not make such an operation impossible: it takes the inherited value as `confirm` and runs
  on its caller's own word. A policy setting that matches the operation or a guardrail that asks
  for an approval refuses the call with `POLICY_DENIED`, and a registration with the default
  policy `approval` stops startup. `api_credentials.create` is the first. A key whose answer was
  lost is revoked and issued again under a new key.
- **Operations (fixed):** a registered operation reads each input field from the part of the
  request its descriptor declares it in. A query field the descriptor does not declare no longer
  replaces a field of the body; it is ignored, as on every other route.
- **Build:** a Connection's row no longer shows where the Connection comes from.
- **Config CLI (breaking API):** `catalyst config pull`, `diff`, `push`, `validate`, `list` and
  `show` read with `assets.list` and `assets.get` and write with one `assets.sync` call per push.
  The release path is removed: `GET /api/v1/instance/config/export`,
  `POST /api/v1/instance/config/import` and `POST /api/v1/instance/config/validate`, the client
  methods `config_assets.export`, `config_assets.replace` and `config_assets.validate`, the type
  `ConfigAssetBundle`, and the audit events `config_assets.replaced` and
  `governance.config_assets_release_authorized`. A push is now one Operation Run of the key's
  service principal with the audit events of the asset operations. **Upgrade CLI and server
  together.** A CLI of an earlier release is answered `404` at the three addresses with the
  sentence to upgrade it; this CLI against an earlier server reports that the instance does not
  serve the asset operations. The key needs what it needed: `config_assets.read` and
  `config_assets.release` with the scopes `config_assets:read` and `config_assets:release`.
  What changes at the terminal: `--force` sends every local asset against the revision the
  instance holds now and no longer switches a check off on the server, so a write that arrives
  during the push refuses it; `--prune` deletes at the revision of the last pull and reports an
  asset it has not seen as a conflict; one push holds at most 2,000 assets, where the release
  path had no count limit, and a request over one megabyte is answered `400` with
  `details.reason` `body_too_large` instead of `500`, both with the advice to push in parts with
  `--only`; `--force` also sends the default agent against the one the instance holds at that
  moment, so a default changed during the push refuses it; a push that conflicts on assets and
  on the default agent names the assets first; a
  push the instance holds for approval exits with 1 and names the waiting run; a push whose
  answer is lost is sent again under the same idempotency key. The first pull of a working copy
  reads each asset with one call. `push` and `validate` first ask `assets.sync_check`, and
  against an instance that has `assets.sync` without it they say that the instance must be on
  this release or later and write nothing.
- **Asset API:** `POST /api/v1/assets/sync/check` (`assets.sync_check`) takes the body of
  `assets.sync`, runs its checks and writes nothing. A release through `assets.sync` is checked
  against the whole stored set instead of what its key may read, as the release path was, and
  its delete of an absent asset is refused when the asset was created meanwhile. A sync is a
  release only with the scope `config_assets:release` on the key and the right
  `config_assets.release` on its principal, both: under a key with `config_assets:write` alone
  a release holder syncs as any writer does.
- **Document extraction (breaking config):** the extraction of the document processing
  capability calls its model through the model gateway. The block
  `capabilities.documentProcessing.extraction.provider` is gone, and startup of the API and of
  the document worker stops with this message:
  `'capabilities.documentProcessing.extraction.provider' moved: the provider becomes an entry under 'infrastructure.models' with provider 'google-vertex', 'region', 'model', 'projectId' and 'credentialSecret'; a model binding under 'modelBindings' names that entry; and 'capabilities.documentProcessing.extraction.modelBindingId' names the binding`.
  What to change: add the entry under `infrastructure.models` (`provider: google-vertex`,
  `region: eu`, `model`, `projectId`, `credentialSecret`), add a model binding with
  `agentSelectable: false` that names it, and set `extraction.modelBindingId` to that binding.
  `location` and `endpoint` have no counterpart: `region: eu` selects both.
  `credentialsFileEnvName` becomes `credentialSecret`; a deployment that set
  `DOCUMENT_EXTRACTION_GOOGLE_CREDENTIALS_FILE` keeps the variable and names the secret
  `DOCUMENT_EXTRACTION_GOOGLE_CREDENTIALS`. The API and the agent run worker create every entry
  of `infrastructure.models` at startup, so they now need the key file and the variable too, not
  only the document worker. A binding whose model does not read documents or answer in a JSON
  format, or whose entry states `region: global`, stops startup. Deploy the API and the document
  worker together: the worker's extraction answer no longer carries `usage` and `providerCalls`.
  Rollback: the earlier version does not load the new config, so roll the config back with the
  code. Usage rows written by this version stay valid for the earlier one.
- **Usage of document extraction:** an extraction is recorded by the gateway when the model
  answers, as a call of the product with the purpose `document_extraction`, the conversation and
  the user, and no longer as usage of the agent run after the tool returned. A refused or failed
  extraction call leaves a row with the status `failed`. The provider id of the row is the id of
  the entry under `infrastructure.models`, so a rate card entry for the extraction model must
  name that id. The tool result and the stored extraction no longer carry token counts.
- **Tools (breaking for tool authors):** `ToolHandlerSuccessResult.modelUsage` and
  `ToolModelUsageReport` are removed, and `InProcessToolExecution` no longer takes
  `usageRecorder`. A tool that calls a model does so through the model gateway, which records
  the usage.
- **Navigation:** the sidebar has one entry for a chat. The row "Chat" is gone; "New chat" starts
  a conversation, and inside a conversation its row under "Recent" is the current item. A section
  that stands alone, such as the Inbox, now shows its row, in one group with "New chat". "Recent"
  is the list of the workspace's conversations: it reads the 30 latest, and the next 30 when a
  person scrolls to its end or picks "Load more". A page that fails to load says so and offers
  "Try again". The search in the sidebar's header finds a conversation that is not loaded, and
  an open conversation older than the loaded rows is the first row. During a run the sidebar no
  longer reads the whole list every second: the open conversation follows its event stream, and
  one page is read every two seconds only while another listed conversation runs or a new one
  waits for its title.
- **Branding:** the platform's default favicon is the Catalyst mark, an orange field with a small
  dark square at the bottom right that follows the colour scheme by itself. It replaces the
  shield in `packages/chat-ui/assets/favicon.svg`, the standalone app, the demo client and the
  docs site. A client that ships its own `favicon.svg` keeps it.
- **Tools:** `defineTool` requires `effect: "reading" | "changing"`. A tool that only reads
  declares `reading`; one that writes, sends, spends or starts work declares `changing`. An
  assembly whose tool lacks it does not compile. The audit log records a tool call as
  `operation.authorization_checked`, `operation.started`, `operation.completed`,
  `operation.failed` or `operation.denied` with the tool's name as operation; the events
  `tool.authorization_checked`, `tool.started`, `tool.completed` and `tool.failed` are no longer
  written, and rows already stored keep their labels. `InProcessToolExecution`,
  `ToolAuthorizationDecision` and the `toolExecution` option of the local agent runtime are
  removed; an assembly built on `createClientInstanceApp` needs no change beyond `effect`.
- **Startup:** a tool that declares no `effect` stops the start, and the message names the
  tool. A tool that declares no `permission.mode` takes the instance default of its effect
  (`policy.defaults`) and no longer runs as `allow`: with the default `confirm` for changing
  calls, an enabled changing tool without a mode stops the start and the message names it.
  Declare `permission: { mode: "allow" }` on such a tool to keep what it did before.
- **Startup:** an enabled tool with the mode `approval_required` still stops the start until an
  agent's run can be paused, and the message names that. A tool that declares `reading` together
  with `approval_required` is refused too, because an approval cannot hold a read.
- **Views:** a view can no longer move its own frame to another host. Every view is framed in
  a shell document the instance serves at `/app-runtime/view-shell/1/shell.html`, with the
  header `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'
'unsafe-inline' 'unsafe-eval' <views.allowedScriptSrc>; style-src 'unsafe-inline'; img-src
data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none';
form-action 'none'`. Under `frame-src 'none'` the browser refuses `location`, a refresh tag, a
  clicked link and a download link in a view before it sends a request, to the instance's own
  addresses as well. The shell answers a frame only: another `Sec-Fetch-Dest` gets `403`, and
  both answers carry `Vary: Sec-Fetch-Dest`. A
  reverse proxy must route `/app-runtime/*` to the API, as it already must for the view
  runtime. The view's own policy no longer names `navigate-to`, which no browser enforced.
- **Views:** a view that holds private rows (`private_hydrated_view`) is static. It runs no
  script, because WebRTC lets a script send packets to any host and no browser lets a document
  forbid it. Its body is not the stored HTML: each time it is shown, the interface reads the
  stored HTML with the browser's parser and writes the body from an allowlist of elements and
  attributes. Links lose their address, and scripts, forms, frames, `link`, `meta` and `base`
  elements, event handlers and styles that name an address are left out. Its frame has a fixed
  height and scrolls inside.
- **Views:** a view that runs scripts has `RTCPeerConnection` removed from its window and the
  address taken from every link, and a click on a link that still has one is cancelled. Both
  are hardening and not a boundary. Do not put links into a view.
- **Config assets:** the overview lists the `id` of each agent and skill.
- **Object storage:** every stored byte goes through one port, `ObjectStorage` in
  `@vivd-catalyst/core`: `put`, `get` as a stream with its size, `head`, `delete`,
  `deletePrefix`, `list` in pages and, where the provider can sign, `signedGetUrl`. The new
  package `@vivd-catalyst/object-storage` holds the providers `s3` and `filesystem`; either one
  serves either store under `infrastructure.objectStorage`. No config value moves and no object
  key changes, so a store written by an earlier release is read as it is and a rollback is
  safe. `s3` is now a provider of the platform: a capability no longer registers it, and the
  document-processing capability no longer exports an object store. The byte-store interfaces
  of `capability-sdk` and `tool-execution` and the `createLocalWorkspace...` helpers are gone;
  code that took one takes `ObjectStorage`, and
  `putWorkspaceFile(storage, input)` stores a workspace file. A store fails with `ObjectNotFound`
  or `ObjectStorageUnavailable` and with nothing else: no vendor error, message or address
  crosses the port. A setup failure of the store (missing bucket, refused credentials,
  unreachable endpoint) still answers an upload with `422`; its message names the config entry
  and no longer the bucket. `deletePrefix` and `list` refuse a prefix that does not end with
  `/`, so `users/usr_1` can never reach `users/usr_10/`, and refuse one that holds `.`, `..`, an
  empty segment, a leading `/`, a backslash or a null byte instead of rewriting it. A signed read address lives at most
  300 seconds and is never logged; nothing in the platform asks for one yet.
- **Rights:** every rights check of the API and of tool calls is answered by one evaluator,
  `evaluateAccess` in `@vivd-catalyst/core`. `InProcessToolExecution` takes an optional
  `authorizer`; `ChatServerOptions.stores` needs the `access` store, which
  `createPostgresStores` provides.
- **Deleting an account or a Shared Workspace:** a deletion now finishes by itself. The
  request closes the account or the workspace at once: the user can no longer sign in and is
  listed as "Being deleted", the workspace is gone from every selector and its conversations
  accept nothing. When stored data cannot be removed at once, the request answers `202`
  without a body instead of `409`, and a job (`account.delete`, `workspace.delete`) tries
  again with a growing wait, up to 50 times over about ten days. When nothing is left to wait
  for, the request answers `200` as before. A repeated request answers `202` and starts
  nothing new. After the last attempt the job is dead, the audit log holds
  `user.deletion_stalled` or `collaboration_workspace.deletion_stalled`, the account or
  workspace stays closed, and deleting it again starts a new job. The dead job is kept until
  the account or workspace is gone, also past the 30 days other dead jobs are kept. A closed
  account leaves its Shared Workspaces and access requests with the first pass. Of two owners
  who delete their accounts at the same moment, the second is refused as the last owner; the
  same holds for a deletion and a role change or removal at the same moment. The first pass
  asks the agent runs of the user or in the workspace to stop, and a run still working stores
  no further message: every write into a conversation of a closed account or workspace is
  refused, whichever runtime the instance uses. The account or the workspace is removed only
  when these runs have ended and the stored data of every conversation the user created is
  gone. That includes execution workspace data on an instance that has the feature off: rows
  without stored objects are cleared, and stored objects that cannot be removed fail the
  attempt. An attempt that removes nothing fails, so a deletion that cannot go on ends as a
  dead job with its `deletion_stalled` event. An administrator who changes a user being
  deleted, or writes a grant for one, gets `409 CONFLICT`, and such a user holds no rights.
  The grant and deny rows a user holds go with the user; rows the user wrote for others and
  Namespaces the user registered stay and keep the user's id. The audit log records
  `user.deletion_requested` and `collaboration_workspace.deletion_requested` when a deletion
  is accepted; `user.delete_failed` and `collaboration_workspace.delete_failed` are no longer
  written. A client that calls one of the three delete operations must accept `202`. Upgrade:
  migration `0035_deletion_requested` adds a nullable column to two tables. Rollback: the
  previous release does not know the mark, so a closed account could sign in again and a
  closed workspace would be listed again. Let the deletion jobs finish before rolling back.
  These two queries list what is still closed, and both must return nothing:
  `select id from product_users where deletion_requested_at is not null` and
  `select id from collaboration_workspaces where deletion_requested_at is not null`.
- **API:** a call refused for a missing right answers `403 FORBIDDEN` with the message
  `Missing the right '<action>'` and `details.action` and `details.reason`, on every route.
  The message was `Missing permission '<permission>'` and named the legacy permission. The
  routes ask the server's authorizer, a new server option `authorizer` whose default is the
  rights evaluator over the instance's access store. `details.reason` is `no_grant`,
  `denied`, `holder_inactive` or `unknown_action`.
  routes ask the server's authorizer, a new server option `authorizer` whose default decides
  as before.
- **Logs:** the log record of a failed job keeps the class and the code of its error with the
  job id and kind, and no longer the error with its message and stack. The job row keeps the
  error code and message it kept before.
- **Logs:** the log record of a failed tool handler or operation keeps of a database error
  its SQLSTATE code, constraint and table and no longer its message, which can quote
  rejected values.
- **Interface, Settings:** the Settings dialog, the workspace settings dialog and the
  administration panel are one Settings area with a rail of pages in three groups: You (Profile,
  Language and appearance, Security), Workspace (General, Members, with the shared workspace
  they change named under the group) and Instance (Users, API access, Usage, Audit). A user
  sees only the groups and pages they may open; the server still decides every right. Config
  is the area Build in the main rail and keeps `/admin/config`. Pages live at
  `/settings/<group>/<page>`; `/settings`, `/admin`, `/admin/users`, `/admin/usage`,
  `/admin/audit` and `/admin/api-access` lead to the new addresses. The theme choice gains
  "System". **Breaking for a host that assembles the shell:** the option `adminPanel` of
  `renderStandaloneChatApp` and `ChatShell` is `administration`, and
  `@vivd-catalyst/chat-ui/admin` exports `administration` in place of `superadminPanel` and
  `SuperadminPanel`; pass `administration` from that entry. The type `ChatShellAdminPanel` is
  `ChatShellAdministration`, and `canViewSuperadminPanel` is gone (use
  `canViewAdministrationPanel`).
- **Model calls:** an agent run reaches its model through one model gateway. The gateway
  resolves the model binding, checks what the provider's adapter declares it can do, admits the
  call, retries it and records its usage. Three things change for an operator. Every admitted
  call leaves one usage event, also one that failed, was stopped or timed out; that event has
  no tokens and no cost and counts towards `modelCallsPerDay`. A provider's error is logged
  once as `model_provider.error` with its kind, status, code, request id and the provider's
  message cut to 300 characters on one line; the message is in no error a user or an API
  caller receives. A call that asks an entry for something its adapter does not declare fails
  with a validation error before the provider is called.
- **Breaking, extension API:** a provider on the `models` port returns a `ModelAdapterFactory`
  whose adapter has `capabilities(model)`, `complete` and `stream` and throws
  `ModelProviderError`; `ModelProvider`, `ModelProviderFactory` and
  `ModelProviderRegistry` are gone. `LocalAgentRuntime` takes `modelGateway` in place of
  `modelProvider` and `usageGovernance`. `ModelUsageEventInput` carries an `attribution` in
  place of `conversationId`, `agentRunId` and `agentName`, and `runModelCall` takes the call's
  instance and attribution.
- **Breaking, release config:** `webAccess.search.mode` and `webAccess.search.managedProvider`
  are removed. Delete both before the upgrade; `webAccess.search.enabled` is the only switch.
  A config that still sets one does not start and says: "Client instance config is invalid:
  webAccess.search: 'webAccess.search.mode' was removed: whether a model can search the web is
  declared by its provider, and 'webAccess.search.enabled' is the only switch. Delete the key".
  With both keys the one message names both ("'webAccess.search.mode' and
  'webAccess.search.managedProvider' were removed: ... Delete the keys"). Whether a model can
  search is declared by its adapter: an `openai-compatible` entry with `api: responses` can,
  one on `chat_completions` and the `deterministic` provider cannot. Saving an agent that
  lists `web_search` on a model that cannot is refused with "Agent '<name>' references
  web_search but the model of this agent cannot search the web".
- **Usage:** conversation titles and approval checks are model calls through the gateway and
  now appear in usage. Each leaves one record, also when it failed, timed out or was refused
  by the provider, and counts toward the daily call limit and the other limits of the
  instance. Such a record carries the purpose (`conversation_title`, `guardrail_judge`) where
  an agent run's record carries the agent name, names the conversation when one caused the
  call, and names no agent run. Everything is counted toward the instance's limits. A title
  that a limit
  refuses fails only its job and never a user's message. An approval check that a limit
  refuses blocks under `onFail: block` with the reason "Check '<id>' could not run because
  the model usage limit of this instance is reached. Try again later."; under `onFail: warn`
  the request is stored as not evaluated.
- **Usage:** a title call ends after 60 seconds like an approval check, is recorded once
  without tokens and frees its job slot and its place in admission. The gateway enforces the
  deadline of a call itself, also against a provider that ignores cancellation.
- **Database:** migration `0036_usage_system_calls` drops `NOT NULL` from
  `model_usage_events.conversation_id` and `agent_run_id`; it moves no data. In the API,
  `conversationId` and `agentRunId` of a usage event are optional. **Rollback:** the previous
  release keeps summing usage and admitting calls correctly with such rows, but its Usage
  page fails for as long as a record of a title or an approval check is among the recent
  events it lists.
- **Usage:** every model call is recorded with its provider, the region of the provider entry
  (`eu`, `global`, or none for a provider inside the instance), the model binding it named,
  the user and the workspace. A title or an approval check is recorded with its purpose. The
  Usage page lists the caller and, in one column, the provider and the region of the recent
  calls, and the summary answers a new optional field `attributedUsage`: the last 30 days by
  day, model, provider, region and purpose or agent. A usage event in the API adds `status`
  and the optional fields `purpose` and `region`. The sums of the page are read from daily
  sums that are kept as each call ends; the page reads no usage record except the 25 newest.
- **Usage:** a call is admitted against the limits of the instance in the database, in one
  statement on two counter rows, the day's and the month's. Several API and worker processes
  together admit no more than the limits allow, for calls, tokens and spend. No process waits
  for a lock per instance, and admission reads no usage record. At admission a call reserves
  what it can use at most: its input by the size of the request, 16,000 output tokens, and
  both at the highest price the rate card has for the model. When the call ends, the
  reservation is replaced by what it used. **Changed behaviour:** a call is refused when its
  reservation no longer fits a token or spend limit, so a limit is reached slightly before it
  is used up. A token limit at or below the 16,000 reserved output tokens would admit no
  call: the config is refused with a message that names both numbers. With a spend budget, a
  model without a price on the rate card is refused; a `deterministic` provider needs no
  price and its calls reserve no cost. A cost that is not whole, such as one whose provider
  reported no cached tokens, no longer stops every later call: it counts at the highest
  price. The limits are protective safeguards: a call settles its real usage, which can be
  more than it reserved, so a limit can be passed by the calls in flight times what each
  used beyond its reservation (`MODEL_CALL_RESERVED_OUTPUT_TOKENS`).
- **Usage:** a usage record has a status. `pending`: the call was admitted and has not ended;
  the Usage page shows it as "Running". `settled`: it ended with usage, and the page says
  whether the provider reported it, reported none, or it is estimated. `failed`: it failed,
  was stopped or timed out before any answer arrived; it counts as one call, uses nothing
  and shows "Failed". A stream that is stopped or breaks off after its answer began is
  settled with the usage its provider had reported by then, and otherwise with an estimate
  of three characters a token, one token for a character outside the Latin alphabet, and
  marked `estimated`.
  `abandoned`: its process went away; it shows "Abandoned". A job
  (`usage.recover_abandoned_calls`, every 10 minutes) takes a call that is still `pending`
  six hours after its admission as abandoned and releases what it reserved.
- **Usage and deletion:** usage records are kept for the accounting of the instance. When an
  account is deleted, the user is removed from its usage records together with the
  conversation id, the run id, the operation id and the correlation id; the amounts, the
  model, the provider and the agent or purpose stay. When a workspace is deleted, the
  workspace is removed from its usage records and the amounts stay. The database enforces
  both: no user and no workspace row can go while a usage record still names it. A call that
  was being admitted while its workspace was deleted no longer fails with a database error.
- **Database:** migrations `0041_usage_attribution`, `0042_usage_attribution_indexes` and
  `0043_usage_attribution_validate` add the nullable columns `purpose`, `region` and
  `binding_id` to `model_usage_events`, drop `NOT NULL` from `agent_name`, tie `user_id` and
  `collaboration_workspace_id` to their tables with `ON DELETE SET NULL`, and add one partial
  index for each of the two. No column is dropped. After the upgrade a background job fills
  older usage rows. Until it ends, older rows show no region. The job
  (`usage.backfill_attribution`) runs in the API and worker processes, 5,000 rows per
  statement, and may be interrupted at any time. A row whose provider and model are no longer
  configured keeps no region. `0042` is the first migration that builds an index with
  `CREATE INDEX CONCURRENTLY`; a migration step that finds another step running now asks for
  the migration lock again every 250 ms and no longer waits inside a statement, because the
  index build would wait for that statement and the two would stop each other.
- **Database:** migrations `0044_usage_counters` and `0045_usage_pending_index` add the tables
  `model_usage_counters`, `model_usage_daily_rollups` and `model_usage_maintenance`, the
  columns `status` (default `settled`), `counted_tokens` and `counted_cost_micros` on
  `model_usage_events`, and a partial index on the calls in flight. No column is dropped.
  After the upgrade the job `usage.reconcile` reads every usage record once and builds the
  daily sums; until it ends, the Usage page shows no sums for the days before the upgrade
  (about 3 seconds per million records). It then runs once a day and at every start, reads
  the records of the month and corrects the counters and sums by what it finds. **During a
  rolling upgrade** a process of the previous release writes usage records that are in no
  counter and no sum, so a limit can be passed by what those processes admit. Stop the
  previous release before the new one takes calls, or accept that gap until the next run of
  `usage.reconcile`, which closes it. The attribution backfill keeps its place in the
  database: a process that is killed loses one batch of 5,000, and the next tick, at most 10
  minutes later, goes on from there. After a pass without a change it reads the records
  again once a day until the job is removed. **Rollback:** the previous release runs against
  the migrated database. Its Usage page works: a title or an approval check still carries its
  purpose as agent name for this release. Calls it admits are counted by `usage.reconcile`
  after the next upgrade. **Contract step, a later release:** stop writing the agent name of
  a call the product made for itself, and remove `usage.backfill_attribution`.
- **Breaking, extension API:** `ModelCallGovernance` is `admitModelCall` and
  `settleModelCall` in place of `runModelCall`; a call that ended without an answer is
  settled without usage. `ModelCallAdmission` adds `request`, the size of the request.
  `ModelUsageEventStore` replaces `summarizeModelUsageEvents` with
  `summarizeModelUsageHistory` and `summarizeRecentModelUsage` and adds
  `admitModelUsageEvent`, `settleModelUsageEvent`, `listPendingModelUsageEvents`,
  `reconcileModelUsage`, `readModelUsageMaintenance`, `writeModelUsageMaintenance`,
  `clearUserFromModelUsageEvents`, `clearWorkspaceFromModelUsageEvents` and
  `backfillModelUsageAttribution`.
- **Breaking, extension API:** `ChatServerOptions` takes `modelGateway` in place of
  `modelProvider`; `ApprovalCheckRunner` takes `{ clientInstanceId, config, modelGateway }`;
  `reasoningEffortChoiceForBinding` takes the efforts the model's adapter declares as its
  second argument, and `createSafeConfigView` offers a reasoning effort choice only when it is
  given `reasoningEffortsOfBinding`. `WebAccessSearchModeConfig`,
  `OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID` and the gateway's `unsettled` door are gone.
- **Retention:** a conversation's deletion date counts from the last message a user sent, no
  longer from its creation: accepting a message moves the date to `retention.conversationDays`
  later, in the transaction that stores the message. Opening, reading, renaming, moving, the
  generated title and background jobs do not move it. `retention.extendOnActivity: false`
  keeps the date set at creation as a fixed maximum age. Check what an instance promised its
  users before upgrading: the default is `true`. A conversation within seven days of its date
  shows one line above the composer with the deletion date. The line and the clock in the list
  cover at most half the retention period, so a new message always clears them; where a message moves the date,
  the line says that a new message keeps the conversation. The safe config answer carries
  `retention.extendOnActivity`, optional for clients of an older API.
- **UI library:** `Banner` has the layout `line`, one quiet sentence without a box whose icon
  alone carries the tone.
- **Interface, navigation:** the rail is 280 px wide and collapses to a strip of icons with one
  visible control; under 768 px it is a drawer the header opens. Its filter field is gone:
  Search in the rail, or ⌘K (Ctrl+K), opens a command palette that offers New chat, the
  conversations of the active workspace, whose titles it searches on the server, and under
  "Go to" the Settings pages the viewer may open and Build. New chat also has ⌘⇧O
  (Ctrl+Shift+O). The account menu in the rail's footer leads to Profile and to Language and
  appearance and holds the theme switch and sign out. The row menu of a conversation shows
  while the pointer or the keyboard is on the row; the retention clock shows all the time.
  Before anything is typed the palette lists the eight most recent conversations. The list shows placeholder
  rows while it loads and a retry when the load failed. A skip link leads past the rail.
- **Interface, surface:** closing a surface returns the focus to what opened it, a surface that
  covers the conversation takes it out of the tab order, and Escape closes a menu or the
  palette before the surface.
- **UI library:** `Sidebar` is one `nav` landmark where it was an `aside` around a `nav`.
  `NavItem` gains `trailing` and `shortcut`, `IconButton` gains `shortcut`. New:
  `CommandPalette`, `SkipLink` and the token `--layout-sidebar-collapsed`.
- **Interface, default theme:** an instance that sets no `ui.theme` or `ui.darkTheme` now shows
  warm paper neutrals with one terracotta accent (light `#fdfbf7` page, `#f6f3ec` sidebar,
  `#b5573a` accent; dark `#1c1a17` page, `#131210` sidebar, `#d98c6c` accent). An instance
  with its own theme keeps its seven colours; the names of the inputs and tokens are
  unchanged. On every instance, buttons and the segmented control are pills and filled buttons
  carry a hairline and a faint edge. The primary and the danger button are tinted instead of
  solid: a soft fill of the accent or of red, its line and its strong text. The send button
  in the composer is filled with the text colour. A hovered ghost button keeps the text
  colour, and an avatar without a colour of its own is a neutral grey with initials in the
  text colour. One derived token is new: `--shadow-control`.
- **Chat:** the display panel is the surface slot. A tool display or a file preview stands
  beside the conversation while both sides keep 380 px, which is from 760 px of main area, and
  covers the main area below that, where its header offers "Show chat" alone. The former drawer
  below 1024 px is gone. The width is free, is remembered in the browser per kind of surface
  and is clamped so neither side falls below 380 px. The handle is the line between the two
  sides: the arrow keys move it 16 px, Home and End go to the limits. Fullscreen shows "Show
  chat" beside its controls. Nothing animates when the surface opens or resizes.
- **Chat UI:** `ToolDisplayPanel` and `ToolDisplayPanelFrame` are replaced by `SurfaceSlot` and
  the library's `SurfaceFrame`. The standalone app builds its routes from one table,
  `chat-ui/src/routes.ts`; every address keeps its path.
- **Limits:** five defaults that failed honest use are raised. A model call is tried three
  times, waiting about 1 s and then about 4 s, so a run survives two provider errors in a row
  (a rate limit waits longer, see Fixed). An approval check may take 60 s (was 10 s); a blocking rule that runs out of time says
  so. A spreadsheet previews up to 50,000 cells per sheet or range (was 5,000), and the stored
  failure names the limit. A preview embedded in a message is read up to 500 pages (was 200),
  the same ceiling the preview worker uses, exported as `ARTIFACT_PREVIEW_MAX_PAGES` from
  `@vivd-catalyst/core`. A Mailjet send may take 30 s (was 10 s).
  A provider's `Retry-After` replaces the fixed wait up to 60 s; a longer one fails the run at
  once, and no attempt or wait starts past a run's deadline. The preview renderer version is
  `preview-contract-v2`, so every stored preview, including sheets that failed under the old
  cell limit, is rendered once more the next time it is opened.
- **API contract (breaking):** `@vivd-catalyst/api-contract` no longer exports the constant
  `openApiDocument`; call `createOpenApiDocument()`. `createOpenApiDocumentFromOperations`
  takes the operations alone: title and version are those of the release. An operation that
  answers a file states its content type (`blob("text/html")`), and an operation of a
  signed-in caller may state `scope: null` when it asks for no scope.
- **API (operator-relevant):** every operation is rate limited, against spamming and guessing
  only. A call is counted per operation and per caller: the signed-in person or service where
  the operation authenticates one, the client address where it does not. The defaults are 6000
  calls a minute to a reading operation and 1200 a minute to a changing one. A host backend's
  session-token calls are counted under its server credential, 6000 a minute. A caller over a
  limit receives 429 with the code `RATE_LIMITED`, `details.retryAfterSeconds` and a
  `Retry-After` header; the chat interface waits that long and sends an upload again. The new
  release config section `rateLimits` sets `enabled`, `readPerMinute`, `writePerMinute`,
  `signInPerAccountPerMinute` and `signInPerAddressPerMinute`; an instance without the section
  gets the defaults. The counters live in the API process: they start empty after a restart,
  and an instance must run one API process. The client address is taken from
  `X-Forwarded-For` only when the direct peer is a loopback or private address, so the reverse
  proxy in front of the API has to pass the real client address on. Where Caddy sits behind
  another proxy, its Caddyfile needs `servers { trusted_proxies static private_ranges }`, or
  every caller is counted as one address.
- **Sign-in (operator-relevant):** sign-in and password reset are limited to
  10 tries a minute on one account from one client address, and 300 a minute from one address
  whatever the account, so an office behind one address is not locked out by one person. A
  refused API key or server credential is counted per address, 60 a minute, on a counter the
  accepted credential never touches. The sign-in routes under `/api/auth/*` are counted by the
  API before a password is checked and answer with the same 429 as every operation. Until now
  their limit depended on `NODE_ENV=production`, which the reference Compose files do not
  set, so it was off. Reset mails for requests from one client address are capped at 200 an
  hour, up from 20; the cap of three an hour per mailbox stays.
- **Server runtime (breaking):** `createChatServer`, `ClientInstanceApp` and the document
  worker expose `{ fetch(request), listen, close }` and no web framework type.
  `ClientInstanceApp.server` and the worker's `server` are gone: call `app.fetch(new
Request(url))` where code called `app.server.inject(...)`. `listen` resolves with the base
  URL. `createRoute` and `Route` are no longer exported from `@vivd-catalyst/chat-server`.
  The object `createStandaloneAuthRuntime` returns has `routeKind(pathname)`, which the server
  uses to count calls to the sign-in routes.
- **Infrastructure (breaking):** every provider an instance runs on is named in the new
  `infrastructure` section of the instance config, one provider per port: `secrets`, `models`,
  `mail`, `objectStorage.files`, `objectStorage.workspaces` and `sandbox`. The keys
  `modelProviders`, `mail`, `executionWorkspaces.runner` and
  `capabilities.documentProcessing.objectStorage` moved there. Config that still carries one of
  them does not load: startup stops with a message that names the key and its new place. There
  is no transition release, so deploy the config change together with this version. What to
  change:
  - `modelProviders` (a list) becomes `infrastructure.models` (a map): `id` is the map key,
    `type` becomes `provider`, the key's `…EnvName` field becomes `credentialSecret`, the
    organization's becomes `organizationSecret` and `compliance.residency` becomes `region`.
    A residency of `unknown` has no counterpart: state where the provider processes data, and
    `global` when no EU processing is agreed. An id made only of digits is refused, because
    such a key is read before the others and would move the default provider; rename it, also
    where an agent names it.
    Maps merge key by key across `extends` files, so delete an entry of a base file that an
    overlay used to replace. At least one entry is required; the implicit `deterministic`
    default is gone.
  - `mail` becomes `infrastructure.mail`: the two `…EnvName` fields become `apiKeySecret` and
    `apiSecretSecret`, and an instance without mail leaves the key out instead of
    `enabled: false`.
  - `executionWorkspaces.runner` becomes `infrastructure.sandbox`: `mode` becomes `provider`
    (`docker` or `local`). `networkMode` and `readOnlyRootFilesystem` are fixed and no longer
    settings. `EXECUTION_WORKSPACE_RUNNER_IMAGE` still replaces the image of a `docker` sandbox
    and is ignored for any other. A Docker sandbox with an `endpoint` runs on another host and
    must state a `region`; without an endpoint it must not.
  - `capabilities.documentProcessing.objectStorage` becomes `infrastructure.objectStorage.files`:
    `kind` becomes `provider`, the vendor's `region` becomes `bucketRegion`.
    `DOCUMENT_OBJECT_STORE_BUCKET`, `DOCUMENT_OBJECT_STORE_REGION` and
    `DOCUMENT_OBJECT_STORE_ENDPOINT` still replace the entry's values.
  - The variables `EXECUTION_WORKSPACE_OBJECT_ROOT` and `ARTIFACT_PREVIEW_OBJECT_ROOT` are no
    longer read. Name the directory in `infrastructure.objectStorage.workspaces`
    (`provider: filesystem`, `root`), and mount the same directory into the API and its workers.
    Enabled execution workspaces need this entry and `infrastructure.sandbox`. A deployment
    that set the directory through one of the two variables, in Compose or in an environment
    file, moves that path into config and removes the variable; the files stay where they are
    as long as `root` names the same directory.
  - A provider that sends data outside the instance (`openai-compatible`, `mailjet`, `s3`) must
    state `region: eu` or `region: global`; one that keeps data inside must not.
- **Secrets (breaking for integrators):** every secret is taken from one secret resolver, by
  name. The `environment` provider reads the variable of that name and otherwise the file named
  by `<NAME>_FILE`, so a mounted secret works for every secret, including `DATABASE_URL`. Config
  fields that take a secret end in `Secret` and hold its name, never its value. The S3 store
  always takes its credentials by name (default `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`); the AWS credential chain and the built-in S3Mock credentials are no
  longer used. A deployment that reached S3 through an instance role or another source of the
  AWS credential chain must now provide an access key pair as two named secrets, and a local
  S3Mock that ran without credentials needs both variables set to any value. A name must read
  as an environment variable name (upper-case words joined by underscores, at most 64
  characters); anything else is refused and never repeated in a message, so a credential
  pasted where a name belongs does not reach a log. The same holds for a data source's
  `connectionRef: env:NAME`. A secret whose `<NAME>_FILE` is set and whose file cannot be read
  or is empty stops startup, also for a secret the instance may leave unset. An instance whose
  config carries `auth.sessionToken` no longer starts without `CHAT_SESSION_TOKEN_SECRET` and
  `CHAT_SERVER_CREDENTIAL`: before, it started without session-token sign-in when another
  sign-in path existed. Set both, or remove `auth.sessionToken`. A seed user's
  `passwordEnvName` follows the same naming rule.
  `createClientInstanceApp`, the worker factories and `seedStandaloneAuthUsers` accept a
  `secrets` resolver. `@vivd-catalyst/data-source` no longer exports `createEnvSecretResolver`,
  `createDataSourceRegistry` is asynchronous and takes `secrets`, and
  `createModelProviderRegistry` is asynchronous and takes the instance's provider `registry`. A capability receives `secrets`, `logger` and `objectStorage` in its context and
  may bring provider definitions in `providers`. An artifact preview `sourceReaderFactory`
  receives `context` (the resolver and the logger) for the store it creates.
- **Config API:** a selectable model in the safe config view carries `region` (`eu` or
  `global`) in place of `residency`.
- **Startup messages:** an invalid instance config names the first failing key in the error
  message, not only in its details.
- **Database (operator-relevant):** `infrastructure.database.poolSize` sets how many PostgreSQL
  connections each process of the instance keeps at most; the default is 10, the value until
  now. `createPlatformStore` requires `poolSize` (breaking for integrators that call it).
- **Run start:** a repeated run start with the same idempotency key waits up to 10 seconds for
  the first one, in steps of 100 ms, before it answers 409; until now it waited one second.
- **Jobs:** `JobWorker.idle()` resolves when the worker has no pass and no job in flight and
  sleeps until its next poll.
- **Jobs (operator-relevant):** the API process runs a job executor on the new table
  `platform_jobs` (one migration, which only creates the table and moves no data). It replaces
  the three interval timers for conversation expiry, workspace cleanup and run recovery, and
  the in-process title generation. A job survives a restart: it is leased, retried with
  backoff and recovered when its worker dies. `createClientInstanceApp` starts the worker in
  `listen()` and stops it in `close()`; `createJobWorker` is exported from
  `@vivd-catalyst/client-assembly`. On SIGTERM the worker stops claiming, waits up to 20
  seconds for running jobs and gives the rest back, so the Compose service `api` needs
  `stop_grace_period: 30s`. Ended job rows are removed after 7 days (succeeded, cancelled) or
  30 days (failed, dead).
- **Jobs (operator-relevant, breaking for integrators):** file previews and document
  preprocessing run on the job executor, as the kinds `artifact_preview.render` (two attempts,
  30 seconds apart, a lease of 5 minutes) and `conversation_attachment.preprocess` (three
  attempts, 30 seconds doubling up to 10 minutes, a lease of twice the preprocessing timeout
  and at least a minute). The preview row and the attachment stay the record the interface
  reads; the row and its job are written in one transaction. No migration. A storage
  or database error, or a converter killed by a signal, is now tried three times before the
  attachment shows as failed, and a conversion that timed out twice; a refused or corrupt
  document, such as an unsupported format or a converter ending with an exit code, fails at
  once as before.
  - The preview worker no longer reads `ARTIFACT_PREVIEW_POLL_INTERVAL_MS`,
    `ARTIFACT_PREVIEW_LEASE_DURATION_MS`, `ARTIFACT_PREVIEW_LEASE_RENEW_INTERVAL_MS` and
    `ARTIFACT_PREVIEW_MAX_ATTEMPTS`, and the document worker no longer reads
    `DOCUMENT_WORKER_POLL_INTERVAL_MS`. Remove them from the environment.
    `ARTIFACT_PREVIEW_CONCURRENCY` and `DOCUMENT_WORKER_CONCURRENCY` stay: they are how many
    jobs one process runs at once.
  - On SIGTERM both workers give their running jobs back, so the Compose service of the
    document worker needs `stop_grace_period: 30s`, as the preview worker has it.
  - This release can run beside the previous one and be rolled back to it. A job copies its
    lease onto the old lease columns of its row, so a worker of the previous release leaves
    the row alone; the job leaves a row alone while a worker of the previous release holds it;
    and the schedule `platform_jobs.adopt_legacy` gives every unfinished row without a job
    its job once a minute, which covers rows the previous release's API writes. The copy, the
    schedule and the old lease columns go in a later release.
  - `@vivd-catalyst/tool-execution` exports `createArtifactPreviewJobHandler` in place of the
    class `ArtifactPreviewWorker`. `ClientInstanceArtifactPreviewWorker.worker` is a
    `JobWorker` and its `stop()` takes no argument. The file store loses
    `claimNextArtifactPreviewJob`, `recoverStaleArtifactPreviewJobs` and
    `claimNextQueuedConversationAttachment`; a row is claimed by id with
    `claimArtifactPreviewJob` and `claimConversationAttachmentForPreprocessing`.
- **Agent Runs (operator-relevant, breaking for client assemblies):** an Agent Run executes
  only as a claimed job of the kind `agent_run.execute` (one attempt, a lease of 90 seconds
  renewed every 15 seconds). The run row stays the record the interface reads; the row and its
  job are written in the transaction that accepts the message. No migration. The option
  `agentRuntimeMode` of `defineClientInstance` and `createClientInstanceApp` is removed, with
  the runtime that kept runs in the memory of the API process. Its place takes
  `agentRunWorker`: `"in_process"` (the default) serves the runs from a second job worker
  inside the API process, `"separate"` leaves them to the processes started with
  `runAgentRunWorker`. A deployment that set `agentRuntimeMode: "worker"` sets
  `agentRunWorker: "separate"`; one that set `"local"` or nothing removes the option. The
  environment variables of the worker are unchanged: `AGENT_RUN_WORKER_CONCURRENCY` (runs one
  process executes at once, default 8, read by the API process too when it serves the runs),
  `AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS` and `AGENT_RUN_WORKER_ID`.
  - A run is never executed twice. Every event and every message of a run is stored in a
    transaction that first reads the job row under a share lock and requires its lease token
    and an unexpired lease, so a worker that lost its lease stores nothing more, whatever it
    still does.
  - When the worker of a run is killed, nobody can tell for up to 90 seconds: the reply stands
    still and the conversation takes no message. Then the next pass of any job worker of the
    instance, the one of the API process included, marks the job dead and, in the same
    transaction, fails the run with the code
    `AGENT_RUN_WORKER_LOST` and the category `runtime_interrupted`, stores the event
    `run_failed` and the audit event `agent_run.recovered`. The interface shows the reply as
    interrupted with what was streamed so far, and the conversation takes the next message.
    The message is not sent to the model again. This needs no second Agent Run worker: the
    API process buries the jobs of lost workers without executing any. A run that another
    worker holds under a live lease, one of the previous release during a rolling deploy, is
    left alone when the job beside it dies.
  - On SIGTERM a worker takes no new run and lets its runs go on for the drain time, as
    before; a run that is still going then fails with `AGENT_RUN_RUNTIME_INTERRUPTED` and is
    not executed again. A second signal ends the drain at once. An API process that serves
    the runs itself stops them at once when it closes.
  - A cancellation reaches the worker within about a second: the job reads its row once a
    second, and at once when the API and the worker are one process. The cancel route answers
    with the status `cancelling` for a run that has started, in every topology; the run is
    `cancelled` once the worker has stored what the model wrote so far. A run that was asked
    to cancel ends as cancelled even when its completion arrives first.
  - A run that stores no event for 30 minutes fails as interrupted. A run that no worker took
    within 10 minutes of its acceptance fails with the code `AGENT_RUN_NOT_STARTED`; the
    conversation takes the next message and the interface says that the reply could not be
    started. The previous release failed such a run after 30 minutes. The limit is the
    constant `AGENT_RUN_MAX_QUEUED_MS`. It must stay above the longest wait of a healthy
    instance, which grows with the runs queued ahead divided by the slots of all worker
    processes, times the length of a run. Instance > Jobs marks a kind whose due jobs have
    waited a minute with none running as "No worker takes these"; for `agent_run.execute` that
    is the missing Agent Run worker. `/ready` does not change.
  - The answer of a run and the end of the run are stored in one transaction. A worker that is
    killed at the end of a run leaves either the answer with a completed run, or a failed run
    without the answer; the previous state of this release could show the full answer beside
    a failed run. Every event the worker takes after the answer is held with it until the
    event that ends the run, since such an event may be older than the answer. Above
    `AGENT_RUN_HELD_END_MAX_EVENTS` (1000) held events the answer and those events are stored
    at once and that run goes on without this guarantee.
  - An approval request a tool proposes and a provider continuation the runtime drops carry
    the lease of the run's job into their transaction (`RuntimeCallContext.runFence`), like
    the events and messages, so a run that lost its lease leaves none of them behind. Usage
    settlement and audit are not fenced, on purpose: a model call that was made and a tool
    that ran are recorded whoever holds the run. Workspace commands, artifacts and files are
    not fenced; the run checks its lease before each tool call.
  - A stopped reply is named "The reply was stopped." in the interface, in English and
    German, where it showed the reason code of the request.
  - This release can run beside the previous one with the worker topology and be rolled back
    to it. A job copies its lease onto the lease columns of its run row, so a worker and the
    API of the previous release leave the row alone; a job that finds its run held by a
    worker of the previous release ends without waiting; and the schedule `agent_run.adopt`,
    served by the API process and by every Agent Run worker, gives every queued run that
    has no live job a job every 15 seconds, which covers runs the previous release's API
    accepts. The same tick fails a started run as lost when the lease on its row has run out
    and no job of it is running, so a run whose previous-release worker died ends within 15
    seconds of its lease, also while no Agent Run worker is up. After a
    rollback the previous release's worker claims the queued runs this release accepted, and
    its recovery fails the runs this release's worker held once their lease has run out. An
    API of the previous release that kept runs in its own memory (`agentRuntimeMode:
"local"`) cannot run beside this release: stop it before the new processes start.
  - Rollback in the single-process topology: the previous release with `agentRuntimeMode:
"local"` executes only runs it accepted itself. A run that was in flight on this release
    at the rollback stays `running` on the previous release until that release's recovery
    fails it, up to 30 minutes later, and its conversation answers the next message with 409
    until then. Let the runs end before a rollback, or expect that wait.
  - Compose: give an Agent Run worker a `stop_grace_period` of at least its drain timeout plus
    30 seconds (15 minutes 30 seconds with the default `AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS`),
    or Docker kills it mid-drain and its runs fail as lost after the lease time instead of
    ending. The recommended `AGENT_RUN_WORKER_CONCURRENCY` is the default of 8: a worker
    process with 8 runs in progress was measured at 201 MB.
  - The schedule `agent_run.recover` is gone. The kind stays registered with a handler that
    does nothing, so the tick the previous release left behind ends; it is removed in a later
    release.
  - `@vivd-catalyst/agent-runtime` exports `createAgentRunJobs`, `createLocalAgentRunExecutor`
    and `createAgentRunSignal` in place of the class `AgentRunWorker` and
    `createWorkerLocalAgentRunExecutor`. `@vivd-catalyst/chat-server` no longer exports
    `RunRecoveryWatchdog` or the job option `runRecovery`. `AgentRuntime.holdsRun` is removed.
    The run store loses `claimNextAgentRun`, `heartbeatAgentRun`, `recoverExpiredAgentRuns`,
    `listStaleActiveAgentRuns` and `recoverStaleAgentRun` and gains `claimAgentRunForJob`,
    `renewAgentRunJobLease`, `failLostAgentRun`, `failAgentRunsQueuedTooLong`,
    `failAgentRunsWithoutWorker`, `appendClaimedAgentRunEnd` and `listAgentRunsWithoutJob`; the fenced
    writes take `lease: { jobId, leaseToken }`. `UserStore` gains `getUser`.
    `JobWorker.stop` takes `{ drainMs }`. `@vivd-catalyst/core` gains `defineJobBurial`, which
    registers only the burial of a kind's dead jobs in a process that does not execute the
    kind, and `createAgentRunUpkeepJobs`, which `createChatServerJobs` registers.
- **Jobs (operator-relevant, breaking for integrators):** workspace commands run on the job
  executor, as the kind `workspace.command` (one attempt, a lease of 2 minutes renewed every 30 seconds, one command
  per workspace at a time, so two commands of a workspace run in the order they were queued).
  The command row stays the record a tool reads; the row and its job are written in one
  transaction. No migration. A command is never run twice: when its worker dies, the command
  fails with the code `WORKSPACE_COMMAND_WORKER_LOST` and the category `worker_lost`, in place
  of `WORKSPACE_COMMAND_STALE`, once the lease has run out. What `workspace.exec` returns is
  unchanged. Instance > Jobs offers no retry for a `workspace.command` job: the job of a
  command that has ended does nothing.
  - A cancelled command ends within about a second: the job reads its row once a second and
    stops the process group. A cancellation that arrives after the process has ended does
    not change the record: the command is completed or failed with its real result. A tool
    that waits for a result still asks the row every 500 ms; it is not woken by a
    notification yet. On SIGTERM a running command is recorded as cancelled with the
    reason "Workspace command worker is stopping" and is not run again.
  - The command worker reads only `executionWorkspaces.worker.concurrency`, which is how many
    commands one process runs at once. `pollIntervalMs`, `leaseDurationMs`,
    `heartbeatIntervalMs`, `cancellationPollIntervalMs`, `staleRecoveryIntervalMs` and
    `staleRecoveryLimit` under `executionWorkspaces.worker` are still accepted and no longer
    read. After a command worker is killed, its command fails as lost within two minutes,
    and the later commands of that workspace wait until then; until now they ran at once. A
    worker that finds at a heartbeat that it lost its lease stops the process group of its
    command at once.
  - Temporary command state is removed by the schedule `workspace_command.clean_temp_state`,
    which the command worker serves. With several command workers on separate disks one tick
    cleans one host.
  - This release can run beside the previous one and be rolled back to it. A job copies its
    lease onto the lease columns of its command row, so a worker of the previous release
    leaves the row alone; the job leaves a row alone while a worker of the previous release
    holds it, and fails the command as lost when that lease runs out; and the schedule
    `workspace_command.adopt_legacy` gives every unfinished command without a job its job
    every 15 seconds, which covers commands the previous release's API queues. A job that
    waits for a worker of the previous release holds one slot of the new worker. The copy,
    the schedule and the lease columns go in a later release.
  - A job kind may name its heartbeat interval with `heartbeatMs`, below its lease; without
    it the lease is renewed every third of its length, as before.
  - `@vivd-catalyst/tool-execution` exports `createWorkspaceCommandJobs` in place of the class
    `WorkspaceCommandWorker`, and the client and the tools take a store with `transaction`.
    `ClientInstanceWorkspaceCommandWorker.worker` is a `JobWorker` and its `stop()` takes no
    argument. The command store loses `claimNextWorkspaceCommand`,
    `heartbeatWorkspaceCommand` and `recoverStaleWorkspaceCommands`; a command is claimed by
    id with `claimWorkspaceCommand`.
  - `@vivd-catalyst/capability-sdk` exports `defineJobKind` and `defineJobHandler`. The
    capability context has `jobs`, to enqueue, and `transaction`, to write a record and
    enqueue its job together. An attachment handler may implement `adoptLegacyAttachments`
    for the transition.
- **Audit (breaking, deletes data):** audit retention is enforced. The daily job `audit.prune`
  deletes the instance's audit events older than `retention.auditDays` (default 365) and
  records one `audit.pruned` event with the count. There is no switch. On the first start
  after the upgrade the first run is due at once, so every audit event older than
  `auditDays` is deleted then. Raise `retention.auditDays` (up to 3650) before upgrading if
  older events have to stay.
- **Conversation titles (breaking):** the title is generated by the job
  `conversation.generate_title`, enqueued with the first user message. The operation
  `conversations.title.generate` (`POST /api/v1/conversations/:conversationId/title`) and the API
  client's `conversations.generateTitle` are removed. A client that still calls the route gets
  a 404 and reads the title from the conversation list.
- **Chat server (breaking):** the server options `retentionExpiration` and `runRecovery` are
  removed, with `ConversationRetentionJob`, `createConversationRetentionJob`,
  `ExecutionWorkspaceCleanupJob` and the `start`/`stop`
  of `RunRecoveryWatchdog`. `createChatServerJobs(options)` returns the handlers and schedules
  for a job worker. A store implementation needs `jobs`,
  `audit.deleteAuditEventsOlderThan` and `conversations.replaceConversationTitle`. Runs that a
  process-bound runtime lost with the last process are recovered by an `agent_run.recover`
  tick that is due at every start. The generated title is written only while the conversation
  still carries the title the job read, so a rename by the user stays.

- **Platform store (breaking):** Postgres is the only platform store. The `STORE` environment
  variable is no longer read, so `STORE=memory` no longer starts an instance without a
  database; every process needs `DATABASE_URL`. Remove `STORE` from environment files. The
  `storeMode` option is gone from `createClientInstanceApp`, the worker factories, `listen` and
  the capability context, together with the `PlatformStoreMode` type, and an artifact preview
  `sourceReaderFactory` no longer receives `storeMode`. `@vivd-catalyst/core/testing` and its
  `InMemoryPlatformStore` are removed.
- **Workspaces (breaking):** workspaces are part of every instance, and the switch
  `ui.collaborationWorkspaces.enabled` is removed. Every signed-in user of the interface sees
  the workspace selector at the top of the rail, with the client branding inside it; an
  embedded token session keeps its fixed context and the branding head. Remove
  `ui.collaborationWorkspaces` from config files. For this one release a config that still
  says `enabled: true` loads; `enabled: false`, or any other value, stops the instance at
  startup with a message that names the key. That acceptance ends with the next release. The
  safe config (`GET /api/v1/instance/config`) no longer carries `features.collaborationWorkspaces`:
  deploy the interface and the API together, because an interface built before this release
  reads the new answer as invalid. Creating, browsing and requesting access to a Shared
  Workspace and adding members no longer answer 403 "Collaboration workspaces are not enabled
  for this instance".
- **Views (breaking):** a generated view loads Tailwind CSS and Lucide from the instance, in
  pinned versions under `/app-runtime/view/1/`, and no longer from two public hosts. A reverse
  proxy in front of an instance must route `/app-runtime/*` to the API. The hosts a view may
  load other scripts from are the instance key `views.allowedScriptSrc`, which defaults to
  none; before, the `show_view` tool's `config.allowedScriptSrc` defaulted to every HTTPS
  host. The `show_view` tool takes no config now: any key left there fails validation and
  names the new key. The interface composes a view's head and content policy when it shows
  the view, so the setting also governs views saved earlier: before upgrading, name every
  host saved views still need.
- **Breaking, operations:** migrations run only as an explicit step, and `RUN_MIGRATIONS` is
  gone. Each client builds `dist/migrate.js` (`client.migrate()` in `src/migrate.ts`); the
  Compose `migrate` service runs `node <client folder>/dist/migrate.js` and the API and workers
  wait for it. The API and the workers no longer migrate when they start: a database that
  lacks committed migrations stops them with the missing migration names, and a database
  ahead of the release starts. Remove `RUN_MIGRATIONS` from Compose and environment files and
  replace an inline migration command with the entry; a setup that relied on the API
  migrating at startup must run the step first. `@vivd-catalyst/postgres-store` exports
  `migrateDatabase({ databaseUrl })`, which holds the advisory lock and returns the applied
  names; the `runMigrations` option and the store's `migrate()` are removed.
- **Operations:** schema changes follow expand and contract. `pnpm check:migrations` rejects
  a changed, removed or renamed committed migration and lints every migration the base branch
  lacks against an allow list of additive forms. Any other statement, such as a drop, a
  rename, a type change, `DELETE` or a `DO` block, passes only under
  `-- contract-after: <tag>` once the oldest supported release in
  `packages/postgres-store/migration-policy.json` reached that tag; a required column without
  a default and a blocking index build never pass. A concurrent index build goes in a
  migration of its own and runs outside a transaction. `pnpm test:compatibility` runs the
  database tests of the previous and the oldest supported release against the new schema, and
  `pnpm test:upgrade` migrates a database of the oldest supported release.
- **API (breaking):** every product operation is under `/api/v1`, and no old path answers any
  more. An old path returns 404 `NOT_FOUND` "Operation is not available" with
  `details.reason: "unknown_operation"`; the one exception is the old API-key exchange below.
  A caller changes the path of every request. `/api/conversations…`
  becomes `/api/v1/conversations…`, `/api/collaboration-workspaces…` becomes
  `/api/v1/workspaces…`, `/api/approval-requests…` becomes `/api/v1/approval-requests…`,
  `/api/me…` becomes `/api/v1/me…`, and `/api/password-reset` and `/api/password-setup` gain the
  prefix. Paths carry no role name: `/api/admin/config/…` becomes `/api/v1/instance/config/…`,
  `/api/admin/collaboration-workspaces` becomes `/api/v1/instance/workspaces`,
  `/api/superadmin/users…` becomes `/api/v1/instance/users…`, `/api/superadmin/usage` becomes
  `/api/v1/instance/usage`, `/api/superadmin/api-access/service-principals…` becomes
  `/api/v1/instance/service-principals…`, `/api/superadmin/api-access/credentials/:id/revoke`
  becomes `/api/v1/instance/api-credentials/:id/revoke`, `/api/audit-events` and
  `/api/audit-activities` move to `/api/v1/instance/…`, and `/api/config` and `/api/branding`
  become `/api/v1/instance/config` and `/api/v1/instance/branding`. Rights are unchanged.
  `/health` stays public and unversioned, and `/api/auth/*` stays the sign-in library's mount.
  A reverse proxy that forwards `/api/*` needs no change.
- **Interface:** reload every open tab after the upgrade. A tab loaded before it calls the old
  paths and shows "Operation is not available" with no hint; this release cannot change that
  page. From this release on, the interface shows one notice with a reload action when the
  server answers that it does not know an operation the interface called.
- **API (breaking):** the API-key exchange moved from `POST /api/auth/access-token` to
  `POST /api/v1/auth/access-token`. Session-token issuance for embedding hosts moved from
  `POST /api/superadmin/session-tokens` to `POST /api/v1/instance/session-tokens`, and its
  alias `POST /auth/session-token` is removed. An older CLI, which sends its key as a bearer
  to the old exchange path, reads 401 `UNAUTHENTICATED` "Standalone auth endpoints do not
  accept explicit credential headers" on an instance with standalone sign-in, because the
  sign-in mount refuses the header before it routes, and 404 elsewhere. A backend that issues chat session tokens
  changes its URL; the `x-server-credential` header and the payload are unchanged. Before this
  release is deployed, search the production access log for both old token paths and move any
  caller found.
- **API (breaking):** operation ids are `<resource>.<verb>`, for example `conversations.list`,
  `workspaces.members.add` and `me.get`, in the OpenAPI document and in `apiOperations`. Code
  that read `apiOperations.listConversations` reads `apiOperations["conversations.list"]`.
  The development mail listing moved to `GET /api/v1/dev/captured-mail` and stays out of the
  document, as does `/health`.
- **CLI (breaking):** `catalyst config` signs in with `CATALYST_API_KEY` only. The fallback to
  `CATALYST_SERVER_CREDENTIAL` and `CHAT_SERVER_CREDENTIAL` and its deprecation warning are
  removed; without a key the CLI stops before it sends a request. Create a service principal
  and a key under Administration → API Access and set `CATALYST_API_KEY` wherever the CLI runs.
  The server needs `SERVICE_ACCESS_TOKEN_SECRET` set, at least 32 characters; without it the
  instance has no API access and the CLI cannot sign in. For a local development instance,
  `catalyst config local-key` creates the principal and key as the seeded superadmin and
  writes the key into `.env`; it refuses any other host. CLI and server ship together: this
  CLI needs a server that answers under `/api/v1`.
- **Client:** `getAuthSession`, `signInWithEmail` and `signOut` are exported from
  `@vivd-catalyst/api-client`; the interface no longer fetches `/api/auth/*` itself.
- **Client (breaking):** the methods of `createApiClient` are derived from the operation
  catalog instead of written by hand or generated. Every operation is one method under the
  segments of its id, and takes one object with the parts its descriptor names:
  `client.conversations.thread.get({ params: { conversationId } })`,
  `client.conversations.list({ query: { collaborationWorkspaceId } })`,
  `client.users.create({ body })`, each with an optional `signal`. The old names are gone, for
  example `client.account.get()` is `client.me.get()`, `client.runs.start(id, input)` is
  `client.conversations.runs.start({ params, body })` and `client.configAssets.export()` is
  `client.config_assets.export()`. A list method answers one page, `{ items, nextCursor }`;
  `listAll((paging) => client.users.list({ query: paging }))` reads a list to its end. A
  stream is an async iterable, resumed with `query: { after }`. A file URL for the browser
  comes from `client.urlFor(operationId, { params, query })`. A success that is not valid JSON
  or does not match the response schema is now an `ApiError` with the response status and the
  parse failure as `payload`, where a schema mismatch was a `ZodError` before; an abort
  through the caller's `signal` rejects with the abort itself, never an `ApiError`; a stream
  that breaks off is an `ApiError` of status 0. The package no longer contains generated code
  and no longer depends on `@hey-api/openapi-ts`; its `generate` script is removed. The
  OpenAPI document of `@vivd-catalyst/api-contract` is unchanged.
- **API (breaking):** every list answers with `{ items, nextCursor }` instead of a bare array.
  `limit` defaults to 50 and accepts 1 to 200, anything else answers 422. `nextCursor` is
  absent on the last page; pass it back as `cursor` with the same filters to read the next
  page. A cursor from another list or with other filters answers 422. The conversation
  resources list carries `items` instead of `resources`, and the agents of a workspace carry
  `items` instead of `agents`, next to `defaultAgentName`. Workspaces in the directory and in
  the administration picker carry `createdAt`, the key they are paged by. The audit
  activity view is not paged: it answers `{ items }` with the latest activities only, at most
  100 from the latest 500 audit events, and takes no `limit` or `cursor`. The shared API
  client keeps returning complete arrays; its audit event helper returns the latest 100
  events.
- **API (breaking):** every timestamp is UTC and ends in `Z`. A timestamp with an offset such
  as `+02:00`, or without a zone, answers 422; this applies to `expiresAt` when an API
  credential is created.
- **API (breaking):** reading no longer creates anything. A list of workspaces or
  conversations does not create the caller's Personal Workspace; call
  `POST /api/v1/workspaces/personal` once instead. A preview read does not start
  the preview; call `POST /api/v1/conversations/{conversationId}/artifacts/{artifactId}/preview`
  or `POST /api/v1/conversations/{conversationId}/attachments/{attachmentId}/preview`, and read
  the preview until it is ready. A preview that was never started reads as `pending` without
  `queuedAt`. The three operations need the scope of the read they replace.
- **API (breaking):** every error answers with
  `{ error: { code, message, correlationId, details? } }`, and the same id in the
  `x-correlation-id` response header. A caller's own `x-correlation-id` request header is
  kept. An unknown path answers 404 in this shape. `RATE_LIMITED` (429) is a new code. An
  `INTERNAL` error always reads "Internal server error".
- **Document worker (breaking):** the worker answers errors in the same envelope,
  `{ error: { code, message, correlationId } }`, instead of the flat `{ code, message }`.
  Deploy the worker and the application of one release together.
- **Chat:** after a restart, an instance that runs agents in its own process ends the runs the
  last process left open, so their conversations accept new messages at once.
- **Chat:** the conversation list is a compact single-line list without the last-updated date.
  A conversation within seven days of its retention date carries an amber clock, on instances
  with `retention.expireConversations` enabled. Its hint names the deletion date; it opens on
  hover and on keyboard focus, and the row's menu repeats it for touch.
- **Administration:** saving an agent or skill confirms it next to the save button until the
  form is edited again.
- **Chat:** the start page introduces the agent with its icon and name, centred above the
  composer: several agents make the name a picker that opens on click, a single agent a plain
  label. In a conversation the header shows the icon alone, and pointing at it opens the agent
  list, with a single agent too. `ui.showAgentName` is now `true` by default, decides
  only whether the start page shows the name beside the icon, and no longer adds the client
  name beneath the agent; with `ui.showAgentName: false` the start page shows the icon alone
  as well.
- **Chat:** the agent list shows each agent's description only with the new
  `ui.showAgentDescriptions: true`; by default it lists the names alone.
- **Approvals:** the review queue behind the clipboard icon in the sidebar's footer is gone;
  `/approvals` leads to `/inbox`. The card of a request in a conversation opens the same item
  beside the chat. Rejecting from the item takes an optional comment. A collapsed sidebar shows
  the number of an item's count on its icon.
- Rename workspace packages to `@work-shape/catalyst-*`, including `@work-shape/catalyst-server`, and deployment assembly packages to their explicit Workshape names. Keep stored keys, resource names and host paths unchanged. Publish repository metadata only for the four public edge packages.
- Read actual imports in the workspace dependency check so gallery code examples and seeded Apps keep their existing build boundary after the scope rewrite.
- Keep rebuilding stored Pages with legacy App Kit imports, and allow the CLI itself in the public tarball install check while rejecting workspace dependencies.
- **Packages:** complete the freeze-C package layout: move the server to `packages/server` and the standalone client to `clients/chat-standalone`; fold data sources into postgres-connector, the widget into chat-ui/widget, and native document helpers into tool-execution/native-document. Remove registry-canary, unused image mirror plumbing and deployment-kit forwarders. Update consumer imports, source aliases, baseline scopes and deployment paths together.

- **Compatibility:** consumers must update the removed package imports and script paths in the paired capability/deployment changes. No database migration or runtime configuration change is required; rollback uses the previous matched repository revisions.
- Trim the published `@work-shape/catalyst-chat-ui` package by scanning its compiled JavaScript for Tailwind classes instead of shipping a duplicate TypeScript implementation. Keep the stylesheet, Vite helpers, types and runtime chunks in the package, and the full source for workspace development.
- Run hosted checks on main pushes and release tags, or explicitly by dispatching a branch or adding the `ci` PR label. Ordinary PR events allocate no runners; the local combined batch check gates landing. Keep `check` as the stable result aggregate, share one build across parallel checks, and select labeled PR jobs from changed paths.
- Fail the aggregate on cancelled browser shards, select browser and image checks from the demo/server workspace dependency closure, and run the format check for docs-only changes too.
- Group server implementation files by feature and rename workflow implementation files to services, preserving the public package exports and runtime behavior.
- **Postgres stores:** Fold store factories into their operation modules and remove the internal
  `stores/` folder. Public store contracts, SQL, transactions and migration files are unchanged.
- **Quality checks:** Ratchet retired product terms in platform code, starting with Namespace, against exact per-package baseline counts. Technical Postgres, ESTree, esbuild and process-isolation terms are excluded. Namespace removal remains in NS-RETIRE.
- **Quality checks:** Remove the max-lines rule and its platform and capabilities baseline entries; keep all other rules and counts unchanged.
- The chat E2E runner labels its Postgres container and volume `catalyst.worktree=<name>`, taken from `CATALYST_WORKTREE` or the checkout's `.worktrees/<name>` path, so the lane's `tidy` removes a stack whose worktree is gone by its label and never by a name.
- Organize chat-ui source into chat, studio, admin and shared folders, preserving package entrypoints and behavior. Repoint internal imports, test aliases, guard keys and capacity references. Include a replayable D2 move script for the freeze's moving base.
- Share contract allowed-value lists and typed subsets through asset-schemas and core, preserving accepted values, order, exported unions and the existing documented disagreements. Add a measured duplicate-list lint ratchet; no dependency, lockfile, API document, migration or runtime behavior changes.
- **Workspace checks:** Derive the package dependency graph and source aliases from package manifests. Lint now owns the workspace dependency check across package and client source, tests, scripts, tools, Astro and MDX as well as package cycles; the separate workspace-deps script and manually maintained graphs are removed. Test-only UI subpaths are development-only exports and remain absent from published packages. After editing exports, run `pnpm exec catalyst-quality aliases --write` in platform and capabilities; lint refuses stale maps with a repair command that also covers new exports in the sibling platform repository.
- Split workspace access requests and settings, configuration schemas, managed-file attachments and cleanup, execution-workspace persistence, and command filesystem handling into concern modules while preserving their existing entry points and public contracts.
- Split chat workspace state, tool-call presentation and assistant message conversion into focused modules. Existing entry points and behavior are unchanged.
- Add a limit guard to the hosted check: a line marked `check-limit` (the package tarball limits, the test and job timeouts) moves only in a pull request titled `chore(limits): ...`, which lands alone.
- Lower the release check's tarball limit for `@work-shape/catalyst-chat-ui` from 1.3 MB back to 650 kB. The package packs to about 540 kB since it stopped shipping a duplicate TypeScript source.
- **Release:** Set the docs package tarball budget to 2,000,000 bytes, based on a packed site of 1.55 MB.
- Use generic accounting and deployment examples in platform packages and docs, and guard against customer and vendor names returning.
- **Version 0.7.0:** all platform packages and the public CLI `@work-shape/catalyst-cli` carry
  version 0.7.0, the first version whose CLI has `catalyst setup`. 0.6.4 is taken by the hotfix
  release on `release/0.6.4`. The API reference `openapi.json` names release 0.7.0.
- **Platform:** Remove unreachable Connection scope code, clarify agent-facing data-scope guidance, and use generic accounting examples in App documentation.
- **Docs say what the product does today (D-1):** guardrails run at every before-event and are
  written as assets (How rights work, Current status, CLI); the CLI signs in with
  `catalyst login` and a personal key from Settings > You > API keys (Config Assets, CLI, Auth
  and embedding); the page of a Connection made in Studio is edited there, and its status table
  says what to do for such a Connection; Modules lists `apps`, `workflows`, `dataStores` and
  `knowledge`; the glossary gains Workspace, Studio, Skill, Page, App, Workflow, Connection, Data
  Store, Guardrail, Inbox and Module, with German screen names; the docs home has an Apps card.
  The pages OpenAPI API Tools, Config Asset Migration and Chat Experience are gone from the site
  and from the shipped skill `platform-docs`: the first described a tool that is not built, the
  second a migration that is done, the third types that do not exist.
- **Docs:** The docs start with the people who use Catalyst. The home page opens with one plain sentence and tiles for getting started, building agents and Apps, automating, connecting systems and managing. Two new pages, Your first conversation and Workspaces, cover the first steps. Setup, configuration, code tools and running the reference client locally move into a section for operators and developers, and several page titles lose their jargon.
- **Docs tabs stand apart from an instance:** every page title on the docs site starts with
  "Docs" ("Docs · Workshape Catalyst" on the home page, "Docs · <page title>" elsewhere), and the
  site uses a docs variant of the Catalyst mark as favicon and logo: a dark ink square with the
  orange corner, outlined in light on a dark scheme. It uses only the mark's colours.
- **The docs describe what the product does, not what is missing:** the sections "Not In The
  Current Release" (What the release contains), "Not built yet" (Rights), "What the system does
  not have yet" (How rights work), "Not yet stated" (Capacity and limits) and "What is not in it"
  (CLI) are gone, and so are sentences that announce a later feature on the pages Build an App,
  Release config, Apps, Workflows, Build, Modules and Config assets. A limit that shapes how a
  feature is used today stays, stated as how it works. The shipped skill `platform-docs` carries
  the same text.
- **A Connection is not MCP only in the docs:** Connect a system, the glossary and What the
  release contains name REST interfaces read by GET (`http_api`) beside remote MCP servers.
- **CLI:** the note that `catalyst config local-key` was removed, and that `pnpm config:local-key`
  in the client repository replaces it, stays on the page without a heading of its own.
- **Docs, Operated Instances:** a new page under Operate holds what every instance operated with
  the deployment kit needs: the three repositories and the deployment repo's layout, the
  Cloudflare, Hetzner and GitHub tokens and secrets, the Terraform roots, the env file and zram on
  the host, the release flow with its manifest, pins and rollback, the six images, a manual
  deploy, the backup timer, the bucket retention rules with Hetzner's limits, the model provider
  smoke test and the local development loop. It moves out of the deployment repos' READMEs, which
  keep only what belongs to their instance.
- Show the Catalyst mark and three product screens in the public repository's README: a chat answer from the CRM, an offer waiting for approval and a Workflow run. The public mirror now carries `docs/` from the approved release assets.
- Describe rights in the docs by the asset owner: an agent or skill belongs to the instance or to the Shared Workspace it was made in, and a right in a workspace covers everything it owns. Namespaces remain only as a short note on what is left of them until their code is removed.
- Move "Rights for one person or asset" to `/operate/rights-for-one-person/`; the old address redirects.
- Point the interface's rights help links at the rewritten headings, and regenerate the shipped platform docs skill from the pages.
- **A person's or a service principal's own rights are grant rows (AP-4):** the nine legacy
  permission keys in the lists of users and service principals become instance-wide rows of
  `permission_grants`, one per action a key stands for (`config_assets.write` is `agent.write`,
  `agent.delete`, `skill.write` and `skill.delete`), an allow for `key` and a deny for `!key`,
  written with `grantedBy` `legacy_permission_list`. The evaluator no longer reads the columns
  `permissions`, and nothing writes them. The Users and API access screens show and save the
  same lists, now as rows: a saved list rewrites only the keys it changes, and the new rows name
  who saved them. A list entry that is no key is refused with `422` "'…' is not a permission".
  **Instance > Access** no longer lists the instance-wide rows of a user or a service principal,
  and revoking one there is refused with `invalid_scope` "An instance-wide right is changed on
  the page of the user or the service principal". `permissions.effective` names such an entry
  with the source `grant`; the source `legacy` is gone from the contract, and the Check tab
  calls such a right "Given right". An API key created without scopes is stored with `["*"]`.
  An API key's scopes still cap its service principal: a key holds a principal's instance-wide
  right only when one of its scopes carries the legacy key behind it, one key per scope as a
  request read it before (`governance:read` is `usage.view`). No user, service principal or API
  key gains or loses a right.
- **Breaking for Apps: `connections.call` is removed.** An App reaches a Connection only through
  a named `connection` action in its folder (`actions/<name>.action.yaml` with `connection`,
  `operation` and `effect`, called with `actions.call('<name>', input)`). The route
  `POST /api/v1/app-content-sessions/{pageSessionId}/connections/{connection}/operations/{operation}`
  (`apps.sessions.call_connection`) is gone. An App built against kits 1.1.0 to 1.3.0 that still
  calls `connections.call` gets at once the error `connection_call_removed`, which names the named
  action as the fix (kit 1.0.0 had no call of a Connection). A `connections.call` that waited for
  an approval across the upgrade is ended when it is approved: its run fails with the same
  message and the Connection is not called. The platform operation `connections.call` for the
  CLI, MCP and agents is unchanged.
- **App Kit 1.4.0** is released without `connections` and is the kit version for new Pages and
  Apps. It adds about 485 kB to the `chat-server` package; its size limit moves from 2.1 MB to
  2.7 MB.
- **Reserved App keys:** the build refuses `rights` and `requires` at the top of `app.yaml`,
  `requires` on an action, and an action of `kind: code` or with `reads` or `writes`, as a line
  of the manifest or in its action file, with the code `key_reserved`. The `code` action arrives
  with APP-12; rights inside Apps are not yet decided.
- **App bridge v1 is frozen:** the docs page Reference > App bridge v1 lists its messages and the
  kit's calls. Changes to version 1 are additive, a new call needs a named App that cannot be
  built without it, and a breaking change is version 2 beside it.
- The Results tools on the agent page say what they do: **Keep a fact sheet** ("Faktenblatt führen"), **Read the fact sheet** ("Faktenblatt lesen") and **Reopen an earlier result** ("Früheres Ergebnis öffnen"). Where the instance offers both, keeping the fact sheet and reading it are one check box: on, the agent holds `structured_data.publish` and `structured_data.read`; off, neither. An agent stored with only one of them is saved as its box shows on its next save from the page, also when only another field changed: with both when it held `structured_data.publish`, with neither when it held only `structured_data.read`. Where the instance offers only `structured_data.publish`, it stands alone as before. The tool names are unchanged.
- The chat steps of these tools follow the same names: **Update the fact sheet** ("Faktenblatt aktualisieren"), **Read the fact sheet** ("Faktenblatt lesen") and **Reopen an earlier result** ("Früheres Ergebnis öffnen").
- **The instance's Postgres image is our own, with pgvector (KB-3, ADR-0023):**
  `ghcr.io/vivd-solutions/catalyst-postgres`, pinned by digest in
  `docker/postgres/pinned-image`. It is `postgres:17.11-trixie` by the digest the live hosts
  ran on 2026-10-14 (Debian 13, glibc 2.41) plus `postgresql-17-pgvector` 0.8.7-1.pgdg13+1 from
  PGDG, checked against its SHA-256 and installed alone, so Debian, glibc and Postgres stay
  those of the base. `vector` is not a trusted extension on it. The demo Compose files, the
  hosted checks and `pnpm check:local` start it; `POSTGRES_VERSION` is gone from the demo's
  environment. The workflow "Postgres image" builds, checks and pushes it
  (`docker/postgres/check-image.sh`: versions, collation, `halfvec` ranking exact and through
  HNSW, a dump with vectors restored into a scratch database). `DataStores` gains
  `ensureVectorExtension(storeId)`, which creates the extension in one store as the platform's
  role, and finds it where the store already has it, also where an operator created it as its
  refusal `vector_extension_not_permitted` says; nothing calls it yet (KB-5). **Operators:**
  switch the `postgres` service of a deployment to the pinned digest once, in the order of the
  KB-3 rollout: every database backed up with the roles (`pg_dumpall --globals-only`),
  `/etc/os-release`, `version()` and `datcollversion` recorded on the host, staging first, the
  log and `pg_database` read for collation warnings after the restart. **Rollback:** until the
  first `CREATE EXTENSION vector` on a server, restart the `postgres` service on the image it
  ran before (`postgres@sha256:2d2b8998...` on the hosts read so far); the data directory is the
  same. After it, do not start the old image on that data directory: a store database with the
  extension can then not be read at all, its other columns included, and `pg_dump` and
  `pg_dumpall` fail on it, so a backup of all databases breaks as well. A dump taken on the new
  image does not restore on the old one either ("extension "vector" is not available"). The way
  back is on the new image: in every database that has it, `DROP EXTENSION vector CASCADE`,
  which drops the columns and indexes that use it with their embeddings; then restart on the
  old image.
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
  `conversation.subject_opened` with the tool call it confirms, and then opens the page. A
  `toolCallId` that names no open of that asset in that conversation which waits for the person
  is refused (`open_not_pending`), so the audit row names only a call the agent made. Until
  then a changing asset tool on it is refused. Before, such an open was refused outright.
  Once OP-3 exists, the open pauses for the confirmation in the host's prompt instead.
- **No asset beside the chat:** the Workflow canvas, the App draft and the agent no longer open
  as surfaces beside the conversation; "Edit with the agent" opens the asset's page with the
  conversation in the dock. A preview the dock's conversation opens on a page, such as a file or
  a view, covers the page and leaves the dock in view.
- **"Draft · not published":** the page of a Workflow or an App that was never published says
  so. On the App's page that badge stands at the end of the tab row, so it stays whole with the
  dock open, whatever room the actions take.
- **The New right dialog offers no Namespace, and Connection rights no workspace:** Instance >
  Access offers a new right in a shared workspace (chosen first where the kind can be owned by
  one), on one asset, or on the whole instance, each only where the right can be written there,
  and asks for no place when there is one. Today every kind has one place, one asset. Rights in
  a Namespace that exist stay listed and revocable, and `permissions.grant` still writes them,
  until the Namespace is retired. `connection.read` and `connection.use` at workspace scope are
  refused with `422` and the reason `invalid_scope`: "'connection.use' cannot be granted at the
  scope kind 'workspace'". **Operators:** rows already written there stay and are read as
  before, and the Access page lists them under the workspace's name; revoke them there.
  **Rollback:** an earlier release writes them again.
- **Connect a local agent:** `PUBLISHED_CLI_VERSION` names `@work-shape/catalyst-cli` 0.7.0, the
  first version on npm with `catalyst setup`. Settings > "Connect a local agent" shows the command
  `npm install --global @work-shape/catalyst-cli@0.7.0 && catalyst setup <tool> --instance <url>`
  instead of "The command is not available yet", and `platform.context.get` answers
  `release.cliVersion` 0.7.0. The page still appears only where personal API keys are on.
- **No escalation through service principals (RIGHTS-1a):** a person gives or lends a right
  only where their own call holds it, with the scopes of a personal key counted. Making a
  Workflow revision live, the newest or an earlier one, asks `workflow.publish` and every right
  of the service principal it runs as. The superadmin role and `api_access.manage` no longer
  stand in for that, so an administrator publishes a Workflow whose principal holds what she
  holds. A test run is unchanged. A Workflow whose principal holds `config_assets.release` is
  published by nobody. A refusal names the first missing right, and the asset only where the
  caller may read it.
- **`service_principals.manage`:** a new right, held by administrators and superadmins through
  their role. It lists and creates service principals, gives and takes their rights, and
  enables and disables them, each gift and each enabling under the rule above. Issuing a key
  needs `api_access.manage` and every right of the principal; revoking one needs
  `api_access.manage` only. Only a superadmin gives a principal `config_assets.release`. The
  API access page shows principals to holders of the new right and keys to holders of
  `api_access.manage`.
- **`PlatformContext.instanceActions`:** `platform.context.get` names the rights the caller
  holds over the instance itself, today `service_principals.manage`.
- **No escalation through people (RIGHTS-1b):** `users.manage` no longer hands out more than
  the caller holds. Giving a person a grant, a role or a legacy key asks every action it
  carries, at the scope given; writing a deny and lifting one ask the action the deny names.
  Nobody writes or lifts a grant of their own (`holder_not_administrable`), and nobody gives
  themselves a role or a key. Changing an account (name, email, status, roles, keys, a sign-in,
  the password, an invitation, deletion) asks every right the person holds: role defaults,
  instance-wide rows and keys, rows in a workspace, a Namespace or on an asset, and memberships
  of Shared Workspaces, a disabled person's included. The person's own Personal Workspace does
  not count. A superadmin follows the same rule; the superadmin-only rules stay as they were.
  A refusal is `403 FORBIDDEN` naming the first missing right, for example "This call does not
  hold 'agent.write' in the Namespace 'kai-', and 'Kai' would hold it. Only a holder of a right
  gives or lends it". Existing rows and accounts are not re-checked and nothing is migrated. A
  holder of `users.manage` without the admin role can therefore change only people who hold
  nothing beyond their Personal Workspace, until RIGHTS-1c lets an admin give them more.
- **A deny counts wherever it lies:** a right given over a Namespace, a workspace or the whole
  instance (a role, a legacy key, a key of a Service Principal, a Workflow's principal) is
  refused while the giver holds a deny of it on anything inside that place, rather than
  narrowed: "'agent.read' on an asset this call may not read is denied to this call, and the
  right in the Namespace 'kai-' reaches it". The asset is named only to a giver who may read
  it. The same holds for changing an account whose rights reach the deny.
- **Permission refs follow the rule:** a reference of a tool is given only by a person who
  holds it, never to oneself, and a person's references count when their account is changed.
  A superadmin who does not hold a reference no longer gives it on the Users page.
- **The rights checked are the rights written:** every write that changes who holds what
  (grants and their removal, roles, legacy keys, permission refs, sign-ins, passwords,
  memberships, Service Principals and their keys, personal API keys) takes the instance's
  access lock and then the lock of the user it changes, at the start of its transaction, and
  asks its check again there, of the rights as they are then rather than as the call was
  admitted. A user promoted, a deny given to the caller, a deny of the user lifted or a
  membership given in between is counted, not missed. A first password sign-in is created only
  after that check and removed again when the change fails; a new password for an existing
  sign-in is the last step before the commit. Rights writes of one instance now run one at a
  time, and an account change and a grant for the same user no longer end in a Postgres
  deadlock.
- **Effect on an operated instance:** an admin keeps every change they made before, except
  changing the account of a person who holds `api_access.manage` or `agent_models.manage`,
  which now only a superadmin does, and writing a grant for themselves, which another admin
  or a superadmin now writes. Rolling back restores the earlier rule; no data changes.
- **Close the remaining rights races:** deletion admission and its mark share the rights
  transaction; identity mappings cannot silently move between users; new sign-in mappings and
  direct membership/provisioning writes take access, user, then identity/workspace locks.
- **Existing sign-ins stay independent:** refreshing an already linked sign-in locks only its
  user before its identity, so an unrelated rights write or password hash does not queue every
  authenticated request. Creating a user, linking a sign-in and writing legacy grants still
  take access first; a mapping changed during the lookup is re-read before anything is written.
- **A Workflow's page says whom it runs as (WF-RUNAS-1):** the first line under its head reads
  "Runs as <account>" ("Läuft als <account>"), by the label of the service principal every run
  acts as, never by the definition's name for it. `workflows.list` names that label in the new
  optional field `runsAs` of each Workflow; it is missing where the principal is disabled or gone,
  which the Workflow's `reasons` already say. The list reads each principal once for both.
- **An unpublished draft names its account too:** `assets.get` returns the active configured
  account's label in optional `runsAs`, only after the asset read is authorized. The header
  uses it when the Workflow has no published entry. Disabled or missing accounts have no label.
- **Words on the rights screens (RIGHTS-WORDS):** Instance > Access, Users, API access, a
  workspace's Members and a Connection's page say every right with one verb per action, the
  same in every dialog, row and refusal: view, use, edit, publish, delete, approve (German
  ansehen, verwenden, bearbeiten, veröffentlichen, löschen, freigeben), so "Read agents" is now
  "View agents" and "Agenten: Lesen" is "Agenten ansehen". No rights screen shows an action id,
  a legacy key, a key scope or an asset id any more: an asset the reader may not see is "An
  asset you cannot see". The German interface calls a service principal "Technisches Konto".
  "Rolle" names the instance role only: the Users page's "Access level" is now "Role", and a
  workspace member's role is their "Membership" ("Mitgliedschaft").
- **Workspace > Members** says what a member gets and what Builder and Publisher add.
- **The principal-rights dialog on API access** offers only rights the person holds
  themselves: a Connection they are denied, or hold no right on, stands disabled with the
  reason. Everyone may read their own effective rights, and principal managers may read
  principal grants and effective rights without `users.manage`; other people’s rights
  remain protected. The instance still refuses an unheld grant itself.
  A holder of `api_access.manage` alone is told that the service principals need the right to
  manage them, instead of "No service principals yet".
- **An agent's page (AGENT-AVAIL-1)** names "Available in" ("Verfügbar in") once, as its
  section's heading, and saves where the agent can be chosen through the page's one save bar
  with the agent's other changes. The section's own "Save availability" button is gone. The
  library's `RadioGroup` takes `labelHidden` for a group whose heading names it already.
- **Settings waits for the platform context** before it sends an address elsewhere: an
  administrator who opened Instance > API access by its address, such as from a Connection's
  page, was sent to Users while the right that shows the page was still loading.
- **Instance > API access** lists every person's own keys only to a holder of
  `api_access.manage`, who alone may read and revoke them; an administrator without it no
  longer meets a refused request on the page.
- Refuse reserved data-scope config keys and Data Store table metadata with SCOPE-1, and Connection operation scope declarations with SCOPE-2, including malformed values. Ship the SCOPE-0 build rules in Workflow authoring and App-building guidance.
- **The head of every asset page names the asset and says what it does:** the name, then its
  description or summary on the same row. The asset's id is no longer shown on the page; "Copy
  ID" ("ID kopieren") in the head's "…" menu puts it on the clipboard, on Studio pages, Apps
  (for whoever builds them) and Workflows (for whoever may change them). The App details dialog
  no longer lists the id.
- **Long names wrap, then cut:** a name in an asset's head, a Studio list row or an App, agent or
  Workflow card takes a second line, is then cut and reads whole on hover, also beside the dock
  at 1280 and at 390.
- **No id as a row's second line, one scope chip per row:** Data Store and Knowledge Base rows
  show their description instead of their id, an App card no longer shows its id to builders,
  and a Connection or Data Store row shows one chip for whose it is ("Persönlich" alone for the
  reader's own) instead of a second "Arbeitsbereich"/"Instanz" chip.
- UI library: `PageHeader`'s detail name and `ListRow`'s title wrap to two lines, `CardTitle`
  takes `clamp`, and `DropdownMenuCopyItem` copies a text and says so in place.

- Header actions stay within the screen at phone widths, including the German Workflow
  header: the shared header wraps them so its Copy ID menu stays reachable.
- **App drafts fold Files and Actions under "Technical details":** an App's draft page opens
  with its preview and one line, "Technical details" ("Technische Details"), after the Preview
  tab. One click shows the Files and Actions tabs; the browser remembers the choice for the next
  draft and after a reload. Folding them again returns to the preview. The UI library's
  `TabsList` takes an `end` beside the tabs, and `TabsDisclosure` is the line that shows more.

- The disclosure stays within the tab row at phone widths, including German: its label
  truncates when needed and reads in full on hover.
- **Create in one step (UXA-2):** the New agent and New skill dialogs that stay where no
  building agent is offered, New agent on the Agents page, Copy to edit, and the New connection
  dialog ask for the name first; the New agent dialog also asks "What should it do?", which
  becomes the agent's description. The address (the id) is made from the name under
  "Advanced" ("Erweitert"), or under "Technical details" for a Connection, and follows the name
  until it is edited. It is checked while typing: a taken address, or one the kind's rule for
  names refuses, is named at the field, the fold opens, and Continue or Connect stays off
  until it is fixed. The Namespace choice moved under the same fold. The UI library gains `NameWithAddress`.
- **`assets.check_name`:** `POST /api/v1/assets/{kind}/check-name` with `name` and an optional
  `workspaceId` answers `{ available: true }`, or `{ available: false, reason, message }` with
  `reason` `name_invalid` (creation's shared name validation and its reason, including the
  agent schema's refusal of `.` and `..`) or `name_taken` (the generic revision-conflict
  sentence a non-reader's create gives). It writes nothing and requires the kind's write
  right on the requested name; without it the caller gets 403. A fresh create names
  `expectedRevision: null`: both active and deleted assets reserve their names. The check
  reveals only the submitted kind and name, with no title, owner, workspace, revision or
  deleted state. Reusing a deleted name still requires its deletion revision. A put is
  unchanged. Rollback: the dialogs of an older UI do not call it; nothing is stored.
- Reconcile publish metadata at the existing lockstep version, 0.7.0: API contract/client,
  asset schemas and CLI are MIT/public; other libraries and deployment-kit are
  UNLICENSED/restricted. Docs, demo, standalone UI, App Kit source and quality tooling stay
  unpublished. Preserve the folded package layout: server ships vendor assets, the standalone
  UI is a private client assembly, and the removed widget, data-source, document-execution and
  registry-canary packages stay absent. Derive the quality graph from manifests.
- Add a visibility/dependency guard and release-tag-only CI: require tag/manifest agreement,
  main or release/* ancestry and the commit's green Check, mirror only public packages,
  publish in dependency order, resume existing versions and verify private names anonymously.
  Candidates use next; older hotfixes use release-X.Y without moving latest backwards.
- Mirror the core lockfile's peer-install setting so public installs keep the tested dependency
  graph, including peer resolutions.
- Inspect capability tarballs and imports in the external consumer too; budget the existing
  standalone artifact-helper bundles at 6.5 MB (measured 5.9 MB).
- No tag or package is released by merging this change. The manager must authorize the
  paired 0.8.0-rc.1 cut and tags. Core needs Actions secrets NPM_TOKEN and PUBLIC_MIRROR_KEY;
  the public repo needs its bootstrap NPM_TOKEN until all four trusted publishers exist.
  VP-5 must add deployment-kit/docker and regenerate metadata when its Dockerfile is built.
  Existing package versions remain available for rollback; never move a tag or unpublish.
- Prune the public lock to reachable importer resolutions before pnpm regenerates it; verify
  frozen installation, builds, publish dry runs and installed dependency parity with core.
  Mirror only the public metadata policy and remove bootstrap change files.
- Pin release npm to 11.21.1. Clear a registry-created candidate latest tag, including on reruns;
  warn and leave latest on a sole candidate if npm refuses removal. Set latest explicitly
  only for final releases that do not move it backwards.
- **Deployment kit:** Source-ref deployment lockfile refreshes resolve exact Catalyst version pins against matching local packages. This keeps existing image builds working while deployments move to published packages; root development uses the workspace repository's generated local overrides.
- **Workflows (WF-AUTO-1):** a run of a published Workflow revision performs its changing
  operations. Where the policy of an operation is `confirm`, a step of a run from a schedule,
  or of a manual or parent start of what is published, runs the call: publishing the Workflow
  was the confirmation. Before, that `confirm` became an approval nobody could give, so every
  `data_store.<id>.insert` of a published run failed under the instance's default policy. The
  call's Operation Run records the decision reason `workflow_publish` ("Approved by publishing
  the Workflow" on its detail), and its `operation.completed` audit row carries
  `decisionReason: "workflow_publish"`. A `deny`, an `approval`, a floor of the operation, a
  guardrail and the grants of the Workflow's service principal still stop the call. A test run
  of a draft acts as its tester, as before, and an agent's call still asks its person.
- **Workflows:** a step refused because a guardrail asks for an approval names the guardrail
  and its reason: "The guardrail '…' asks for another person's approval of '…': <reason>",
  with `details.guardrailId` beside `details.reason: approval_unavailable`.
- **Workflows:** a test run no longer marks a step "A published run asks for approval here" for
  a plain `confirm`, since a published run now runs it; the mark stays where the operation's
  floor asks for a confirmation.
- **Workflows:** a run that is still going when its Workflow is deleted loses the publish's
  confirmation: a later step whose operation's policy is `confirm` fails with `POLICY_DENIED`,
  `details.reason: workflow_deleted`, "The Workflow of this run was deleted, so its publish no
  longer confirms '…'". Its reading steps and the calls its policy allows still run.
- **Connection operations stay inside the instance unless an admin opens them:** an operation
  of a Connection has a fourth exposure, `outside`, which admits the CLI and the platform MCP
  server and nothing else. It is off on every operation, new and stored, and no migration sets
  it. Before, the CLI, an MCP client and a person in the browser passed any non-empty exposure;
  now `cli` and `mcp` need `outside`, and a person outside an App and a schedule reach no
  Connection operation directly (`connection_exposure:<origin>`). Over HTTP only an API
  credential (a personal API key, a service principal's credential or a token exchanged for
  one) gives origin `cli`; a session token an embedding host issued is the person (`user`).
  The Connection page has the check box **Outside clients (CLI, MCP)**, German **Externe
  Clients (CLI, MCP)**, on each operation of a Connection made on the instance; release config
  names `outside` in `exposure`. A personal connection refuses every exposure but `agent`.
- **Platform:** reconcile the combined folder and store refactors with tool validation and App CLI commands, regenerate their documentation, remove one-time freeze replay tooling and the obsolete usage-store exception.
- **Platform:** remove one-time freeze replay scripts after integrating the D7b and D7c concern splits.
- **Platform:** remove the one-time freeze-C replay script and document hosted checks without the retired image mirror.
- Move the core to `work-shape/catalyst-core`: build Postgres under
  `ghcr.io/work-shape/catalyst-postgres` on Blacksmith, pin the checked image in CI and the
  demo, and update its source label. Move the docs and mirror workflow guards and mirror
  destination to Workshape; remove the registry-canary workflow.
- **CI:** Balance fourteen browser shards by measured main-run durations, keep serial Inbox tests together, use uniform 2-vCPU runners, retain JSON reports for refreshing the measurements, and validate the browser selection directly so the required aggregate runs alongside the compatibility aggregate.
- **Tests:** Consolidate duplicate browser checks and cover Page mouse-modifier cancellation in unit tests, while retaining browser exit, authorization, focus, layout and interaction guards. Make the retained deleting-user fixture independent of browser shard order.
- Balance Vitest shards by measured file duration, using the median for new files and retaining hosted timing artifacts for refreshes. Speed up the independent child-run budget test by seeding completed history instead of replaying thousands of no-op jobs.
- **Tests:** Split the platform asset tool tests by execution mode, keep the cross-process read/write and actor checks, share read-only fixtures, and skip deterministic model word pacing in the in-process tests.

### Fixed

- **A service principal calls no operation that a person calls:** an operation registered with
  `auth: "user"`, such as `workspaces.create`, is refused to a service principal on the call
  path as its route refuses one, also where the call takes no route, as from a step of a
  Workflow. The call is denied before the operation runs, with an Operation Run that is
  `denied` and the reason `user_only`, and the step says that only a person may call it. Such
  a refusal names no right where the operation names none: `action` of a forbidden denial is
  optional, and is left out where no right opens the call.
  Before, the step's call ran into the operation and failed there.
- **Parallel browser suites on one Postgres:** `scripts/run-chat-e2e.mjs`, `playwright.config.ts`
  and the specs hard-coded the database `agent_chat`, so several runs on one machine erased each
  other's data. `E2E_DATABASE_URL` now replaces that URL for the migration, the API, the worker
  and the specs; without it nothing changes. The runner still creates and drops no database or
  role. Use it with `E2E_EXTERNAL_POSTGRES=1` and an empty database per run.
- **Backups of the whole database server:** `backup-postgres.sh` of the deployment kit dumped
  only `POSTGRES_DB`, so no Data Store database and no role was in a nightly or pre-deploy
  backup. A backup is now one tar archive, `<instance>-<database>-<timestamp>[-<label>].tar`,
  with `globals.sql` from `pg_dumpall --globals-only` and a custom-format `pg_dump` of every
  database the server lists, except the templates, `postgres`, invalid databases and the
  scratch databases of `restore-postgres.sh`. `restore-postgres.sh` lists, verifies and recovers
  both the archives and the earlier `.sql.gz` dumps; a recovery from an archive creates the
  missing roles, replaces every database it holds and then sets the roles as in the backup, and
  if a step fails or it is stopped, it puts every database back and leaves the roles' passwords
  as they were. **Upgrade:** a deploy
  of the release installs both scripts; nothing else changes. **Rollback:** the previous
  scripts neither list nor restore a `.tar` backup; restore one with this release's
  `restore-postgres.sh`.

- **Outside hosts of an App on the viewer's own network:** `externalHosts` in `app.yaml` took a
  name under `.localhost`, `.local`, `.internal`, `.lan` or `.home.arpa`, which reaches the
  viewer's own machine or network. The build refuses one with "a host on the internet: a name
  under .localhost, .local, .internal, .lan, .home.arpa reaches the viewer's own machine or
  network", and a host listed twice with "lists the host '<host>' twice". The content policy of
  a revision stored before leaves such a name out and names each host once. **Upgrade:** a Page
  whose manifest lists one no longer builds until the entry is removed.
- **A JSON request body the server does not read:** an empty body with a JSON content type, one
  that does not parse, and one that names `__proto__` or `constructor.prototype` as a key
  answered `500` on every operation. Each now answers `400` `BAD_REQUEST` with
  `details.reason` `invalid_json_body`.
- **Chat starters:** a starter of a skill that ships with the platform shows that skill's
  icon. Every starter showed the generic book, because the agent's starters did not carry the
  skill's `icon`. A skill of the instance's own keeps the generic book.
- **The agent opens no asset of the instance on its own:** `platform.assets.open` moves the
  conversation's subject onto an asset of the conversation's workspace, such as an App, as
  before, but no longer onto an asset of the whole instance, such as a Workflow or an agent. A
  prompt injection the agent read could have opened a shared Workflow for an administrator and
  saved a poisoned draft on it. Such an asset becomes the subject only when the person starts
  the conversation from its page ("Edit with the agent"). The refused open tells the agent to
  read the asset with `platform.assets.get` or to ask the person to open its page; its call
  ends `failed` with `not_allowed`, and the audit row names the kind and the asset, never the
  definition. A confirmation of the agent's open in the host's prompt comes with NAV-2.
- **Dialogs:** a dialog closed by its Cancel or close button gives the focus back to what
  opened it, such as New agent on the Agents page. Only Escape did; the buttons left the focus
  on the page body.
- **Agents page:** an agent renamed or changed in Studio shows its new name and description on
  its card and in the agent picker without a reload. A save of an agent, and a change of the
  default agent, now also ask again for the workspaces' lists of agents.
- **Hostile YAML and tool-call text:** every YAML file an author or an agent writes
  (`workflow.yaml`, `app.yaml`, App action files, `store.yaml`, `SKILL.md` frontmatter), the
  release config and the CLI working copy are read by one reader. It knows JSON types only:
  a timestamp, `!!binary` or other YAML-only tag in `store.yaml`, `SKILL.md` frontmatter, the
  release config or an agent file now reads as plain text or is refused, as `workflow.yaml` and
  `app.yaml` already were. A file whose aliases expand past 100,000 values is refused
  (`'<file>' holds more than 100000 values once its aliases are followed
(YAML_DATA_MAX_VALUES).`); before, such a `workflow.yaml` hung its reader. A file with a NUL
  character or half of a surrogate pair is refused (`'<file>' holds a NUL character or half of a
surrogate pair, which cannot be stored.`). A tool call whose arguments hold either is answered
  to the model as the tool error `invalid_text` and stored with an empty input; before, it ended
  the whole run with `INTERNAL`. Rollback: none needed, nothing is stored differently.

- **Claude runs with `workspace.preview_images` or `structured_data.publish`:** the input schema
  a model is shown for each of the two had a combinator at its root (`anyOf` over the three
  preview sources, `oneOf` over replace and patch), which Anthropic's Messages format, also on
  Amazon Bedrock, refuses, so every run of an agent that lists one of them failed at the first
  model call. Both are now one object at the root. `workspace.preview_images` names the rule
  "exactly one of `artifactId`, `path`, `paths`" in its description, and
  `structured_data.publish` shows the fields of both operations with `operation` as the choice.
  What each tool accepts is unchanged: a call with no source or several, or with a field of the
  other operation, is still refused.
- **Workflows, the agent's save and a policy on `assets.put`:** a central policy setting on
  `assets.put`, or on `assets.*`, that matches the Workflow of a conversation now holds for
  the agent's `platform.assets.put` too: `deny` refuses the save and `approval` holds it for
  the Inbox, as the API does. Before, only a setting on `platform.assets.put` itself did.
- **Workflows, the conversation about one in a shared workspace:** a conversation with a
  subject is created `private` in a shared workspace, whatever the workspace's default is, and
  `conversations.move` refuses `visibility: workspace` for it with the reason
  `subject_conversation_private`. Its transcript holds the definition the agent read, which a
  member of the workspace without `workflow.read` could open before.
- **Assets, a text the store cannot hold:** a definition with a NUL character or half of a
  surrogate pair in any text or key is refused by `assets.validate` and by a save of any kind
  with an issue of the code `text_not_storable` at the path of the value (for a key, at the
  object that has it), where a save answered an internal error. The content of a step file
  of a Workflow is answered the same way, no longer as `code_file_invalid`.
- **Connections, schemas of an outside system:** a JSON Schema that an MCP server lists for a
  tool can no longer hold the API process. Such a schema is compiled, and an input or a result
  checked by it, in a worker thread: 2 threads per process, a check of at most 2 seconds, 500
  compiled schemas per thread. A check that passes the deadline stops its thread, and the call
  is refused with the new reason `schema_check_timeout` (`TIMEOUT`); a check no thread takes
  within 5 seconds, or whose thread ends, is refused with `schema_check_unavailable`
  (`CONFLICT`). A schema whose check passed
  the deadline is refused for 30 seconds without a new check. A discovery also leaves out a
  tool whose schema holds more than 200 `$ref`, more than 100 regular expressions or one longer
  than 1,000 characters, beside the bounds of size and depth it had, and names why on the
  Connection (`lastErrorCode`) and in the event `connection.discovered` (`reason` and
  `schemaRefusedCount`): `schema_too_large`, `schema_too_deep`, `schema_too_many_refs`,
  `schema_too_many_patterns`, `schema_pattern_too_long`, `schema_uncompilable` or
  `schema_check_timeout`. The schemas of a Connector type's own catalog, such as `postgres`,
  are checked as before. **On upgrade:** an operation of an `mcp` Connection whose stored
  schema is over one of these bounds (200 `$ref`, 100 regular expressions, 1,000 characters
  per expression, 256 KiB, 20,000 nodes, 64 levels) stops being callable. It keeps its entry
  with the status `unknown` and the code of the bound as `schemaRefusal`, and a call answers
  `CONFLICT` with that code as its reason and a sentence that names the limit, which brings
  the reasons to twenty-two. It is callable again once the server lists a schema within the
  bounds. **Operators:** nothing to set. The package `@vivd-catalyst/connections`
  now ships `dist/json-schema.js`, the file the threads run, beside `dist/index.js`; a build
  that bundles the package into one file must keep it beside the bundle.
- **Chat, attachments:** a file added to a message no longer stays on "Queued" while the
  browser tab is in the background. The composer asked for the file's state once a second
  only while the page was visible, so a file the instance had finished in two seconds still
  read "Queued" on return, and the message could not be sent until the next answer came. It
  now asks in the background too while a file is being processed, and once more when the page
  comes back. The other regular reads (Jobs, Operations, Infrastructure, Inbox, approvals, a
  Page's access check) still pause while the page is hidden: none of them holds an action
  back, and each reads again on return.
- **Local development, UI image:** the development UI image (`ui-dev` in
  `docker/vivd-client.Dockerfile`, the one `pnpm dev` starts) builds the packages that `core`,
  `config-schema` and `ui` depend on. Before, it built `core` without `asset-schemas`, the
  image built, and the UI container stopped at start with `Cannot find module
.../asset-schemas/dist/index.js`. The image build now loads the Vite plugin and fails when
  a package is missing, and `pnpm check:images` builds this image too.

- **Model providers and redirects:** no model adapter follows a redirect any more. A provider
  endpoint that answered with a redirect had the API key, the access token and the conversation
  sent on to the host the redirect named. The call now fails as a refused request and is not sent
  again; this holds for `openai-compatible`, `google-vertex` and their provider checks.
- **Deployment kit, worker guards:** the Compose checks under `verify/` judge what a worker
  must not have on the stack as `docker compose config` resolves it: the
  files the deploy script passes with `-f`, and locally `docker-compose.yml` with
  `docker-compose.override.yml`. A secret that reaches a worker through a YAML anchor, a merge
  key or an override file is refused. Before, the checks read the text of the service block
  and such a secret passed. **`catalyst-deploy check` now needs `docker compose`**, and it
  stops a deployment that passed before with `<file>: <worker> must not ...` for
  `agent-run-worker`, `workspace-command-worker` and `artifact-preview-worker`:
  - `receive <NAME>`: a signing secret, and for the two workers that call no model a model
    key. Model key names are `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`,
    `GOOGLE_VERTEX_CREDENTIALS` and every `credentialSecret` and `organizationSecret` a file
    under `config/` names.
  - `use env_file`, `use extends`, `use secrets`, `use configs`, `use volumes_from`: the
    resolved file does not show what they carry. A worker names each variable under
    `environment`. There is no allow list; none of the operated deployments uses one of the
    five keys.
  - `set pid`, and `mount <path>` for `/etc/vivd-catalyst`, a directory that holds it, a
    path whose variable has no default, and, except on `workspace-command-worker`, the Docker
    socket under any path.

  `AWS_SECRET_ACCESS_KEY` left the lists of the workspace command worker and the artifact
  preview worker: both read and write the object stores, and the deployments hand them that
  key through an anchor, which the text check never saw. Compose fills the variables in
  itself, in an environment where none has a value, so the check runs on the Compose of a
  hosted runner; it is tested from Compose 2.29. `verify/compose-helpers.mjs` gains
  `resolveCompose`, `assertWorkerIsolation`, `reachesDockerSocket`, `serviceNames` and
  `modelSecretNames`.

- **A command no worker takes fails after 30 seconds:** `workspace.exec` waited without a limit
  for a worker to claim its command; with the workspace command worker down the run stood
  still until the idle limit of 30 minutes ended it. The tool call now fails when its command
  has been due for 30 seconds and the workers of the kind reported nothing for 30 seconds. The
  agent reads that code execution is unavailable and the run goes on. A command behind a
  worker that reports waits as before, and a job a dead worker left `running` holds nobody
  up. A kind that never reported, served by a worker of the previous release during a deploy,
  is judged by its queue: no job under a live lease and none claimed or ended in 30 seconds.
  A Page save uses the same rule, now `noWorkerTakesJobs` in `@vivd-catalyst/core`. Jobs
  nobody claimed no longer outlive what queued them: a cancelled command and the queued
  commands of a run that ended (completed, failed, cancelled, lost or never started) end
  their job as `cancelled` with the error class `WITHDRAWN`. A worker that claims a job whose
  command was cancelled ends it as `cancelled`, not `succeeded`. A run ended by the idle limit
  says what it waited on: the codes `AGENT_RUN_COMMAND_NOT_TAKEN` and `AGENT_RUN_TOOL_SILENT`
  carry the new optional `tool` of a run error, the name of the tool only, and the
  conversation says that code could not be run or which tool did not answer;
  `AGENT_RUN_IDLE` replaces `AGENT_RUN_RUNTIME_INTERRUPTED` for a run that stood still on no
  tool.
- **The Infrastructure page no longer shows a sandbox check nobody runs as "ok":** every job
  worker reports the kinds it claims every 10 seconds into the new table `job_worker_reports`
  (migration `0057_job_worker_reports`), one row per kind; a row nobody renewed for a day is
  removed with the ended jobs. The sandbox shows as failed with the new error class
  `no_report` and the time of the last report when the workers of its check were silent for 30
  seconds, also before their first result, or when its last result is older than two check
  intervals (10 minutes). `GET /instance/infrastructure` gains `codeExecution` with
  `available` and `since`. **Deploy order:** run the migration before the workers start, as
  always; a worker of the previous release writes no report and its result is judged by its
  age alone, so the page stays correct while the workers are replaced. On a rollback the
  table stays and is not read.
- **Workers no longer end on their own:** a job worker with nothing to do ended with exit code
  13 when the driver closed its last database connection at the end of the connection's
  lifetime, 30 to 60 minutes after the start. The sleep between two polls did not hold the
  process. Every process that only runs a job worker was affected: the artifact preview worker,
  the workspace command worker and the Agent Run worker. Compose started each one again.

- An open tool call in the work history shows an output that is only an error as wrapped text, so the whole sentence is readable: what happened, whether trying again helps and who can act. It was one line of JSON in a code box, cut at the right edge. The id of a tool call is no longer written into the page.

- **Demo:** the rate card of the reference client has a price for GPT-5.6 Sol, Terra and Luna.
  The composer offered all three, and under the demo's spend budget each run on them was
  refused. A test holds that every model binding of the demo has a price.
- **Chat:** the message above the composer after a failed or refused reply is the library's
  warning banner and follows the theme. It was a fixed pale yellow box with dark red text, which
  glared on the dark page. A run that is refused because its model has no price on the customer
  rate card now fails with the code `MODEL_NOT_PRICED` (it was `FORBIDDEN`; the message is
  unchanged), and the chat words it for its reader in English and German: someone with
  `usage.view` reads that the price is missing and to choose another model until the operator
  has added it, anyone else reads to choose another model or ask an administrator. The notice
  spans the composer, goes when another model is picked, and a reply that failed or was stopped
  before anything of it arrived leaves no empty row with copy and retry buttons. The warning
  outcome in the audit log and the budget bar from 80% use the library's warning tone.
- **Connections:** a Connection whose host is on the egress list and does not resolve, as with
  a stopped service or a resolver that is down, no longer reads as refused by the list. A call
  answers `connection_unavailable` with "the host <host>:<port> did not resolve to an address"
  and a test answers `unavailable`, where both said `egress_denied` and `network_denied`
  before. The target stays refused and nothing is contacted. A host outside the list keeps
  `egress_denied`, decided before any lookup. The log line of a failed job attempt now carries
  the fixed reason code of its error beside the class and the code.

- **Models:** a caller that stops reading a streamed answer without stopping the call now ends
  the request to the provider, for every adapter. Before, the provider kept generating, and
  billing, after the call was settled.

- **Chat:** a list or menu opened right after a conversation stays open. The composer tried
  for the focus once more 50 milliseconds after a conversation was opened, and took it out of
  an agent list opened in that time, which closed the list. The composer now stops trying once
  a pointer or a key is pressed.

- **Chat:** an answer that has just finished gets its work history, its actions and the next
  turn without a reload. An instance that runs its agents in the API process announced the end
  of a run before its stores had recorded it, so a page that read the conversation back at that
  moment was told the run was still going and kept showing the answer as unfinished. The end
  of a run is now announced once it is recorded.
- **Audit:** the audit event for the end of a run (`message.completed`, `message.failed`,
  `message.cancelled`) is written before the run's event stream announces that end. It was
  written beside the stream, so a reader of the audit right after the end could miss it.
- **Conversation rail:** the retention clock of a conversation with a long title can be reached
  with the pointer. The clock stood at the end of the row under the row's menu button, unseen
  until the row is hovered, and moved aside when the button appeared. A row with a clock now
  keeps the room for its menu button, so the clock stays where it is. `NavItem` takes
  `trailingKeepsRoom` for this.
- **Chat:** a conversation opened while another one is answering shows only its own messages.
  Until its thread arrives it is empty, where it used to show the messages and the partial
  answer of the conversation left behind, and the page no longer asks for that conversation's
  run under the address of the one opened.
- **Chat:** an instance configuration that does not load no longer leaves "Loading
  configuration" standing. A request without an answer or with a 5xx is tried three more times;
  after that, or at once for an answer of a shape the interface cannot read, a panel offers "Try
  again" and "Reload". An answer from another release reads as the outdated-tab notice does, and
  the console names the paths of the fields that did not fit, never their values. The client
  reports an answer that does not match its operation's schema as `ApiResponseShapeError`, an
  `ApiError` with those paths, and calls `onResponseMismatch`; the interface then shows the
  reload notice, also for an enum value or a stream event of a later release.
- **Models:** a long conversation no longer fails on every message after the provider compacted
  its context into an item above the provider's limit of 20,971,520 characters per string. Such
  an item, and an encrypted reasoning item of that size, is not kept. A stored one, or one the provider refuses with 400
  `string_above_max_length` on `encrypted_content`, is dropped and the request is sent once more
  from the conversation's history, so affected conversations answer again without a migration.
  A provider's 400 `context_length_exceeded` fails the run with "This conversation is too long
  for the model. Start a new conversation." instead of an internal error.
- **Models:** an image whose data URL would exceed the same limit (about 15 MiB of image bytes) is
  left out of the request to an OpenAI-compatible provider, and the model reads a note in its
  place that an image was too large to include. Such an image used to fail the run with 400
  `string_above_max_length` on every message of the conversation.
- **Models:** images a tool loaded for the model, such as rendered document pages, are sent only
  during the run that loaded them. In later runs the tool result names what each image showed
  (file, page, slide, sheet or range) and the model repeats the tool call to see it again. Every
  request used to carry every such image of the conversation again, which made requests of tens
  of megabytes and provider compaction items above the provider's string limit. Images a user
  attached to a message are still sent in later runs. One request carries at most 32 MiB of image
  bytes (`MODEL_INPUT_IMAGES_MAX_BYTES`); above that the oldest images are named instead of sent.
- **Models:** the image of a page, slide or sheet that the model reads is a rendition of its
  own: JPEG at quality 80 with a long edge of at most 1568 pixels
  (`MODEL_PAGE_IMAGE_MAX_LONG_EDGE_PIXELS`), 0.06 to 0.45 MB a page. The preview worker renders
  it beside each preview page and `workspace.preview_images` gives it to the model; the PNG a
  person sees in a preview is unchanged. The model used to be given that PNG, which the
  renderer scales to 4096 pixels: 0.9 MB for a text page and 17 MB for a colour scan. A preview
  rendered before this release has no such rendition, and the model is given its PNG, counted
  at its real size against the image budget. The artifact preview worker must run this release
  for new previews to carry the rendition.
- **Models:** a run waits out a provider's per-minute rate limit. On HTTP 429, or the same
  refusal inside a stream, a model call waits about 4 s, 8 s, 16 s and 32 s, up to 60 s in
  total, and never sooner than the provider's `Retry-After`; a `Retry-After` beyond what is
  left of the 60 s fails the run at once. As before, this applies only while nothing of the
  answer was shown, and no wait starts past the run's deadline or continues after a cancel. A
  run that still fails on a rate limit reads "The model is receiving too many requests. Try
  again in a minute." with code `RATE_LIMITED` instead of an internal error.
- **Retention:** conversation expiry decides under the conversation's row lock and removes
  data only afterwards. A conversation is expired only if it is still due, or still an
  abandoned draft, at that moment, so a message, an upload or a restored draft attachment that
  arrives while the job runs keeps the conversation and its files. A due conversation with an
  agent run in progress is left for the next run of the job. Deleting a conversation follows
  the same order. When removing stored objects fails, the conversation stays expired or
  deleted, the failure is audited as `conversation.cleanup_failed`, and the retention job
  retries the cleanup on each run and audits `conversation.cleanup_completed` when it is done.
  `conversation.retention_expired` and `conversation.deleted` carry `cleanup: "complete"` or
  `"pending"`. The first retention run after the update also cleans what earlier deleted or
  expired conversations left behind when their cleanup had failed.
- **Workspaces, accounts:** deleting a Shared Workspace, an account or a user answers 409 with
  `details.pendingCleanupCount` while data of its deleted conversations is still being
  removed, and removes nothing further. The conversations are deleted at that point. The
  request completes when it is repeated after the retention job has finished the cleanup. A
  refused account deletion leaves the user with every membership and access request. The
  refusal is audited as `collaboration_workspace.delete_failed` or `user.delete_failed`. The
  retention job now retries pending cleanups before it expires conversations. When only
  execution workspace data of a deleted conversation is left, the workspace cleanup job
  finishes it, not the retention job. No time is promised for the repeat: it succeeds once
  the jobs have run and found nothing left. Both deletions take the workspace row lock first,
  so a conversation that is created in the workspace or moved into it at the same moment
  fails instead of being removed with it.
- **Conversations:** an artifact, a workspace file or a message is written only into an active
  conversation and under the conversation's row lock. A write that arrives after the
  conversation was deleted or expired is refused with `NOT_FOUND`; the writer removes the
  bytes it had already stored, best effort, and logs a failed removal with the object key. An
  agent run or a workspace command that is still working when its conversation is deleted
  fails at its next such write.
- **Attachments:** in an instance without a capability attachment handler, deleting a
  conversation now removes every object its records name, preview images under
  `artifact-previews/` included. Before, those images stayed in storage while their records
  were marked deleted. Images left behind by earlier versions are not removed by this
  release.
- **Audit:** `conversation.cleanup_failed` and `conversation.cleanup_completed` appear in the
  governance tier, and the four new event types have labels in the activity view.
- **Migrations:** two migration steps that start at once no longer deadlock on a migration
  that builds an index concurrently. The step asks for its lock again every 100 ms instead of
  waiting inside one statement.
- **Migrations:** a migration step whose database connection the server ended names the
  migration and the cause (`Migration <name> failed: the database connection ended (…)`) and
  exits, instead of dying with a `TypeError` of the driver or not ending at all. A step that
  waits for another step's lock says so when it starts to wait and every 30 seconds after.
- **Inbox:** the open item asks for its state every 60 seconds and whenever a list shows it
  changed, so it no longer offers a decision on a request someone else has decided. A decision
  that still comes too late is answered in one sentence that names who decided, and a comment
  already written stays on the page.
- **`load-deploy-env.sh` finds the workspace's `.env.deploy` from any directory:** without an
  argument it read `../../.env.deploy` relative to the current directory, so sourcing it from a
  deployment repo or from a Terraform root failed with "Missing deploy env file". It now reads
  `.env.deploy` at the workspace root, found from the kit's own location. An argument still
  names another file.
- **CLI:** `catalyst <kind> validate --from <folder>` reads what `put` reads. For a kind whose
  revisions hold files, such as an App, it checks the folder against the limits of one write and
  says that the instance checks the files as it writes them.
- **CLI:** the commands of one asset, such as `catalyst skill put`, address the workspace a
  working copy is bound to, as its `config` commands do; `--workspace` still names another.
- **A Data Store or Knowledge Base query past `temp_file_limit`:** a statement that sorted or
  generated more than the store role's 1 GiB of temporary files (SQLSTATE 53400) was told as
  the database being unreachable and answered 500 with no sentence. It is now refused as the
  caller's statement with status 422, the SQLSTATE and the advice to narrow or aggregate it, and
  is not retried. Too many connections stays unavailable.
- **Agent configuration (SA-0):** stored agents naming unavailable tools, skills or models no longer stop instance startup. Missing tools and skills are omitted at runtime, including native `web_search` when web access, model support or customer pricing is unavailable (`unknown_tool`); an agent with an unavailable primary model is excluded from chat rather than silently switching models. Startup warns once per affected agent, and agent reads report unavailable references and their reasons without changing the stored definition. Skill-change approval and revert read the stored agent, preserving unavailable references; a missing primary model does not supersede pending requests. New and changed agent definitions, including those written by skill changes, remain strictly validated, so an invalid agent update is refused without changing storage.
- **Agent page (SA-0):** a "Not available" line names each tool, skill and model the agent names that the instance lacks, with the reason in plain words, and an agent whose model is missing says it cannot chat until its model is changed. A tool the instance does not have shows as unavailable and removable in the Tools section, as a tool of a module that is off already did. The page reads the agent's `unavailableTools` in place of the deprecated `moduleOffTools`.

- **Agent reference checks:** editing or reverting an agent may retain an existing skill reference that only the caller cannot read. New unreadable references and references missing from the instance remain refused.
- Show the Tools section of the agent page as the agreed rows again: one row per package, per own tool of the instance and per Connection, the switched-off ones too, each with its icon, name, sentence, how many of its tools are on and one switch for all of them, mixed while only some are on. The chevron folds out the tools, each with its check box. "This instance" and "Connections" head their rows, "Technical details" stays, and the heading counts the tools that are on, the sum of the rows. The library `Switch` has its mixed state back, and a switch that can be partly on is a tri-state check box to screen readers, so "partly on" is not read as "off"; the `trailing` and `popover` options of `Chip` are gone.
- Give the Connection draft tool `platform.connections.draft_tools` a title, a summary, the group `platform` and an icon, so the agent page no longer shows it by its id.
- **The agent can list what an App may call:** `platform.assets.operations` takes `for: app`
  and then lists the operations of Connections exposed to Apps (`bridge`), named
  `connection.<connection>.<operation>`, as far as the person may use them. Without `for` it
  lists, as before, what a step of a Workflow may call. An operation exposed to Apps alone was
  listed nowhere, so an agent writing a `connection` action had to guess its name. The list is
  of the instance and no longer needs the conversation to be about an asset, so it answers
  while the agent builds a Page.
- **Data stores page:** the description and the empty list say that a data store is created
  through the CLI or the API by a person with the right to create one. They said an agent
  creates one, which no agent tool does.
- **A Page that reads a Data Store offers no retry:** the refusal `data_store_needs_app` is
  final in the frame (`retryable: false`), as a Page reaches a Data Store only once it is an
  App.
- **The test of every kind of table and every page size of a Data Store's page no longer runs
  into its timeout:** it read 666 pages one after the other, about 13 seconds on an idle
  machine and over 30 on a busy CI runner. It now reads about 350 pages, the six tables side by
  side, in about 3 seconds. Every table is still read whole at every page size, and a page of
  every size still starts in one part of a table and goes on in the next. A cursor that answers
  a row again now fails the test at once instead of at the timeout.
- **The demo's seeded Customers App and accounting Workflows read the Connection's rows:** the
  App `customer-list` and the Workflows `accounting-clients` and `kai-client-years` read the rows
  of an MCP Connection under `structuredContent`, where the Connection answers them. Before, the
  App showed "The customers could not be loaded." and both Workflows failed their loop as
  `reference_unresolved`. Revision 1 of each is changed in place, so a local demo database seeded
  before this fix needs a fresh seed.
- **Local development:** Build the demo migration image from current code before starting the stack,
  so startup applies the migrations expected by the API. `dev:restart` follows the same path.
- Upgrade the static documentation site to Astro 7.2 with matching Starlight and Markdown packages and require Sharp 0.35.5, removing vulnerable documentation build dependencies while preserving the `/catalyst` base path and generated API reference.
- Isolate browser Connection editor and page-frame fixtures from instance-wide Connection list and principal rights checks, verify cleanup succeeds, and diagnose abandoned holders without capping healthy lock queues. Keep page-frame lock waits outside test timeouts, after the App build. Serialize the sidebar rights writer and revoke its grant during cleanup.
- **Guardrails on UTF-16 without a mark and on the App draft of a `page.save`:** a file is now
  read as UTF-16 without a byte order mark where at least 90% of the bytes at one parity of its
  first KiB are NUL and at most 10% at the other. Before, it took a NUL in every other byte, so
  one letter outside Latin-1, as in "Łukasz", left the file printable runs and an IBAN in it
  passed. A guardrail that warns about the App draft a `page.save` writes is now passed on to
  the agent (`app.warnings` of the answer). One that asks for an approval there blocks the draft,
  as no request is filed and nobody could approve it; the answer says that the person's Update
  app on the Page can wait for the approval. Its hit is kept as a `block` that says it answered
  a request for an approval (`convertedFrom: require_approval` of `guardrails.list_hits`), and
  the guardrail's page shows it as "Blocked: approval could not wait".
- Publish self-approval requires an instance-level approve right and a click in the app.
  Workspace approvers and CLI publishers wait in the Inbox; the CLI names the request and
  tells instance approvers where to approve it. Keys never carry approve rights.
- Workflow publish reviews include `workflow.yaml`, comparing its manifest with the live
  revision alongside the step files.
- Regression tests cover workspace self-approval, CLI-origin self-approval, an admin's real
  personal key with an interactive answer and forged origin headers, and MCP publish refusal.
- **Guardrails list:** the guardrail the platform ships ("Publishing needs an instance admin's approval") is the first row of the Guardrails list, under the search and the scope, marked as shipped with the platform, with its switch and its state line. The list no longer says "Nothing in Instance yet" while that guardrail is in it, and the search and the scope narrow it as they narrow every row.
- Remove the unused `BuildListLead` barrel export so the guardrails list passes the lint baseline check.
- The composer's model picker opens its menu and its Model and Reasoning panels above the page, through the UI library's popover. In the chat beside a Workflow canvas the model panel was cut off at the chat's edge; it now shows whole, flips below the composer where there is no room above, and shifts to stay in the window. The picker follows a window resized across the breakpoint, keeps a panel no taller than the window with its Back row in reach, leaves the open panel in place while the pointer crosses the other row into it, and works from the keyboard: the arrow key towards a panel or Enter enters it, the other arrow key or Escape goes back one level. `PopoverContent` takes `surface="none"` for content that draws its own surfaces, and `reserve` for room kept free beside it, and `onEscapeKeyDown`.
- Keep workflow header actions inside narrow screens, including German start buttons at 390 px.
- Reserve readable space for user names in narrow lists and expose the full name when truncated.
- Show disabled workflow accounts by display label with English and German reasons.
- **Banners line up their icon, title and actions:** a Banner's actions are centred on the whole
  message and no longer reach into its padding, where they sat at the top edge above the title.
  The icon stays on the title's first line, a one-line message sits on the middle of its action,
  and the dismiss stays at the top end when the actions take a line of their own on a narrow
  screen, instead of wrapping under them. This shows on the Workflow draft bar and on the notice
  that the application was updated. The UI library shows a Banner with a title and an action
  alone.
- **The notice that the application was updated is opaque:** it floats over the page on the
  raised surface under its warning tint, so the page under it no longer shows through.
- **Skills:** Keep existing instance skills when an upgrade ships skills with the same names, and warn the operator instead of refusing API startup. Instance content, revisions and agent references remain intact. A later config push can remove instance-owned copies so the next start seeds the shipped skills; upgrades do not require that push beforehand. Workspace-owned names remain with their workspace even after deletion and are skipped with the same warning, keeping API startup available.
- Remove the former product name from the public README template before mirroring releases.
- **Publishing the public CLI:** the publish workflow runs on a GitHub-hosted runner again. npm
  refuses a provenance statement signed on a self-hosted runner such as Blacksmith.
- **Published packages:** Pin the tested assistant-ui AI SDK adapter, streamdown integration and zod versions, and constrain assistant-ui React and AI SDK dependencies to the tested minors so fresh deployment installs avoid incompatible dependency drift.
- **Release gate and the host's memory:** the release gate's resolve-only run of the workspace
  command worker compared the memory its sandboxes need with the memory of the machine the
  gate runs on, so a CI runner smaller than the host stopped every deploy with
  `sandbox_memory_exceeds_host`. A resolve-only run no longer makes that check and prints
  `host memory not checked: checked at startup on the host`; the worker still refuses to start
  on a host that cannot hold its sandboxes. **Upgrade:** nothing to do. **Rollback:** the
  previous release's gate refuses such a config again on a smaller CI machine.
- Refuse `assets.run_live_once` for API keys and their access tokens, including personal keys, with an error directing callers to a person signed in to the app.
- **CI:** Retry image checks only after transient registry failures, and distinguish the tagged, expected WebRTC failure from unexpected browser failures and passes in hosted logs.
- **Tests:** Make audit assertions independent of tied timestamps, exercise the rights regressions with Date frozen, and give operation-run helper sorts an explicit ID tie-breaker.
- **Tests:** Observe the composer’s running and finished animation alongside its start/end positions, isolate surface journeys by user, and settle the desktop rail before edge hit testing.
- **Tests:** Stop workspace workers before removing their directories, observe queued commands and held workflow steps, and await the refused message’s own audit event. Exercise the command give-up boundary with only Date frozen.

The workflow outcome-wait probe holds the second operation note, proving the worker has waited before checking the running state. It fails explicitly if the worker finishes without waiting.
- Upgrade SheetJS readers to the upstream 0.20.3 tarball, raise the published CLI and asset-schema js-yaml minimum to 4.3.2, and patch multipart parsing, Seroval, Fastify routing/URI parsing and Better Auth dependencies.
- Use the legacy spreadsheet reader for ODS files that the primary XLSX reader accepts without finding any worksheets.
- Keep app-content tokens out of request logs through Fastify’s supported log controller, and return a 400 product error for malformed multipart uploads.
- Pin and verify the SheetJS tarball integrity in the release gate so lock regeneration cannot silently remove its checksum.
- **A session token names only a service principal as its delegated actor:** the issuer refuses
  any other kind (`A session token names only a service principal as its delegated actor`), and
  verification refuses a signed token that names one (`UNAUTHENTICATED`, `Chat session token names a delegated
actor other than a service principal`). Before, a token signed with the session secret that
  named an API key authenticated, skipped resolving its user and was recorded as the CLI. The
  `session_tokens.issue` route accepted only `service_principal` already, so no caller of the API
  changes.
- Show a scrollbar's thumb only while the pointer is over its scroll area or the area holds the keyboard focus, like an overlay scrollbar; the bar keeps its width, so nothing moves. A screen without hover shows it as before.
- A sidebar item that lies wholly in a faded edge of the list takes no pointer, so a conversation row next to unseen under the bottom fade no longer lights up and opens its menu's tooltip beside the row above it. A row with any part in sight keeps its hover and click.
- Make the access-operation audit assertion independent of row order when audit timestamps tie, preventing intermittent staging release-check failures while still checking the exact events, statuses and actors.
- **A new API key starts with no scope ticked:** You > API keys and a CLI's connect code no
  longer tick every right the person holds. A click on the scope a person wanted used to take it
  away, so the key came out with every other scope. The key gets exactly the boxes ticked.
- **`catalyst <kind> put` and `validate` take what `show --json` printed:** the definition is
  read from its `config`. The whole answer was sent as the definition before, so an unchanged
  agent read as a changed model and an admin was refused with "Missing the right
  'agent_models.manage'". The right is still asked where the model settings change, leaving a
  model binding out included.
- **Docs and agent orientation on Connections:** the docs name the interface's navigation,
  Studio > Connections and Studio > Guardrails (German: Studio › Verbindungen), and Studio's page
  walks through connecting a remote MCP server with the rights each step needs. They and the
  orientation every agent reads say that MCP is the only connector type, with no HTTP
  connector, and that a Connection's key is entered on its page, never in a chat.
- **A user's detail no longer lays its cards over each other:** Settings > Instance > Users puts
  Password, Delete account and Account beside Profile and Rights only where the detail itself has
  the room for both columns, not where the window is 1280 wide. At 1280 the right column covered
  the Profile and Rights cards and hid their switches; at 390 every card ran past the right edge.
  The profile and identity fields wrap by the width of their card in the same way.
- **The test that a loop runs three items at once no longer fails now and then on a busy
  runner:** it counted the calls that were with the Connection in the same 40 ms, so three items
  that reached their call further apart than that were counted as two. The first calls now wait
  for each other, for 1.5 s at most, before the 40 ms begin. A loop that runs fewer items at once
  still fails the count, and one that runs a fourth is still counted.
- **A Workflow step calls no asset operation:** an `operation` step that names `assets.*`
  (`assets.list`, `assets.get`, `assets.put`, `assets.publish`, `assets.sync` and the rest) is
  refused when the Workflow is saved or published, with the reason `operation_not_callable` and
  the step's path. A run acts as its service principal, and a principal that holds
  `config_assets.read` or `config_assets.release` could read every agent's and skill's
  definition through a step or reach `assets.sync`. A definition stored before this release is
  listed as not runnable with the same reason, and a run that reaches such a step fails it
  before anything is called. The demo's seeded Workflows, which read agents and skills, now
  read the Connection `sample-accounting`: `accounting-clients` (was `agent-inventory`) and
  Kai Berger's draft `kai-client-years` (was `kai-skill-inventory`). Their principal
  `workflow-demo` holds no permission and one grant, `connection.use` on that Connection.

### Database

- **Legacy permission keys become grant rows (AP-4):** migration
  `0079_legacy_permission_grants` writes the rows; a user whose deletion was requested gets
  none, an entry that is no key gives none, and a row the holder already had keeps who wrote it
  (a `!key` still makes it a deny). It gives `["*"]` to every API key without scopes, keeps an
  empty list empty (it still gives nothing) and takes `*` out of a list that held it (it gave
  nothing before and would give everything now). Every statement can run again. It creates the
  table `legacy_permission_restores`. **Operators:** after the migration and before anyone
  changes a right, run `node --experimental-strip-types scripts/verify-permissions.ts` with
  `DATABASE_URL` set: it compares every holder's rights from the rows with what the columns
  answered and exits `1` on a difference. Do not change rights while a release before this one
  still runs beside it: that release writes the column only, and the change is not seen.
  **Rollback:** the columns are kept for one release. Stop this release, run the script with
  `--restore-legacy-columns`, then start the earlier release. It writes each holder's rows back
  into its column and removes them (the earlier release reads every row as well), turns `["*"]`
  back to null and marks the restore with a row in `legacy_permission_restores`; it leaves the
  migration record alone. To upgrade again, run the migration step as always: after the
  migrations it moves the lists the earlier release kept into rows again and clears the mark, in
  one transaction, whatever migrations are recorded. Until then this release refuses to start.
  A later release drops the columns.
- **Workflows:** Workflow steps can start a published child Workflow, wait without a step slot, and return its output. Child runs retain lineage and the root starter, inherit test mode, stop with their parent, and nest at most three levels. Save and publish check child contracts, parent triggers, use rights, and cycles. Migrations 0087–0088 add workflow run lineage and the unique parent step key. Datasets and child run keys remain unsupported.
- **Refusals:** A fourth level fails with `depth_limit`: "A child run cannot start below three levels". Publishing a cycle fails with `workflow_cycle`: "Publishing this Workflow would make it reach itself". Missing child use rights fail with `child_use_forbidden`: "The parent's principal does not hold workflow.use on the child". Dataset inputs fail with `not_supported_yet`: "Child datasets are not supported yet".
- **Rollback:** The migrations are additive; keep the new columns and indexes when rolling application code back. Drain child runs and unpublish Workflows using child steps or parent triggers before rollback because the previous engine cannot execute those definitions.

- **Deploy order:** after EW-2a (0085–0086), run `0087_workflow_child_runs` and
  `0088_workflow_child_run_indexes` before starting this release. Without them startup refuses
  with `The database is behind this release. Run the migration step before starting. Missing migrations: 0087_workflow_child_runs, 0088_workflow_child_run_indexes`.
  Generated Drizzle snapshots stay in the source checkout; runtime packages ship migration SQL
  and the journal within the existing package size budget.
- **An agent's call waits for its person's confirmation (EW-2a):** a call whose policy is
  `confirm`, made by an Agent Run's worker, pauses the run instead of being refused. Its
  Operation Run becomes `pending_confirmation` (24 hours), the run becomes
  `waiting_for_decision` and holds no lease and no worker. `operations.decide`
  (`POST /api/v1/operations/runs/:runId/decision`, `{ "decision": "confirm" | "decline",
"reason"?: string }`) records the run owner's decision; the run goes on in a worker in the
  same reply, with the call executed once, or answered to the agent as declined with the
  reason. The same decision again answers the same run; another one is a `409 CONFLICT`. The
  run status `waiting_for_permission` is now `waiting_for_decision`, the event
  `tool_permission_requested` is now `tool_decision_requested` (with `tool_decision_recorded`
  beside it), and the run command `tool_permission_decision` is removed: `continue` is the only
  run command.
- **Migrations:** `0085_agent_run_resume_state` adds the nullable column
  `agent_runs.resume_state` (jsonb), what a waiting run goes on from; it is cleared when the run
  ends. `0086_agent_run_waiting_for_decision_index` recreates the unique index
  `agent_runs_active_conversation_idx` with `waiting_for_decision` in place of
  `waiting_for_permission`, concurrently. No row has ever held `waiting_for_permission`: the
  worker failed such a run instead. **Deploy order:** run the migration step before the new
  release starts, as always. Without it the release refuses to start with: `The database is
behind this release. Run the migration step before starting. Missing migrations:
0085_agent_run_resume_state, 0086_agent_run_waiting_for_decision_index`. **Rollback:** the
  previous release ignores the column, but it knows no `waiting_for_decision` run: such a run
  keeps its conversation from starting another run, and its upkeep never ends it. Before
  starting the previous release, end the waiting runs:
  `UPDATE agent_runs SET status = 'failed', resume_state = NULL, failed_at = now(),
updated_at = now(), error = '{"code":"AGENT_RUN_ROLLED_BACK","message":"The release that
paused this run was rolled back","category":"internal_error"}'::jsonb WHERE status =
'waiting_for_decision'`. The index can stay as it is.

- **Packaging:** postgres-store keeps Drizzle schema snapshots in the source checkout and ships
  only the migration SQL and journal. Runtime migration history and startup checks are unchanged.
- **Workflows:** Migration `0081_test_run_targets` adds `workflow_step_runs.target` and
  `workflow_step_runs.published_would_ask`, both nullable and checked. It gives
  `live_once_switches` the owner in its key (`asset_id`, `part`, `switched_by_id`), and adds the
  table `live_once_runs`, which records the step of a test run a switch made live and is removed with the run. Rollback: a
  release without 0081 ignores the new columns and the new table. Released versions up to v0.6.4
  have no "Run live once" at all. A build between 0073 and 0081 sets a switch with a conflict on
  (`asset_id`, `part`), which no longer has a unique key, so its "Run live once" fails. Before
  going back to such a build, delete the rows of `live_once_switches` and restore the old key:
  `ALTER TABLE live_once_switches DROP CONSTRAINT live_once_switches_owner_pk, ADD CONSTRAINT
  live_once_switches_pk PRIMARY KEY (asset_id, part)`.
- **Shipped guardrail switches (GR-PUB-1):** migration `0083_shipped_guardrail_switches`
  creates the table `shipped_guardrail_switches`, one row per shipped guardrail an instance
  admin switched, with who switched it and when. A shipped guardrail without a row is on, so
  "Publishing needs an instance admin's approval" is on on every existing instance from this
  release; no row is written by the migration or by a release. **Deploy order:** run the
  migration before the new release starts, as always; the previous release ignores the table.
  **Rollback:** the previous release does not read the table and runs no shipped guardrail, so
  every publish goes live on its publisher's click again; the table can stay.
- **Knowledge Bases:** Migration `0082_knowledge_base_states` adds the table of a Knowledge
  Base's last check. Rollback: the previous release ignores the new table and drops an agent's
  `knowledgeBases` when it reads the agent, so its agents answer without them.
- **`0080_guardrail_hits_converted_from`:** adds the nullable column `converted_from` to
  `guardrail_hits`, without a default and without a scan. A release before this one writes no
  value and reads none, so a rollback of the app keeps working on the migrated database.
- **Workspace inspections:** Mark historical workspace inspection images with `metadata.purpose = "inspection"` so conversation resources and file search hide them. Only files under `previews/` with preview-only source rows or exact artifact IDs proven by retained path-preview tool results are updated; ambiguous rows and promoted files remain unchanged. No files or bytes are deleted.

## 0.6.3 — 2026-10-08

### Fixed

- **Chat:** a file is read before its upload request opens, and an upload that fails without an
  answer from the API is retried. A browser that could not read a file promptly used to stall
  the request until the reverse proxy gave up. The remaining error names the file.
- **Models:** a provider `server_error` or `rate_limit_exceeded` inside a Responses stream is
  retried like the same failure on the request. A stream that stays silent for 10 minutes is
  given up as a timeout instead of holding the run until the provider answers.

## 0.6.2 — 2026-10-08

### Changed

- **Chat:** a long user message is collapsed to a few lines with "Show more" and "Show less".

## 0.6.1 — 2026-10-08

### Changed

- **Skill change proposals:** a proposal for a new skill can carry its supporting files in the
  same request: `create_skill` first, followed by `create_resource` operations such as
  `references/checklist.md`. The limit per operation text is 20,000 characters instead of 4,000.

## 0.6.0 — 2026-10-06

### Added

- **Deployment kit:** the release and deploy tooling of operated instances is the package
  `@vivd-catalyst/deployment-kit` with the command `catalyst-deploy` (`check`, `update-refs`,
  `prepare-workspace`, `publish`, `manifest`, `deploy`). It carries what each deployment repo
  kept as its own copy: the deploy by image digest, release manifests, staging and production
  publishing, Postgres backup and restore with their systemd units, the zram setup, and the
  checks of the worker wiring in Compose. A deployment names its instance in
  `deploy/deployment.env` (`INSTANCE`, `IMAGE_REPOSITORY`, `APP_PACKAGE`,
  `EXECUTION_WORKSPACES`); host paths, dump names and unit names follow from it. The package is
  not published yet and is used from the platform checkout at the pinned ref.

### Changed

- **Deployment kit:** the scripts under `scripts/deployment-kit/` moved into the package. The
  old paths remain as forwarding stubs, so deployments pinned to them keep working.
- **Release check:** `check-release.sh` no longer requires a `deploy/scripts` directory in the
  deployment.

## 0.5.1 — 2026-10-06

### Added

- **Retention:** the hourly retention job removes orphaned managed files. A `managed_files` row
  older than 24 hours that no active conversation refers to, through an attachment of any
  status or as the source of an artifact, is marked deleted and its stored object is removed.
  This reaches what user deletions before 2026-08-31 and interrupted uploads left behind. The
  job records one `storage.orphaned_files_deleted` audit event with counts per run that removed
  something. An attachment handler takes part by implementing the optional
  `deleteOrphanedFileObjects`; without it nothing is removed.

### Fixed

- **Admin pages:** a table taller than the window, such as the user list, scrolls again instead
  of being cut off.
- **show_view:** the layout guidance for views closes two padding loopholes.
- **Conversation rail:** the collapse handle on the rail's edge no longer covers the list's
  scrollbar. It appears while the pointer is on the rail's right border or the handle has
  keyboard focus.
- **Uploads into a deleted conversation:** a draft attachment whose conversation is deleted
  while the file is still arriving is rejected before any bytes are stored. The conversation
  was checked only when the request started, so a slow upload could leave a stored object and
  a `managed_files` row that no deletion would reach.

## 0.5.0 — 2026-10-06

### Added

- **Retention:** `retention.expireConversations: false` lets a client instance keep
  conversations indefinitely.

### Changed

- **Packaging:** the library packages carry publish metadata for npm (`files`, typed `exports`
  without the `development` condition, restricted access, licence, `engines`) and are no longer
  marked `private`. `pnpm release:check` builds, packs and inspects every tarball and installs a
  consumer set outside the workspace; `pnpm release:metadata` reapplies the shared fields.
  Nothing is published yet.
- **chat-ui:** `tailwindcss` and `tw-animate-css` are peer dependencies. The stylesheet no longer
  scans `chat-standalone`, which has its own stylesheet now, and finds Streamdown's classes when
  installed from a tarball as well as in the workspace.

### Fixed

- **Abandoned draft conversations:** attaching files on the start page and removing them again
  no longer leaves an empty conversation in the rail. `GET /api/conversations` lists a
  conversation without messages only to its creator, and only while it holds draft attachments;
  access by id is unchanged. Removing the last draft attachment returns the composer to the
  start page, and the retention job expires conversations that have had neither messages nor
  draft attachments for 24 hours. This cleanup also runs with
  `retention.expireConversations: false`, which keeps every conversation that has a message or
  a draft attachment.
- The `catalyst` CLI did nothing when started through the `node_modules/.bin` link of an
  installed package.

## 0.4.0 — 2026-10-06

### Changed

- **Agent model settings:** an agent may offer its users any model binding agents may use. The
  binding-level `userSelectable` key in release config is still accepted but no longer has an
  effect; `agent_models.manage` governs the choice. The agent editor shows one model list with
  a default and a "Selectable by users" tick per model.
- **Reasoning effort per model:** `modelReasoningEfforts` sets the effort for each model an
  agent offers to users, edited per row in the model list. `reasoningEffort` stays the effort
  of the agent's own model and is no longer applied to a model a user picked instead, which
  now runs with its own entry or the binding's default.
- **API:** the safe config view no longer carries the top-level `selectableModels`; use
  `agents[].selectableModels`. The config assets overview no longer carries
  `references.userSelectableModelBindings`.

## 0.3.0 — 2026-10-06

### Changed

- **Agent model settings:** each agent lists the models chat users may pick in
  `userSelectableModelBindingIds`, editable with `agent_models.manage`. The composer offers the
  agent's own model plus that list instead of every `userSelectable` binding, so a deployment
  that offered a model choice must add the list to its agents to keep it. The safe config view
  carries `agents[].selectableModels`.

### Fixed

- Saving an agent's model settings no longer fails with 403 when its other fields are locked:
  unchanged fields were reported as changed because stored JSON key order differs.
- A rejected save shows the server's message next to the save button.
- Viewers of a shared conversation can no longer interrupt another user's active run.

## 0.2.0 — 2026-10-06

First versioned release. Compared with production, which runs `staging-2026.09.14-1` (platform
`a2a13a8`, deployed 2026-09-14):

### Added

- **Email:** transactional mail with password reset and user invitations.
- **Approvals:** agents propose skill changes; reviewers approve, reject or request changes on an
  approvals page with an open queue and a collapsed history. Decisions appear in the conversation.
  Release-configured checks fail closed. A reviewer revises someone else's proposal in their own
  conversation.
- **Conversation visibility:** private conversations in Shared Workspaces, with a default per
  workspace.
- **Agent availability:** agents can be limited to selected Collaboration Workspaces.
- **Start page:** centred composer with starter prompts and agent cards.
- **Agent model settings:** model, reasoning effort and fast mode per agent behind the
  `agent_models.manage` permission; fast runs are settled by the tier the provider reports.
- **Operations:** the agent-run worker drains active runs on shutdown; the config CLI detects
  conflicts per asset and lists agents left hidden after a push.

### Fixed

- Workspace conversations stay in the rail on settings, approvals and admin pages.
- User messages with wide code blocks stay inside the thread; code and quotes are readable in
  user message bubbles.
- Forwarding headers are trusted from private proxy peers.
- Emailed password setup completes in one transaction and rejects invalid tokens early.

### Database

Migrations 0025 to 0029. 0027 backfills existing conversations as visible to the workspace; 0028
backfills existing agents as available everywhere.
