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

## What it does today

The `config` commands synchronize agents and skills between a folder and an instance. [Config Assets](/configure/config-assets/) describes the working copy, the commands and what a push does.

```sh
catalyst config pull
catalyst config diff
catalyst config validate
catalyst config push
```

## One command per asset operation

Every operation on assets has a command, for every kind the instance registers: agents, skills, Apps, Workflows, Connections, Data Stores. The kind is the first word, by its id, its plural or with dashes (`data-store`). The instance names its kinds; a kind a later release adds works without a new CLI.

```sh
catalyst context                  # the instance, your rights and Namespaces, its kinds
catalyst kinds                    # each kind: lifecycle, folder or definition, rights
catalyst references               # models, efforts and tools a definition may name
catalyst agent list --prefix kai-
catalyst agent show kai-tax
catalyst agent history kai-tax
catalyst skill validate --from skills/kai-guide
catalyst skill put kai-guide --from skills/kai-guide --if-revision new
catalyst agent put kai-tax --from agents/kai-tax.agent.yaml --if-revision 3
catalyst app put offers --from offers --if-revision 4 --workspace <workspace-id>
catalyst app publish offers --revision 5 --workspace <workspace-id>
catalyst agent revert kai-tax --to 2 --if-revision 4
catalyst agent delete kai-tax --if-revision 5
```

`--from` takes the forms of the working copy: an `.agent.yaml` or any YAML or JSON definition, a skill's folder with its `SKILL.md`, or the folder of a kind whose revisions hold files, such as an App. A write names the revision it was made against with `--if-revision`, or `new` to create; read it with `show` or `history`. `discard-draft`, `set-availability` and `set-default` complete the list; `catalyst --help` shows each with its options. `--json` prints the instance's answer as it came.

The instance decides every right, revision and check. A `revert` needs the read right on the asset beside the write right, as it restores content. A refusal is printed as the instance gave it, with each asset, issue or item it names:

```text
Refused by the instance (HTTP 403 FORBIDDEN): Missing the right 'agent.write'
```

The exit code is 0 when the call was applied, 1 when it was refused or failed, 2 when the command line was wrong and nothing was sent, and 3 when the call waits for another person's approval and has changed nothing yet.

## The key

The tool reads its key from the variable `CATALYST_API_KEY`. It never takes a key as an argument and never writes one into the working copy.

- The key is sent only to the instance you name, and only over HTTPS. Plain HTTP is accepted for `localhost`, `127.0.0.0/8` and `::1`.
- The key is exchanged once for a short-lived access token. Every other request carries the token, not the key.
- An error message never repeats the key.

## What is not in it

`catalyst config local-key` is no longer a command of this tool. It created a key on a local development instance by reading the release config and its secrets, which the public tool does not do. A client repository runs its `config:local-key` script instead, which calls `catalyst-local-key` of the private `client-assembly` package.

## For maintainers

`pnpm release:check` packs the tool and reads every file of the tarball. It fails when the tarball depends on a workspace package, holds source of a private package, holds what looks like a credential or a file that stores credentials, or has no licence file. `pnpm release:check:public` runs the same check alone and then installs the tarball with npm in an empty directory.

The workflow `Publish public CLI` publishes the tarball to npm. It is switched off until the repository variable `PUBLISH_PUBLIC_CLI` is `true`.
