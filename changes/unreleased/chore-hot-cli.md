---
section: Changed
---

- **Tooling:** The CLI's commands are registered as groups in `config-cli/src/command-groups/<group>.ts`, one line each in `command-groups/index.ts`; `--help` and `commandNames()` are derived from them. Each asset verb lives in `config-cli/src/asset-verbs/<verb>.ts` and declares its own options. The CLI tests are split into `tests/config-cli/<area>.test.ts` over `tests/support/config-cli.ts`, and the CLI reference into `configure/cli/<group>.md` with a generated sidebar. Commands and options are unchanged; `--help` lists the same lines with its sections in group order.
