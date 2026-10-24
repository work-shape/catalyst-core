# Releases

How core and capabilities are cut, validated and published, and the Postgres image the checks
and instances run. The public mirror's own README is `public/README.md`; it ships with the mirror
and says nothing about this repository's workflow.

## Cutting a release

From a clean release branch, run `pnpm release:cut 0.8.0 --root ../capabilities` to cut both
repositories. `--root` is required: core and capabilities always cut together. Every root, package
and reference-client manifest advances to that version, including private packages; dependencies
stay `workspace:*`.
Both repositories must share one current version. The command refuses SemVer build metadata,
invalid versions, versions at or below any current package version, detached HEADs, and dirty
trees (including staged and untracked files) in either repository before making changes.

The cut uses `scripts/release/changelog.mjs` to turn each repository's Unreleased section and
change files into `## <version> — <today>`, then deletes the folded files. Empty companion releases
get a version section too. It refreshes OpenAPI and runs `release:check` before creating one
`chore(release): cut <version>` commit per repository. A failed gate leaves the cut uncommitted
for inspection; restore or commit it before retrying from a clean tree. Both cuts are staged and
verified before either commit. If a commit fails, the error lists both repository SHAs and exact
commands to finish the staged cut or undo both cuts; do not rerun `release:cut`. Run both
repositories' `pnpm check` on scratch release branches to validate the cut. The command never tags,
pushes or publishes; CI publication on a release tag is a separate step.

`pnpm changelog` prints the next release's section as it will read, and
`pnpm changelog --release <version> --date YYYY-MM-DD` folds change files alone. Entries in the
Unreleased section of `CHANGELOG.md` are the ones written before change files existed.

A release that offers the Connect a local agent command publishes the CLI of its version to npm
before it names that version in `PUBLISHED_CLI_VERSION` and before the instance switches on
`personalApiKeys`. The order is in `packages/docs/src/content/docs/configure/cli.md`, For
maintainers.

## Validation and publication

The tag workflows use npm 11.21.1. Merging these workflows publishes nothing.
`publish.mjs` packs with pnpm, checks each packed manifest, and publishes the tarball.
Candidates use `next`; an older final uses `release-X.Y`; a current final uses `latest`.

The npm registry may initialize `latest` on the first publish of a new name even when the
publish requests `next`. After each candidate publish the job reads `dist-tags.latest`,
removes it if it points to that candidate, and verifies the removal. Reruns perform the same
cleanup for already published versions. There can be a brief registry-created tag between
publish and cleanup. If npm refuses removal and that candidate is the name's only published
version, the job logs a warning and leaves `latest` on the candidate, including on reruns.
Other cleanup failures fail the job and require a rerun. Only a final release
explicitly adds `latest`, and an older hotfix leaves the current `latest` intact. No placeholder
stable version is published. The first real cut still needs its own authorization.

`pnpm test:release` covers visibility, mirror allowlists and tag reconciliation with local
fixtures (including a simulated first-publish `latest`, sole-version cleanup refusal and
interrupted-job recovery).

`mirror.mjs` seeds the public lock with the exact transitive closure of the four public
importers, including optional dependencies and peer-qualified snapshots, then runs pnpm's
lockfile-only install. It never seeds the public tree with the closed dependency graph.
Public release helpers use a separate public metadata policy. The mirror removes bootstrap
change files; release notes link public documentation instead of copying the private changelog.

After installing core, run the real mirror proof:

```sh
pnpm test:release:mirror
```

When dependencies are installed at a wrapper workspace root, set `CORE_WORKSPACE_ROOT` to
that root (for example `CORE_WORKSPACE_ROOT=.. pnpm test:release:mirror`). The test refuses
empty `pnpm ls` results. It independently walks manifest dependencies and the resulting lock,
asserts that no package or snapshot is unreachable and that retained records equal core's,
compares all four installed graphs using `pnpm ls --depth Infinity --json`, installs frozen,
builds and dry-runs publication. It creates and removes its own temporary mirror.

Use a core checkout installed from its frozen lock as the comparison reference. If the
committed lock records match but the installed graphs differ, check the installed
`node_modules/.pnpm/lock.yaml`: pnpm can retain records from an earlier local resolution.
A fresh install of that checkout from its frozen lock removes that stale reference graph.

