---
section: Changed
---

- **Tooling:** Each browser spec's own seed users live in `tests/fixtures/e2e-users/<spec>.yaml`; `scripts/e2e-config.mjs` composes them into the suite's config in file name order and refuses an email listed twice, so two specs no longer edit the same lines of `tests/fixtures/e2e-app.yaml`.
- **Tooling:** A page error that one spec's tests cause on purpose is allowed in that spec, with `test.use({ allowedPageErrors: [...] })`, instead of in the shared `e2e/allowed-page-errors.ts`, which keeps only the 6 entries several specs meet. Every entry is unchanged.
