# App Kit

The App's half of the bridge between an App and the interface that shows it, published to Apps as `@work-shape/catalyst-app-kit`. The bridge protocol is version 1 and frozen: changes are additive, and a breaking change is version 2 beside version 1. The messages and calls are listed in the docs page `packages/docs/src/content/docs/reference/app-bridge.md`.

A change to the kit is released as a new kit version with `pnpm --dir platform kit:release`; a released version is never rewritten.
