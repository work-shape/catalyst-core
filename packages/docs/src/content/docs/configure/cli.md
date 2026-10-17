---
title: The Catalyst CLI
description: Install the public catalyst command from one file and use it against an instance.
---

`catalyst` is the command line tool for an instance. It is the public package `@work-shape/catalyst-cli` under the MIT licence and needs Node 22 or later.

## Install

Install the release tarball you were handed:

```sh
npm install --global ./work-shape-catalyst-cli-<version>.tgz
catalyst --help
```

A team that keeps its tooling with its working copy installs the same file as a development dependency and runs `npx catalyst`.

The package installs from that one file. It depends on two third-party packages, `js-yaml` and `zod`, and on no private package: the asset schemas, the API contract and the API client it uses are built into it. No registry account and no token are needed to install it.

## What it does

The `config` commands synchronize agents and skills between a folder and an instance. [Config assets](/configure/config-assets/) describes the working copy, the commands and what a push does.

```sh
catalyst config pull
catalyst config diff
catalyst config validate
catalyst config push
```

## Follow a held call

A publish that waits for approval exits 3 and prints its Operation Run id. Follow it with:

```sh
catalyst operation show <run-id>
catalyst requests
catalyst requests --withdraw <request-id>
```

`operation show` prints the status, decision and any failure; add `--json` for the full record. It exits 3 while awaiting a decision, 1 for a failed, denied or expired run, and 0 otherwise. `requests` lists your requests in every state, including the decision; `--json` prints the list as JSON. Withdrawal needs a personal key with an asset write or delete scope (`config_assets:write`). Reading your own runs, listing and counting your own requests uses the `me:read` scope every personal key carries. Another person's run is not found, and their requests cannot be listed or withdrawn through your key.

## Log in

On an instance with the module `personalApiKeys` on, a person logs the tool in with a key of their own:

```sh
catalyst login --instance https://chat.example.com
```

The tool prints an address and a code such as `BCDF-GHJK`. Open the address, signed in as yourself; it leads to **Settings > You > API keys** (German: **Einstellungen › Du › API-Schlüssel**). Check that the code is the one your terminal shows, choose what the key may do and until when, and confirm. The tool then collects the key and saves it. Nothing is pasted anywhere: the code you confirm cannot be used to sign in, and the key travels only from the instance to the tool. A code expires after 15 minutes and is collected once.

A key acts as you, narrowed to its scopes. A scope is a right such as `agent.write`. A key never does more than you may at the moment of each call: a right an administrator takes from you is gone from the key on its next call. A key lives at most a year. A new key starts with no scope ticked: tick the ones the key needs. **Settings > You > API keys** lists your keys and revokes them; a revoked key is refused on its next call. Whoever administers API access sees and revokes every person's keys. No key issues another key.

`catalyst logout --instance <address>` removes the saved key from this machine. It stays valid until you revoke it under **Settings > You > API keys**.

`catalyst setup <claude-code|codex|other> --instance <address>` logs in the same way where no working key is saved, then writes the Catalyst skill for an AI tool on your computer. [Connect a local agent](/getting-started/local-agent/) describes it.

A command without `--instance` works on the `defaultInstance` of the working copy's `catalyst.yaml`; one without a default is refused with the instances it names, and a saved key never chooses among them. Outside a working copy it works on the one instance a key is saved for, unless `CATALYST_API_KEY` is set. With none or several saved it names the saved ones and asks for `--instance`. `catalyst --version` prints the version of the tool.

A working copy can belong to one Shared Workspace: then the agents and skills it pushes are the workspace's own, and a pull reads only what the workspace owns. Bind an empty working copy once with its first pull:

```sh
catalyst config pull --workspace <workspace-id>
```

