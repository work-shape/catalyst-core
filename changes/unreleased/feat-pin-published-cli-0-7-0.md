---
section: Changed
---

- **Connect a local agent:** `PUBLISHED_CLI_VERSION` names `@work-shape/catalyst-cli` 0.7.0, the
  first version on npm with `catalyst setup`. Settings > "Connect a local agent" shows the command
  `npm install --global @work-shape/catalyst-cli@0.7.0 && catalyst setup <tool> --instance <url>`
  instead of "The command is not available yet", and `platform.context.get` answers
  `release.cliVersion` 0.7.0. The page still appears only where personal API keys are on.
