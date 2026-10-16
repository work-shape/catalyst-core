# @work-shape/catalyst-deployment-kit

Release and deploy tooling for operated Catalyst instances: one Hetzner VM per environment,
Docker Compose, images on GHCR, releases as manifests of image digests. A deployment repo
(`deployment.<instance>`) calls the kit instead of carrying its own copies of these scripts.

A deployment installs the kit as a dev dependency at the Catalyst release it runs and calls
`catalyst-deploy` from its own install. Every Catalyst package is pinned to that same exact
published version in `package.json`; the deployment commits its own `pnpm-lock.yaml`.

## The one input

`deploy/deployment.env` in the deployment repo. Four keys, no quotes, nothing else:

```sh
INSTANCE=acme
IMAGE_REPOSITORY=ghcr.io/vivd-solutions/vivd-catalyst-acme
APP_PACKAGE=@work-shape/deployment-acme
EXECUTION_WORKSPACES=1
```

Derived from `INSTANCE`:

| What                    | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| App directory on the VM | `/opt/vivd-catalyst/<instance>`                        |
| Env file on the VM      | `/etc/vivd-catalyst/<instance>/app.env`                |
| Database backups        | `<instance>-<database>-<timestamp>[-<label>].tar`      |
| Backup units            | `vivd-catalyst-<instance>-backup.service` and `.timer` |

`INSTANCE` is lowercase letters, digits and dashes, and may start with a digit (`123-example`): a
directory, a Compose project, a container, a dump and a unit all take such a name. The kit
derives no database name and no shell variable from it.

The SSH user is `deploy`. `EXECUTION_WORKSPACES=1` makes a deploy pull the runner image and
start `workspace-command-worker`.

## Commands

`catalyst-deploy` finds the deployment repo from the current directory, or from
`DEPLOYMENT_ROOT`.

| Command                                          | Does                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `check [--static]`                               | The release pin (below) and the policy checks, then the release gate on the installed packages. `--static` stops after the first two.   |
| `bump VERSION`                                   | Pins every catalyst package at `VERSION`, rewrites `pnpm-lock.yaml` and prints the release notes in between.                            |
| `pack-local [--workspace DIR] [--skip-build]`    | Builds the release images from the packages of the local platform and capabilities checkouts.                                           |
| `publish staging`                                | Runs `check --static`, then tags `staging-<date>-<n>` on `main`.                                                                        |
| `publish production`                             | Tags `v<date>-<n>` on the commit of a staging release and starts its deploy. Refuses a release without a successful staging deployment. |
| `manifest write\|check\|fetch\|staging-deployed` | Writes, validates and downloads release manifests (writes schema 2; reads schemas 1 and 2).                                             |
| `deploy --host HOST --manifest FILE`             | Deploys the images of a manifest by digest.                                                                                             |

A deploy sends the Compose file, the Caddyfile and the files under `host/` to the VM, then runs
`lib/deploy-remote.sh` there: pull, back up the database server under `pre-deploy/` (a failed
backup aborts before migrations), migrate, start the services, roll `agent-run-worker` with a
drain, and fail unless every service runs the digest of the release.

The deploy ends with the upload check, `host/check-upload.mjs`, which runs inside the `api`
container: it creates a conversation, uploads one small text file, waits up to 60 s until the
file's state is `ready`, and deletes the file and the conversation again, also when it fails. A
file that is not processed fails the deploy with its state and with the job read from
`platform_jobs`, for example `conversation_attachment.preprocess is queued, attempt 0 of 3`.
The release keeps running; the deploy says that uploads do not work on it.

- **Identity:** the user `catalyst-deploy-check`, shown as "Deploy check (synthetic)". The
  user is created on the first run and stays, with no role and no password. Its conversation
  is titled "Deploy check RELEASE (synthetic, safe to delete)" and its file is
  `deploy-check-synthetic.txt`; one that a check could not remove is named in the output.
