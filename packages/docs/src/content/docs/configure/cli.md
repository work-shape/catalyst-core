---
title: The Catalyst CLI
description: Install the public catalyst command from one file and use it against an instance.
---

`catalyst` is the command line tool for an instance. It is the public package `@work-shape/catalyst-cli` under the MIT licence and needs Node 22 or later.

## Install

Install the public CLI from npm (Node 22 or later):

```powershell
npm install --global @work-shape/catalyst-cli
catalyst --help
```

Run each command on its own line. These commands also work in Windows PowerShell 5.1, which does not support `&&`. No registry account or token is needed. The API contract and client are bundled into the package.

A team that keeps its tooling with its working copy can install it as a development dependency and run `npx catalyst`. A release tarball can also be installed with `npm install --global ./work-shape-catalyst-cli-<version>.tgz`.

## Check and update

```powershell
catalyst doctor
```

`doctor` checks the instance address, sign-in, CLI/server versions and effective key rights, one line each. It exits 0 when all checks pass and 1 when a check fails. `SKIP` means an earlier check prevented that check. It prints no credentials, tokens, personal identities or response contents; its output is safe to paste into a support chat. `--instance <name-or-url>` and `--dir <working-copy-dir>` select the same target as other commands. It makes only reading calls and a short-lived token exchange and never changes stored credentials or assets.

Use the HTTPS origin of the instance, without `/api` or a sign-in path. An unexpected successful response names the URL reached, HTTP status, content type and whether it was an HTML page, other JSON or non-JSON text. It never prints that response's contents or URL credentials/query parameters.

Every instance request sends `Catalyst-CLI-Version`; current servers return `Catalyst-Server-Version`, including on authentication failures. The CLI and server must use the same release version (build metadata is ignored; prereleases are distinct contracts). A mismatch stops the command before the body is parsed and gives the exact command for the server's release:

```powershell
npm install --global @work-shape/catalyst-cli@<server-version>
catalyst doctor
```

Replace `<server-version>` with the version printed by the diagnostic. A prerelease must be named explicitly; installing the default npm version can leave an older stable CLI installed. The matching CLI must have been published by the release owner. For a project-local installation, omit `--global` and use `npx catalyst doctor`. Updates preserve saved sign-ins. Run `catalyst setup <tool> --instance <url>` again to refresh the local tool's skill.

Servers released before version headers were added cannot enforce the early version check; `doctor` also reads the release from instance context after sign-in. A CLI installed before these diagnostics must be updated first.

## Commands

- [Assets](/configure/cli/assets/)
- [Log in and API keys](/configure/cli/auth/)
- [Config working copies](/configure/cli/config/)
- [Initialize a working copy](/configure/cli/init/)
- [Workflows, checks and lists](/configure/cli/named/)
- [Catalog operations and Connections](/configure/cli/operations/)
- [CLI maintainers](/configure/cli/maintainers/)

## Log in

[Log in with a personal API key](/configure/cli/auth/#log-in).

## The key

[How the CLI stores and uses its key](/configure/cli/auth/#the-key).
