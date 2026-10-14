---
section: Fixed
---

- **`load-deploy-env.sh` finds the workspace's `.env.deploy` from any directory:** without an
  argument it read `../../.env.deploy` relative to the current directory, so sourcing it from a
  deployment repo or from a Terraform root failed with "Missing deploy env file". It now reads
  `.env.deploy` at the workspace root, found from the kit's own location. An argument still
  names another file.