- **Credential:** `CHAT_SERVER_CREDENTIAL`, which the `api` service already has from the env
  file of the instance. With it the check asks `POST /api/v1/instance/session-tokens` for a
  session token of its user with the scopes `conversation:read` and `conversation:write`. The
  instance therefore needs `auth.sessionToken` in its config. Nothing is provisioned for the
  check and no secret is added to GitHub; a service principal cannot be used, because
  conversations belong to users.
- **Audit:** each run records `auth.session_token_issued` and `conversation.deleted`.

`check` starts with `lib/check-deployment-policy.sh`: production Compose pins every first-party
image by digest, `deploy.yml` requires a successful staging deployment, the bake targets are the
image keys of a manifest, and the worker wiring under `verify/` holds. What a worker must not
have is judged on the stack as `docker compose config` resolves it, with anchors, merge keys
and the override file applied, in an environment where no variable has a value: one with a
default takes it, and one without counts as unknown. The stack is the files `lib/deploy-remote.sh`
passes with `-f`, and locally `docker-compose.yml` with `docker-compose.override.yml`. A
worker receives only what its `environment` spells out:

- no signing secret, and no model key unless it is `agent-run-worker`. The model key names are
  the adapters' defaults and every `credentialSecret` and `organizationSecret` under `config/`;
- no `env_file`, `extends`, `secrets`, `configs` or `volumes_from`, because the resolved file does not
  show what they carry;
- no `pid`, no mount of `/etc/vivd-catalyst` or of a path whose variable has no default, and
  the Docker socket only on `workspace-command-worker`.

A deployment adds its own assertions in an executable
`deploy/scripts/check-release-policy.sh`, which runs last.

The release gate also starts every built process entry point of the deployment once per
release config (`lib/resolve-entry-points.mjs`): `dist/server.js`, `dist/agent-run-worker.js`,
`dist/workspace-command-worker.js` and `dist/artifact-preview-worker.js`. Its log names the ones
it ran and the ones the deployment does not build. Each is started with the argument
`--resolve-only`, with which a process loads the config, resolves its modules against the build
it was assembled from, makes the checks that need only the two, prints
`resolve-only: this process starts with this config` and ends with code 0 before it opens a
store. A config the schema refuses fails there, and so does a process that would stop on the
host: a module is on that its build ships no code for, or the workspace command worker is built
for a config that turns Execution Workspaces off. Whether the host has the memory for the
sandboxes of a config depends on the host, not on the machine the gate runs on: the gate does
not check it. Where the sandbox is `docker`, the workspace command worker prints
`host memory not checked: checked at startup on the host` to stderr, and the check is made when
the worker starts on the host. An entry point must start its process through
`defineClientInstance` for this. One that ends without the line fails, and one that is still
running after two minutes is killed and fails.

## Deployments that install released packages

`package.json` names every `@work-shape/catalyst-*` package at one exact release version, the
kit (`@work-shape/catalyst-deployment-kit`) and the CLI among them, and the deployment commits
its own `pnpm-lock.yaml`, written with `--ignore-workspace`. `check` refuses a range, a second
version, a `file:`, `link:` or `workspace:` specifier and a `pnpm.overrides` or `resolutions`
entry for a catalyst package. Before its gate it requires `node_modules` to hold the pinned
release from the registry, not a link to local source: run it on a standalone install
(`pnpm install --frozen-lockfile`), as CI does. The gate is the deployment's typecheck and
build, the entry points, and the Compose and Caddy files; platform and capabilities passed their
checks in their own release. The post-check receives `DEPLOYMENT_ROOT` only. `publish staging`
runs `check --static` locally and leaves the gate to the deploy workflow.

