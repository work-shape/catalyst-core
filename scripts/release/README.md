# Release validation and publication

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

After installing core, run the real mirror proof through the workspace heavy lane:

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
and `build:ui` commands and requires their artifacts, as the kit's check does. Only
Catalyst package overrides select local tarballs; third-party ranges resolve afresh.
Dispatch `gh workflow run release.yml --ref <branch>` to prove this gate without
publishing. Dispatches have their own concurrency group and cannot hold up a tag release.