The pull writes `workspace: <workspace-id>` beside the instance's `url` in `catalyst.yaml`, and every later command of that working copy names the workspace. A working copy is bound once: one bound to another workspace and one that already pulled the instance's own assets are refused, so pull another workspace into a directory of its own. Its `push` is never a release and never changes the instance's default agent, which only an agent of the instance can be; an agent it creates starts hidden until an instance admin offers it, and a guardrail it creates belongs to the workspace as well. A workspace's agent may name the workspace's skills and the instance's skills you may read; no agent outside the workspace may name the workspace's skills.

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
```

`catalyst app publish` and `catalyst workflow publish` ask before they publish. With `--yes` they ask nothing and publish nothing yet: the publish waits in your own Inbox as a confirmation, the command ends with exit code `3` and the request id, and your **Allow** there counts as your click on Publish. A run without a terminal and without `--yes` publishes nothing and exits with 1. When approval is required, the command ends with exit code `3` and the request id, including for an admin's key. An instance approver can approve it in the Inbox ([Guardrails](/manage/guardrails/#publishing-needs-an-instance-admins-approval)). A CLI answer never supplies that approval.

`--from` takes the forms of the working copy: an `.agent.yaml` or any YAML or JSON definition, a skill's folder with its `SKILL.md`, or the folder of a kind whose revisions hold files, such as an App. A write names the revision it was made against with `--if-revision`, or `new` to create; read it with `show` or `history`. `discard-draft`, `set-availability` and `set-default` complete the list; `catalyst --help` shows each with its options. `--json` prints the instance's answer as it came.

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

## Workflows, checks and lists

These commands call the existing API operations with the same key and checks. They print readable YAML by default; add `--json` for JSON. Paginated lists read every page and print the combined items.

```sh
catalyst workflow test month-end --from test-input.json  # {"input":{"month":"2026-10"}}
catalyst workflow runs month-end
catalyst workflow run <run-id>
catalyst workflow steps <run-id>
catalyst workflow cancel <run-id>
catalyst guardrail hits no-iban
catalyst knowledge-base check accounts
catalyst data-store describe reporting
catalyst data-store used-by reporting
catalyst app actions offers
catalyst keys list
catalyst instance workspaces
```

`workflow test` tests the saved draft and simulates changing steps. Its optional `--from <file|->` reads the JSON request body (`{"input": {...}}`); without it, the body is `{}`. It starts a run and returns its current state; use `run` and `steps` to read progress. `cancel` cancels the run you name. These commands do not start a live Workflow.

`app actions` without a name lists actions of the published Apps you may read; with a name it reads that App's draft if you may write it, otherwise its published revision. `keys list` lists your own key metadata, never secrets. `instance workspaces` uses `instance.workspaces.list`: the Shared Workspaces for agent availability, requiring `config_assets:write` and `agent.write`. It is not the list of your workspace memberships.

`guardrail hits` preserves the API's counts and `hasMore`; `data-store used-by` preserves hidden counts and `truncated`, and `app actions` preserves `truncated`. These bounded responses are not paginated lists. All commands accept `--instance` and `--dir` as above, and use the same exit codes, including 3 for a held change.

## Catalog operations and Connections

`call` sends any operation in the CLI's API catalog through the same client and server checks. Input is a JSON object with the API client's `params`, `query` and `body` fields. Use `--from <file>` or `--from -` for stdin; without `--from`, it reads piped stdin or uses `{}` at a terminal. Output is JSON, with the exit codes above. A held call prints `status: pending_approval` and its run, and exits 3.

```sh
catalyst call assets.get --from request.json
printf '%s' '{"params":{"kind":"agent","name":"assistant"}}' | catalyst call assets.get
catalyst connection secret set reporting < /path/to/secret
catalyst connection test reporting
catalyst connection discover reporting
catalyst connection tools
```

`connection secret set <name>` reads stdin or asks at a terminal with echo disabled. The hidden prompt accepts one line; Enter submits it. Send multi-line secrets, such as PEM keys, through stdin (`catalyst connection secret set reporting < key.pem`). It accepts no secret argument, removes one final line ending from stdin, and prints only the secret state and version. It reads the current version before writing; a concurrent replacement is refused. A key without the required scope or right gets the same refusal as the API.

For multipart operations, the JSON input's `file` names a local upload path. Binary responses print JSON with `contentType` and `base64`; streaming operations print one JSON event per line.

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

## The key

The tool takes its key from the variable `CATALYST_API_KEY` when it is set, which is how automation runs it, and otherwise from the key `catalyst login` saved for the instance's address. It never takes a key as an argument and never writes one into the working copy.

- A saved key is kept in `~/.config/catalyst/credentials.json` (`$XDG_CONFIG_HOME/catalyst`, or `$CATALYST_CONFIG_HOME`), readable by you alone. A file others may read is refused until you `chmod 600` it.
- The key is sent only to the instance you name, and only over HTTPS. Plain HTTP is accepted for `localhost`, `127.0.0.0/8` and `::1`.
- The key is exchanged once for a short-lived access token. Every other request carries the token, not the key.
- An error message never repeats the key, and the tool never prints it.

`catalyst config local-key` was removed from this tool and exits with code 2. To create a key on a local development instance, run `pnpm config:local-key` in the client repository, as [Config assets](/configure/config-assets/#the-cli-working-copy) describes.

## For maintainers

`pnpm release:check` packs the tool and reads every file of the tarball. It fails when the tarball depends on a workspace package, holds source of a private package, holds what looks like a credential or a file that stores credentials, or has no licence file. `pnpm release:check:public` runs the same check alone and then installs the tarball with npm in an empty directory.

The workflow `Publish public CLI` publishes the tarball to npm. It is switched off until the repository variable `PUBLISH_PUBLIC_CLI` is `true`. It refuses a commit whose version is on npm already, so each version is published once, from the commit that carries it.

Settings, Connect a local agent installs the CLI version that `PUBLISHED_CLI_VERSION` in `packages/api-contract/src/public-cli.ts` names, and only one that is on npm. While it is unset the page says the command is not available yet. A release that offers the command goes in this order:

1. Bump the version all packages share, in a commit of its own.
2. Run `Publish public CLI` on that commit.
3. Set `PUBLISHED_CLI_VERSION` to that version and commit it.
4. Deploy that commit.
5. Only then switch on the module `personalApiKeys` on the instance.
