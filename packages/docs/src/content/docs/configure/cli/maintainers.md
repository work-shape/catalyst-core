---
title: CLI maintainers
description: Package, publish and offer the public Catalyst CLI.
---

## For maintainers

`pnpm release:check` packs the tool and reads every file of the tarball. It fails when the tarball depends on a workspace package, holds source of a private package, holds what looks like a credential or a file that stores credentials, or has no licence file. `pnpm release:check:public` runs the same check alone and then installs the tarball with npm in an empty directory.

The workflow `Publish public CLI` publishes the tarball to npm. It is switched off until the repository variable `PUBLISH_PUBLIC_CLI` is `true`. It refuses a commit whose version is on npm already, so each version is published once, from the commit that carries it.

Settings, Connect a local agent installs the CLI version that `PUBLISHED_CLI_VERSION` in `packages/api-contract/src/public-cli.ts` names. It is the CLI released with this platform version: `pnpm release:cut` sets it to the version it cuts, and `pnpm release:check` fails when it differs from the version of the CLI package. The page never names a version that npm does not have, because the release publishes first. A release that offers the command goes in this order:

1. Run `pnpm release:cut <version>`. It bumps the version all packages share and sets `PUBLISHED_CLI_VERSION` to it, in one commit.
2. Run `Publish public CLI` on that commit.
3. Deploy that commit.
4. Only then switch on the module `personalApiKeys` on the instance.

Run `catalyst docs` for this release's product docs index, or `catalyst docs <page>` for a page from it.
When `catalyst context` finds an older CLI than the published version the instance names, it prints an npm update command on stderr; it leaves stdout unchanged and never updates itself.
