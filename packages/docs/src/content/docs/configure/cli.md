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
