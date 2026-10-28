---
section: Fixed
---

- **CLI:** The CLI sends its version and checks the server release before parsing responses, with an exact npm install command when they differ. Unexpected success responses identify the reached URL, content type and body category without exposing content. `catalyst doctor` checks address, sign-in, versions and effective key rights in four shareable lines. CLI installation and update docs include Windows PowerShell 5.1.

  Version mismatch refusal: `Catalyst CLI <cli-version> does not match server <server-version>; run: npm install --global @work-shape/catalyst-cli@<server-version>`. The CLI for that server release must be published before users can follow the command. Older servers without version headers retain their existing request behavior; rolling back the server requires installing its matching CLI version. Existing CLI binaries need an update to gain these diagnostics.
