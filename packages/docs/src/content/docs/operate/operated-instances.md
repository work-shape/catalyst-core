---
title: Operated Instances
description: Set up, release and back up an instance operated with the deployment kit on one Hetzner VM per environment.
---

An operated instance runs on one Hetzner Cloud VM per environment, usually `staging` and
`production`. Each VM runs Docker Compose: Caddy with TLS, the API, the interface, the workers,
the command containers and Postgres. Two Hetzner Object Storage buckets per environment hold the
files and the database backups, and Cloudflare holds the DNS records. The images are on GHCR. A
release is a manifest of image digests that staging runs first and production runs unchanged.

This page holds what every such instance needs. The commands of the release and deploy tooling
are in `packages/deployment-kit/README.md`. What belongs to one instance, such as its hostnames,
buckets, model providers and approvals, stays in the README and `docs/` of its deployment repo.

## Repositories

An instance is built from three repositories, checked out next to each other:

| Checkout                 | Repository                                  | Visibility |
| ------------------------ | ------------------------------------------- | ---------- |
| `platform/`              | `vivd-solutions/vivd-catalyst`              | public     |
| `capabilities/`          | `vivd-solutions/vivd-catalyst-capabilities` | private    |
| `deployment.<instance>/` | `vivd-solutions/deployment.<instance>`      | private    |

The deployment repo builds the images, because it owns the combination of platform,
capabilities, client assembly, registry names and deploy rights. Its layout is the same in every
instance:

| Path                                                        | What it is                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/client.ts`                                             | The client assembly: capabilities, tools and hooks of this instance.                                    |
| the rest of `src/`, `index.html`, `vite.config.ts`          | One entry point per process (`server.ts`, the workers, `migrate.ts`, `seed-auth.ts`) and the interface. |
| `config/`                                                   | Release config, one base file and an overlay per environment.                                           |
| `config-assets/`                                            | CLI working copies of agents and skills, one folder per environment.                                    |
| `docker-compose.yml`                                        | The local development stack.                                                                            |
| `docker-compose.prod.yml`, `deploy/Caddyfile`               | What runs on a VM.                                                                                      |
| `deploy/docker-bake.hcl`, `.github/workflows/`              | The image builds, the deploy workflow and a manual build workflow.                                      |
| `deploy/deployment.env`                                     | The kit's one input.                                                                                    |
| `deploy/release.refs`, `deploy/workspace/pnpm-lock.yaml`    | The pinned platform and capabilities commits, and the lockfile CI builds from.                          |
| `deploy/scripts/check-release-policy.sh`                    | The instance's own release assertions.                                                                  |
| `infra/terraform/`                                          | The module `compose-host` and one root per environment.                                                 |
| `.env.example`, `.env.staging.example`, `.env.prod.example` | The local env file, and the templates of the env files on the VMs.                                      |
| `docs/`                                                     | Runbooks and decisions of this instance.                                                                |

The Compose files, the Caddyfile, the bake file, the workflows and the Terraform module are
copied from one deployment repo to the next. The kit does not ship them.

## Accounts and tokens

Provider tokens stay out of Git. On the workstation they live in an untracked `.env.deploy` at the
workspace root, the directory that holds `platform/` and the deployment checkouts:

```sh
CLOUDFLARE_API_TOKEN=replace-with-token
CLOUDFLARE_ZONE_ID=replace-with-zone-id
HETZNER_API_TOKEN=replace-with-hetzner-project-token
HETZNER_OBJECT_STORAGE_ACCESS_KEY=replace-with-object-storage-access-key
HETZNER_OBJECT_STORAGE_SECRET_KEY=replace-with-object-storage-secret-key
GITHUB_TOKEN=replace-with-bootstrap-token
GHCR_USERNAME=replace-with-github-username-or-bot
GHCR_PULL_TOKEN=replace-with-read-packages-token
```

Load it in the shell that runs Terraform, from the deployment repo:

```sh
source ../platform/packages/deployment-kit/lib/load-deploy-env.sh
```

The script exports `HCLOUD_TOKEN`, which the Hetzner provider reads, from `HETZNER_API_TOKEN`, and
the zone id and the Object Storage key pair as `TF_VAR_` variables. It stops when one of them is
empty. Without an argument it reads `.env.deploy` at the workspace root, from any directory; an
argument names another file.

- **Cloudflare.** Use an account token when one token should manage several zones. It needs
  `Zone` → `Zone` → `Read` and `Zone` → `DNS` → `Edit`. Give it all zones only when it is meant
  to be reused, otherwise the one zone of the instance. The zone id is on the zone's Overview
  page, in the API section of the right sidebar.
- **Hetzner Cloud.** A project API token. `HETZNER_API_TOKEN` is only the local name for it.
- **Hetzner Object Storage.** Files and backups go through its S3-compatible API. Hetzner
  documents bucket creation with Terraform through the `aminueza/minio` provider, with S3
  credentials generated in the Hetzner Console. Create one key pair for the Terraform bootstrap;
  Terraform creates the buckets of both environments with it. The env files on the VMs may use the same pair
  during bootstrap; split it into narrower keys per bucket once the console's restrictions are
  set up. The backup script reads a pair of its own, `BACKUP_AWS_ACCESS_KEY_ID` and
  `BACKUP_AWS_SECRET_ACCESS_KEY`.
- **GitHub.** `GITHUB_TOKEN` is for bootstrapping on the workstation only. GitHub Actions does
  not allow a secret of that name, so the workflows read their token as
  `CROSS_REPO_CHECKOUT_TOKEN`.
- **GHCR.** A token with `read:packages` lets a VM pull the images. It goes into the VM's env
  file as `GHCR_USERNAME` and `GHCR_PULL_TOKEN`, and a deploy logs in with them.

## GitHub

The deployment repo has one repository secret, `CROSS_REPO_CHECKOUT_TOKEN`, which reads the
private capabilities repository during a build.

It has two GitHub Environments, `staging` and `production`. `production` requires a reviewer
before its deploy job runs; `staging` needs none once the first deploy works. Each Environment
holds two secrets:

- `DEPLOY_HOST`: the SSH host of that environment's VM.
- `DEPLOY_SSH_PRIVATE_KEY`: the private half of the deploy key whose public half Terraform
  installs for the user `deploy`.

Nothing else goes into GitHub. The workflow token pushes the images and the build cache to GHCR
and creates the GitHub release with the manifest. Model provider keys and object store keys stay
in the env file on the VM, because the deploy workflow ships only images and Compose wiring.

Make a deploy key for the instance instead of using a personal key. One key for both
environments works, and so does one per environment:

```sh
ssh-keygen -t ed25519 -N "" -C "github-actions-<instance>-deploy" -f ~/.ssh/<instance>-deploy
```

Terraform reads the public half from the path in `ssh_public_key_path`.

## Terraform

The module `infra/terraform/modules/compose-host` creates, per environment:

- one Hetzner Cloud server for Docker Compose;
- a Hetzner firewall that opens SSH, HTTP and HTTPS;
- the Cloudflare DNS records of the environment's hostnames;
- the files bucket and the backup bucket, with the rules under [Bucket retention](#bucket-retention).

Apply staging first, then production:

```sh
cd infra/terraform/environments/staging
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