`release.yml` gates publication on one `fresh-resolution` job. It builds core from the
frozen lock, reuses deployment kit `pack-local` to pack and substitute every release
package, and installs the reference demo in a scratch directory without core's lockfile,
source aliases or third-party overrides. It then runs the deployment's `build:server`
and `build:ui` commands and requires their artifacts, as the kit's check does. It then runs
the consumer through the deployments' own entries: `dist/migrate.js` (compose's `migrate`
service) against a hosted test Postgres whose password the job generates,
`dist/seed-auth.js` (the deployments' `seed:auth`) for a disposable standalone user, and
`dist/server.js` until `/ready` answers 200. It signs in over HTTP and requires a session
cookie plus a 200 from `GET /api/v1/me` (401 without the cookie). Then it makes one agent
available (a seeded superadmin creates an API key, the consumer's own `catalyst config push`
sends a one-agent package), serves the built UI, which was built against the server's port, and
in Chromium signs in, opens the workspace start page and types in the composer
(`composer-probe.mjs`). A page error, a composer that disappears or one that loses the text
fails the step: the chat runtime drift of 0.8.0-rc.2 passed every HTTP probe and threw here.
Before the builds, `check-runtime-pins.mjs` requires the chat runtime versions of core's
lock. Any failure blocks
publication and names its step on the run's summary page (`Fresh consumer gate failed at:
<step>`); a failure after the server starts also prints the server's last 200 log lines.
The child server and scratch consumer are removed even on failure. The job takes about two minutes
(1 min 53 s on a dispatch, which also runs the drift proof below). Only
Catalyst package overrides select local tarballs; third-party ranges resolve afresh.
Dispatch `gh workflow run release.yml --ref <branch>` to prove this gate without
publishing. Dispatches have their own concurrency group and cannot hold up a tag release.

Dispatch also proves the regression: after the good consumer passes, it overrides
`better-auth` to `1.7.10` and `zod` to `4.4.3`, installs and rebuilds the server, and requires
the same smoke to reject sign-in with 500. An install/build/startup failure is not accepted
as mutation proof, nor is an unexpected success. Tags run only the good consumer.

Published runtime dependencies and peers deliberately stay on these tested lines (the
range test checks their starting versions against core's lock):

| Dependency                                    | Range               | Reason                                                                                             |
| --------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| better-auth                                   | 1.6.22              | 1.7.10 calls Zod APIs absent from core's 4.4.3; its @better-auth/* dependencies are already exact. |
| zod                                           | 4.4.3 (retained)    | Schema identity and validation must agree across packages and auth.                                |
| drizzle-orm                                   | 0.45.2              | Pre-1.0 ORM and auth adapter contracts move in patch releases.                                     |
| react, react-dom                              | ^19.2.7 (peers)     | The host owns the renderer and hooks; UI packages build and test with dev dependencies at 19.2.7.  |
| fastify                                       | 5.12.7              | Request/auth boundary and emitted server types must match the tested security patch.               |
| @fastify/cors, @fastify/multipart             | 11.2.0, 9.4.0       | Credentialed origins and upload parsing sit on the HTTP/data boundary.                             |
| postgres                                      | ~3.4.9              | DB protocol, transactions and value conversion must stay on the tested minor.                      |
| js-yaml                                       | ~4.3.2              | Parses release and asset configuration before validation.                                          |
| re2js                                         | ~2.8.6              | Compiles guardrail validation patterns.                                                            |
| ajv                                           | ~8.20.0             | Validates connector inputs and outputs at the data boundary.                                       |
| @tanstack/react-query, @tanstack/react-router | ~5.101.0, ~1.170.16 | Cache and route transitions carry signed-in UI state.                                              |
| @assistant-ui/react, core, store, tap         | 0.14.26, 0.2.20, 0.2.19, 0.9.3 | react 0.14.29 with tap 0.9.23 loops on the workspace start page (tap's `useSyncExternalStore`). |
| ai, @ai-sdk/react                             | 6.0.224, 3.0.226    | Stream and message contracts of the chat runtime; they float together with assistant-ui.           |

chat-ui declares core, store and tap directly although it imports none of them: a range in a
dependency's own manifest (react 0.14.26 asks for tap `^0.9.3`) would otherwise float in a
lock-free consumer. The fresh consumer gate checks the result
(`check-runtime-pins.mjs`): one resolved version of each, the one in core's lock.
Other exact pins stay in place.
Unrelated UI helpers and tooling keep their existing ranges. Changes to these lines require
a deliberate manifest/lock update and both the frozen-lock Check and fresh consumer gate.

## Renaming a deployment package scope

Private deployment assemblies are supplied explicitly when migrating their package scope:

```sh
node scripts/release/rename-scope.mjs --write --assembly <name> ../deployment.<customer>
```

`--assembly <name>` maps `@vivd-catalyst/<name>` to `@work-shape/deployment-<name>` for
that run and can be repeated for several assemblies. Without `--write`, the command reports
changes only. An unlisted package outside `packages/` stops the run before any file is written.
Lockfiles are skipped; regenerate them afterwards.

## The Postgres image

The checks start the instance's own Postgres image (ADR-0023): `docker/postgres/Dockerfile`, the
official image the live hosts ran plus pgvector, pinned by digest in `docker/postgres/pinned-image`.
`.github/scripts/start-postgres.sh` and `pnpm check:local` read that file, and the demo Compose files
repeat it. The workflow "Postgres image" checks the pinned image with
`docker/postgres/check-image.sh`; when the Dockerfile changed, it builds the image, checks it,
pushes it for amd64 and arm64 on a push to a branch of this repository and fails with the line to
pin. Commit that line to `docker/postgres/pinned-image` and to the capabilities', the demo's and the deployments' files that
name the digest.

`work-shape/catalyst-postgres` is private and belongs to `work-shape/catalyst-core`.
Before another repository consumes it, grant that repository **Read** under **Manage Actions
access** in the [package settings](https://github.com/orgs/work-shape/packages/container/catalyst-postgres/settings).
This applies to `catalyst-capabilities`, `deployment.catalyst` and
`deployment.<customer>` when they switch to the pinned image. Keep core's existing
publishing access. Repository transfers and image publication do not grant these other
repositories access. Each consuming workflow also needs `packages: read` and must sign in
with its own `GITHUB_TOKEN` before pulling (service containers use `credentials`). A successful
registry login alone does not prove access to the package.

If Actions reports `manifest unknown`, first inspect the exact pin with an authorized
local Docker login: `docker manifest inspect "$(grep '^ghcr.io/' docker/postgres/pinned-image)"`.
If the digest resolves locally, check the failing repository's Actions access and token
permissions before rebuilding or changing the pin. A local pull uses the local credential;
rerun the failing workflow to verify its repository token can pull too. Keep the package
private; local Compose and checks that pull it require an authorized registry login as well.

Capabilities CI currently starts stock Postgres 17.6 from public ECR. The deployments install
versioned npm packages for their release checks and use stock Postgres in Compose. Granting
package access does not switch those consumers to the pinned image.

Images used as build inputs (`node`, `nginx`, `docker` in `docker/vivd-client.Dockerfile`) still
come from Docker Hub, which by GitHub's account does not limit hosted runners.
