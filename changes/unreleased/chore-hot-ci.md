---
section: Changed
---

- **Tooling:** The browser suite uploads every screenshot a spec keeps for review in one step, as the artifact `evidence-<shard>`: a spec names such a file `evidence-<name>.png` and no longer adds an upload step to `check.yml`. The release tooling job runs every `scripts/release/*.test.mjs`; the real pnpm proof is `scripts/release/mirror-proof.mjs`, still run by `pnpm test:release:mirror`. `catalyst-quality aliases --write` writes the paths of `tsconfig.base.json` sorted by name, so a new package's line lands beside its neighbours by name.
