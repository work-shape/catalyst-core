# App Kit

The App's half of the bridge between an App and the interface that shows it, published to Apps as `@work-shape/catalyst-app-kit`. The bridge protocol is version 1 and frozen: changes are additive, and a breaking change is version 2 beside version 1. The messages and calls are listed in the docs page `packages/docs/src/content/docs/reference/app-bridge.md`.

A change to the kit is released as a new kit version with `pnpm --dir platform kit:release`; a released version is never rewritten.

File contents are stored by SHA-256 under `packages/server/vendor/app-kit-shared/`.
Each retained version's unchanged manifest selects its exact bytes; Apps keep loading
`/app-runtime/kit/<version>/<file>`. `kit:release` reuses an identical
shared file and refuses a damaged one. Never remove a shared file a retained manifest pins.