Git ignores `terraform.tfvars`, the state and the provider lock. The state is local during
bootstrap. Before production changes depend on it, move it to a remote backend, such as a bucket
in Hetzner Object Storage or Terraform Cloud, and write the backend down in the deployment repo.

The server type is a variable of each root. Check the prices in the Hetzner API or console before
changing the server family; a newer generation is not always cheaper. On 2026-06-20 the API
listed lower monthly gross prices for the `cx` line than for `cpx22`.

## The host

Compose on a VM reads `/etc/vivd-catalyst/<instance>/app.env`. Start the file from
`.env.staging.example` or `.env.prod.example`, replace every placeholder, and keep it readable by
root and the group `deploy` only:

```sh
sudo install -d -o root -g deploy -m 0750 /etc/vivd-catalyst/<instance>
sudo install -o root -g deploy -m 0640 app.env /etc/vivd-catalyst/<instance>/app.env
```

- `CLIENT_CONFIG_PATH` selects the release config, for example
  `/app/deployment.<instance>/config/app.production.yaml`.
- `PUBLIC_HOSTNAMES` lists every hostname Caddy serves, separated by commas.
- A deploy writes `IMAGE_REPOSITORY`, `IMAGE_TAG` and the image digests into the file. Leave them
  to it.

A host can keep a small zram swap device for short memory peaks, without writing process memory
to disk. It is a safety buffer, not capacity: sustained use means the host or the runner limits
need changing. Before raising the number of commands a worker runs at once, watch sustained swap
use, host memory pressure and the working sets of concurrent runners. The kit's script sets up a
2 GB device with swappiness 20:

