---
section: Changed
---

- **CLI:** A `catalyst` installed with `npm install --global` whose instance answers a command's
  first request with a newer release installs that version of `@work-shape/catalyst-cli`, says so
  in one line and runs the same command again, once. It never installs an older version, never
  reacts to a later answer of the same command and never replaces a checkout `npm link` points at. A Catalyst skill `catalyst setup` wrote and nobody changed is
  updated with it. It happens only at a terminal: in CI, without a terminal and with
  `CATALYST_NO_AUTO_UPDATE=1` the CLI still stops with the update command, as it does when the
  install fails. A CLI installed in a project names the project's folder and its own install
  command instead of the global one.
