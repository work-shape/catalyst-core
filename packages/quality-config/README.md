# Workshape Catalyst quality checks

Each repository owns its `quality-package-graph.json`, `knip.json`, TypeScript check projects and `quality-baseline.json`. The ESLint configuration, the collector and the baseline comparison live in this package. Capabilities consumes it through its existing sibling platform workspace, not through a copy or a published package.

`pnpm check` builds first, then runs format, lint, compiler checks, tests and the named CB-1b browser placeholder. Capabilities first builds the sibling platform packages. The build comes first because some tests and package exports load compiled files. The browser placeholder runs no browser tests; the follow-up after CB-1a and CB-1b replaces it and adds the workflow job.

## Clean checkouts

Use Node 22 or newer and pnpm 10.29.3. Platform is its own workspace:

```sh
cd platform
pnpm install --frozen-lockfile
pnpm check
```

Capabilities requires a platform checkout at `../platform`, as its committed `pnpm-workspace.yaml` specifies. Its installation also installs those platform packages:

```sh
cd capabilities
pnpm install --frozen-lockfile
pnpm check
```

Platform database tests need Postgres via `POSTGRES_STORE_TEST_DATABASE_URL`. Its HTTP tests also open local ports. Both workflows provide Postgres and invoke the same local commands.

The capabilities lockfile records the platform manifests it was resolved against. A platform change that adds or changes a dependency needs a matching capabilities lockfile update, or the frozen installation of capabilities fails. The capabilities workflow checks out platform `main` on purpose, because the two repositories move together.

## What checks what

- **typescript-eslint**, with type information: floating and misused promises, `return-await` inside try, non-null assertions, explicit `any`, unsafe and unnecessary type assertions, and `@ts-` comments.
- **ESLint**: `max-lines` at 800 lines. Inline directives are switched off (`noInlineConfig`), so a disable comment suppresses nothing; ESLint warns about each directive and the collector counts that warning as `eslint/inline-config`.
- **eslint-plugin-import-x**, resolving through `tsconfig.lint.json`: `no-relative-packages` rejects a relative path into another package, in `import`, `import()` and `require()`. `no-unresolved` rejects a path that a package does not export, which is what a deep import is.
- **Knip**: unused files, exports, types and dependencies, and imports of a package the manifest does not declare (`knip/unlisted`). That last check is what holds imports to the declared package graph. Vite configs are scanned as source because loading them fails on the chat UI plugin.
- **The `catalyst` ESLint plugin** in `eslint.config.mjs`: console only in a package's CLI entry, environment reads only in a package's `src/env.ts`, global `fetch` only in `api-client` and adapter folders, and the two temporary CB-3b rules for in-memory stores and conditional database skips. The three boundary rules find every reference to the global through scope analysis, so destructuring and aliasing do not hide one, and the environment rule also rejects importing the `process` module. Root files such as tests and scripts are outside these three rules.
- **The collector** in `check.mjs`: the declared package graph against the manifests in both directions, cycles in the declared graph, and cycles between source modules.
- **TypeScript**: every package project and the test project, with `noUnusedLocals` and `noUnusedParameters`. A file that several projects share reports once. Astro keeps its own `astro check` target.
- **Prettier**: source and configuration files. A Prettier ignore comment counts as a violation, because it would hide new formatting findings.

Every message counts, whatever its severity, so a rule set to `warn` still fails. Tool crashes, parse errors and configuration failures are fatal and cannot be baselined.

### Why these parts are our own

- The three boundary rules could be written with ESLint's `no-restricted-globals` and `no-restricted-properties`, but then they share one rule name. The baseline counts by rule, and console, environment and fetch have different owners.
- Module cycles use TypeScript's own resolver with the lint project's options, and a short graph search. `import-x/no-cycle` was tried and dropped: on platform ESLint needed 7.5 GB and 38 seconds with it, against 3 GB and 14 seconds without, and ran out of memory at Node's default limit. dependency-cruiser was not tried: it would add a third resolver beside TypeScript's and import-x's, and it reports each edge of a cycle rather than each cycle.
- ESLint's bulk suppressions have no owners and no package scopes, and cover ESLint only. The baseline covers all four tools in one format.

## Merge gate

Platform `main` is protected with this check required once the pipeline runs; Felix can bypass it. Capabilities follows the same gate by convention.

## Baselines

The collector compares the exact measured count with each baseline entry by target, rule and package. Large files are counted per file. A missing entry means zero. A rise fails, and a fall fails until the entry is lowered or removed. No check rewrites the baseline.

After repairing a violation, run its target, read the reported difference and lower only that entry. `catalyst-quality <target> --measure` prints every finding with its file and position. The targets are `format`, `lint`, `types:packages` and `types:tests`. `pnpm format` rewrites the files Prettier checks.

`platform/tests/quality-baseline.test.ts` tests the comparison. `platform/tests/quality-collector.test.ts` runs the real collector over a small project that breaks every rule once, including each known way around a rule; weakening a rule or the collection fails it.

Owners are recorded per entry. Test compiler errors belong to CB-2b. Other test findings go to CB-2, browser findings to CB-1b, environment and console to CB-8c, provider fetch to CB-6a and CB-10a, CLI non-null assertions to PA-1b and its fetch to PA-3. Other cleanup findings use CB-8b. See [the measured baseline](BASELINE.md).

## Open points

1. The 16 capabilities artifact-helper files over 800 lines have `owner: "OPEN"`. The program names no slice that retires them, and the architect assigns one before the merge. Their counts still cannot rise.
2. `rxjs` stays in chat-ui at 7.8.2: the program calls it unused, but the Univer packages require it as a peer. `@ai-sdk/react` was removed.
3. `api-contract` declares its dependency on `core` in the graph and the manifest before it imports it. Knip reports the unused dependency, and CB-4a, which introduces the import, owns that entry.
4. Literal interface text is not measured here. CB-8a adds that rule and its baseline entries.