```sh
rsync -az ../platform/packages/deployment-kit/host/configure-zram.sh deploy@<host>:/tmp/configure-zram.sh
ssh deploy@<host> 'chmod +x /tmp/configure-zram.sh && sudo /tmp/configure-zram.sh'
```

The script can run again without harm. It installs the optional Ubuntu kernel module that zram
needs and keeps that module installed across generic kernel updates. Change `ZRAM_SIZE` or
`ZRAM_SWAPPINESS` only after looking at the host's workload and memory pressure.

## Releases

A release is a list of image digests. CI builds it once, for staging, and production runs the
same images. Nothing is rebuilt on the way to production.

```text
pnpm publish:staging      tags staging-<date>-<n> on main
  -> CI: release checks and image builds in parallel
  -> CI: release-manifest.json on the GitHub release of the tag
  -> CI: deploys the manifest to staging

pnpm publish:prod         tags v<date>-<n> on the commit of the staging release
  -> copies the manifest to the GitHub release of the v* tag
  -> CI: fetches the manifest, requires a successful staging deployment,
         deploys the same digests to production
```

`.github/workflows/deploy.yml` is the only deploy path.

- `pnpm publish:staging` runs the release gate locally, then creates and pushes the next annotated
  `staging-*` tag. The tag starts the build and the deploy.
- `pnpm publish:prod` promotes the staging release of `origin/main`, and
  `pnpm publish:prod --release staging-<...>` promotes another one. It refuses a release without a
  manifest or without a successful staging deployment, and the workflow checks both again.
- The `:watch` variants, such as `pnpm publish:staging:watch`, follow the deploy run until it ends.
- A manual run of the workflow never builds. It deploys the manifest of the tag it was started
  from, so every production release was a staging release first.

To roll back, run the workflow from an earlier release tag. It deploys the digests, the Compose
file and the Caddyfile of that tag:

```sh
gh workflow run deploy.yml --ref v2026.10.01-1 -f environment=production
```

Staging works the same with `-f environment=staging` and a `staging-*` tag. A rollback changes
the application only. Migrations only move forward, so a release keeps working on the schema of
the release after it; read the rollback notes of the platform changelog for the releases in
between before rolling back. To go back to an earlier database, restore a backup.

### The release gate

`pnpm release:check` runs `catalyst-deploy check`. It starts with the deploy policy of the Compose
file, the bake file and the workflow. Then it checks the committed lockfile and the env examples,
installs the stitched workspace, runs the platform and capabilities checks, builds the deployment
assembly and starts every built entry point once per release config with `--resolve-only`. It
renders the production Compose file against the example env files, validates the Caddyfile, and
ends with `deploy/scripts/check-release-policy.sh`. `pnpm publish:staging` runs it before tagging
and the workflow runs it again beside the image builds; the manifest is published only when it
passed. The kit README has the policy it enforces.

### The manifest

The manifest is the asset `release-manifest.json` on the GitHub release of the tag. GitHub
releases hold it because the repository has them already, and both CI and a workstation read them
with `gh`, without another registry or tool. Staging releases are marked as pre-releases.

```json
{
  "schema": 1,
  "release": "staging-2026.10.07-1",
  "commits": {
    "deployment": "<deployment commit sha>",
    "platform": "<platform commit sha>",
    "capabilities": "<capabilities commit sha>"
  },
  "images": {
    "api": "ghcr.io/vivd-solutions/vivd-catalyst-acme-api@sha256:...",
    "ui": "...-ui@sha256:...",
    "doc-worker": "...-doc-worker@sha256:...",
    "workspace-command-worker": "...-workspace-command-worker@sha256:...",
    "artifact-preview-worker": "...-artifact-preview-worker@sha256:...",
    "runner": "...-catalyst-runner-base@sha256:..."
  }
}
```

`catalyst-deploy manifest` writes, fetches and validates manifests (`fetch TAG FILE`,
`check FILE`) and checks the staging deployment (`staging-deployed FILE`). A successful staging
deployment means that the GitHub Environment `staging` has a successful deployment for the
release tag and its commit; the deploy job records it. The deploy job also requires that the kit
it runs is the platform commit the manifest names.

### Pinned source refs

The build reads `deploy/release.refs` from the tagged deployment commit:

```text
PLATFORM_REF=<platform commit sha>
CAPABILITIES_REF=<capabilities commit sha>
```

