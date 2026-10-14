---
section: Added
---

- **Connect a local agent:** Settings > "Connect a local agent" ("Lokalen Agenten verbinden"),
  at `/settings/you/connect` while personal API keys are on, gives one command for Claude Code,
  Codex or another tool: `npm install --global @work-shape/catalyst-cli@<version> && catalyst
  setup <tool> --instance <url>`, with the instance's release and address filled in. The page
  issues nothing; no key and no connect code exists until the command runs.
- **`catalyst setup <claude-code|codex|other> --instance <url>`** logs in by a connect code
  labelled "<Tool> on <host>" where no working key is saved, opens the confirmation address in
  the browser, and writes the Catalyst skill the package ships to
  `~/.claude/skills/catalyst/SKILL.md` or `~/.agents/skills/catalyst/SKILL.md`. A different file
  there is kept unless `--force` is given, which keeps it as `SKILL.md.bak`. A run again keeps a
  working key and updates the skill. It never prints the key. A test fails when the skill names
  a command or option `catalyst --help` does not list.
- **`CommandLine`** in the UI library: one command with a copy button.
- **The docs page "Work with a local agent"**, carried into `platform-docs`.
