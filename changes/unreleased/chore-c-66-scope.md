---
section: Changed
---

- Rename workspace packages to `@work-shape/catalyst-*`, including `@work-shape/catalyst-server`, and deployment assembly packages to their explicit Workshape names. Keep stored keys, resource names and host paths unchanged. Publish repository metadata only for the four public edge packages.
- Read actual imports in the workspace dependency check so gallery code examples and seeded Apps keep their existing build boundary after the scope rewrite.
- Keep rebuilding stored Pages with legacy App Kit imports, and allow the CLI itself in the public tarball install check while rejecting workspace dependencies.
