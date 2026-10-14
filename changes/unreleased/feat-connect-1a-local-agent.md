---
section: Added
---

- **Connect a local agent:** Settings > "Connect a local agent" ("Lokalen Agenten verbinden"),
  at `/settings/you/connect` while personal API keys are on, gives one command for Claude Code,
  Codex or another tool: `npm install --global @work-shape/catalyst-cli@<version> && catalyst
setup <tool> --instance <url>`, with the instance's address and the CLI version
  `PUBLISHED_CLI_VERSION` names filled in. The page issues nothing; no key and no connect code
  exists until the command runs. `platform.context.get` answers that version as
  `release.cliVersion`. It is unset in this release, because no published CLI has `setup` yet:
  the page says the command is not available and shows none. Deploy order for the release that
  offers it: bump the shared version, run `Publish public CLI` on that commit, set
  `PUBLISHED_CLI_VERSION` and commit it, deploy, and only then switch on `personalApiKeys`.
  `Publish public CLI` now refuses a commit whose version is on npm already, with
  "@work-shape/catalyst-cli@<version> is on npm already. Bump the version all packages share and
  publish from that commit."
- **`catalyst setup <claude-code|codex|other> --instance <url>`** logs in by a connect code
  labelled "<Tool> on <host>" where no working key is saved, opens the confirmation address in
  the browser, and writes the Catalyst skill the package ships to
  `~/.claude/skills/catalyst/SKILL.md` (below `$CLAUDE_CONFIG_DIR` where that is set) or
  `~/.agents/skills/catalyst/SKILL.md`. A different file there is kept unless `--force` is
  given, which moves it to the first free name of `SKILL.md.bak`, `SKILL.md.bak.1` and so on; a
  link at that path is never written through. A run again keeps a working key and updates the
  skill; only a key the instance refuses (401 or 403) is replaced by a new login. It never prints
  the key. A test fails when the skill names a command or option `catalyst --help` does not list.
- **CLI:** outside a working copy, a command without `--instance` works on the one instance a
  key is saved for, unless `CATALYST_API_KEY` is set. With none or several saved it is refused,
  and the message names the saved ones. In a working copy nothing changes: one whose
  `catalyst.yaml` names no `defaultInstance` is refused, and the message names its instances. `catalyst --version` prints the version.
  `login`, `logout` and `setup` name the address of API keys, `<url>/settings/you/api-keys`.
- **`CommandLine`** in the UI library: one command with a copy button.
- **The docs page "Connect a local agent"**, carried into `platform-docs`.