The platform pin is also the version of the kit: CI checks the kit out at `PLATFORM_REF`, and
`pnpm release:check` refuses a local platform checkout at another commit.

`pnpm release:update` sets the refs, and `pnpm release:update --latest` pins both repositories to
`origin/main`. It also writes `deploy/workspace/pnpm-lock.yaml`, the dependency resolution CI
builds from. Commit the two files together; the release checks fail when they disagree. After a
change to `package.json`, run the command without arguments to refresh the lockfile for the
current refs.

Before moving the platform pin, read the platform changelog between the two commits: the sections
of `CHANGELOG.md` and the change files in `changes/unreleased/`, which `pnpm changelog` prints as
the release will read. They name the config keys a new release refuses.

## Images

A release has six images, built from `deploy/docker-bake.hcl`:

| Manifest key               | Image                                          | Used by                                 |
| -------------------------- | ---------------------------------------------- | --------------------------------------- |
| `api`                      | `${IMAGE_REPOSITORY}-api`                      | `api`, `agent-run-worker`, `migrate`    |
| `ui`                       | `${IMAGE_REPOSITORY}-ui`                       | `ui`                                    |
| `doc-worker`               | `${IMAGE_REPOSITORY}-doc-worker`               | `doc-worker`                            |
| `workspace-command-worker` | `${IMAGE_REPOSITORY}-workspace-command-worker` | `workspace-command-worker`              |
| `artifact-preview-worker`  | `${IMAGE_REPOSITORY}-artifact-preview-worker`  | `artifact-preview-worker`               |
| `runner`                   | `${IMAGE_REPOSITORY}-catalyst-runner-base`     | started by the workspace command worker |

`IMAGE_REPOSITORY` comes from `deploy/deployment.env`, for example
`ghcr.io/vivd-solutions/vivd-catalyst-acme`. Production Compose names each image as
`${IMAGE_REPOSITORY}-<suffix>:${IMAGE_TAG}@${<NAME>_IMAGE_DIGEST}`. Docker resolves the digest;
the tag only names the release in `docker ps`. Every deploy writes `IMAGE_REPOSITORY`, `IMAGE_TAG`
(the staging release tag) and the six digests into the env file.

The images `api`, `ui`, `workspace-command-worker` and `artifact-preview-worker` come from one
Dockerfile and build in one `docker buildx bake` run, so the dependency install and the server
build run once. The document worker and the runner build in jobs of their own. Images with a slow
system layer keep a registry build cache under the tag `buildcache`.

To build locally, run from the workspace root:

```sh
docker buildx bake -f deployment.<instance>/deploy/docker-bake.hcl client
```

The manual workflow `.github/workflows/build-images.yml` runs the same builds from any ref,
without a release and without a deploy. Its input `push_images` defaults to `false`.

## Deploy

The kit README lists what `catalyst-deploy deploy` does on the VM: it pulls the images of the
manifest by digest, backs up the database, migrates, starts the services, rolls the agent-run
worker and runs the upload check. It also checks the API's health, and it fails unless every
service runs the image of the release. Agent-run workers of the previous release that still drain
are the one exception.

The workflow calls it. For the first setup or a break-glass deploy, check out the release tag and
the platform commit of its `deploy/release.refs` first, so that the Compose file and the kit match
the release. Then, from the deployment repo:

```sh
kit=../platform/packages/deployment-kit/bin/catalyst-deploy
"$kit" manifest fetch staging-2026.10.07-1 /tmp/release-manifest.json
"$kit" deploy --host staging.chat.example.com --manifest /tmp/release-manifest.json
```

A deploy is done when every container on the host runs and one signed-in action worked, not when
the script ends.

## Backups

Every deploy puts the kit's `backup-postgres.sh` and `restore-postgres.sh` into the app directory,
`/opt/vivd-catalyst/<instance>`. The kit README says what a backup holds and how `list`, `verify`
and `recover` work. The scripts find the backup bucket in the env file:

- `BACKUP_OBJECT_STORE_ENDPOINT`
- `BACKUP_OBJECT_STORE_BUCKET`
- `BACKUP_OBJECT_STORE_REGION`
- `BACKUP_AWS_ACCESS_KEY_ID`
- `BACKUP_AWS_SECRET_ACCESS_KEY`

Every deploy also writes the systemd unit and timer to `deploy/systemd/` in the app directory.
Install them once, after the first deploy:

```sh
cd /opt/vivd-catalyst/<instance>
sudo cp deploy/systemd/vivd-catalyst-<instance>-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vivd-catalyst-<instance>-backup.timer
```

