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
| Database dumps          | `<instance>-<database>-<timestamp>[-<label>].sql.gz`             |
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
`lib/deploy-remote.sh` there: pull, dump the database under `pre-deploy/` (a failed dump aborts
before migrations), migrate, start the services, roll `agent-run-worker` with a drain, and fail
unless every service runs the digest of the release.

`check` starts with `lib/check-deployment-policy.sh`: production Compose pins every first-party
image by digest, `deploy.yml` requires a successful staging deployment, the bake targets are the
image keys of a manifest, and the worker wiring under `verify/` holds. What a worker must not
have (a model key, a signing secret, the Docker socket) is judged on the Compose file as
`docker compose config --no-interpolate` resolves it, with anchors and merge keys applied; the
model key names are the adapters' defaults and every `credentialSecret` and
`organizationSecret` under `config/`. A deployment adds its own
assertions in an executable `deploy/scripts/check-release-policy.sh`, which runs last.

The release gate also starts every built process entry point of the deployment once per
release config (`lib/resolve-entry-points.mjs`): `dist/server.js`, `dist/agent-run-worker.js`,
`dist/workspace-command-worker.js` and `dist/artifact-preview-worker.js`. Its log names the ones
it ran and the ones the deployment does not build. Each is started with the argument
`--resolve-only`, with which a process loads the config, resolves its modules against the build
it was assembled from, makes the checks that need only the two, prints
`resolve-only: this process starts with this config` and ends with code 0 before it opens a
store. A config the schema refuses fails there, and so does a process that would stop on the
host: a module is on that its build ships no code for, or the workspace command worker is built
for a config that turns Execution Workspaces off. An entry point must start its process through
`defineClientInstance` for this. One that ends without the line fails, and one that is still
running after two minutes is killed and fails.

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
