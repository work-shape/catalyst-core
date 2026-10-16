---
section: Changed
---

- Reconcile publish metadata at the existing lockstep version, 0.7.0: API contract/client,
  asset schemas and CLI are MIT/public; other libraries and deployment-kit are
  UNLICENSED/restricted. Docs, demo, standalone UI, App Kit source and quality tooling stay
  unpublished. Preserve the folded package layout: server ships vendor assets, the standalone
  UI is a private client assembly, and the removed widget, data-source, document-execution and
  registry-canary packages stay absent. Derive the quality graph from manifests.
- Add a visibility/dependency guard and release-tag-only CI: require tag/manifest agreement,
  main or release/* ancestry and the commit's green Check, mirror only public packages,
  publish in dependency order, resume existing versions and verify private names anonymously.
  Candidates use next; older hotfixes use release-X.Y without moving latest backwards.
- Mirror the core lockfile's peer-install setting so public installs keep the tested dependency
  graph, including peer resolutions.
- Inspect capability tarballs and imports in the external consumer too; budget the existing
  standalone artifact-helper bundles at 6.5 MB (measured 5.9 MB).
- No tag or package is released by merging this change. The manager must authorize the
  paired 0.8.0-rc.1 cut and tags. Core needs Actions secrets NPM_TOKEN and PUBLIC_MIRROR_KEY;
  the public repo needs its bootstrap NPM_TOKEN until all four trusted publishers exist.
  VP-5 must add deployment-kit/docker and regenerate metadata when its Dockerfile is built.
  Existing package versions remain available for rollback; never move a tag or unpublish.
- Prune the public lock to reachable importer resolutions before pnpm regenerates it; verify
  frozen installation, builds, publish dry runs and installed dependency parity with core.
  Mirror only the public metadata policy and remove bootstrap change files.
- Pin release npm to 11.21.1. Clear a registry-created candidate latest tag, including on reruns;
  warn and leave latest on a sole candidate if npm refuses removal. Set latest explicitly
  only for final releases that do not move it backwards.