The timer runs at 02:15 UTC and writes under the key prefix `postgres/`. A deploy writes under
`pre-deploy/`, with the release tag in the name, before it migrates. Test a restore on staging
before production holds real data: take a backup, verify it in a scratch database and recover from
it.

## Bucket retention

The module `compose-host` sets the same lifecycle rules on both environments. Its defaults:

| Bucket  | Keys                                         | Rule                                                                        |
| ------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| backups | `postgres/`, the nightly backups             | deleted 35 days after upload                                                |
| backups | `pre-deploy/`, backups taken before a deploy | deleted 90 days after upload                                                |
| files   | the prefixes the application writes          | versioned; a deleted or overwritten object is removed for good 7 days later |

Hetzner runs lifecycle rules on its own schedule, so an object disappears some time after it
passes its window, not at an exact moment.

Backups:

- The backup bucket is not versioned. An expired backup cannot be recovered.
- A rule matches by key prefix only. A backup gets the 90-day window only when it is uploaded under
  `pre-deploy/` (`BACKUP_PREFIX=pre-deploy`). One under `postgres/` expires after 35 days, whatever
  its file name says.
- Keys outside both prefixes never expire. Upload backups nowhere else.
- A backup holds every conversation and audit row that existed when it was taken. Data the
  application has deleted stays in backups for up to 35 days, or 90 days in a pre-deploy backup.

Files:

- The application deletes an object without naming a version. With versioning that hides the
  object and keeps its bytes as a noncurrent version. The lifecycle rule removes that version 7
  days later, then the delete marker left behind.
- A file the application has deleted, by a user, by the retention job or with an account, is gone
  from the application at once and from storage up to 7 days later. When someone asks how long
  files are kept, quote `retention.conversationDays` plus these 7 days, counted as
  [Governance](/operate/governance/#retention) describes, not the application's window alone.
- The rule never expires current objects. Only the application removes those.
- A prefix without a rule keeps its deleted objects in the versioned bucket for good. The
  application writes uploaded documents under `documents/`, and with the module `apps` on also
  Pages under `pages/` and asset files under `assets/`, so the rules have to name all three there.
- To erase a file before the window ends, delete its versions by id, as Hetzner's
  [versioning guide](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/protect-versioning/)
  describes. To recover a deleted file inside the window, remove its delete marker, or copy the
  noncurrent version back onto the same key.

Hetzner specifics, checked against its documentation on 2026-10-06:

- Lifecycle rules support `Expiration` by days, `NoncurrentVersionExpiration` with
  `NoncurrentDays` only, `ExpiredObjectDeleteMarker` and `AbortIncompleteMultipartUpload`.
- Every rule needs a non-empty key prefix. For a rule without a prefix the `aminueza/minio`
  provider sends an `ObjectSizeGreaterThan` filter, which Hetzner does not document.
- The provider (3.38) does not send `abort_incomplete_multipart_upload`, so these rules leave the
  parts of a failed backup upload behind.

## Model providers

Before a model provider serves staging or production, run a smoke test against it with synthetic
prompts only, and keep to synthetic data until its residency, processing agreement and retention
controls are approved. An EU endpoint alone proves no residency: the provider account or project
has to be confirmed as EU-resident as well. Provider keys live in the env file of each VM, never
in Git or GitHub. Which providers an instance may use, and the record of each approval, belong to
that instance.

## Local development

A deployment repo starts its local stack with:

```sh
cp .env.example .env
pnpm dev
```

The development Compose stack runs Postgres, S3Mock, the API, the workers and the interface. Each
deployment repo uses ports of its own, so the stacks of several instances can run at once.

`pnpm dev` fingerprints the dependency manifests, the lockfiles, the Dockerfiles and the Compose
build configuration, and builds images only when one of them changed or an image is missing.
Otherwise it starts the existing images and attaches Compose watch with an initial source sync.
Compose watch copies TypeScript and config changes into the containers, where the API and the
workers run from TypeScript in watch mode and Vite reloads the interface. A source edit therefore
rebuilds no image, also in the document worker.

- `pnpm dev:rebuild` discards the saved fingerprint and rebuilds every development image.
- `pnpm dev:runner` rebuilds the runner image. `pnpm dev` builds it only when its local tag is
  missing, so run this after changing the runner Dockerfile or the artifact helpers, then restart
  the stack.
- `pnpm dev:db` starts only Postgres and S3Mock.
