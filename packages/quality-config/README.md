# Workshape Catalyst quality checks

Each repository owns its package manifests, `knip.json`, TypeScript check projects and `quality-baseline.json`. The ESLint configuration, the collector and the baseline comparison live in this package. Capabilities consumes it through its existing sibling platform workspace, not through a copy or a published package.

`pnpm check` builds first, then runs format, lint, compiler checks and tests. Capabilities first builds the platform packages its own packages depend on, not every platform package. The build comes first because some tests and package exports load compiled files. The browser suite is not part of `pnpm check`: it needs a browser and ports of its own, so the platform Check workflow runs `pnpm test:e2e` as a second job beside it.

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

Platform database tests need Postgres via `POSTGRES_STORE_TEST_DATABASE_URL`. Its HTTP tests also open local ports. Both workflows provide Postgres and invoke the same local commands. On a pull request they first run the baseline guard described under [Baselines](#baselines). After `pnpm check` the platform workflow runs two more steps in the same job: `pnpm test:compatibility`, the database tests of the previous and the oldest supported release against the schema of the commit, and `pnpm release:check --skip-build`, which packs and inspects every publishable package. Both run locally against the same database variable; neither is part of `pnpm check`.

`pnpm check:local`, in either repository, is `pnpm check` with its own database. It starts a Postgres 17 container under a unique name on a free local port, points `POSTGRES_STORE_TEST_DATABASE_URL` at it, runs the steps of the check and removes the container when the check ends, fails or is interrupted. In platform, `scripts/check-local.mjs` runs every step after the build side by side and reports each failed step; `CHECK_LOCAL_SERIAL=1` runs them one after another. It needs a running Docker and says so when there is none.

The capabilities lockfile records the platform manifests it was resolved against. The capabilities workflow checks out the platform branch of the same name when it exists, otherwise `main`, because the two repositories move together, so a platform change that adds or changes a dependency leaves that lockfile behind. The workflow therefore installs capabilities without `--frozen-lockfile`: versions the lockfile knows stay pinned, and only what platform changed is resolved fresh. Update the capabilities lockfile with `pnpm install --lockfile-only` in capabilities when convenient; a clean local checkout that installs with `--frozen-lockfile` fails until then.

## What checks what

- **typescript-eslint**, with type information: floating and misused promises, `return-await` inside try, non-null assertions, explicit `any`, unsafe and unnecessary type assertions, and `@ts-` comments.
- **ESLint**: Inline directives are switched off (`noInlineConfig`), so a disable comment suppresses nothing; ESLint warns about each directive and the collector counts that warning as `eslint/inline-config`.
- **eslint-plugin-import-x**, resolving through `tsconfig.lint.json`: `no-relative-packages` rejects a relative path into another package, in `import`, `import()` and `require()`. `no-unresolved` rejects a path that a package does not export, which is what a deep import is.
- **Knip**: unused files, exports, types and dependencies, and imports of a package the manifest does not declare (`knip/unlisted`). Knip does not cover all import locations. The collector enforces workspace dependency declarations across package and client source, tests, scripts, tools, Astro and MDX, and checks package cycles directly from manifests. Vite configs are scanned as source because loading them fails on the chat UI plugin.
- **The `catalyst` ESLint plugin** in `eslint.config.mjs`: no console global in server package sources, with config-cli exempt, logger declarations only in core, environment reads only in the one environment module of a package, which is `src/env.ts` and nothing nested below it (`chat-ui` keeps `src/env.js` for its Vite plugin and `artifact-helpers` keeps `src/lib/env.ts`, both named in the rule), and in no other file of the package, its root and its scripts included; `import.meta.env` is allowed only in the four named frontend entries, global `fetch` only in `api-client` and adapter folders, literal interface text, and the two temporary CB-3b rules for in-memory stores and conditional database skips. Root files such as tests and scripts are outside the boundary rules.
  - The boundary rules find every reference to a global through scope analysis and allow only what they can follow. `console` and `fetch` are reported wherever they are referenced. `process` may only be the object of a static read of something other than `env`, as in `process.argv` or `const { platform } = process`; any other use is reported, because an alias such as `const p = process` reaches `env` unseen. Importing the `process` module is reported too.
  - The host objects `globalThis`, `global`, `window` and `self` follow the same pattern. Their members `console`, `process` and `fetch` are reported by the rule that owns each, and `catalyst/host-object-boundary` reports every use of a host object that is not a static read of a named member: an alias, an argument, a computed key, or one host object read from another.
  - A `typeof` test and a name in a type position read nothing and are allowed.
- **Literal interface text** (`catalyst/literal-text`), in packages and clients: words written directly as JSX text, or as a JSX child or the value of `aria-label`, `aria-description`, `aria-roledescription`, `title`, `placeholder` or `alt`. A value counts when it is a string or a template, a condition, a fallback or a `+` that yields one, with or without a type assertion around it. Text comes from the translations instead, in chat-ui through `t("key")` with the key declared in `src/i18n/<area>.ts`. Text without a letter, such as a separator or a number, is not a finding. The rule reads JSX only and does not follow a value, so it does not find text that reaches the interface through a variable, an object member, a helper call, a `.ts` file, or a custom component prop such as `label`.
- **The job executor boundary** (`catalyst/job-executor-boundary`), in server package sources: a claim query (`skip locked` in a string or template, or Drizzle's `skipLocked`) and `setInterval` belong in `postgres-store/src/jobs/`. A new leased kind registers on the job executor instead of building its own lease. No lease implementation outside the executor remains, so the rule has no exemption for one. Its one list, `processLocalTimers`, names the interval timers that keep state of a single process and are not jobs, each with the file, the function that holds it and the reason. `chat-ui` is not a server package and is outside the rule.
- **The operation runner boundary** (`catalyst/run-operation-boundary`), in server package sources: `runOperation` from `@work-shape/catalyst-tool-execution` is imported, read from a namespace import or exported again in `server/src/operations/operation-face.ts` and in `server/src/apps/action-call.ts` only. The second runs the calls a frame makes through the bridge, whose operation is a named action read from the file set the frame shows. Every other route registers its operation with `route.operation`, so each call is authorized, recorded and replayed in one place. The list `runOperationCallers` in `run-operation-rule.mjs` names the callers; `tool-execution`, which defines the function, is outside the rule.
- **The workspace command boundary** (`catalyst/workspace-command-boundary`), in server package sources: `enqueueWorkspaceCommand`, `getWorkspaceCommand` and `requestWorkspaceCommandCancellation`, read from an object by member access or by destructuring, belong in `tool-execution/src/workspace-command-client.ts`. A tool queues a command and waits for its result through the client's `enqueue` and `await`. `postgres-store`, which implements the store, and `workspace-command-worker.ts`, whose job handler looks for a cancellation request on the row of the command it runs, are outside the rule.
- **The module snapshot boundary** (`catalyst/module-snapshot-boundary`), in server package sources: `config.modules` is read in `config-schema` only, where `resolveModuleSwitches` applies the legacy keys. The assembly resolves those switches against the registry of the modules this build ships, and every other reader takes the `ModuleSnapshot` it hands on. The rule reports a static read of `modules` from anything named `config` and a destructuring of it; it does not follow a config that was given another name.
- **Test support boundaries**: `catalyst/test-api-path`, `catalyst/test-injection` and `catalyst/test-store` reject API literals (including templates), injection (including computed members and destructured aliases), and platform store class imports/construction outside `tests/support/`. Test callers use `createTestInstance` and catalog operation names. Capabilities resolves the same support through its test alias, `#platform-test-support/*`; Vitest, TypeScript and Knip share that mapping.
- **Retired product terms** (`catalyst/retired-terms`): platform opts into this rule in its root ESLint configuration. The short list in `retired-terms-rule.mjs` starts with `Namespace`. Matching is case-insensitive within identifiers, string literals, template segments, JSX names and JSX text, so camel case, plurals, routes and product SQL names count too. The explicit technical exceptions are Postgres `pg_namespace`, `relnamespace`, `pronamespace` and their catalog aliases, ESTree `ImportNamespaceSpecifier`, the phrase `process namespace`, and esbuild's exact plugin identifiers in the two named implementations. An exception never skips the rest of a string, so a product `namespaceId` beside `pg_namespace` still counts. Escaped identifiers and strings are read as their decoded values. Each matching token counts once per term, including a shorthand property visited twice by the parser. Comments and language keywords are outside the check. Platform excludes the rule’s own vocabulary file and the collector test source that holds its negative fixtures; the generated fixtures are checked normally. The existing per-package baseline is a ratchet; NS-RETIRE removes the feature and lowers those counts. Capabilities has not opted in: its XML and document namespaces are separate from this product concept.
- **The collector** in `check.mjs`: package cycles derived from manifests, workspace dependency declarations across package and client source, tests, scripts, tools, Astro and MDX, generated source paths, and cycles between source modules. Modules that import each other form a group, and each member file is one finding, so a file that joins a group raises the count. A new import between two files that are already in the same group is not detected. The three groups on platform are probably type-only imports: `import-x/no-cycle`, which ignores those, finds none.
- **TypeScript**: every package project and the test project, with `noUnusedLocals` and `noUnusedParameters`. A file that several projects share reports once. Astro keeps its own `astro check` target.
- **Prettier**: source and configuration files. A Prettier ignore comment counts as a violation, because it would hide new formatting findings.

ESLint skips `packages/postgres-store/migrations` by path. A folder that is merely named `generated`, `vendor` or `migrations` is linted.

Every message counts, whatever its severity, so a rule set to `warn` still fails. Tool crashes, parse errors and configuration failures are fatal and cannot be baselined.

### Why these parts are our own

- The console, environment and fetch rules could be written with ESLint's `no-restricted-globals` and `no-restricted-properties`, but then they share one rule name. The baseline counts by rule, and console, environment and fetch have different owners.
- The type checks and the lint hold whole TypeScript programs in memory. Every `catalyst-quality` target starts itself again with a 4 GB heap when Node's default for the machine is smaller, which it is on a runner with 8 GB of memory, such as the one a private deployment repository gets. Callers set nothing. The 4 GB are the ceiling and not the working size: a target that nears them is split, not given more.
- The lint runs in parts. One program for the whole repository, built from `tsconfig.lint.json` and checked in one process, needed between 3.1 and 3.3 GB of heap and 39 seconds. `catalyst-quality lint` now takes the files in the order Git lists them, 150 to a part (`lintFilesPerProcess` in `check.mjs`), and starts itself once per part, up to three at a time. Each part builds its program from its own files and what they import, with the compiler options of `tsconfig.lint.json`, and hands it to the parser, so every rule sees the same types as before. Declaration files, and files that declare globals or add to another module, are in every part's program, because they change types in files that never import them. The parts print their findings to the first process, which counts them and runs Knip, the package graph and the module cycles once. Measured on 12 October 2026 on platform, 1,371 files in 10 parts, on a machine with 16 cores: the whole lint passes with a 1,536 MB heap and fails with 1,408 MB, and takes 24 seconds. All 804 findings are the same by rule, file and position; in 11 of them TypeScript prints the members of a union in another order. When a part nears half the ceiling, lower the number of files per part.
- A typed file outside `tsconfig.lint.json` that no file inside it imports used to stop the lint with a parser error. It is now linted with types like any other file.
- For reference, the other targets on the same day: the type check of the tests needs between 2.0 and 2.3 GB, the type check of the packages between 1.5 and 2.0 GB.
- Module cycles use TypeScript's own resolver with the lint project's options, and a short graph search. `import-x/no-cycle` was tried and dropped: on platform ESLint needed 7.5 GB and 38 seconds with it, against 3 GB and 14 seconds without, and ran out of memory at Node's default limit. dependency-cruiser was not tried: it would add a third resolver beside TypeScript's and import-x's, and it reports each edge of a cycle rather than each cycle.
- ESLint's bulk suppressions have no owners and no package scopes, and cover ESLint only. The baseline covers all four tools in one format.

## Merge gate

Platform `main` is protected with this check required once the pipeline runs; Felix can bypass it. Capabilities follows the same gate by convention.

## Baselines

The UI library guard (`tests/ui-guard.test.ts`) uses this same comparator and baseline under
target `ui-guard`, counted by category and package. Its scanner still checks every source file
and stylesheet and holds the library at zero. After a repair, lower only the reported entry;
there is no separate UI baseline or update command. The S9 transfer retains the previous
counts exactly; its acceptance records admit only that transfer, never a later rise.

Rights wording checks discover `// @rights-screen:` and `// @rights-copy:` markers anywhere
under chat-ui source. Keep these markers with the screens and translation modules when moving
folders; mark new rights screens and their copy. `// @service-principal-copy:` adds German
terminology checks to copy outside the rights screens.

The collector compares the exact measured count with each baseline entry by target, rule and package. Literal interface text is counted per folder, so an entry for one folder cannot cover new text in another. A missing entry means zero. A rise fails, and a fall fails until the entry is lowered or removed. No check rewrites the baseline.

A rise names the files that hold the findings for that rule and scope, the first ten, with the number in each. An invalid entry is printed in full.

After repairing a violation, run its target, read the reported difference and lower only that entry. `catalyst-quality <target> --measure` prints every finding with its file and position. The targets are `format`, `lint`, `types:packages` and `types:tests`. `pnpm format` rewrites the files Prettier checks.

Counts may only fall. On a pull request, `baseline-guard.mjs` compares `quality-baseline.json` with the commit where the branch left its base and fails when a count is higher or an entry was added. Both workflows run it before the installation. A pull request that introduces a rule together with its measured entries fails the guard by design, and merging it needs the bypass.

The manager can accept one raise in `acceptedRaises` of `quality-baseline.json`, as `{ key, to, reason, acceptedBy, date }`, where `key` is `target|rule|scope`. The guard then lets that key rise from the merge base to exactly `to`, when the entry is absent at the merge base: an entry that is already on the base branch excuses no later raise. A higher count, or a rise on any other key, still fails.

`platform/tests/quality-baseline.test.ts` tests the comparison and the guard. `platform/tests/quality-collector.test.ts` runs the real collector over a small project that breaks every rule once, including each known way around a rule; weakening a rule or the collection fails it.

Owners are recorded per entry. Test compiler errors belong to CB-2b. Other test findings go to CB-2, browser findings to CB-1b, environment, console and host objects to CB-8c, provider fetch to CB-6a and CB-10a, CLI non-null assertions to PA-1b and its fetch to PA-3. Literal interface text has no entry: every finding is new and fails. Other cleanup findings use CB-8b. See [the measured baseline](BASELINE.md).

## Check limits

A check's limit (a size, length, baseline or timeout it holds the code to) moves only in a pull request of its own that Felix approved, and that pull request lands alone. Each such limit sits on a line that ends with the comment `check-limit` (after `//` or `#`): the tarball limits in `scripts/release/check-packages.mjs`, the test timeouts in `vitest.config.ts` and `playwright.config.ts`, and the job timeouts in `.github/workflows/check.yml`. A new limit gets the marker too.

On a pull request, `limit-guard.mjs` compares the branch with the commit where it left its base. Each limit is known by its file and its place: the enclosing lines of smaller indentation (the job, the object) and its own words (the key), without numbers or punctuation; its value is the numbers on the line, read without digit separators. A limit whose value changed, that was added or removed, or whose marker was dropped has moved. A block that holds a limit is a table of limits: a line with a number added to it is a new limit and has moved, marked or not. Marking an unchanged line, writing `500_000` as `500000` or reordering a block, trailing commas included, is no move. A moved limit passes only when the pull request's title starts with `chore(limits)`, or, where no title is known (the landing lane), when every commit of the branch starts with `chore(limits)`. The hosted check reads the title when its run starts, so the title is set before the push. `platform/tests/limit-guard.test.ts` tests it.

The static job runs the guard on `ci`-label pull request runs and full `workflow_dispatch` runs. Dispatches compare `origin/main` with the dispatched SHA and pass no PR title, so every branch commit must start with `chore(limits)` if a limit moves. This covers foundation changes, including workflow timeouts, that land through a full dispatch. Main pushes also compare the landed commit with `HEAD^` without a title; a squash commit carries the PR title. Release tag pushes skip the guard.

## Open points

1. `rxjs` stays in chat-ui at 7.8.2: the program calls it unused, but the Univer packages require it as a peer. `@ai-sdk/react` was removed.
2. `api-contract` declares its dependency on `core` in the manifest before it imports it. Knip reports the unused dependency, and CB-4a, which introduces the import, owns that entry.

## Source resolution

Package `exports` own the source entry points. `sourceAliases(root)` reads their `development`
conditions (or direct source exports) for Vitest in platform and capabilities. Test-only
subpaths use development-only exports and are omitted from published metadata. TypeScript's
JSON `paths` are a generated cache of the same entries: run `pnpm exec catalyst-quality aliases --write` in each repository after changing exports. Lint rejects a stale cache with the repair command, including when a sibling platform package adds an export. Runtime source requires dependencies, peerDependencies or optionalDependencies; other files and the bundled CLI may also use devDependencies. Demo seed App files are checked by their own build boundary. The explicit
capabilities `#platform-test-support` path remains outside package resolution.

Chat UI tests use public subpaths or `tests/support/chat-ui.ts`, the sole private test seam.
Its named exports and source URLs keep folder moves out of test callers without widening the
published package surface. The platform root ESLint config rejects private static imports,
re-exports, dynamic imports, require calls and type imports everywhere else under tests/.

## Allowed-value lists

`catalyst/duplicate-literal-list` compares literal enums, named arrays, sets, query subsets and literal type unions across package sources. It compares value sets even when their orders differ. Use the constants in `asset-schemas/src/contract-values.ts`, imported through core by private consumers. A subset keeps its own order and uses `as const satisfies readonly ParentValue[]`. Defaults, per-operation error declarations, utility-type field selections and discriminated object branches are outside the check. The Page kit, sandbox asset-repo command and UI library keep their dependency boundaries.

The initial D5 baseline retains recorded disagreements, documented presentation orders and lists outside D5's inventory. It is a ratchet, not permission to reconcile their accepted values during the freeze. A scoped lint still compares against all package sources, so a copy outside the selected package is visible.
