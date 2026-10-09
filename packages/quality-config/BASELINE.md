# Measured quality baseline

Counts are exact by target, rule and package in each repository's `quality-baseline.json`. Large files are scoped per file. Zero counts are left out and fail on their first violation. Measured on platform `218cd58` and capabilities `d050a54` with this ticket's changes.

| Target         | Rule                                               | Tool              | Platform | Capabilities | Owners                                                                                                         |
| -------------- | -------------------------------------------------- | ----------------- | -------: | -----------: | -------------------------------------------------------------------------------------------------------------- |
| format         | `prettier`                                         | Prettier          |        3 |          236 | CB-2, CB-6b, CB-8b, CS-5                                                                                       |
| lint           | `@typescript-eslint/ban-ts-comment`                | typescript-eslint |        1 |            0 | CB-2                                                                                                           |
| lint           | `@typescript-eslint/no-floating-promises`          | typescript-eslint |       67 |            2 | CB-10a, CB-6b, EW-1, G-5c                                                                                      |
| lint           | `@typescript-eslint/no-misused-promises`           | typescript-eslint |       16 |            0 | G-5c                                                                                                           |
| lint           | `@typescript-eslint/no-non-null-assertion`         | typescript-eslint |      205 |           10 | CB-1b, CB-2, PA-1b                                                                                             |
| lint           | `@typescript-eslint/no-unnecessary-type-assertion` | typescript-eslint |      148 |           17 | CB-10a, CB-2, CB-4a, CB-6b, CB-7c, CB-8b, G-5c                                                                 |
| lint           | `@typescript-eslint/no-unsafe-type-assertion`      | typescript-eslint |      299 |          277 | AP-1, CB-10a, CB-1b, CB-2, CB-3a, CB-4d, CB-6b, CB-7c, CB-8b, CS-2, EW-1, G-5c, PA-1b                          |
| lint           | `@typescript-eslint/return-await`                  | typescript-eslint |        1 |            2 | CB-6b, PA-1b                                                                                                   |
| lint           | `catalyst/console-boundary`                        | ESLint plugin     |       25 |            2 | CB-8c                                                                                                          |
| lint           | `catalyst/database-skip`                           | ESLint plugin     |       10 |            0 | CB-3b                                                                                                          |
| lint           | `catalyst/env-boundary`                            | ESLint plugin     |       15 |           47 | CB-8c                                                                                                          |
| lint           | `catalyst/fetch-boundary`                          | ESLint plugin     |       15 |            2 | CB-6a, CB-10a, PA-3                                                                                            |
| lint           | `catalyst/host-object-boundary`                    | ESLint plugin     |        1 |            0 | CB-8c                                                                                                          |
| lint           | `catalyst/memory-store`                            | ESLint plugin     |       78 |            4 | CB-3b                                                                                                          |
| lint           | `catalyst/module-cycle`                            | Collector         |       16 |           11 | CB-4d, CB-8b, G-5c                                                                                             |
| lint           | `eslint/inline-config`                             | ESLint            |        1 |            0 | G-5c                                                                                                           |
| lint           | `import-x/no-relative-packages`                    | import-x          |      222 |           29 | CB-2, CB-8b                                                                                                    |
| lint           | `knip/binaries`                                    | Knip              |        0 |            1 | CB-2                                                                                                           |
| lint           | `knip/dependencies`                                | Knip              |        5 |            0 | CB-4a, CB-4d, CB-8b                                                                                            |
| lint           | `knip/devDependencies`                             | Knip              |        6 |            2 | CB-6b, CB-8b                                                                                                   |
| lint           | `knip/duplicates`                                  | Knip              |        3 |            0 | CB-4a, CS-5                                                                                                    |
| lint           | `knip/exports`                                     | Knip              |       44 |           13 | CB-3a, CB-4b, CB-4d, CB-6b, CB-7c, CB-8b, G-5c                                                                 |
| lint           | `knip/files`                                       | Knip              |        1 |            1 | CB-4b, CB-8b                                                                                                   |
| lint           | `knip/types`                                       | Knip              |      140 |           33 | CB-10a, CB-4b, CB-4d, CB-7c, CB-8b, EW-1, G-5c                                                                 |
| lint           | `knip/unlisted`                                    | Knip              |       63 |            7 | CB-2                                                                                                           |
| lint           | `max-lines`                                        | ESLint            |       42 |           23 | AP-3, C-126, CB-10a, CB-1b, CB-2, CB-3a, CB-3b, CB-7c, CB-8a, CB-9, EW-1, G-5c, LU-1, MD-1, NL-1, PA-1a, PA-1b |
| types:packages | `typescript/unused`                                | TypeScript        |       15 |           16 | CB-10a, CB-2, CB-3a, CB-4d, CB-7c, CB-8b, EW-1, G-5c                                                           |
| types:tests    | `typescript/test-errors`                           | TypeScript        |      216 |           24 | CB-2b                                                                                                          |
| types:tests    | `typescript/unused`                                | TypeScript        |       18 |           17 | CB-10a, CB-2, CB-3a, CB-4d, CB-7c, CB-8b, EW-1, G-5c                                                           |

Explicit `any`, unresolved imports, declared graph drift, package cycles, formatting suppressions and package type errors measure zero in both repositories.

Platform non-null assertions are 20 in config-cli (PA-1b), 183 in tests (CB-2) and 2 in e2e (CB-1b). Capabilities has 10 in tests (CB-2). No non-null assertion remains in product source outside config-cli.

Platform test compiler errors are 215 in `tests` and one imported CSS declaration error in chat-ui. Capabilities has 24 in `tests`. CB-2b owns all of them.

The relative imports into another package are almost all tests that import a package's source files directly (219 in platform `tests`, 3 in `scripts`). CB-2 owns the test entries.

Module cycles count one finding per member file. Platform has three groups with 4, 6 and 6 members (chat-server, chat-ui, core), capabilities has five groups with 11 members in all, in artifact-helpers.

Capabilities environment findings include the 30 artifact-helper CLI entries that pass the whole `process` object to the command runner.

C-126 owns the 16 artifact-helper source and script files over 800 lines.