`bump VERSION` asks npm for every catalyst package of `package.json` at `VERSION` and changes
nothing when one is missing (the restricted packages need a read token in `~/.npmrc`). Then it
sets them, runs `pnpm install --lockfile-only --ignore-workspace` and prints the GitHub release
notes of `work-shape/catalyst-core` and `work-shape/catalyst-capabilities` after the previous
version up to `VERSION`, or their addresses where `gh` cannot read them. Run it from the
deployment repo, for example `pnpm exec catalyst-deploy bump 0.8.0`, review the printed release
notes, and commit `package.json` and `pnpm-lock.yaml` together. CI installs that lockfile frozen.
To return to an earlier package release, bump to its exact version in a new commit; rolling
back an operated deployment uses the earlier tag's digest manifest.

The release manifest is schema 2: `catalystVersion` instead of the platform and capabilities
commits. `manifest check` accepts schema 1 too, so an earlier release can still be deployed, and
`deploy` refuses a schema 2 manifest whose `catalystVersion` is not the kit's own version.

### Images

`docker/deployment.Dockerfile` builds the six images from the deployment folder alone: it
downloads what `pnpm-lock.yaml` names with the npmrc secret `npmrc`, installs offline and frozen,
and runs the deployment's `build:server` and `build:ui`. The images keep the deployment at
`/app/deployment.<instance>`, so Compose commands and `CLIENT_CONFIG_PATH` stay as they are.

| Target                     | Runs                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `api`                      | `dist/server.js` of the deployment                                                                        |
| `workspace-command-worker` | the API image with a Docker client, `dist/workspace-command-worker.js`                                    |
| `artifact-preview-worker`  | `dist/artifact-preview-worker.js` on the LibreOffice runtime                                              |
| `ui`                       | nginx with `dist/client` and `docker/nginx-spa.conf`                                                      |
| `doc-worker`               | `@work-shape/catalyst-document-worker` with the deployment's `config/`; the deployment must depend on it  |
| `runner`                   | the commands of `catalyst-app-build`, `catalyst-asset-repo` and `catalyst-artifact-helpers` as user 10001 |

The runner and document worker images carry their packages and exactly what those depend on,
copied out of the same install (`docker/copy-packages.mjs`), and nothing of the deployment's own
code. The system layers (LibreOffice, fonts, Python) are copies of those in the platform's and
capabilities' Dockerfiles, which keep serving the demo and platform CI; the kit's tests and a
capabilities test fail when the package lists drift apart.

`deploy/docker-bake.hcl` stays the deployment's. It builds with context `.` and these
variables, which `pack-local` and CI set:

```hcl
variable "CATALYST_KIT" { default = "node_modules/@work-shape/catalyst-deployment-kit" }
variable "NPMRC" { default = "" } # an npmrc that may read @work-shape; empty: no secret
variable "IMAGE_REPOSITORY" { default = "ghcr.io/work-shape/catalyst-acme" }
variable "RELEASE_TAG" { default = "local" }
variable "PUSH" { default = false }

target "_release" {
  context    = "."
  dockerfile = "${CATALYST_KIT}/docker/deployment.Dockerfile"
  args       = { DEPLOYMENT_DIR = "deployment.acme" }
  secret     = NPMRC == "" ? [] : ["id=npmrc,src=${NPMRC}"]
  output     = [PUSH ? "type=registry" : "type=cacheonly"]
}

target "api" {
  inherits = ["_release"]
  target   = "api"
  tags     = ["${IMAGE_REPOSITORY}-api:${RELEASE_TAG}"]
}
# ... ui, workspace-command-worker, artifact-preview-worker and doc-worker the same way;
# runner with target "runner" and the tag "${IMAGE_REPOSITORY}-catalyst-runner-base:${RELEASE_TAG}".
```

