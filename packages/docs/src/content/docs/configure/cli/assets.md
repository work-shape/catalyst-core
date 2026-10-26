---
title: Assets
description: Read, write, publish and follow assets with the CLI.
---

## Follow a held call

A publish that waits for approval exits 3 and prints its Operation Run id. Follow it with:

```sh
catalyst operation show <run-id>
catalyst requests
catalyst requests --withdraw <request-id>
```

`operation show` prints the status, decision and any failure; add `--json` for the full record. It exits 3 while awaiting a decision, 1 for a failed, denied or expired run, and 0 otherwise. `requests` lists your requests in every state, including the decision; `--json` prints the list as JSON. Withdrawal needs a personal key with an asset write or delete scope (`config_assets:write`). Reading your own runs, listing and counting your own requests uses the `me:read` scope every personal key carries. Another person's run is not found, and their requests cannot be listed or withdrawn through your key.

## One command per asset operation

Every operation on assets has a command, for every kind the instance registers: agents, skills, Apps, Workflows, Connections, Data Stores, guardrails. The kind is the first word, by its id, its plural or with dashes (`data-store`). The instance names its kinds; a kind a later release adds works without a new CLI.

```sh
catalyst context                  # the instance, your rights in it and its workspaces, its kinds
catalyst kinds                    # each kind: lifecycle, folder or definition, rights
catalyst references               # models, efforts and tools a definition may name
catalyst agent list --prefix tax-
catalyst agent show tax-vat
catalyst agent history tax-vat
catalyst skill validate --from skills/tax-guide
catalyst skill put tax-guide --from skills/tax-guide --if-revision new
catalyst agent put tax-vat --from agents/tax-vat.agent.yaml --if-revision 3
catalyst app put offers --from offers --if-revision 4 --workspace <workspace-id>
catalyst app publish offers --revision 5 --workspace <workspace-id>
catalyst agent revert tax-vat --to 2 --if-revision 4
catalyst agent delete tax-vat --if-revision 5
catalyst agent publish tax-vat --revision 6
catalyst agent discard tax-vat --revision 6
catalyst agent give-tools tax-vat --tool connection.crm.list_clients --tool connection.crm.get_client
```

A `put` or `revert` of an agent that exists writes its draft and prints the draft revision. `--if-revision` names the live revision. Where the agent has a draft, `--if-draft-revision <n>` names the draft revision you read, the one `show` prints; without it the write expects no draft, and one that finds a draft is refused with its revision and author and changes nothing. `catalyst agent publish <name> --revision <n>` makes that draft revision live, and `catalyst agent discard <name> --revision <n>` drops it and leaves the live agent as it is. `list` shows each agent's pending draft in a column of its own, and `show` names it with its author. An instance's own agent is published without a question, a workspace's agent (`--workspace <id>`) asks as an App does and then waits in the Inbox for a holder of `agent.approve`; its first publish offers it in its own workspace. `catalyst agent give-tools <name> --tool <tool-name>...` gives an instance's own agent tools at once, as a new live revision of what is live plus the tools; a pending draft keeps its content and its author and gets the same tools. It needs the rights to change and to publish the agent, and `--if-revision <n>` refuses it where the live agent moved past the revision you read. A key that may not publish, such as a service principal's, is refused with the reason and what to do instead.

`catalyst app publish` and `catalyst workflow publish` ask before they publish. With `--yes` they ask nothing and publish nothing yet: the publish waits in your own Inbox as a confirmation, the command ends with exit code `3` and the request id, and your **Allow** there counts as your click on Publish. A run without a terminal and without `--yes` publishes nothing and exits with 1. When approval is required, the command ends with exit code `3` and the request id, including for an admin's key. An instance approver can approve it in the Inbox ([Guardrails](/manage/guardrails/#publishing-needs-an-instance-admins-approval)). A CLI answer never supplies that approval.

`--from` takes the forms of the working copy: an `.agent.yaml` or any YAML or JSON definition, a skill's folder with its `SKILL.md`, or the folder of a kind whose revisions hold files, such as an App. A write names the revision it was made against with `--if-revision`, or `new` to create; read it with `show` or `history`. `discard-draft`, `set-availability` and `set-default` complete the list; `catalyst --help` shows each with its options. `--json` prints the instance's answer as it came.

`catalyst workflow adopt --all` (or `adopt <name>`) gives every revision of the Workflows written before their writes were commits one commit each, oldest first, with the author and time of the revision, so running it again changes nothing. It needs the release key (`config_assets:release` on a principal that holds the release right) and reaches every workspace, Personal Workspaces among them, so it prints asset ids and counts, never a name. It prints its progress as it goes; a stop loses nothing, and the same command goes on where it stopped. An asset it cannot adopt is listed as refused, and the instance's log names the revision and why. It exits 1 where any was refused. It is an operator's step after the deploy of the release that brought it, never a step of startup.

Guardrails have four commands of their own beside `put`:

```sh
catalyst guardrail test no-iban --text "DE89 3704 0044 0532 0130 00"   # or --from <file>, --asset skill:<name>
catalyst guardrail dry-run no-iban                 # what the draft would have done in the last 14 days
catalyst guardrail publish no-iban --revision 2    # shows the dry run first
catalyst guardrail unpublish no-iban               # stops it; the draft stays
```

