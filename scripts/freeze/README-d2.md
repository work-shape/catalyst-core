# Replay D2

Run from the platform checkout, after installing its workspace dependencies:

```sh
node scripts/freeze/d2-chat-ui.mjs --dry-run
node scripts/freeze/d2-chat-ui.mjs --apply
```

The map is the architect's 2026-10-15 D1/D2 map in Brain. The script resolves imports
with TypeScript before moving files and preserves extensionless specifiers,
including file-versus-directory resolution for `i18n`. It updates source-reading
tests, aliases, guard keys and capacity references. It refuses missing sources,
existing destinations and a second application. Six later sources are optional on the older C branch: agent-unavailable, the day
marker and thread clock, skill-files and skill-form-model, and their translations.
They stay in their existing feature folders under the new parent. Main replaced
`assistant/elapsed-time.ts` with `assistant/thread-time.ts`; the replay skips the
deleted file when its replacement is present.

Replay the separate hand-fix commit after applying the script: knip entry paths,
the rights-words screen list, and the personal-key test's import-path regex. Then
run `pnpm generate:platform-docs` to regenerate the capacity reference. This keeps
other slices' edits to the same docs and generated file intact.

Compare fresh builds of chat-ui before and after replay: all declaration files
(including `src/vite.d.ts`), compressed tarball size (within 1%), API contract,
exports, and baseline counts. The source map keeps the three composition files at
root, approvals and inbox under chat, and no shared imports into the other areas.
No product behavior, package exports, dependencies or migrations change.