`pack-local` builds and packs every published package of `../platform` and `../capabilities`
(`--workspace DIR` for another folder) into `<deployment>/.local-packages/`, a folder that
ignores itself. It copies the deployment's files to a scratch folder, points every catalyst
package there at its tarball (`file:` specifiers and overrides, a lockfile written for them) and
runs the bake file there with every output set to the local engine (`type=docker`), the images tagged `pack-local` (`RELEASE_TAG` overrides
it). Bake reads a Dockerfile outside the context only when allowed, so `pack-local` passes
`--allow=fs.read` for the kit's `docker/` folder; CI, with the kit under `node_modules`, needs none. Nothing in the deployment changes, and `check` refuses such a manifest. The tarballs carry
the workspace's version, whatever the deployment pins.

## Backups

`host/backup-postgres.sh` runs nightly from the backup timer (key prefix `postgres/`) and before
the migrations of every deploy (`pre-deploy/`). It backs up the instance's whole Postgres server
into one tar archive in the backup bucket:

- `globals.sql`: the roles with their passwords, settings and memberships, from
  `pg_dumpall --globals-only`.
- `<database>.dump`: a `pg_dump` in custom format for each database, the platform database and
  every Data Store database (`catalyst_ds_...`).

The databases come from the server's own catalog, not from the platform's records of its stores,
so a store whose record is missing or not yet written is backed up too. Left out are the
templates, `postgres` (the maintenance database, so a grant changed there is not in the backup),
the `<database>_restore_<timestamp>` and `<database>_replaced_<timestamp>` databases that
`restore-postgres.sh` makes, and a database an interrupted `DROP DATABASE` left invalid, which
the backup names on stderr. A database whose name cannot be a file name fails the backup instead
of being skipped. `CATALYST_SECRET_STORE_KEY` is not in the backup: the platform reads the store
roles' passwords with it, so a restored instance needs the key from the password manager.

`host/restore-postgres.sh` runs on the VM, in the app directory:

- `list` prints the backups of both prefixes: the archives, and the `.sql.gz` dumps of the
  platform database written before them.
- `verify [KEY]` restores each database of a backup into a scratch database
  `<database>_restore_<timestamp>`, without owners and grants, prints its row counts next to
  the live database's and drops it again. No live database and no role is changed.
- `recover KEY --replace-database <platform database>` refuses while app containers run or a
  session is open on a database of the backup, and asks for the database name before it changes
  anything. It creates the roles the server lacks, without login. Then it renames each database
  of the backup to `<database>_replaced_<timestamp>` and creates it again from its dump, with
  owner, grants and settings. Last, in one transaction, it sets every role as in the backup
  (attributes, passwords, settings, memberships), except `POSTGRES_USER`, whose password stays
  the one in the env file. If a step fails or the script is stopped, every database is put back
  and the roles keep their passwords; only the roles it created stay, without login. A database
  that the backup does not hold, such as a store made after it, stays as it is. On an empty
  server the same command restores the whole instance. Recover onto a server with the backup's
  `POSTGRES_USER`: under another one, the backup's comes back as a second superuser with its old
  password, and a role membership it granted fails the recovery.
- A `.sql.gz` key restores the platform database as before: into a scratch database, which a
  recovery then swaps in.

## Still owned by the deployment repo

`docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/docker-bake.hcl`, the GitHub workflows and
the Terraform roots.

## Layout

- `bin/catalyst-deploy`: dispatcher.
- `lib/`: the commands. `load-deploy-env.sh` is sourced before Terraform runs.
- `host/`: files for the VM. `backup-postgres.sh`, `restore-postgres.sh` and the units under
  `systemd/` are templates; a deploy fills in the instance and puts the scripts in the app
  directory and the units in `deploy/systemd/` below it. `configure-zram.sh` is copied by hand.
- `verify/`: Node checks of the Compose wiring of the workers, and their helpers.
- `dev/`: helpers for the local Compose development loop.
- `docker/`: the release Dockerfile, its ignore file, the nginx configuration of the UI image and
  the package copy the Dockerfile runs.
- `tests/`: `pnpm test:deployment-kit` in the platform root (the shell suite and
  `node --test tests/*.test.mjs`). Not shipped.