`test` checks the draft, or `--revision <n>`, and keeps no hit. A first `publish` of a guardrail that would have blocked or held actions asks for `--confirm <n>` with the number the dry run counted. [Guardrails as assets](/configure/config-assets/#guardrails-as-assets) says who may do what.

The instance decides every right, revision and check. A `revert` needs the read right on the asset beside the write right, as it restores content. A refusal is printed as the instance gave it, with each asset, issue or item it names:

```text
Refused by the instance (HTTP 403 FORBIDDEN): Missing the right 'agent.write'
```

The exit code is 0 when the call was applied, 1 when it was refused or failed, 2 when the command line was wrong and nothing was sent, and 3 when the call waits for another person's approval and has changed nothing yet.

## Apps as a folder

An App is a folder of files with `app.yaml` at its root. Four commands work on that folder. Each one uses the same asset operations as the commands above, so the instance decides every right and every build.

```sh
catalyst app pull offers --workspace <workspace-id>   # the draft into ./offers
catalyst app push offers                              # the folder becomes the next draft
catalyst app status offers offers                     # draft, published, local changes
catalyst app publish offers                           # shows what goes live, then asks
```

An App belongs to one workspace. The commands take it from `--workspace`, from the folder's last pull, or from the selected instance's `workspace: <id>` in `catalyst.yaml`.

- `pull <app> [dir]` writes the draft into `dir`, which defaults to a folder named after the App. `--published` writes the published revision instead, and `--revision <n>` writes any one revision. Every file is written byte for byte and checked against the hash the instance gave. The folder also gets `.catalyst-app.json`, which records the instance, the workspace, the revision and each file's hash. That file is never sent. A pull refuses to overwrite a file you changed, and it refuses a folder that holds files but no pulled App.
- `push [dir]` sends the folder as the App's next draft revision. The revision it names as its base is the one the folder was pulled at. A folder that was never pulled creates the App under the `id` its `app.yaml` names. A pulled folder keeps its App: a push whose `app.yaml` names another `id` is refused before anything is sent. The instance builds the files before it writes the revision. A build that fails writes nothing, prints every error as `file:line:column: message` and exits with 1:

  ```text
  Refused by the instance (HTTP 422 VALIDATION_FAILED): The files of app 'offers' do not build. Nothing was written.
  - src/routes/history.tsx:4:1: Expected ">" but found "}"
  ```

  A push refused because someone else saved the draft in between also writes nothing. Pull into another folder, carry your changes over and push from there. Merging such a push needs the App's repository, which is not built yet.

- A push leaves out dotfiles, dot-folders, `node_modules` and anything that is not a regular file such as a link, and it names what it left out. A dotfile the App already holds is sent like any other file, so pulling and then pushing changes nothing. The limits of the instance are checked before anything is sent, with the file named. In the default release a file holds at most 2 MiB, an App at most 500 files, and one push at most 8 MiB. Larger media belong in Managed Files.
- `publish <app>` prints what the draft makes live. That is the publish dialog's Connections and outside hosts, and beside them the changing actions the revision calls live (each marked new or changed) and the Data Store levels it needs, all compared against the published revision. It then asks before publishing. `--yes` asks nothing: the publish waits in your Inbox until you allow it there (exit 3), and a run without a terminal and without `--yes` publishes nothing (exit 1). A required approval still waits in the Inbox (exit 3). `--revision <n>` publishes an older revision instead, which is the way back.
- `status <app> [dir]` prints the draft revision and the published revision, with who made each and when. A revision exists only once its files have built, so the draft shown is built, together with its kit version. With a pulled folder it also lists the files you changed, added or removed since the pull.

## Workflows as a folder

A Workflow folder holds `workflow.yaml` at its root and its scripts in `steps/`. It uses the App folder commands and the same `.catalyst-app.json` baseline, recording the Workflow's name, instance, workspace, revision and file hashes. Pull into an empty or new folder; a refresh refuses local changes. A push from a stale revision is refused with the instance's reason.

```sh
catalyst workflow pull <workflow> [dir] [--published | --revision <n>] # write a revision locally
catalyst workflow push [dir]                                      # save a changed folder as one draft revision and commit
catalyst workflow status <workflow> [dir]                         # draft, published and local changes
catalyst workflow publish <workflow> --revision <n> [--yes]      # review and ask before publishing
catalyst workflow history <workflow>                              # list revisions
catalyst workflow revert <workflow> --to <n> --if-revision <n>      # restore a revision
```

An unchanged push creates no revision or commit. A new folder creates the Workflow under the `id` in `workflow.yaml`; a pulled folder keeps its id. Files that look like credentials are saved with a warning naming their path and line, never the matched text. Publishing, history and revert use the generic asset commands. `catalyst config pull|push` still carries agents, skills and guardrails, with no Workflow.

## Pull a skill for a local agent

When you want to use one of the instance's skills locally, pull its entire folder:

```sh
catalyst skill pull <name> .claude/skills/<name>
# For Codex:
catalyst skill pull <name> .agents/skills/<name>
```

The CLI writes every file byte for byte and checks its SHA-256. Pulling again refreshes a clean earlier pull; foreign folders, links and local changes are refused. A failed pull keeps the target unchanged. Scripts are written with mode 0644 and nothing is run or installed. Read scripts before running them: they may assume Catalyst's sandbox. `skill put --from` leaves out the local `.catalyst-skill.json` baseline.
