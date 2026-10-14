# @vivd-catalyst/deployment-kit

Release and deploy tooling for operated Catalyst instances: one Hetzner VM per environment,
Docker Compose, images on GHCR, releases as manifests of image digests. A deployment repo
(`deployment.<instance>`) calls the kit instead of carrying its own copies of these scripts.

The package is not published yet. A deployment uses it from the platform checkout at its pinned
`PLATFORM_REF`:

```sh
../platform/packages/deployment-kit/bin/catalyst-deploy publish staging
```

## The one input

`deploy/deployment.env` in the deployment repo. Four keys, no quotes, nothing else:

```sh
INSTANCE=acme
IMAGE_REPOSITORY=ghcr.io/vivd-solutions/vivd-catalyst-acme
APP_PACKAGE=@vivd-catalyst/acme
EXECUTION_WORKSPACES=1
```

Derived from `INSTANCE`:

| What                    | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| Deployment checkout     | `deployment.<instance>`, next to `platform/` and `capabilities/` |
| App directory on the VM | `/opt/vivd-catalyst/<instance>`                                  |
| Env file on the VM      | `/etc/vivd-catalyst/<instance>/app.env`                          |
| Database backups        | `<instance>-<database>-<timestamp>[-<label>].tar`                |
| Backup units            | `vivd-catalyst-<instance>-backup.service` and `.timer`           |

`INSTANCE` is lowercase letters, digits and dashes, and may start with a digit (`exampletax`): a
directory, a Compose project, a container, a dump and a unit all take such a name. The kit
derives no database name and no shell variable from it.

The SSH user is `deploy`. `EXECUTION_WORKSPACES=1` makes a deploy pull the runner image and
start `workspace-command-worker`.

## Commands

`catalyst-deploy` finds the deployment repo from the current directory, or from
`DEPLOYMENT_ROOT`.

| Command                                          | Does                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                                          | Release gate for the stitched workspace, then the policy checks below.                                                                  |
| `update-refs [--latest \| --check \| ...]`       | Pins `deploy/release.refs` and refreshes `deploy/workspace/pnpm-lock.yaml`.                                                             |
| `prepare-workspace`                              | Prepares the parent directory as the image build workspace.                                                                             |
| `publish staging`                                | Runs `check`, then tags `staging-<date>-<n>` on `main`.                                                                                 |
| `publish production`                             | Tags `v<date>-<n>` on the commit of a staging release and starts its deploy. Refuses a release without a successful staging deployment. |
| `manifest write\|check\|fetch\|staging-deployed` | Writes, validates and downloads release manifests (schema 1).                                                                           |
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
- `tests/`: `pnpm test:deployment-kit` in the platform root. Not shipped.
