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
