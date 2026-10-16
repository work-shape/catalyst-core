---
section: Added
---

- The deployment kit ships `docker/deployment.Dockerfile`: a deployment builds its six release
  images (api, ui, workspace-command-worker, artifact-preview-worker, doc-worker, runner) from
  its own folder, installing the catalyst packages its lockfile pins with an `npmrc` build
  secret. The runner and document worker images carry only their packages and what those
  depend on. The images keep `/app/deployment.<instance>`, so Compose files are unchanged. The
  kit README holds the bake file a deployment points at it.
- `catalyst-deploy bump VERSION` pins every `@work-shape/catalyst-*` dependency at a version
  npm has, rewrites the deployment's own `pnpm-lock.yaml` (`--ignore-workspace`) and prints the
  release notes in between. `catalyst-deploy pack-local` builds the same images from the
  workspace's platform and capabilities packages packed into `.local-packages/`, for changes not
  yet released.
- For a deployment without `deploy/release.refs`, `catalyst-deploy check` refuses a catalyst
  dependency that is not one exact release (`workspace:`, `file:`, `link:`, ranges, two versions,
  overrides), then gates on the installed release: it refuses `node_modules` that links local
  source. Refusal texts start with `catalyst-deploy:`, for example
  `dependencies.@work-shape/catalyst-ui is workspace:*: a local package never reaches a release`.
  `check --static` runs only the checks that read files; `publish staging` runs it.
- Release manifests of such deployments are schema 2 with `catalystVersion` instead of the
  platform and capabilities commits. `manifest check` still accepts schema 1, so rolling back to
  an earlier release keeps working; `deploy` refuses a schema 2 manifest whose
  `catalystVersion` is not the kit's own version.
- Deployments with `deploy/release.refs` keep `update-refs`, `prepare-workspace` and the
  stitched gate unchanged until they switch (VP-6, VP-7); `bump` and `pack-local` refuse them.
- pnpm drops the integrity of the SheetJS URL tarball whenever it rewrites a lockfile. The kit
  puts back the integrity core's lockfile records after every lockfile it writes (`update-refs`,
  `bump`, `pack-local`). It refuses a lockfile that still resolves a URL tarball without an
  integrity, or with a different one, before anything is compared or written. `check` refuses
  a deployment lockfile an install left without it; `bump` to the pinned version puts it back.
