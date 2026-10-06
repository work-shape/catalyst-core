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
image keys of a manifest, and the worker wiring under `verify/` holds. A deployment adds its own
assertions in an executable `deploy/scripts/check-release-policy.sh`, which runs last.

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
